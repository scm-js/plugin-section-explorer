/**
 * The inspector: what the bytes under the cursor are, and the section's structure.
 *
 * Top to bottom: the section's description; find and go-to; the field at the cursor
 * (its path, its value with its meaning, and a control that edits it — a number box, a
 * drop-down of names, tick boxes per flag bit, a text box); the raw readings at the
 * cursor (every integer width, the bits, the character); and the structure tree, which
 * opens on demand, pages long arrays, and follows the cursor.
 */
import { findBytes, latin1, parseHex, type EditBuffer } from "./buffer";
import { clear, h } from "./dom";
import { describe, leafAt, pathAt, readChars, readPrim, siblingsOf, writePrim, PRIM_RANGE, type Ctx, type Node, type Prim } from "./layout";

const PAGE = 64;

export interface InspectorHost {
  ctx: () => Ctx;
  buffer: () => EditBuffer | null;
  layout: () => Node | null;
  /** Show a node's bytes in the hex view. */
  onPick: (node: Node) => void;
  onGoto: (offset: number) => void;
  /** Select a found range. */
  onFound: (at: number, length: number) => void;
  onStatus: (text: string) => void;
}

export interface SectionHeader {
  name: string;
  what: string;
  doc: string | null;
  size: number;
  expected: number | null;
  recordSize: number | null;
  mode: string;
  occurrence: string | null;
  modelled: boolean;
  dirty: boolean;
}

const key = (n: Node) => `${n.start}:${n.size}:${n.label}`;

export class Inspector {
  readonly el: HTMLElement;
  private doc: HTMLElement;
  private field: HTMLElement;
  private data: HTMLElement;
  private tree: HTMLElement;
  private findBox: HTMLInputElement;
  private findMode: HTMLSelectElement;
  private gotoBox: HTMLInputElement;
  private expanded = new Set<string>();
  private pages = new Map<string, number>();
  private selectedKey: string | null = null;
  private cursor = 0;
  private hoverLine: HTMLElement;
  private editing = false;
  private host: InspectorHost;

  constructor(host: InspectorHost) {
    this.host = host;
    this.doc = h("div", { className: "sx-doc" });
    this.hoverLine = h("div", { className: "sx-hint" });
    this.findBox = h("input", { type: "text", placeholder: "find hex or text", spellcheck: false }) as HTMLInputElement;
    this.findMode = h("select", null, h("option", { value: "hex" }, "hex"), h("option", { value: "text" }, "text"), h("option", { value: "u16" }, "u16"), h("option", { value: "u32" }, "u32")) as HTMLSelectElement;
    this.gotoBox = h("input", { type: "text", placeholder: "go to 0x…", spellcheck: false, style: "width: 78px; flex: none" }) as HTMLInputElement;
    this.findBox.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); this.find(e.shiftKey ? -1 : 1); } e.stopPropagation(); });
    this.gotoBox.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); this.goto(); } e.stopPropagation(); });
    const search = h("div", { className: "sx-search" },
      this.findBox, this.findMode,
      h("button", { className: "sx-btn small", title: "Find next (Enter); Shift+Enter finds the previous", onclick: () => this.find(1) }, "Find"),
      this.gotoBox,
    );
    this.field = h("div", { className: "sx-field" });
    this.data = h("div", { className: "sx-data" });
    this.tree = h("div", { className: "sx-tree" });
    const body = h("div", { className: "sx-pane-body" }, this.tree);
    this.el = h("div", { className: "sx-pane sx-insp" },
      h("div", { className: "sx-pane-head" }, h("b", null, "Inspector"), h("span", { className: "sx-dim sx-grow" }), this.hoverLine),
      this.doc, search, this.field, this.data, body,
    );
    this.hoverLine.className = "sx-dim";
    this.hoverLine.style.cssText = "font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:60%";
  }

  /* ── Header ───────────────────────────────────────────── */

  setHeader(hd: SectionHeader | null) {
    clear(this.doc);
    if (!hd) { this.doc.append("Choose a section on the left."); this.expanded.clear(); this.pages.clear(); this.selectedKey = null; return; }
    const sizeNote = hd.expected !== null && hd.expected !== hd.size
      ? h("span", { className: "sx-warn" }, ` — the game expects ${hd.expected.toLocaleString()} bytes`)
      : hd.recordSize !== null && hd.size % hd.recordSize !== 0
        ? h("span", { className: "sx-warn" }, ` — not a whole number of ${hd.recordSize}-byte records`)
        : null;
    this.doc.append(
      h("div", null, h("b", { className: "sx-mono" }, hd.name), " ", h("span", null, hd.what), h("span", { className: "sx-faint" }, ` · ${hd.mode}${hd.occurrence ? ` · ${hd.occurrence}` : ""}`)),
      h("div", null, `${hd.size.toLocaleString()} bytes`, hd.recordSize !== null ? ` — ${Math.floor(hd.size / hd.recordSize).toLocaleString()} records of ${hd.recordSize}` : "", sizeNote ?? ""),
      hd.doc ? h("div", { style: "margin-top:3px" }, hd.doc) : h("div", { style: "margin-top:3px" }, "The editor has no layout for this section; the bytes are shown as they are."),
      hd.modelled
        ? h("div", { className: "sx-faint", style: "margin-top:3px" }, hd.dirty ? "The editor has unsaved changes here; what you see is what Save would write." : "The editor decodes this section; an applied edit is read back into the map.")
        : h("div", { className: "sx-faint", style: "margin-top:3px" }, "The editor keeps this section as bytes and writes it back unchanged."),
    );
  }

  setHover(offset: number | null) {
    const root = this.host.layout();
    const buf = this.host.buffer();
    if (offset === null || !buf) { this.hoverLine.textContent = ""; return; }
    const path = root ? pathAt(root, offset) : [];
    const leaf = path[path.length - 1];
    if (!leaf || leaf.child) { this.hoverLine.textContent = `0x${offset.toString(16)}`; return; }
    const d = describe(leaf, buf.bytes, this.host.ctx(), siblingsOf(path, buf.bytes));
    this.hoverLine.textContent = `${path.slice(1).map((n) => n.label).join(" › ")} = ${d.text}${d.meaning ? ` (${d.meaning})` : ""}`;
    this.hoverLine.title = this.hoverLine.textContent;
  }

  /* ── The cursor ───────────────────────────────────────── */

  setCursor(offset: number, reveal = true) {
    this.cursor = offset;
    this.renderField();
    this.renderData();
    if (reveal) this.revealOffset(offset);
  }

  /** Values changed underneath: redraw what is showing, keep the tree's shape. */
  refresh() {
    if (!this.editing) this.renderField();
    this.renderData();
    this.renderTree();
  }

  private renderField() {
    clear(this.field);
    const buf = this.host.buffer();
    const root = this.host.layout();
    if (!buf) return;
    if (buf.length === 0) { this.field.append(h("div", { className: "sx-fdoc" }, "No bytes.")); return; }
    const hit = root ? leafAt(root, this.cursor) : null;
    if (!hit) {
      this.field.append(h("div", { className: "sx-crumb" }, h("b", null, `byte 0x${this.cursor.toString(16)}`)), h("div", { className: "sx-fdoc" }, root ? "Not part of the layout." : "Type hex digits in the byte column or characters in the text column to change it."));
      return;
    }
    const { leaf, path } = hit;
    const ctx = this.host.ctx();
    const siblings = siblingsOf(path, buf.bytes);
    const d = describe(leaf, buf.bytes, ctx, siblings);
    const crumb = h("div", { className: "sx-crumb", title: path.slice(1).map((n) => n.label).join(" › ") });
    path.slice(1, -1).forEach((n) => crumb.append(h("span", { style: "cursor:pointer", onclick: () => this.host.onPick(n) }, n.label), " › "));
    crumb.append(h("b", null, leaf.label));
    this.field.append(crumb);
    this.field.append(h("div", { className: "sx-fdoc" },
      h("span", { className: "sx-mono" }, `${leaf.type}`), ` at 0x${leaf.start.toString(16)}`, leaf.size > 1 ? `, ${leaf.size} bytes` : "",
      leaf.start + leaf.size > buf.length ? h("span", { className: "sx-warn" }, " — runs past the end of the section") : "",
      leaf.doc ? h("div", null, leaf.doc) : "",
    ));
    const sem = leaf.semantic;
    const value = h("div", { className: "sx-frow" }, h("label", null, "value"), h("div", { className: "sx-mono" }, d.text, d.meaning ? h("span", { className: "sx-dim" }, `  ${d.meaning}`) : ""));
    this.field.append(value);
    if (!sem || sem.edit === "none" || leaf.type === "bytes") return;
    const commit = (bytes: Uint8Array) => { this.editing = true; try { buf.set(leaf.start, bytes); } finally { this.editing = false; } this.renderField(); };
    if (leaf.type === "chars") {
      const input = h("input", { type: "text", value: readChars(buf.bytes, leaf.start, leaf.size), maxlength: leaf.size, spellcheck: false }) as HTMLInputElement;
      input.addEventListener("keydown", (e) => e.stopPropagation());
      input.addEventListener("change", () => { const out = new Uint8Array(leaf.size); out.set(latin1(input.value).subarray(0, leaf.size)); commit(out); });
      this.field.append(h("div", { className: "sx-frow" }, h("label", null, "text"), input));
      return;
    }
    const prim = leaf.type as Exclude<Prim, "chars" | "bytes">;
    const [min, max] = PRIM_RANGE[prim];
    const write = (v: number) => commit(writePrim(buf.bytes, prim, leaf.start, Math.max(min, Math.min(max, Math.trunc(v)))));
    if (sem.edit === "select" && sem.options) {
      const options = sem.options(ctx);
      const select = h("select") as HTMLSelectElement;
      let present = false;
      for (const o of options) { select.append(h("option", { value: o.value }, `${o.value} — ${o.label}`)); if (o.value === d.value) present = true; }
      if (!present) select.prepend(h("option", { value: d.value }, `${d.value} — (not in the list)`));
      select.value = String(d.value);
      select.addEventListener("keydown", (e) => e.stopPropagation());
      select.addEventListener("change", () => write(Number(select.value)));
      this.field.append(h("div", { className: "sx-frow" }, h("label", null, "choose"), select));
    }
    if (sem.edit === "flags" && sem.bits) {
      const box = h("div", { className: "sx-flagbox" });
      for (const b of sem.bits) {
        const cb = h("input", { type: "checkbox", checked: (d.value & b.bit) !== 0 }) as HTMLInputElement;
        cb.addEventListener("change", () => write(cb.checked ? d.value | b.bit : d.value & ~b.bit));
        box.append(h("label", null, cb, b.label));
      }
      this.field.append(h("div", { className: "sx-frow" }, h("label", null, "bits"), box));
    }
    const num = h("input", { type: "text", value: sem.hex ? `0x${(d.value >>> 0).toString(16)}` : String(d.value), spellcheck: false }) as HTMLInputElement;
    num.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Enter") { e.preventDefault(); num.dispatchEvent(new Event("change")); } });
    num.addEventListener("change", () => { const v = parseNumber(num.value); if (v !== null) write(v); else num.value = String(d.value); });
    this.field.append(h("div", { className: "sx-frow" }, h("label", null, "number"), num));
  }

  private renderData() {
    clear(this.data);
    const buf = this.host.buffer();
    if (!buf || buf.length === 0) return;
    const b = buf.bytes;
    const at = this.cursor;
    const row = (k: string, v: string) => { this.data.append(h("span", { className: "k" }, k), h("span", { className: "v" }, v)); };
    row("offset", `${at} (0x${at.toString(16)})`);
    row("u8 / i8", `${readPrim(b, "u8", at, 1)} / ${readPrim(b, "i8", at, 1)}`);
    if (at + 2 <= b.length) row("u16 / i16", `${readPrim(b, "u16", at, 2)} / ${readPrim(b, "i16", at, 2)}`);
    if (at + 4 <= b.length) row("u32 / i32", `${readPrim(b, "u32", at, 4)} / ${readPrim(b, "i32", at, 4)}`);
    row("bits", b[at].toString(2).padStart(8, "0"));
    row("char", b[at] >= 0x20 && b[at] < 0x7f ? `'${String.fromCharCode(b[at])}'` : b[at] === 0 ? "NUL" : `\\x${b[at].toString(16).padStart(2, "0")}`);
    if (at + 4 <= b.length) row("chars", JSON.stringify(readChars(b, at, 4, false)));
  }

  /* ── Find / go to ─────────────────────────────────────── */

  private needle(): Uint8Array | null {
    const text = this.findBox.value;
    if (!text) return null;
    switch (this.findMode.value) {
      case "hex": return parseHex(text);
      case "text": return latin1(text);
      case "u16": { const v = parseNumber(text); return v === null ? null : new Uint8Array([v & 0xff, (v >> 8) & 0xff]); }
      case "u32": { const v = parseNumber(text); return v === null ? null : new Uint8Array([v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff]); }
    }
    return null;
  }

  find(direction: 1 | -1 = 1) {
    const buf = this.host.buffer();
    const needle = this.needle();
    if (!buf || !needle) { this.host.onStatus("Nothing to look for — type hex digits, text or a number."); return; }
    let at = -1;
    if (direction > 0) at = findBytes(buf.bytes, needle, this.cursor + 1, true);
    else {
      // Backwards: the last match before the cursor, else the last in the buffer.
      let from = 0;
      for (;;) { const hit = findBytes(buf.bytes, needle, from, false); if (hit < 0 || hit >= this.cursor) break; at = hit; from = hit + 1; }
      if (at < 0) { let from2 = this.cursor; for (;;) { const hit = findBytes(buf.bytes, needle, from2, false); if (hit < 0) break; at = hit; from2 = hit + 1; } }
    }
    if (at < 0) { this.host.onStatus("Not found."); return; }
    this.host.onFound(at, needle.length);
    this.host.onStatus(`Found at 0x${at.toString(16)}.`);
  }

  private goto() {
    const v = parseNumber(this.gotoBox.value);
    if (v === null) { this.host.onStatus("An offset is a number: 1234 or 0x4d2."); return; }
    this.host.onGoto(v);
  }

  focusFind() { this.findBox.focus(); this.findBox.select(); }
  focusGoto() { this.gotoBox.focus(); this.gotoBox.select(); }

  /* ── The tree ─────────────────────────────────────────── */

  /** Open the tree down to the leaf at an offset and select it. */
  revealOffset(offset: number) {
    const root = this.host.layout();
    if (!root) { this.selectedKey = null; this.renderTree(); return; }
    const path = pathAt(root, offset);
    for (let i = 0; i < path.length - 1; i++) {
      const node = path[i], next = path[i + 1];
      this.expanded.add(key(node));
      if (node.count && node.count > PAGE && node.child) {
        const index = node.stride ? Math.floor((next.start - node.start) / node.stride) : this.indexOf(node, next);
        this.pages.set(key(node), Math.floor(index / PAGE));
      }
    }
    const leaf = path[path.length - 1];
    this.selectedKey = leaf ? key(leaf) : null;
    this.renderTree();
    const row = this.tree.querySelector(".sx-node.on") as HTMLElement | null;
    row?.scrollIntoView({ block: "nearest" });
  }

  private indexOf(node: Node, child: Node): number {
    if (!node.child || !node.count) return 0;
    for (let i = 0; i < node.count; i++) if (node.child(i).start === child.start) return i;
    return 0;
  }

  renderTree() {
    clear(this.tree);
    const root = this.host.layout();
    const buf = this.host.buffer();
    if (!root || !buf) {
      this.tree.append(h("div", { className: "sx-hint" }, buf ? "No layout for this section. Hover the bytes for their offsets; the hex view still edits them." : ""));
      return;
    }
    this.expanded.add(key(root));
    this.tree.append(this.renderNode(root, 0, []));
  }

  private renderNode(node: Node, depth: number, path: Node[]): DocumentFragment {
    const frag = document.createDocumentFragment();
    const buf = this.host.buffer()!;
    const ctx = this.host.ctx();
    const k = key(node);
    const container = !!node.child && !!node.count;
    const open = container && this.expanded.has(k);
    const row = h("div", { className: `sx-node ${container ? "cont" : "leaf"}${this.selectedKey === k ? " on" : ""}`, style: `padding-left:${6 + depth * 12}px`, title: node.doc ?? "" });
    const tw = h("span", { className: "sx-tw" }, container ? (open ? "▾" : "▸") : "");
    tw.addEventListener("click", (e) => { e.stopPropagation(); if (!container) return; if (open) this.expanded.delete(k); else this.expanded.add(k); this.renderTree(); });
    row.append(tw, h("span", { className: "sx-lbl" }, node.label));
    if (container) {
      const summary = node.summary?.() ?? `${node.count} ${node.count === 1 ? "entry" : "entries"}, ${node.size.toLocaleString()} bytes`;
      row.append(h("span", { className: "sx-mean" }, ` ${summary}`));
    } else {
      const d = describe(node, buf.bytes, ctx, siblingsOf([...path, node], buf.bytes));
      row.append(h("span", { className: "sx-val" }, d.text), d.meaning ? h("span", { className: "sx-mean" }, ` ${d.meaning}`) : "");
    }
    row.addEventListener("click", () => {
      this.selectedKey = k;
      if (container && !open) this.expanded.add(k);
      this.host.onPick(node);
      this.renderTree();
    });
    frag.append(row);
    if (!open) return frag;
    const count = node.count!;
    const next = [...path, node];
    let from = 0, to = count;
    if (count > PAGE) {
      const page = Math.min(Math.floor((count - 1) / PAGE), this.pages.get(k) ?? 0);
      from = page * PAGE;
      to = Math.min(count, from + PAGE);
      const select = h("select") as HTMLSelectElement;
      for (let p = 0; p * PAGE < count; p++) select.append(h("option", { value: p }, `${p * PAGE}–${Math.min(count, p * PAGE + PAGE) - 1}`));
      select.value = String(page);
      select.addEventListener("change", () => { this.pages.set(k, Number(select.value)); this.renderTree(); });
      select.addEventListener("keydown", (e) => e.stopPropagation());
      frag.append(h("div", { className: "sx-pager", style: `padding-left:${18 + depth * 12}px` },
        h("button", { className: "sx-btn small", disabled: page === 0, onclick: () => { this.pages.set(k, page - 1); this.renderTree(); } }, "‹"),
        select,
        h("button", { className: "sx-btn small", disabled: to >= count, onclick: () => { this.pages.set(k, page + 1); this.renderTree(); } }, "›"),
        h("span", null, `of ${count.toLocaleString()}`),
      ));
    }
    for (let i = from; i < to; i++) frag.append(this.renderNode(node.child!(i), depth + 1, next));
    return frag;
  }
}

/** "1234", "0x4d2", "-5" → number; null otherwise. */
export function parseNumber(text: string): number | null {
  const t = text.trim();
  if (/^-?0x[0-9a-f]+$/i.test(t)) return parseInt(t, 16);
  if (/^-?\d+$/.test(t)) return parseInt(t, 10);
  return null;
}
