/**
 * Section Explorer — a plugin for the scmJS map editor (https://github.com/jeany55/scm-js).
 *
 * Tools ▸ Section Explorer… opens the map file the way the game reads it: every section
 * in the order Save would write them, its bytes in a hex view coloured by field, and an
 * inspector that says what the byte under the cursor is — the record, the field, the
 * value and the name behind it — and edits it as a number, a choice, a set of flags or
 * text. Sections can be added, removed, renamed and reordered; bytes can be typed,
 * pasted, inserted and deleted; whole records can be inserted and removed. Apply hands
 * the edited sections back to the editor (`api.document.sections`), which parses the
 * file again so every dialog and the map view follow.
 *
 * `buffer.ts` is the edit buffer with its own undo, `layout.ts` the node model and
 * `layouts.ts` the sections' layouts (both pure, with tests); `hexview.ts` and
 * `inspector.ts` are the two big panes; this file is the dialog and the glue.
 * `plugin-api/` is the editor's emitted type declarations, vendored so the repository
 * type-checks alone; the host erases the type-only import.
 */
import type { DialogHandle, PluginApi, SectionInfo } from "./plugin-api/plugins/api";
import { EditBuffer } from "./buffer";
import { clear, h, STYLE } from "./dom";
import { HexView, type Range } from "./hexview";
import { Inspector } from "./inspector";
import type { Ctx, Node } from "./layout";
import { blankRecord, expectedSize, knownLayouts, recordSize, SECTION_DOCS, sectionLayout } from "./layouts";

export default function activate(api: PluginApi) {
  let explorer: Explorer | null = null;
  const open = () => {
    if (!api.document.isOpen()) { api.ui.status("Section Explorer: open a map first."); return; }
    if (explorer?.isOpen()) return;
    explorer = new Explorer(api);
    explorer.open();
  };
  api.menu.add("Tools", { label: "Section Explorer…", shortcut: "Ctrl+Shift+H", enabled: () => api.document.isOpen(), run: open });
  api.hotkeys.add("Ctrl+Shift+H", open);
  return () => { explorer?.close(); };
}

/* ── The explorer ───────────────────────────────────────── */

const fmt = (n: number) => n.toLocaleString();
const hex = (n: number) => `0x${n.toString(16)}`;

class Explorer {
  private handle: DialogHandle | null = null;
  private infos: SectionInfo[] = [];
  private selected = -1;
  private buffers = new Map<number, EditBuffer>();
  private unsubBuffer: (() => void) | null = null;
  private layoutFor: { bytes: Uint8Array; root: Node | null } | null = null;
  private hex!: HexView;
  private insp!: Inspector;
  private listBody!: HTMLElement;
  private listFoot!: HTMLElement;
  private filter!: HTMLInputElement;
  private summary!: HTMLElement;
  private statusLine!: HTMLElement;
  private hexHead!: HTMLElement;
  private undoBtn!: HTMLButtonElement;
  private redoBtn!: HTMLButtonElement;
  private applyBtn!: HTMLButtonElement;
  private revertBtn!: HTMLButtonElement;
  private insertTick!: HTMLInputElement;
  private applying = false;
  private closeArmed = false;
  private pickingFromInspector = false;
  private disposers: (() => void)[] = [];
  private api: PluginApi;

  constructor(api: PluginApi) { this.api = api; }

  isOpen() { return this.handle?.isOpen() ?? false; }
  close() { this.handle?.close(); }

  open() {
    this.handle = this.api.ui.dialog({
      title: "Section Explorer",
      size: "full",
      tall: true,
      mount: (body, handle) => this.mount(body, handle),
      buttons: [
        { label: "Apply", primary: true, closes: false, run: () => { this.apply(); return false; } },
        { label: "Close", run: () => this.tryClose() },
      ],
      onPaste: (transfer) => {
        if (!transfer.text || this.selected < 0) return;
        const n = this.hex.paste(transfer.text);
        this.status(n ? `Pasted ${n} byte${n === 1 ? "" : "s"}.` : "Nothing to paste — hex digits in the byte column, text in the text column.");
      },
    });
  }

  private tryClose(): boolean {
    const pending = [...this.buffers.values()].filter((b) => b.modified).length;
    if (pending === 0 || this.closeArmed) return true;
    this.closeArmed = true;
    this.status(`${pending} section${pending === 1 ? " has" : "s have"} changes you have not applied — Apply, Revert, or press Close again to drop them.`);
    return false;
  }

  /* ── Mount ────────────────────────────────────────────── */

  private mount(body: HTMLElement, handle: DialogHandle): () => void {
    this.handle = handle;
    const root = h("div", { className: "sx" });
    root.append(h("style", null, STYLE));

    this.summary = h("span", { className: "sx-dim" });
    this.undoBtn = h("button", { className: "sx-btn small", title: "Undo (Ctrl+Z in the hex view)", onclick: () => this.buffer()?.undo() }, "Undo") as HTMLButtonElement;
    this.redoBtn = h("button", { className: "sx-btn small", title: "Redo (Ctrl+Y)", onclick: () => this.buffer()?.redo() }, "Redo") as HTMLButtonElement;
    this.insertTick = h("input", { type: "checkbox", title: "Insert mode: typed and pasted bytes are inserted rather than overwritten; Delete removes bytes. Also the Insert key." }) as HTMLInputElement;
    this.insertTick.addEventListener("change", () => { this.hex.insertMode = this.insertTick.checked; this.updateStatus(); });
    this.applyBtn = h("button", { className: "sx-btn primary small", title: "Write every changed section into the map", onclick: () => this.apply() }, "Apply") as HTMLButtonElement;
    this.revertBtn = h("button", { className: "sx-btn small", title: "Drop every change and read the sections again", onclick: () => this.reload("revert") }, "Revert") as HTMLButtonElement;
    const bar = h("div", { className: "sx-bar" },
      this.summary, h("span", { className: "sx-grow" }),
      h("button", { className: "sx-btn small", title: "Download the scenario file as Save would write it (scenario.chk, no archive)", onclick: () => this.exportFile() }, "Export .chk"),
      h("button", { className: "sx-btn small", title: "Replace the whole scenario with a .chk file", onclick: () => void this.importFile() }, "Import .chk…"),
      h("span", { className: "sx-sep" }),
      this.undoBtn, this.redoBtn,
      h("span", { className: "sx-sep" }),
      h("label", { className: "sx-check" }, this.insertTick, "Insert mode"),
      h("span", { className: "sx-sep" }),
      this.revertBtn, this.applyBtn,
    );

    // Sections.
    this.filter = h("input", { type: "text", placeholder: "filter", spellcheck: false, style: "width: 90px" }) as HTMLInputElement;
    this.filter.addEventListener("input", () => this.renderList());
    this.filter.addEventListener("keydown", (e) => e.stopPropagation());
    this.listBody = h("div", { className: "sx-pane-body sx-sections" });
    this.listFoot = h("div", { className: "sx-pane-foot" });
    const sections = h("div", { className: "sx-pane" }, h("div", { className: "sx-pane-head" }, h("b", null, "Sections"), h("span", { className: "sx-grow" }), this.filter), this.listBody, this.listFoot);

    // Hex view.
    this.hex = new HexView({
      buffer: () => this.buffer() ?? new EditBuffer(new Uint8Array(0)),
      layout: () => this.layout(),
      onCursor: (offset) => { this.insp.setCursor(offset, !this.pickingFromInspector); this.updateStatus(); },
      onHover: (offset) => this.insp.setHover(offset),
      onSelection: () => this.updateStatus(),
      onModeChange: () => { this.insertTick.checked = this.hex.insertMode; this.updateStatus(); },
    });
    this.hexHead = h("div", { className: "sx-pane-head" });
    this.statusLine = h("div", { className: "sx-hexstatus" });
    const hexPane = h("div", { className: "sx-pane" }, this.hexHead, this.hex.el, this.statusLine);

    // Inspector.
    this.insp = new Inspector({
      ctx: () => this.ctx(),
      buffer: () => this.buffer(),
      layout: () => this.layout(),
      onPick: (node) => this.pick(node),
      onGoto: (offset) => { this.hex.setCursor(offset); this.hex.focus(); },
      onFound: (at, length) => { this.hex.select({ from: at, to: at + length }); this.hex.focus(); },
      onStatus: (text) => this.status(text),
    });

    root.append(bar, h("div", { className: "sx-main" }, sections, hexPane, this.insp.el));
    body.append(root);

    // Keys that reach the dialog body but not the hex view.
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const k = e.key.toLowerCase();
      if (k === "f") { e.preventDefault(); e.stopPropagation(); this.insp.focusFind(); }
      else if (k === "g") { e.preventDefault(); e.stopPropagation(); this.insp.focusGoto(); }
      else if (k === "s") { e.preventDefault(); e.stopPropagation(); this.apply(); }
    };
    root.addEventListener("keydown", onKey);

    const events = this.api.events.on("document", () => { if (!this.applying) this.reload("document"); });
    this.disposers.push(() => events.dispose(), () => this.hex.dispose());

    this.reload("open");
    const remembered = this.api.storage.get<string | null>("lastSection", null);
    const first = remembered ? this.infos.findIndex((s) => s.name === remembered) : -1;
    this.select(first >= 0 ? first : this.infos.length ? 0 : -1);
    return () => { for (const d of this.disposers.splice(0)) d(); this.handle = null; };
  }

  /* ── State ────────────────────────────────────────────── */

  private buffer(): EditBuffer | null {
    return this.selected >= 0 ? this.buffers.get(this.selected) ?? null : null;
  }

  private ctx(): Ctx {
    const info = this.api.document.info();
    return { names: this.api.names, width: info?.width ?? 0, height: info?.height ?? 0 };
  }

  private layout(): Node | null {
    const buf = this.buffer();
    const info = this.infos[this.selected];
    if (!buf || !info) return null;
    if (this.layoutFor && this.layoutFor.bytes === buf.bytes) return this.layoutFor.root;
    const root = sectionLayout(info.name, buf.bytes, this.ctx());
    this.layoutFor = { bytes: buf.bytes, root };
    return root;
  }

  private status(text: string) { this.api.ui.status(`Section Explorer: ${text}`); }

  /** Read the section list again from the document (after Apply, Revert, a structural edit, or a map change). */
  private reload(reason: "open" | "revert" | "document" | "structure") {
    const keep = this.selected;
    this.infos = this.api.document.sections.list();
    this.buffers.clear();
    this.layoutFor = null;
    this.closeArmed = false;
    if (reason === "revert") this.status("Reverted — every section read again from the map.");
    this.renderSummary();
    this.renderList();
    if (this.infos.length === 0) { this.select(-1); return; }
    if (reason !== "open") this.select(Math.min(keep, this.infos.length - 1), true);
  }

  private select(index: number, keepCursor = false) {
    if (this.unsubBuffer) { this.unsubBuffer(); this.unsubBuffer = null; }
    const cursor = keepCursor ? this.hex.cursor : 0;
    this.selected = index;
    this.layoutFor = null;
    const info = this.infos[index];
    if (!info) {
      this.insp.setHeader(null);
      this.renderHexHead();
      this.hex.invalidate();
      this.insp.refresh();
      this.updateStatus();
      return;
    }
    this.api.storage.set("lastSection", info.name);
    let buf = this.buffers.get(index);
    if (!buf) { buf = new EditBuffer(this.api.document.sections.bytes(index)); this.buffers.set(index, buf); }
    this.unsubBuffer = buf.onChange(() => this.onBufferChange());
    this.renderHeader();
    this.renderHexHead();
    this.renderList();
    this.hex.setFieldRange(null);
    this.hex.invalidate();
    this.hex.setCursor(Math.min(cursor, Math.max(0, buf.length - 1)));
    this.insp.refresh();
    this.updateStatus();
  }

  private onBufferChange() {
    this.layoutFor = null;
    this.hex.invalidate();
    this.insp.refresh();
    this.renderHeader();
    this.renderList();
    this.updateStatus();
  }

  private pick(node: Node) {
    this.pickingFromInspector = true;
    try {
      this.hex.setFieldRange({ from: node.start, to: node.start + node.size });
      if (node.child) this.hex.select({ from: node.start, to: Math.min(this.buffer()?.length ?? 0, node.start + node.size) });
      else this.hex.setCursor(node.start);
    } finally {
      this.pickingFromInspector = false;
    }
    this.insp.setCursor(this.hex.cursor, false);
  }

  /* ── Rendering ────────────────────────────────────────── */

  private renderSummary() {
    const info = this.api.document.info();
    const total = this.infos.reduce((n, s) => n + 8 + s.size, 0);
    const repeats = new Set(this.infos.filter((s) => s.occurrences > 1).map((s) => s.name)).size;
    const unknown = this.infos.filter((s) => !s.spec).length;
    clear(this.summary);
    this.summary.append(
      h("b", { className: "sx-gold" }, info?.name || "Untitled"),
      ` — ${fmt(total)} bytes, ${this.infos.length} sections`,
      repeats ? `, ${repeats} repeated` : "", unknown ? `, ${unknown} unknown` : "",
      info?.fileName ? h("span", { className: "sx-faint" }, ` · ${info.fileName}`) : "",
    );
  }

  private renderList() {
    clear(this.listBody);
    const q = this.filter.value.trim().toLowerCase();
    for (const s of this.infos) {
      const what = s.spec?.what ?? "unknown section";
      if (q && !s.name.toLowerCase().includes(q) && !what.toLowerCase().includes(q)) continue;
      const buf = this.buffers.get(s.index);
      const badges = h("span", { className: "sx-badges" });
      if (!s.spec) badges.append(h("span", { className: "sx-badge unknown", title: "The editor knows nothing about this section" }, "?"));
      else if (!s.spec.modelled) badges.append(h("span", { className: "sx-badge raw", title: "Kept as bytes and written back unchanged" }, "raw"));
      if (s.dirty) badges.append(h("span", { className: "sx-badge dirty", title: "The editor has unsaved changes that will be encoded here on Save" }, "unsaved"));
      if (buf?.modified) badges.append(h("span", { className: "sx-badge edited", title: "Changed here and not yet applied" }, "edited"));
      if (s.occurrences > 1) badges.append(h("span", { className: "sx-badge repeat", title: `Occurrence ${s.occurrence + 1} of ${s.occurrences}; the game combines them (${s.spec?.mode ?? "last wins"})` }, `${s.occurrence + 1}/${s.occurrences}`));
      const expected = s.spec?.size ?? null;
      if (s.truncated) badges.append(h("span", { className: "sx-badge warn", title: `Declares ${s.declaredSize} bytes but the file ended early` }, "cut"));
      else if (expected !== null && expected !== (buf?.length ?? s.size)) badges.append(h("span", { className: "sx-badge warn", title: `The game reads ${fmt(expected)} bytes here` }, "size"));
      const row = h("div", { className: `sx-row${s.index === this.selected ? " on" : ""}`, title: `${s.name} at ${hex(s.offset)} — ${what}` },
        h("span", { className: "sx-name" }, s.name),
        h("span", { className: "sx-what" }, what, badges),
        h("span", { className: "sx-size" }, fmt(buf?.length ?? s.size)),
      );
      row.addEventListener("click", () => { if (s.index !== this.selected) this.select(s.index); });
      row.addEventListener("dblclick", () => this.renameForm(s.index));
      this.listBody.append(row);
    }
    this.renderListFoot();
  }

  private renderListFoot() {
    clear(this.listFoot);
    const has = this.selected >= 0;
    const btn = (label: string, title: string, run: () => void, enabled = true) => h("button", { className: "sx-btn small", title, disabled: !enabled, onclick: run }, label);
    this.listFoot.append(
      btn("Add…", "Insert a new section", () => this.addForm()),
      btn("Remove", "Remove this occurrence from the file", () => this.structural(() => this.api.document.sections.remove(this.selected), "Removed the section."), has),
      btn("Rename…", "Change the four-character name", () => this.renameForm(this.selected), has),
      btn("↑", "Move up", () => this.structural(() => this.api.document.sections.move(this.selected, this.selected - 1), "Moved.", -1), has && this.selected > 0),
      btn("↓", "Move down", () => this.structural(() => this.api.document.sections.move(this.selected, this.selected + 1), "Moved.", 1), has && this.selected < this.infos.length - 1),
      btn("Export", "Download this section's bytes", () => this.exportSection(), has),
      btn("Import…", "Replace this section's bytes with a file's (then Apply)", () => void this.importSection(), has),
    );
  }

  private renderHeader() {
    const s = this.infos[this.selected];
    const buf = this.buffer();
    if (!s || !buf) { this.insp.setHeader(null); return; }
    const ctx = this.ctx();
    this.insp.setHeader({
      name: s.name,
      what: s.spec?.what ?? "unknown section",
      doc: SECTION_DOCS[s.name] ?? null,
      size: buf.length,
      expected: s.spec?.size ?? expectedSize(s.name, ctx),
      recordSize: recordSize(s.name),
      mode: s.spec ? `${s.spec.mode} on repeat` : "unknown",
      occurrence: s.occurrences > 1 ? `occurrence ${s.occurrence + 1} of ${s.occurrences}` : null,
      modelled: s.spec?.modelled ?? false,
      dirty: s.dirty,
    });
  }

  private renderHexHead() {
    clear(this.hexHead);
    const s = this.infos[this.selected];
    const buf = this.buffer();
    if (!s || !buf) { this.hexHead.append(h("b", null, "Bytes")); return; }
    this.hexHead.append(h("b", { className: "sx-mono" }, s.name), h("span", { className: "sx-dim" }, ` at ${hex(s.offset)}`), h("span", { className: "sx-grow" }));
    const stride = recordSize(s.name);
    if (stride) {
      const at = () => Math.floor(this.hex.cursor / stride) * stride;
      this.hexHead.append(
        h("button", { className: "sx-btn small", title: `Insert a blank ${stride}-byte record before the one under the cursor`, onclick: () => { const b = this.buffer(); if (!b) return; const where = b.length ? at() : 0; b.insert(where, blankRecord(s.name)!); this.hex.setCursor(where); this.status(`Inserted a blank record at ${hex(where)}.`); } }, "Insert record"),
        h("button", { className: "sx-btn small", title: "Append a blank record at the end", onclick: () => { const b = this.buffer(); if (!b) return; const where = b.length; b.insert(where, blankRecord(s.name)!); this.hex.setCursor(where); } }, "Append"),
        h("button", { className: "sx-btn small", title: "Remove the record under the cursor", onclick: () => { const b = this.buffer(); if (!b || b.length < stride) return; const where = at(); b.remove(where, stride); this.hex.setCursor(Math.min(where, Math.max(0, b.length - 1))); this.status(`Removed the record at ${hex(where)}.`); } }, "Delete record"),
      );
    } else {
      const expected = s.spec?.size ?? expectedSize(s.name, this.ctx());
      if (expected !== null && expected !== buf.length) {
        this.hexHead.append(h("button", { className: "sx-btn small", title: `Pad with zeros or cut to ${fmt(expected)} bytes`, onclick: () => { this.buffer()?.resize(expected); this.status(`Resized to ${fmt(expected)} bytes.`); } }, `Fit to ${fmt(expected)}`));
      }
    }
    const sizeBox = h("input", { type: "text", value: String(buf.length), style: "width: 70px", title: "Set the section's length (zero-padded or cut); Enter applies" }) as HTMLInputElement;
    sizeBox.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Enter") { e.preventDefault(); const n = Number(sizeBox.value); if (Number.isInteger(n) && n >= 0 && n <= 64 * 1024 * 1024) { this.buffer()?.resize(n); } else sizeBox.value = String(this.buffer()?.length ?? 0); } });
    this.hexHead.append(h("span", { className: "sx-dim", style: "font-size:11px" }, "length"), sizeBox);
  }

  private updateStatus() {
    clear(this.statusLine);
    const buf = this.buffer();
    if (!buf) return;
    const sel = this.hex.selection;
    const piece = (k: string, v: string) => h("span", null, `${k} `, h("span", { className: "sx-mono" }, v));
    this.statusLine.append(
      piece("offset", `${hex(this.hex.cursor)} (${this.hex.cursor})`),
      sel ? piece("selected", `${hex(sel.from)}–${hex(sel.to - 1)} (${fmt(sel.to - sel.from)})`) : "",
      piece("typing in", this.hex.column === "hex" ? "hex" : "text"),
      piece("mode", this.hex.insertMode ? "insert" : "overwrite"),
      buf.modified ? h("span", { className: "sx-teal" }, "changed — not applied") : h("span", { className: "sx-faint" }, "unchanged"),
    );
    this.undoBtn.disabled = !buf.canUndo;
    this.redoBtn.disabled = !buf.canRedo;
    const pending = [...this.buffers.values()].some((b) => b.modified);
    this.applyBtn.disabled = !pending;
    this.revertBtn.disabled = !pending;
    this.applyBtn.textContent = pending ? `Apply (${[...this.buffers.values()].filter((b) => b.modified).length})` : "Apply";
  }

  /* ── Applying ─────────────────────────────────────────── */

  /** Write every changed buffer into the map. Sections keep their indices across writes, so the order is free. */
  private apply(): number {
    const changed = [...this.buffers.entries()].filter(([, b]) => b.modified);
    if (changed.length === 0) { this.status("Nothing to apply."); return 0; }
    this.applying = true;
    const warnings: string[] = [];
    try {
      for (const [index, buf] of changed) {
        const r = this.api.document.sections.write(index, buf.bytes);
        warnings.push(...r.warnings);
      }
    } catch (err) {
      this.status(`Apply failed: ${err instanceof Error ? err.message : String(err)}`);
      this.applying = false;
      return 0;
    }
    this.applying = false;
    this.reload("structure");
    this.status(`Applied ${changed.length} section${changed.length === 1 ? "" : "s"}.${warnings.length ? ` The parser said: ${warnings.join(" ")}` : ""}`);
    return changed.length;
  }

  /** A structural edit: pending changes go in first, then the operation, then everything is read again. */
  private structural(op: () => { warnings: string[] }, done: string, moves = 0) {
    if (this.selected < 0) return;
    const before = this.selected;
    if ([...this.buffers.values()].some((b) => b.modified)) this.apply();
    this.applying = true;
    try {
      const r = op();
      this.applying = false;
      this.selected = Math.max(0, before + moves);
      this.reload("structure");
      this.status(`${done}${r.warnings.length ? ` The parser said: ${r.warnings.join(" ")}` : ""}`);
    } catch (err) {
      this.applying = false;
      this.reload("structure");
      this.status(`Failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /* ── Forms ────────────────────────────────────────────── */

  private form(build: (close: () => void) => HTMLElement) {
    const existing = this.listBody.querySelector(".sx-modal");
    existing?.remove();
    const box = h("div", { className: "sx-modal" });
    const close = () => box.remove();
    box.append(build(close));
    this.listBody.prepend(box);
    (box.querySelector("input, select") as HTMLElement | null)?.focus();
  }

  private addForm() {
    this.form((close) => {
      const known = knownLayouts().concat(this.api.document.sections.known().map((k) => k.name).filter((n) => !(n in SECTION_DOCS)));
      const pick = h("select") as HTMLSelectElement;
      pick.append(h("option", { value: "" }, "custom name…"));
      for (const n of known) pick.append(h("option", { value: n }, `${n.trimEnd()} — ${this.api.document.sections.spec(n)?.what ?? SECTION_DOCS[n]?.slice(0, 40) ?? ""}`));
      const name = h("input", { type: "text", maxlength: 4, placeholder: "NAME", spellcheck: false, style: "width: 64px" }) as HTMLInputElement;
      const size = h("input", { type: "text", value: "0", style: "width: 80px" }) as HTMLInputElement;
      const where = h("select", null, h("option", { value: "end" }, "at the end"), h("option", { value: "before" }, "before the selected one"), h("option", { value: "after" }, "after the selected one")) as HTMLSelectElement;
      const fill = h("select", null, h("option", { value: "zero" }, "zeros"), h("option", { value: "game" }, "what the game reads now (repeats combined)")) as HTMLSelectElement;
      pick.addEventListener("change", () => {
        if (!pick.value) return;
        name.value = pick.value;
        const spec = this.api.document.sections.spec(pick.value);
        const exp = spec?.size ?? expectedSize(pick.value, this.ctx());
        size.value = String(exp ?? 0);
      });
      const stop = (e: KeyboardEvent) => e.stopPropagation();
      for (const el of [pick, name, size, where, fill]) el.addEventListener("keydown", stop as EventListener);
      const insert = () => {
        const n = name.value.padEnd(4, " ");
        if (n.trim().length === 0 || n.length > 4) { this.status("A section name is one to four characters."); return; }
        let bytes: Uint8Array;
        if (fill.value === "game") bytes = this.api.document.sections.combined(n) ?? new Uint8Array(Number(size.value) || 0);
        else { const len = Number(size.value); if (!Number.isInteger(len) || len < 0) { this.status("The size is a whole number of bytes."); return; } bytes = new Uint8Array(len); }
        const at = where.value === "end" || this.selected < 0 ? this.infos.length : where.value === "before" ? this.selected : this.selected + 1;
        close();
        this.structural(() => this.api.document.sections.insert(at, n, bytes), `Added ${n.trimEnd()} (${fmt(bytes.length)} bytes).`, at - this.selected);
      };
      return h("div", null,
        h("div", { className: "sx-frow" }, h("label", null, "section"), pick),
        h("div", { className: "sx-frow" }, h("label", null, "name"), name),
        h("div", { className: "sx-frow" }, h("label", null, "size"), size),
        h("div", { className: "sx-frow" }, h("label", null, "contents"), fill),
        h("div", { className: "sx-frow" }, h("label", null, "position"), where),
        h("div", { className: "sx-bar" }, h("button", { className: "sx-btn small primary", onclick: insert }, "Add"), h("button", { className: "sx-btn small", onclick: close }, "Cancel")),
      );
    });
  }

  private renameForm(index: number) {
    const s = this.infos[index];
    if (!s) return;
    this.form((close) => {
      const name = h("input", { type: "text", maxlength: 4, value: s.name, spellcheck: false, style: "width: 64px" }) as HTMLInputElement;
      name.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Enter") go(); if (e.key === "Escape") { e.preventDefault(); close(); } });
      const go = () => {
        const n = name.value;
        if (n.trim().length === 0 || n.length > 4) { this.status("A section name is one to four characters."); return; }
        close();
        this.selected = index;
        this.structural(() => this.api.document.sections.rename(index, n), `Renamed to ${n.padEnd(4, " ").trimEnd()}.`);
      };
      return h("div", null,
        h("div", { className: "sx-frow" }, h("label", null, "rename"), name),
        h("div", { className: "sx-bar" }, h("button", { className: "sx-btn small primary", onclick: go }, "Rename"), h("button", { className: "sx-btn small", onclick: close }, "Cancel")),
      );
    });
  }

  /* ── Files ────────────────────────────────────────────── */

  private download(bytes: Uint8Array, name: string) {
    const url = URL.createObjectURL(new Blob([bytes as unknown as BlobPart], { type: "application/octet-stream" }));
    const a = h("a", { href: url, download: name });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  private exportSection() {
    const s = this.infos[this.selected];
    const buf = this.buffer();
    if (!s || !buf) return;
    this.download(buf.bytes, `${s.name.trim() || "section"}${s.occurrences > 1 ? `-${s.occurrence + 1}` : ""}.bin`);
    this.status(`Exported ${fmt(buf.length)} bytes.`);
  }

  private async importSection() {
    const buf = this.buffer();
    if (!buf) return;
    const [file] = await this.api.ui.pickFiles({ accept: ".bin,.chk,*/*" });
    if (!file) return;
    buf.replace(new Uint8Array(await file.arrayBuffer()));
    this.hex.setCursor(0);
    this.status(`Read ${fmt(buf.length)} bytes from ${file.name} — Apply to keep them.`);
  }

  private exportFile() {
    const info = this.api.document.info();
    const bytes = this.api.document.sections.file();
    this.download(bytes, `${(info?.fileName ?? info?.name ?? "scenario").replace(/\.(scx|scm|chk)$/i, "")}.chk`);
    this.status(`Exported ${fmt(bytes.length)} bytes.`);
  }

  private async importFile() {
    const [file] = await this.api.ui.pickFiles({ accept: ".chk" });
    if (!file) return;
    const bytes = new Uint8Array(await file.arrayBuffer());
    this.applying = true;
    try {
      const r = this.api.document.sections.replaceFile(bytes);
      this.applying = false;
      this.selected = 0;
      this.reload("structure");
      this.status(`Replaced the scenario with ${file.name}.${r.warnings.length ? ` The parser said: ${r.warnings.join(" ")}` : ""}`);
    } catch (err) {
      this.applying = false;
      this.status(`Could not read ${file.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

export type { Range };
