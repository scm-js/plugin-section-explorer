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
 * `@scm-js/plugin-api` is the editor's type declarations, a devDependency generated from
 * its own `src/plugins/api.ts`; the host erases the type-only import.
 */
import type { DialogHandle, PluginApi, SectionInfo } from "@scm-js/plugin-api";
import { EditBuffer } from "./buffer";
import { clear, h, STYLE } from "./dom";
import { HexView, type Range } from "./hexview";
import { Inspector } from "./inspector";
import type { Ctx, Node } from "./layout";
import { bindLanguage, msg, t, translate } from "./i18n";
import { KO } from "./ko";
import { blankRecord, expectedSize, knownLayouts, recordSize, SECTION_DOCS, sectionLayout } from "./layouts";

export default function activate(api: PluginApi) {
  api.i18n.register({ ko: KO });
  bindLanguage(api);
  let explorer: Explorer | null = null;
  const open = () => {
    if (!api.document.isOpen()) { api.ui.status(t("Section Explorer: open a map first.")); return; }
    if (explorer?.isOpen()) return;
    explorer = new Explorer(api);
    explorer.open();
  };
  // Menu labels and command titles go to the editor in English; it shows them in the reader's language.
  api.commands.register({ id: "open", title: msg("Section Explorer…"), enabled: () => api.document.isOpen(), run: open });
  api.menu.add("Tools", { label: msg("Section Explorer…"), shortcut: "Ctrl+Shift+H", enabled: () => api.document.isOpen(), command: "open" });
  api.hotkeys.add("Ctrl+Shift+H", { command: "open" });
  api.events.on("language", () => explorer?.relabel());
  return () => { explorer?.close(); };
}

/* ── The explorer ───────────────────────────────────────── */

const fmt = (n: number) => n.toLocaleString();
const hex = (n: number) => `0x${n.toString(16)}`;
/** `unit 3`, `sprite 0`, `location 12`: a record of something on the map. */
const thing = (kind: "unit" | "sprite" | "location", n: number) =>
  kind === "unit" ? t("unit {n}", { n }) : kind === "sprite" ? t("sprite {n}", { n }) : t("location {n}", { n });
/** The editor's parser warnings after a write, which come in its own words. */
const parserSaid = (warnings: string[]) => (warnings.length ? ` ${t("The parser said: {warnings}", { warnings: warnings.join(" ") })}` : "");

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
  /** Unapplied edits carried across a rebuild of the dialog (a language change). */
  private carry: { buffers: Map<number, EditBuffer>; selected: number } | null = null;
  private api: PluginApi;

  constructor(api: PluginApi) { this.api = api; }

  isOpen() { return this.handle?.isOpen() ?? false; }
  close() { this.handle?.close(); }

  /** Build the dialog again in the new language, keeping the section and the unapplied edits. */
  relabel() {
    if (!this.isOpen()) return;
    this.carry = { buffers: new Map(this.buffers), selected: this.selected };
    this.handle?.close();
    this.open();
  }

  open() {
    this.handle = this.api.ui.dialog({
      title: t("Section Explorer"),
      size: "full",
      tall: true,
      mount: (body, handle) => this.mount(body, handle),
      buttons: [
        { label: t("Apply"), primary: true, closes: false, run: () => { this.apply(); return false; } },
        { label: t("Close"), run: () => this.tryClose() },
      ],
      onPaste: (transfer) => {
        if (!transfer.text || this.selected < 0) return;
        const n = this.hex.paste(transfer.text);
        this.status(n ? t("Pasted {n, plural, one {# byte} other {# bytes}}.", { n }) : t("Nothing to paste — hex digits in the byte column, text in the text column."));
      },
    });
  }

  private tryClose(): boolean {
    const pending = [...this.buffers.values()].filter((b) => b.modified).length;
    if (pending === 0 || this.closeArmed) return true;
    this.closeArmed = true;
    this.status(t("{n, plural, one {# section has} other {# sections have}} changes you have not applied — Apply, Revert, or press Close again to drop them.", { n: pending }));
    return false;
  }

  /* ── Mount ────────────────────────────────────────────── */

  private mount(body: HTMLElement, handle: DialogHandle): () => void {
    this.handle = handle;
    const root = h("div", { className: "sx" });
    root.append(h("style", null, STYLE));

    this.summary = h("span", { className: "sx-dim" });
    this.undoBtn = h("button", { className: "sx-btn small", title: t("Undo (Ctrl+Z in the hex view)"), onclick: () => this.buffer()?.undo() }, t("Undo")) as HTMLButtonElement;
    this.redoBtn = h("button", { className: "sx-btn small", title: t("Redo (Ctrl+Y)"), onclick: () => this.buffer()?.redo() }, t("Redo")) as HTMLButtonElement;
    this.insertTick = h("input", { type: "checkbox", title: t("Insert mode: typed and pasted bytes are inserted rather than overwritten; Delete removes bytes. Also the Insert key.") }) as HTMLInputElement;
    this.insertTick.addEventListener("change", () => { this.hex.insertMode = this.insertTick.checked; this.updateStatus(); });
    this.applyBtn = h("button", { className: "sx-btn primary small", title: t("Write every changed section into the map"), onclick: () => this.apply() }, t("Apply")) as HTMLButtonElement;
    this.revertBtn = h("button", { className: "sx-btn small", title: t("Drop every change and read the sections again"), onclick: () => this.reload("revert") }, t("Revert")) as HTMLButtonElement;
    const bar = h("div", { className: "sx-bar" },
      this.summary, h("span", { className: "sx-grow" }),
      h("button", { className: "sx-btn small", title: t("Download the scenario file as Save would write it (scenario.chk, no archive)"), onclick: () => this.exportFile() }, t("Export .chk")),
      h("button", { className: "sx-btn small", title: t("Replace the whole scenario with a .chk file"), onclick: () => void this.importFile() }, t("Import .chk…")),
      h("span", { className: "sx-sep" }),
      this.undoBtn, this.redoBtn,
      h("span", { className: "sx-sep" }),
      h("label", { className: "sx-check" }, this.insertTick, t("Insert mode")),
      h("span", { className: "sx-sep" }),
      this.revertBtn, this.applyBtn,
    );

    // Sections.
    this.filter = h("input", { type: "text", placeholder: t("filter"), spellcheck: false, style: "width: 90px" }) as HTMLInputElement;
    this.filter.addEventListener("input", () => this.renderList());
    this.filter.addEventListener("keydown", (e) => e.stopPropagation());
    this.listBody = h("div", { className: "sx-pane-body sx-sections" });
    this.listFoot = h("div", { className: "sx-pane-foot" });
    const sections = h("div", { className: "sx-pane" }, h("div", { className: "sx-pane-head" }, h("b", null, t("Sections")), h("span", { className: "sx-grow" }), this.filter), this.listBody, this.listFoot);

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
    const carried = this.carry;
    this.carry = null;
    if (carried && carried.selected < this.infos.length) {
      for (const [index, buf] of carried.buffers) if (index < this.infos.length) this.buffers.set(index, buf);
      this.select(carried.selected);
    } else {
      const remembered = this.api.storage.get<string | null>("lastSection", null);
      const first = remembered ? this.infos.findIndex((s) => s.name === remembered) : -1;
      this.select(first >= 0 ? first : this.infos.length ? 0 : -1);
    }
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

  private status(text: string) { this.api.ui.status(t("Section Explorer: {text}", { text })); }

  /** Read the section list again from the document (after Apply, Revert, a structural edit, or a map change). */
  private reload(reason: "open" | "revert" | "document" | "structure") {
    const keep = this.selected;
    this.infos = this.api.document.sections.list();
    this.buffers.clear();
    this.layoutFor = null;
    this.closeArmed = false;
    if (reason === "revert") this.status(t("Reverted — every section read again from the map."));
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
      h("b", { className: "sx-gold" }, info?.name || t("Untitled")),
      ` — ${t("{bytes} bytes, {n, plural, one {# section} other {# sections}}", { bytes: fmt(total), n: this.infos.length })}`,
      repeats ? `, ${t("{n} repeated", { n: repeats })}` : "", unknown ? `, ${t("{n} unknown", { n: unknown })}` : "",
      info?.fileName ? h("span", { className: "sx-faint" }, ` · ${info.fileName}`) : "",
    );
  }

  private renderList() {
    clear(this.listBody);
    const q = this.filter.value.trim().toLowerCase();
    for (const s of this.infos) {
      const what = s.spec?.what ?? t("unknown section");
      if (q && !s.name.toLowerCase().includes(q) && !what.toLowerCase().includes(q)) continue;
      const buf = this.buffers.get(s.index);
      const badges = h("span", { className: "sx-badges" });
      if (!s.spec) badges.append(h("span", { className: "sx-badge unknown", title: t("The editor knows nothing about this section") }, "?"));
      else if (!s.spec.modelled) badges.append(h("span", { className: "sx-badge raw", title: t("Kept as bytes and written back unchanged") }, t("raw")));
      if (s.dirty) badges.append(h("span", { className: "sx-badge dirty", title: t("The editor has unsaved changes that will be encoded here on Save") }, t("unsaved")));
      if (buf?.modified) badges.append(h("span", { className: "sx-badge edited", title: t("Changed here and not yet applied") }, t("edited")));
      if (s.occurrences > 1) badges.append(h("span", { className: "sx-badge repeat", title: t("Occurrence {n} of {count}; the game combines them ({mode})", { n: s.occurrence + 1, count: s.occurrences, mode: s.spec?.mode ?? t("last wins") }) }, `${s.occurrence + 1}/${s.occurrences}`));
      const expected = s.spec?.size ?? null;
      if (s.truncated) badges.append(h("span", { className: "sx-badge warn", title: t("Declares {n} bytes but the file ended early", { n: s.declaredSize }) }, t("cut")));
      else if (expected !== null && expected !== (buf?.length ?? s.size)) badges.append(h("span", { className: "sx-badge warn", title: t("The game reads {n} bytes here", { n: fmt(expected) }) }, t("size")));
      const row = h("div", { className: `sx-row${s.index === this.selected ? " on" : ""}`, title: t("{name} at {offset} — {what}", { name: s.name, offset: hex(s.offset), what }) },
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
      btn(t("Add…"), t("Insert a new section"), () => this.addForm()),
      btn(t("Remove"), t("Remove this occurrence from the file"), () => { void this.confirmRemove(); }, has),
      btn(t("Rename…"), t("Change the four-character name"), () => this.renameForm(this.selected), has),
      btn("↑", t("Move up"), () => this.structural(() => this.api.document.sections.move(this.selected, this.selected - 1), t("Moved."), -1), has && this.selected > 0),
      btn("↓", t("Move down"), () => this.structural(() => this.api.document.sections.move(this.selected, this.selected + 1), t("Moved."), 1), has && this.selected < this.infos.length - 1),
      btn(t("Export"), t("Download this section's bytes"), () => this.exportSection(), has),
      btn(t("Import…"), t("Replace this section's bytes with a file's (then Apply)"), () => void this.importSection(), has),
    );
  }

  private renderHeader() {
    const s = this.infos[this.selected];
    const buf = this.buffer();
    if (!s || !buf) { this.insp.setHeader(null); return; }
    const ctx = this.ctx();
    this.insp.setHeader({
      name: s.name,
      what: s.spec?.what ?? t("unknown section"),
      doc: SECTION_DOCS[s.name] ? translate(SECTION_DOCS[s.name]) : null,
      size: buf.length,
      expected: s.spec?.size ?? expectedSize(s.name, ctx),
      recordSize: recordSize(s.name),
      mode: s.spec ? t("{mode} on repeat", { mode: s.spec.mode }) : t("unknown"),
      occurrence: s.occurrences > 1 ? t("occurrence {n} of {count}", { n: s.occurrence + 1, count: s.occurrences }) : null,
      modelled: s.spec?.modelled ?? false,
      dirty: s.dirty,
    });
  }

  /** Sections whose records are things on the map, and what `view.goTo` calls them. */
  private static readonly GO_TO: Record<string, "unit" | "sprite" | "location"> = { "UNIT": "unit", "THG2": "sprite", "MRGN": "location" };

  private renderHexHead() {
    clear(this.hexHead);
    const s = this.infos[this.selected];
    const buf = this.buffer();
    if (!s || !buf) { this.hexHead.append(h("b", null, t("Bytes"))); return; }
    this.hexHead.append(h("b", { className: "sx-mono" }, s.name), h("span", { className: "sx-dim" }, ` ${t("at {offset}", { offset: hex(s.offset) })}`), h("span", { className: "sx-grow" }));
    const stride = recordSize(s.name);
    if (stride) {
      const at = () => Math.floor(this.hex.cursor / stride) * stride;
      this.hexHead.append(
        h("button", { className: "sx-btn small", title: t("Insert a blank {n}-byte record before the one under the cursor", { n: stride }), onclick: () => { const b = this.buffer(); if (!b) return; const where = b.length ? at() : 0; b.insert(where, blankRecord(s.name)!); this.hex.setCursor(where); this.status(t("Inserted a blank record at {offset}.", { offset: hex(where) })); } }, t("Insert record")),
        h("button", { className: "sx-btn small", title: t("Append a blank record at the end"), onclick: () => { const b = this.buffer(); if (!b) return; const where = b.length; b.insert(where, blankRecord(s.name)!); this.hex.setCursor(where); } }, t("Append")),
        h("button", { className: "sx-btn small", title: t("Remove the record under the cursor"), onclick: () => { const b = this.buffer(); if (!b || b.length < stride) return; const where = at(); b.remove(where, stride); this.hex.setCursor(Math.min(where, Math.max(0, b.length - 1))); this.status(t("Removed the record at {offset}.", { offset: hex(where) })); } }, t("Delete record")),
      );
      // A record of something the map draws: take the view to it, so a row of bytes can be
      // checked against the thing itself. Only what is actually in the document — an
      // unapplied record has no counterpart on the map yet.
      const kind = Explorer.GO_TO[s.name];
      if (kind) {
        const index = Math.floor(this.hex.cursor / stride);
        this.hexHead.append(h("button", {
          className: "sx-btn small",
          title: t("Scroll the map to {target} and select it", { target: thing(kind, index) }),
          onclick: () => {
            this.api.view.goTo({ kind, index });
            this.status(t("Went to {target}.", { target: thing(kind, index) }));
          },
        }, t("Show on map")));
      }
    } else {
      const expected = s.spec?.size ?? expectedSize(s.name, this.ctx());
      if (expected !== null && expected !== buf.length) {
        this.hexHead.append(h("button", { className: "sx-btn small", title: t("Pad with zeros or cut to {n} bytes", { n: fmt(expected) }), onclick: () => { this.buffer()?.resize(expected); this.status(t("Resized to {n} bytes.", { n: fmt(expected) })); } }, t("Fit to {n}", { n: fmt(expected) })));
      }
    }
    const sizeBox = h("input", { type: "text", value: String(buf.length), style: "width: 70px", title: t("Set the section's length (zero-padded or cut); Enter applies") }) as HTMLInputElement;
    sizeBox.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Enter") { e.preventDefault(); const n = Number(sizeBox.value); if (Number.isInteger(n) && n >= 0 && n <= 64 * 1024 * 1024) { this.buffer()?.resize(n); } else sizeBox.value = String(this.buffer()?.length ?? 0); } });
    this.hexHead.append(h("span", { className: "sx-dim", style: "font-size:11px" }, t("length")), sizeBox);
  }

  private updateStatus() {
    clear(this.statusLine);
    const buf = this.buffer();
    if (!buf) return;
    const sel = this.hex.selection;
    const piece = (k: string, v: string) => h("span", null, `${k} `, h("span", { className: "sx-mono" }, v));
    this.statusLine.append(
      piece(t("offset"), `${hex(this.hex.cursor)} (${this.hex.cursor})`),
      sel ? piece(t("selected"), `${hex(sel.from)}–${hex(sel.to - 1)} (${fmt(sel.to - sel.from)})`) : "",
      piece(t("typing in"), this.hex.column === "hex" ? t("hex") : t("text")),
      piece(t("mode"), this.hex.insertMode ? t("insert") : t("overwrite")),
      buf.modified ? h("span", { className: "sx-teal" }, t("changed — not applied")) : h("span", { className: "sx-faint" }, t("unchanged")),
    );
    this.undoBtn.disabled = !buf.canUndo;
    this.redoBtn.disabled = !buf.canRedo;
    const pending = [...this.buffers.values()].some((b) => b.modified);
    this.applyBtn.disabled = !pending;
    this.revertBtn.disabled = !pending;
    this.applyBtn.textContent = pending ? t("Apply ({n})", { n: [...this.buffers.values()].filter((b) => b.modified).length }) : t("Apply");
  }

  /* ── Applying ─────────────────────────────────────────── */

  /** Write every changed buffer into the map. Sections keep their indices across writes, so the order is free. */
  private apply(): number {
    const changed = [...this.buffers.entries()].filter(([, b]) => b.modified);
    if (changed.length === 0) { this.status(t("Nothing to apply.")); return 0; }
    this.applying = true;
    const warnings: string[] = [];
    try {
      for (const [index, buf] of changed) {
        const r = this.api.document.sections.write(index, buf.bytes);
        warnings.push(...r.warnings);
      }
    } catch (err) {
      this.status(t("Apply failed: {error}", { error: err instanceof Error ? err.message : String(err) }));
      this.applying = false;
      return 0;
    }
    this.applying = false;
    this.reload("structure");
    this.status(`${t("Applied {n, plural, one {# section} other {# sections}}.", { n: changed.length })}${parserSaid(warnings)}`);
    return changed.length;
  }

  /**
   * Removing a section rewrites the file and drops the editor's undo history with it, so
   * unlike every other edit here it cannot be taken back. Ask, and say what the game does
   * without the section.
   */
  private async confirmRemove() {
    const s = this.infos[this.selected];
    if (!s) return;
    const modelled = s.spec?.modelled ? t("The editor models this section: removing it changes what the map is.") : "";
    const ok = await this.api.ui.confirm(
      [t("Remove {name} ({n} bytes) from the file?", { name: s.name, n: fmt(s.size) }), modelled, t("This rewrites the map and clears the undo history — there is no taking it back.")].filter(Boolean).join("\n\n"),
      { title: t("Remove {name}", { name: s.name }), confirmLabel: t("Remove"), danger: true },
    );
    if (!ok) { this.status(t("Kept the section.")); return; }
    this.structural(() => this.api.document.sections.remove(this.selected), t("Removed the section."));
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
      this.status(`${done}${parserSaid(r.warnings)}`);
    } catch (err) {
      this.applying = false;
      this.reload("structure");
      this.status(t("Failed: {error}", { error: err instanceof Error ? err.message : String(err) }));
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
      pick.append(h("option", { value: "" }, t("custom name…")));
      for (const n of known) pick.append(h("option", { value: n }, `${n.trimEnd()} — ${this.api.document.sections.spec(n)?.what ?? (SECTION_DOCS[n] ? translate(SECTION_DOCS[n]).slice(0, 40) : "")}`));
      const name = h("input", { type: "text", maxlength: 4, placeholder: "NAME", spellcheck: false, style: "width: 64px" }) as HTMLInputElement;
      const size = h("input", { type: "text", value: "0", style: "width: 80px" }) as HTMLInputElement;
      const where = h("select", null, h("option", { value: "end" }, t("at the end")), h("option", { value: "before" }, t("before the selected one")), h("option", { value: "after" }, t("after the selected one"))) as HTMLSelectElement;
      const fill = h("select", null, h("option", { value: "zero" }, t("zeros")), h("option", { value: "game" }, t("what the game reads now (repeats combined)"))) as HTMLSelectElement;
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
        if (n.trim().length === 0 || n.length > 4) { this.status(t("A section name is one to four characters.")); return; }
        let bytes: Uint8Array;
        if (fill.value === "game") bytes = this.api.document.sections.combined(n) ?? new Uint8Array(Number(size.value) || 0);
        else { const len = Number(size.value); if (!Number.isInteger(len) || len < 0) { this.status(t("The size is a whole number of bytes.")); return; } bytes = new Uint8Array(len); }
        const at = where.value === "end" || this.selected < 0 ? this.infos.length : where.value === "before" ? this.selected : this.selected + 1;
        close();
        this.structural(() => this.api.document.sections.insert(at, n, bytes), t("Added {name} ({n} bytes).", { name: n.trimEnd(), n: fmt(bytes.length) }), at - this.selected);
      };
      return h("div", null,
        h("div", { className: "sx-frow" }, h("label", null, t("section")), pick),
        h("div", { className: "sx-frow" }, h("label", null, t("name")), name),
        h("div", { className: "sx-frow" }, h("label", null, t("size")), size),
        h("div", { className: "sx-frow" }, h("label", null, t("contents")), fill),
        h("div", { className: "sx-frow" }, h("label", null, t("position")), where),
        h("div", { className: "sx-bar" }, h("button", { className: "sx-btn small primary", onclick: insert }, t("Add")), h("button", { className: "sx-btn small", onclick: close }, t("Cancel"))),
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
        if (n.trim().length === 0 || n.length > 4) { this.status(t("A section name is one to four characters.")); return; }
        close();
        this.selected = index;
        this.structural(() => this.api.document.sections.rename(index, n), t("Renamed to {name}.", { name: n.padEnd(4, " ").trimEnd() }));
      };
      return h("div", null,
        h("div", { className: "sx-frow" }, h("label", null, t("rename")), name),
        h("div", { className: "sx-bar" }, h("button", { className: "sx-btn small primary", onclick: go }, t("Rename")), h("button", { className: "sx-btn small", onclick: close }, t("Cancel"))),
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
    this.status(t("Exported {n} bytes.", { n: fmt(buf.length) }));
  }

  private async importSection() {
    const buf = this.buffer();
    if (!buf) return;
    const [file] = await this.api.ui.pickFiles({ accept: ".bin,.chk,*/*" });
    if (!file) return;
    buf.replace(new Uint8Array(await file.arrayBuffer()));
    this.hex.setCursor(0);
    this.status(t("Read {n} bytes from {file} — Apply to keep them.", { n: fmt(buf.length), file: file.name }));
  }

  private exportFile() {
    const info = this.api.document.info();
    const bytes = this.api.document.sections.file();
    this.download(bytes, `${(info?.fileName ?? info?.name ?? "scenario").replace(/\.(scx|scm|chk)$/i, "")}.chk`);
    this.status(t("Exported {n} bytes.", { n: fmt(bytes.length) }));
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
      this.status(`${t("Replaced the scenario with {file}.", { file: file.name })}${parserSaid(r.warnings)}`);
    } catch (err) {
      this.applying = false;
      this.status(t("Could not read {file}: {error}", { file: file.name, error: err instanceof Error ? err.message : String(err) }));
    }
  }
}

export type { Range };
