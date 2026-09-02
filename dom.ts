/**
 * A small element builder and the explorer's stylesheet. The dialog is plain DOM; the
 * styles are scoped under `.sx` and lean on the editor's design tokens with fallbacks.
 */

export type Child = Node | string | null | undefined | false;

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> | null = null, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === "className") el.className = String(v);
      else if (k === "style") el.setAttribute("style", String(v));
      else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
      else if (k in el && typeof v !== "string") (el as unknown as Record<string, unknown>)[k] = v;
      else el.setAttribute(k, String(v));
    }
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(typeof c === "string" ? document.createTextNode(c) : c);
  return el;
}

export function clear(el: HTMLElement) {
  while (el.firstChild) el.removeChild(el.firstChild);
}

export const STYLE = `
.sx { display: flex; flex-direction: column; gap: 6px; height: 100%; min-height: 0; font-size: 12px; color: var(--text, #dde2ea); user-select: none; }
.sx * { box-sizing: border-box; }
.sx button { font: inherit; }
.sx input, .sx select { font: inherit; color: inherit; background: var(--bg-0, #0a0c10); border: 1px solid var(--border, #2c3341); border-radius: 3px; padding: 2px 5px; min-height: 22px; }
.sx input:focus, .sx select:focus, .sx .sx-hexscroll:focus { outline: none; box-shadow: var(--focus, 0 0 0 1px #4fd1c5); }
.sx .sx-mono { font-family: var(--font-mono, ui-monospace, Consolas, Menlo, monospace); }
.sx .sx-dim { color: var(--text-dim, #99a2b3); }
.sx .sx-faint { color: var(--text-faint, #5d6675); }
.sx .sx-warn { color: var(--warn, #e0a545); }
.sx .sx-danger { color: var(--danger, #d9534f); }
.sx .sx-ok { color: var(--ok, #5cb85c); }
.sx .sx-gold { color: var(--gold, #e6b95c); }
.sx .sx-teal { color: var(--teal, #4fd1c5); }

.sx .sx-bar { display: flex; align-items: center; gap: 6px; flex: none; flex-wrap: wrap; }
.sx .sx-bar .sx-grow { flex: 1; }
.sx .sx-bar .sx-sep { width: 1px; height: 18px; background: var(--border, #2c3341); margin: 0 3px; }
.sx .sx-btn { padding: 2px 8px; min-height: 22px; border: 1px solid var(--border, #2c3341); border-radius: 3px; background: var(--bg-3, #222732); color: var(--text, #dde2ea); cursor: pointer; white-space: nowrap; }
.sx .sx-btn:hover { background: var(--bg-4, #2b313e); }
.sx .sx-btn:disabled { opacity: .45; cursor: default; }
.sx .sx-btn.primary { background: var(--teal-dim, #2c8a83); border-color: var(--teal, #4fd1c5); color: #fff; }
.sx .sx-btn.primary:hover { background: var(--teal, #4fd1c5); color: #06211f; }
.sx .sx-btn.small { padding: 0 6px; min-height: 20px; font-size: 11px; }
.sx .sx-check { display: inline-flex; align-items: center; gap: 4px; white-space: nowrap; }

.sx .sx-main { display: grid; grid-template-columns: 230px minmax(0, 1fr) 320px; gap: 6px; flex: 1; min-height: 0; }
.sx .sx-pane { display: flex; flex-direction: column; min-height: 0; min-width: 0; border: 1px solid var(--border, #2c3341); border-radius: 4px; background: var(--bg-1, #12151b); }
.sx .sx-pane-head { display: flex; align-items: center; gap: 6px; padding: 4px 6px; border-bottom: 1px solid var(--border, #2c3341); background: var(--bg-2, #191d25); flex: none; min-height: 28px; }
.sx .sx-pane-head b { color: var(--gold, #e6b95c); font-weight: 600; }
.sx .sx-pane-body { flex: 1; min-height: 0; overflow: auto; }
.sx .sx-pane-foot { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; padding: 4px 6px; border-top: 1px solid var(--border, #2c3341); flex: none; }

/* section list */
.sx .sx-sections .sx-row { display: grid; grid-template-columns: 44px 1fr auto; align-items: center; gap: 6px; padding: 3px 6px; cursor: pointer; border-bottom: 1px solid rgba(255,255,255,.03); }
.sx .sx-sections .sx-row:hover { background: var(--bg-3, #222732); }
.sx .sx-sections .sx-row.on { background: var(--sel, #2b4f80); }
.sx .sx-sections .sx-row .sx-name { font-family: var(--font-mono, monospace); color: var(--gold-hi, #f4d08a); white-space: pre; }
.sx .sx-sections .sx-row.on .sx-name { color: #fff; }
.sx .sx-sections .sx-row .sx-what { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; color: var(--text-dim, #99a2b3); }
.sx .sx-sections .sx-row.on .sx-what { color: #d8e2f0; }
.sx .sx-sections .sx-row .sx-size { font-family: var(--font-mono, monospace); font-size: 11px; color: var(--text-faint, #5d6675); text-align: right; white-space: nowrap; }
.sx .sx-sections .sx-row.on .sx-size { color: #cfd8e6; }
.sx .sx-badges { display: inline-flex; gap: 3px; margin-left: 4px; vertical-align: 1px; }
.sx .sx-badge { display: inline-block; padding: 0 4px; border-radius: 3px; font-size: 9.5px; line-height: 14px; font-weight: 600; letter-spacing: .02em; text-transform: uppercase; background: var(--bg-4, #2b313e); color: var(--text-dim, #99a2b3); }
.sx .sx-badge.raw { background: #3a3244; color: #d8c8f0; }
.sx .sx-badge.dirty { background: #4a3c14; color: #f4d08a; }
.sx .sx-badge.edited { background: #143f3c; color: #7fe3d9; }
.sx .sx-badge.warn { background: #4c2f12; color: #f0b060; }
.sx .sx-badge.unknown { background: #3f1f22; color: #f0a0a4; }
.sx .sx-badge.repeat { background: #22334f; color: #9cc2ff; }

/* hex view */
.sx .sx-hexpane { display: flex; flex-direction: column; min-height: 0; }
.sx .sx-strip { height: 14px; flex: none; margin: 4px 6px 0; border: 1px solid var(--border, #2c3341); border-radius: 2px; background: var(--bg-0, #0a0c10); cursor: pointer; display: block; width: calc(100% - 12px); }
.sx .sx-hexscroll { flex: 1; min-height: 0; overflow: auto; position: relative; font-family: var(--font-mono, ui-monospace, Consolas, Menlo, monospace); font-size: 12px; line-height: 18px; cursor: text; }
.sx .sx-hexspacer { position: relative; width: 100%; }
.sx .sx-hexrows { position: absolute; left: 0; right: 0; top: 0; padding: 0 6px; white-space: pre; }
.sx .sx-hexrow { display: flex; gap: 10px; height: 18px; }
.sx .sx-hexrow .sx-off { color: var(--text-faint, #5d6675); width: 72px; flex: none; }
.sx .sx-hexrow .sx-hx { display: flex; flex: none; }
.sx .sx-hexrow .sx-as { display: flex; flex: none; color: var(--text-dim, #99a2b3); }
.sx .sx-b { display: inline-block; width: 22px; text-align: center; border-radius: 2px; }
.sx .sx-as .sx-b { width: 9px; }
.sx .sx-b.gap { width: 6px; }
.sx .sx-b.nul { color: var(--text-faint, #5d6675); }
.sx .sx-b.c0 { color: #f4d08a; } .sx .sx-b.c1 { color: #7fe3d9; } .sx .sx-b.c2 { color: #ff9e7a; } .sx .sx-b.c3 { color: #9cc2ff; }
.sx .sx-b.c4 { color: #c6e37f; } .sx .sx-b.c5 { color: #e0a0ff; } .sx .sx-b.c6 { color: #ffd1e8; } .sx .sx-b.c7 { color: #b8c4d6; }
.sx .sx-b.cn { color: var(--text-faint, #5d6675); }
.sx .sx-b.band1 { background: rgba(255,255,255,.035); }
.sx .sx-b.hov { background: rgba(255,255,255,.14); }
.sx .sx-b.fld { background: rgba(79,209,197,.22); }
.sx .sx-b.sel { background: var(--sel, #2b4f80); color: #fff; }
.sx .sx-b.cur { outline: 1px solid var(--gold, #e6b95c); outline-offset: -1px; }
.sx .sx-b.cur.nib { box-shadow: inset 11px 0 0 -9px var(--gold, #e6b95c); }
.sx .sx-hexscroll.ascii .sx-hx .sx-b.cur { outline-color: var(--gold-dim, #a9853c); }
.sx .sx-hexscroll:not(.ascii) .sx-as .sx-b.cur { outline-color: var(--gold-dim, #a9853c); }
.sx .sx-hexempty { padding: 24px; color: var(--text-dim, #99a2b3); text-align: center; }
.sx .sx-hexstatus { display: flex; gap: 10px; flex-wrap: wrap; padding: 3px 8px; border-top: 1px solid var(--border, #2c3341); font-size: 11px; color: var(--text-dim, #99a2b3); flex: none; min-height: 22px; }
.sx .sx-hexstatus .sx-mono { color: var(--text, #dde2ea); }

/* inspector */
.sx .sx-insp { display: flex; flex-direction: column; min-height: 0; }
.sx .sx-insp .sx-doc { padding: 6px 8px; font-size: 11px; line-height: 1.45; color: var(--text-dim, #99a2b3); border-bottom: 1px solid var(--border, #2c3341); flex: none; max-height: 90px; overflow: auto; }
.sx .sx-insp .sx-doc b { color: var(--text, #dde2ea); }
.sx .sx-tabs { display: flex; flex: none; border-bottom: 1px solid var(--border, #2c3341); }
.sx .sx-tab { flex: 1; padding: 4px; text-align: center; cursor: pointer; color: var(--text-dim, #99a2b3); border-bottom: 2px solid transparent; }
.sx .sx-tab.on { color: var(--gold, #e6b95c); border-bottom-color: var(--gold, #e6b95c); }
.sx .sx-tree { font-size: 11.5px; padding: 2px 0; }
.sx .sx-node { display: flex; align-items: baseline; gap: 4px; padding: 1px 6px 1px 0; cursor: pointer; white-space: nowrap; overflow: hidden; }
.sx .sx-node:hover { background: var(--bg-3, #222732); }
.sx .sx-node.on { background: var(--sel, #2b4f80); }
.sx .sx-node .sx-tw { width: 12px; flex: none; text-align: center; color: var(--text-faint, #5d6675); }
.sx .sx-node .sx-lbl { flex: none; }
.sx .sx-node .sx-val { font-family: var(--font-mono, monospace); color: var(--text, #dde2ea); }
.sx .sx-node .sx-mean { color: var(--text-dim, #99a2b3); overflow: hidden; text-overflow: ellipsis; }
.sx .sx-node.leaf .sx-lbl { color: #d2dcea; }
.sx .sx-node.cont .sx-lbl { color: var(--gold-hi, #f4d08a); }
.sx .sx-pager { display: flex; align-items: center; gap: 4px; padding: 1px 6px; font-size: 11px; color: var(--text-dim, #99a2b3); }
.sx .sx-pager select { min-height: 18px; padding: 0 3px; font-size: 11px; }
.sx .sx-field { padding: 6px 8px; border-bottom: 1px solid var(--border, #2c3341); flex: none; display: flex; flex-direction: column; gap: 4px; }
.sx .sx-field .sx-crumb { font-size: 11px; color: var(--text-dim, #99a2b3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sx .sx-field .sx-crumb b { color: var(--gold-hi, #f4d08a); font-weight: 600; }
.sx .sx-field .sx-fdoc { font-size: 11px; color: var(--text-dim, #99a2b3); line-height: 1.4; }
.sx .sx-frow { display: grid; grid-template-columns: 64px 1fr; align-items: center; gap: 6px; min-height: 22px; }
.sx .sx-frow > label { color: var(--text-dim, #99a2b3); font-size: 11px; }
.sx .sx-frow input[type=number], .sx .sx-frow input[type=text] { width: 100%; }
.sx .sx-frow select { width: 100%; }
.sx .sx-flagbox { display: grid; grid-template-columns: 1fr 1fr; gap: 2px 8px; }
.sx .sx-flagbox label { display: flex; align-items: center; gap: 4px; font-size: 11px; white-space: nowrap; }
.sx .sx-data { padding: 6px 8px; flex: none; display: grid; grid-template-columns: auto 1fr; gap: 1px 10px; font-size: 11px; }
.sx .sx-data .k { color: var(--text-dim, #99a2b3); }
.sx .sx-data .v { font-family: var(--font-mono, monospace); }
.sx .sx-search { display: flex; gap: 4px; padding: 4px 6px; border-bottom: 1px solid var(--border, #2c3341); flex: none; align-items: center; flex-wrap: wrap; }
.sx .sx-search input[type=text] { flex: 1; min-width: 80px; }
.sx .sx-hint { padding: 6px 8px; font-size: 11px; color: var(--text-faint, #5d6675); line-height: 1.5; }
.sx .sx-hint kbd { font-family: inherit; color: var(--text-dim, #99a2b3); border: 1px solid var(--border, #2c3341); border-radius: 3px; padding: 0 3px; }
.sx .sx-modal { padding: 8px; display: flex; flex-direction: column; gap: 6px; }
.sx .sx-modal .sx-frow { grid-template-columns: 90px 1fr; }
`;
