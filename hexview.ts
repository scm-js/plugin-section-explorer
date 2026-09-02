/**
 * The hex view: offset, sixteen bytes and their text per row, drawn only for the rows on
 * screen, coloured by the field each byte belongs to, with a cursor, a selection and
 * in-place typing (hex digits in the byte column, characters in the text column).
 *
 * It owns nothing but the view state: the bytes come from an `EditBuffer`, the colours
 * and hover ranges from the layout the host hands it, and every change goes back
 * through the buffer so the inspector and the undo history see it.
 */
import { latin1, parseHex, toHex, type EditBuffer } from "./buffer";
import { h, clear } from "./dom";
import { leafAt, leavesIn, type Node } from "./layout";

export const BYTES_PER_ROW = 16;
const ROW_H = 18;
const OVERSCAN = 6;

export interface Range { from: number; to: number }

export interface HexViewHost {
  buffer: () => EditBuffer;
  layout: () => Node | null;
  /** The cursor moved (a click, a key, a jump). */
  onCursor: (offset: number) => void;
  /** The pointer is over an offset, or left the bytes. */
  onHover: (offset: number | null) => void;
  onSelection: (range: Range | null) => void;
  onModeChange: () => void;
}

export class HexView {
  readonly el: HTMLElement;
  private scroll: HTMLElement;
  private spacer: HTMLElement;
  private rows: HTMLElement;
  private strip: HTMLCanvasElement;
  private empty: HTMLElement;
  cursor = 0;
  nibble: 0 | 1 = 0;
  column: "hex" | "ascii" = "hex";
  insertMode = false;
  selection: Range | null = null;
  private anchor: number | null = null;
  private dragging = false;
  /** The inspector's pick, painted teal. */
  private fieldRange: Range | null = null;
  private hoverRange: Range | null = null;
  private raf = 0;
  private colorCache = new Map<number, { color: number[]; band: number[] }>();
  private host: HexViewHost;

  constructor(host: HexViewHost) {
    this.host = host;
    this.spacer = h("div", { className: "sx-hexspacer" });
    this.rows = h("div", { className: "sx-hexrows" });
    this.spacer.append(this.rows);
    this.empty = h("div", { className: "sx-hexempty", hidden: true }, "This section is empty. Insert a record or bytes from the inspector, or paste hex here.");
    this.scroll = h("div", { className: "sx-hexscroll", tabindex: 0 }, this.spacer, this.empty);
    this.strip = h("canvas", { className: "sx-strip", height: 14, title: "The section's structure; click to jump" });
    this.el = h("div", { className: "sx-hexpane" }, this.strip, this.scroll);
    this.scroll.addEventListener("scroll", () => this.schedule());
    this.scroll.addEventListener("mousedown", (e) => this.onMouseDown(e));
    this.scroll.addEventListener("mousemove", (e) => this.onMouseMove(e));
    this.scroll.addEventListener("mouseleave", () => { this.hoverRange = null; this.host.onHover(null); this.schedule(); });
    window.addEventListener("mouseup", this.onMouseUp);
    this.scroll.addEventListener("keydown", (e) => this.onKey(e));
    this.strip.addEventListener("click", (e) => this.onStripClick(e));
    new ResizeObserver(() => { this.schedule(); }).observe(this.scroll);
  }

  dispose() {
    window.removeEventListener("mouseup", this.onMouseUp);
    cancelAnimationFrame(this.raf);
  }

  focus() { this.scroll.focus({ preventScroll: true }); }

  /** The bytes or layout changed: forget the colour cache and repaint. */
  invalidate() {
    this.colorCache.clear();
    const n = this.host.buffer().length;
    if (this.cursor >= n) this.cursor = Math.max(0, n - 1);
    if (this.selection && this.selection.to > n) this.selection = n > 0 ? { from: Math.min(this.selection.from, n - 1), to: n } : null;
    this.schedule();
  }

  schedule() {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => { this.raf = 0; this.render(); });
  }

  setFieldRange(r: Range | null) { this.fieldRange = r; this.schedule(); }

  setCursor(offset: number, opts: { select?: boolean; reveal?: boolean; keepNibble?: boolean } = {}) {
    const n = this.host.buffer().length;
    const at = Math.max(0, Math.min(Math.max(0, n - 1), offset));
    this.cursor = at;
    if (!opts.keepNibble) this.nibble = 0;
    if (opts.select) {
      if (this.anchor === null) this.anchor = at;
      this.selection = this.anchor <= at ? { from: this.anchor, to: at + 1 } : { from: at, to: this.anchor + 1 };
    } else {
      this.anchor = null;
      this.selection = null;
    }
    if (opts.reveal !== false) this.reveal(at);
    this.host.onCursor(at);
    this.host.onSelection(this.selection);
    this.schedule();
  }

  select(range: Range | null, moveCursor = true) {
    this.selection = range;
    this.anchor = range ? range.from : null;
    if (range && moveCursor) { this.cursor = range.from; this.nibble = 0; this.reveal(range.from); this.host.onCursor(range.from); }
    this.host.onSelection(range);
    this.schedule();
  }

  reveal(offset: number) {
    const row = Math.floor(offset / BYTES_PER_ROW);
    const top = row * ROW_H;
    const viewTop = this.scroll.scrollTop;
    const viewH = this.scroll.clientHeight;
    if (top < viewTop) this.scroll.scrollTop = top;
    else if (top + ROW_H > viewTop + viewH) this.scroll.scrollTop = top + ROW_H - viewH;
  }

  /* ── Painting ─────────────────────────────────────────── */

  private colorsOf(row: number, root: Node | null, bytes: Uint8Array): { color: number[]; band: number[] } {
    const cached = this.colorCache.get(row);
    if (cached) return cached;
    const color = new Array<number>(BYTES_PER_ROW).fill(-1);
    const band = new Array<number>(BYTES_PER_ROW).fill(0);
    const from = row * BYTES_PER_ROW;
    const to = Math.min(bytes.length, from + BYTES_PER_ROW);
    if (root) {
      leavesIn(root, from, to, (leaf) => {
        for (let i = Math.max(leaf.start, from); i < Math.min(leaf.start + leaf.size, to); i++) {
          color[i - from] = leaf.color;
          band[i - from] = leaf.band;
        }
      });
    }
    const entry = { color, band };
    this.colorCache.set(row, entry);
    return entry;
  }

  render() {
    const bytes = this.host.buffer().bytes;
    const root = this.host.layout();
    const n = bytes.length;
    const rowCount = Math.ceil(n / BYTES_PER_ROW);
    this.empty.hidden = n > 0;
    this.spacer.style.height = `${Math.max(1, rowCount) * ROW_H}px`;
    this.scroll.classList.toggle("ascii", this.column === "ascii");
    const first = Math.max(0, Math.floor(this.scroll.scrollTop / ROW_H) - OVERSCAN);
    const last = Math.min(rowCount - 1, Math.ceil((this.scroll.scrollTop + this.scroll.clientHeight) / ROW_H) + OVERSCAN);
    this.rows.style.top = `${first * ROW_H}px`;
    clear(this.rows);
    const sel = this.selection, fld = this.fieldRange, hov = this.hoverRange;
    const inRange = (r: Range | null, i: number) => !!r && i >= r.from && i < r.to;
    for (let row = first; row <= last; row++) {
      const base = row * BYTES_PER_ROW;
      const { color, band } = this.colorsOf(row, root, bytes);
      const hx = h("span", { className: "sx-hx" });
      const as = h("span", { className: "sx-as" });
      for (let i = 0; i < BYTES_PER_ROW; i++) {
        const at = base + i;
        if (i === 8) { hx.append(h("span", { className: "sx-b gap" })); }
        if (at >= n) { hx.append(h("span", { className: "sx-b" }, "  ")); as.append(h("span", { className: "sx-b" }, " ")); continue; }
        const b = bytes[at];
        let cls = `sx-b ${color[i] < 0 ? "cn" : `c${color[i]}`}${band[i] ? " band1" : ""}${b === 0 ? " nul" : ""}`;
        if (inRange(fld, at)) cls += " fld";
        if (inRange(hov, at)) cls += " hov";
        if (inRange(sel, at)) cls += " sel";
        if (at === this.cursor) cls += ` cur${this.nibble ? " nib" : ""}`;
        hx.append(h("span", { className: cls, "data-at": at }, b.toString(16).padStart(2, "0")));
        as.append(h("span", { className: cls, "data-at": at }, b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : b === 0 ? "·" : "."));
      }
      this.rows.append(h("div", { className: "sx-hexrow" }, h("span", { className: "sx-off" }, base.toString(16).padStart(8, "0")), hx, as));
    }
    this.renderStrip(root, n);
  }

  /** The structure strip: the top-level children as proportional blocks, and where the view is. */
  private renderStrip(root: Node | null, n: number) {
    const canvas = this.strip;
    const w = canvas.clientWidth || 300;
    if (canvas.width !== w) canvas.width = w;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, w, canvas.height);
    if (n === 0) return;
    const colors = ["#f4d08a", "#7fe3d9", "#ff9e7a", "#9cc2ff", "#c6e37f", "#e0a0ff", "#ffd1e8", "#b8c4d6"];
    const px = (at: number) => (at / n) * w;
    const draw = (node: Node, depth: number) => {
      if (node.child && node.count && node.count <= 4096 && depth < 2) {
        for (let i = 0; i < node.count; i++) draw(node.child(i), depth + 1);
        return;
      }
      const x0 = px(node.start), x1 = px(Math.min(n, node.start + node.size));
      if (x1 - x0 < 0.5) return;
      ctx.fillStyle = colors[node.color % colors.length];
      ctx.globalAlpha = node.band ? 0.55 : 0.85;
      ctx.fillRect(x0, 2, Math.max(1, x1 - x0 - (x1 - x0 > 3 ? 1 : 0)), 8);
    };
    ctx.globalAlpha = 1;
    if (root) draw(root, 0); else { ctx.fillStyle = "#5d6675"; ctx.fillRect(0, 2, w, 8); }
    ctx.globalAlpha = 1;
    const viewFrom = Math.floor(this.scroll.scrollTop / ROW_H) * BYTES_PER_ROW;
    const viewTo = Math.min(n, Math.ceil((this.scroll.scrollTop + this.scroll.clientHeight) / ROW_H) * BYTES_PER_ROW);
    ctx.strokeStyle = "#ffffff";
    ctx.globalAlpha = 0.7;
    ctx.strokeRect(px(viewFrom) + 0.5, 0.5, Math.max(2, px(viewTo) - px(viewFrom)), canvas.height - 1);
    ctx.globalAlpha = 1;
    if (this.cursor < n) { ctx.fillStyle = "#e6b95c"; ctx.fillRect(px(this.cursor), 0, 2, canvas.height); }
  }

  private onStripClick(e: MouseEvent) {
    const n = this.host.buffer().length;
    if (n === 0) return;
    const rect = this.strip.getBoundingClientRect();
    const at = Math.floor(((e.clientX - rect.left) / rect.width) * n);
    this.setCursor(at);
    // Centre the row.
    this.scroll.scrollTop = Math.max(0, Math.floor(at / BYTES_PER_ROW) * ROW_H - this.scroll.clientHeight / 2);
    this.focus();
  }

  /* ── Mouse ────────────────────────────────────────────── */

  private byteAt(e: MouseEvent): { at: number; column: "hex" | "ascii" } | null {
    const t = e.target as HTMLElement | null;
    const span = t?.closest?.(".sx-b[data-at]") as HTMLElement | null;
    if (!span) return null;
    return { at: Number(span.dataset.at), column: span.parentElement?.classList.contains("sx-as") ? "ascii" : "hex" };
  }

  private onMouseDown(e: MouseEvent) {
    if (e.button !== 0) return;
    const hit = this.byteAt(e);
    this.focus();
    if (!hit) return;
    e.preventDefault();
    this.column = hit.column;
    if (e.shiftKey) {
      if (this.anchor === null) this.anchor = this.cursor;
      this.setCursor(hit.at, { select: true, reveal: false });
    } else {
      this.anchor = hit.at;
      this.setCursor(hit.at, { reveal: false });
      this.anchor = hit.at;
    }
    this.dragging = true;
  }

  private onMouseMove(e: MouseEvent) {
    const hit = this.byteAt(e);
    if (this.dragging && hit) {
      if (hit.at !== this.cursor) this.setCursor(hit.at, { select: true, reveal: false });
      return;
    }
    const at = hit?.at ?? null;
    const root = this.host.layout();
    const leaf = at !== null && root ? leafAt(root, at)?.leaf ?? null : null;
    const next: Range | null = leaf ? { from: leaf.start, to: leaf.start + leaf.size } : at !== null ? { from: at, to: at + 1 } : null;
    if ((next?.from ?? -1) !== (this.hoverRange?.from ?? -1) || (next?.to ?? -1) !== (this.hoverRange?.to ?? -1)) {
      this.hoverRange = next;
      this.schedule();
    }
    this.host.onHover(at);
  }

  private onMouseUp = () => {
    if (!this.dragging) return;
    this.dragging = false;
    if (this.selection && this.selection.to - this.selection.from <= 1) { this.selection = null; this.anchor = null; this.host.onSelection(null); this.schedule(); }
  };

  /* ── Keys ─────────────────────────────────────────────── */

  private onKey(e: KeyboardEvent) {
    const buf = this.host.buffer();
    const n = buf.length;
    const move = (to: number) => { e.preventDefault(); this.setCursor(to, { select: e.shiftKey }); };
    const rowsVisible = Math.max(1, Math.floor(this.scroll.clientHeight / ROW_H) - 1);
    if (e.ctrlKey || e.metaKey) {
      switch (e.key.toLowerCase()) {
        case "z": e.preventDefault(); e.stopPropagation(); if (e.shiftKey) buf.redo(); else buf.undo(); return;
        case "y": e.preventDefault(); e.stopPropagation(); buf.redo(); return;
        case "a": e.preventDefault(); e.stopPropagation(); this.select(n > 0 ? { from: 0, to: n } : null, false); return;
        case "c": e.preventDefault(); e.stopPropagation(); void this.copy(); return;
        case "home": move(0); return;
        case "end": move(n - 1); return;
      }
      return;
    }
    switch (e.key) {
      case "ArrowLeft": move(this.cursor - 1); return;
      case "ArrowRight": move(this.cursor + 1); return;
      case "ArrowUp": move(this.cursor - BYTES_PER_ROW); return;
      case "ArrowDown": move(this.cursor + BYTES_PER_ROW); return;
      case "PageUp": move(this.cursor - rowsVisible * BYTES_PER_ROW); return;
      case "PageDown": move(this.cursor + rowsVisible * BYTES_PER_ROW); return;
      case "Home": move(this.cursor - (this.cursor % BYTES_PER_ROW)); return;
      case "End": move(this.cursor - (this.cursor % BYTES_PER_ROW) + BYTES_PER_ROW - 1); return;
      case "Tab": e.preventDefault(); this.column = this.column === "hex" ? "ascii" : "hex"; this.nibble = 0; this.schedule(); this.host.onModeChange(); return;
      case "Insert": e.preventDefault(); this.insertMode = !this.insertMode; this.host.onModeChange(); return;
      case "Delete":
      case "Backspace": {
        e.preventDefault();
        e.stopPropagation();
        if (this.selection) {
          const { from, to } = this.selection;
          if (this.insertMode) buf.remove(from, to - from); else buf.set(from, new Uint8Array(to - from));
          this.select(null, false);
          this.setCursor(from);
          return;
        }
        if (n === 0) return;
        const at = e.key === "Backspace" ? this.cursor - 1 : this.cursor;
        if (at < 0) return;
        if (this.insertMode) buf.remove(at, 1); else buf.set(at, [0]);
        this.setCursor(at);
        return;
      }
    }
    if (e.altKey) return;
    if (e.key.length !== 1) return;
    if (this.column === "hex") {
      const d = parseInt(e.key, 16);
      if (Number.isNaN(d)) return;
      e.preventDefault();
      e.stopPropagation();
      if (n === 0 || (this.insertMode && this.nibble === 0)) {
        buf.insert(Math.min(this.cursor, buf.length), [d << 4]);
        this.nibble = 1;
        this.setCursor(this.cursor, { keepNibble: true });
        return;
      }
      if (this.nibble === 0) {
        buf.set(this.cursor, [(buf.bytes[this.cursor] & 0x0f) | (d << 4)]);
        this.nibble = 1;
        this.schedule();
      } else {
        buf.set(this.cursor, [(buf.bytes[this.cursor] & 0xf0) | d]);
        this.nibble = 0;
        if (this.cursor + 1 < buf.length) this.setCursor(this.cursor + 1); else this.schedule();
      }
      return;
    }
    // Text column: one character, one byte.
    const code = e.key.charCodeAt(0);
    if (code > 0xff) return;
    e.preventDefault();
    e.stopPropagation();
    if (n === 0 || this.insertMode) {
      buf.insert(Math.min(this.cursor, buf.length), [code]);
      this.setCursor(Math.min(buf.length - 1, this.cursor + 1));
    } else {
      buf.set(this.cursor, [code]);
      if (this.cursor + 1 < buf.length) this.setCursor(this.cursor + 1); else this.schedule();
    }
  }

  /** The selection (or the byte under the cursor) as hex, or as text from the text column. */
  async copy() {
    const buf = this.host.buffer();
    const r = this.selection ?? { from: this.cursor, to: Math.min(buf.length, this.cursor + 1) };
    if (r.to <= r.from) return;
    const slice = buf.bytes.subarray(r.from, r.to);
    const text = this.column === "ascii" ? Array.from(slice, (b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : ".")).join("") : toHex(slice);
    try { await navigator.clipboard.writeText(text); } catch { /* the browser said no */ }
  }

  /** Pasted text: hex digits in the byte column, characters in the text column. Overwrites at the cursor, or inserts in insert mode. */
  paste(text: string): number {
    const buf = this.host.buffer();
    const bytes = this.column === "hex" ? parseHex(text) ?? latin1(text) : latin1(text);
    if (bytes.length === 0) return 0;
    const at = this.selection ? this.selection.from : Math.min(this.cursor, buf.length);
    if (this.selection) {
      if (this.insertMode) buf.remove(this.selection.from, this.selection.to - this.selection.from);
      this.select(null, false);
    }
    if (this.insertMode || buf.length === 0) buf.insert(at, bytes); else buf.set(at, bytes);
    this.setCursor(Math.min(buf.length - 1, at + bytes.length));
    return bytes.length;
  }
}
