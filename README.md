# Section Explorer

A plugin for [scmJS](https://github.com/jeany55/scm-js), the browser-based StarCraft 1 /
Brood War map editor. It is a hex editor that knows the map file.

A scenario is a list of sections — `DIM `, `MTXM`, `UNIT`, `TRIG` and forty-odd others —
each a run of bytes the game reads into a fixed structure. The explorer shows that list the
way Save would write it, the bytes of the section you pick with every field coloured, and
an inspector that says what the byte under the cursor is: which record, which field, what
the number means (a unit id becomes *Terran Marine*, a string index shows its string, a
flag word lists its bits) and lets you change it as a number, a choice, a set of ticks or
text. Anything the inspector cannot explain you can still edit byte by byte.

It is for map makers who want to see what is in their file, and for anyone curious about
how a `.scx` is put together.

## Install

In scmJS: **Plugins ▸ Manage Plugins…**, paste

```
https://github.com/scm-js/plugin-section-explorer
```

and press **Add**. It is normally already in that list, marked *default* and switched off:
tick it to turn it on. To pin a version, add a ref: `github:scm-js/plugin-section-explorer@v1.0.0`.

## Use

**Tools ▸ Section Explorer…** (or `Ctrl+Shift+H`) opens the explorer over the open map.

**Sections** on the left lists every section occurrence in file order with its size and
some badges: *raw* for a section the editor keeps as bytes and writes back unchanged, *?*
for one it has never heard of, *unsaved* where the editor holds changes it will encode on
Save, *edited* where you have changed bytes here and not applied them, *1/2* for a repeated
section (the game combines repeats; the inspector says how), *size* where the length is
not what the game reads, *cut* where the file ended early. The buttons underneath add,
remove, rename and reorder sections and export or import one section's bytes; the top
bar exports or imports the whole `scenario.chk`. Removing a section asks first: it rewrites
the file and clears the editor's undo history with it.

**Bytes** in the middle is the hex view: offset, sixteen bytes, their text. Colours follow
the fields of the layout and alternate from record to record; the strip above is the whole
section at a glance, and clicking it jumps. Hover for the field under the pointer, click to
put the cursor there, drag to select.

- Type hex digits in the byte column or characters in the text column to overwrite.
  `Tab` switches columns.
- In a section of records the editor draws — `UNIT`, `THG2`, `MRGN` — **Show on map**
  scrolls the map to the record under the cursor and selects it, so the bytes can be
  checked against the thing itself.
- **Insert mode** (the tick, or `Insert`) makes typing and pasting insert bytes instead,
  and `Delete` / `Backspace` remove them. In overwrite mode they zero the byte.
- `Ctrl+C` copies the selection as hex (as text from the text column); `Ctrl+V` pastes
  hex or text; `Ctrl+A` selects all; `Ctrl+Z` / `Ctrl+Y` undo and redo within the section.
- For a list section (units, sprites, doodads, locations, triggers, briefings) the header
  has *Insert record*, *Append* and *Delete record*; for a fixed-size one that is the
  wrong length, *Fit to N*. The length box sets any length (zero-padded or cut).

**Inspector** on the right explains the section and the cursor. The top says what the
section is and how many bytes the game expects. *Find* looks for hex, text, a 16-bit or a
32-bit number (`Enter` next, `Shift+Enter` previous); the box beside it goes to an offset
(`Ctrl+F` and `Ctrl+G` focus them). The field panel shows the path to the byte under the
cursor (*Triggers › trigger 3 › actions › action 0 › unitId*), its type and offset, its
value with its meaning, and a control that edits it. Below that, the raw readings at the
cursor in every width. The structure tree lays the whole section out — records with a
one-line summary each, long arrays a page at a time — and follows the cursor; clicking a
row selects its bytes.

Nothing reaches the map until you press **Apply** (or `Ctrl+S`): every changed section is
written into the editor, which parses the file again from scratch, so the map view, the
dialogs and everything else follow. That also drops the editor's undo history, the way
Resize does, since any part of the document may have changed. *Revert* reads every section
again and drops your changes; *Close* with unapplied changes asks once.

The layouts follow the community's
[Scenario.chk reference](https://wiki.staredit.net/wiki/Scenario.chk) and the editor's own
codecs. A section with no layout (an unknown name, a protected map's junk) is shown as
plain bytes and edited the same way.

## Layout

| | |
| --- | --- |
| `plugin.json` | the manifest the editor reads (name, version, `entry`, `icon`, the API version it needs) |
| `plugin.ts` | `activate(api)`: the dialog, the section list, applying |
| `buffer.ts` | the edit buffer: overwrite, insert, remove, resize, undo/redo, hex text helpers |
| `layout.ts` | the node model: schemas, instantiation at an offset, lazy children, value reading, walking |
| `layouts.ts` | every section's layout and the meanings of its fields |
| `hexview.ts` | the hex view |
| `inspector.ts` | the inspector: header, find, field editor, data readings, structure tree |
| `dom.ts` | the element builder and the stylesheet |
| `dist/plugin.js` | the bundle the editor loads; `npm run build` writes it, CI commits it |
| `tests/` | vitest over `buffer.ts` and `layouts.ts` |

Types come from [`@scm-js/plugin-api`](https://github.com/scm-js/plugin-api), a devDependency
generated from the editor's own `src/plugins/api.ts`; `npm update @scm-js/plugin-api` takes the
newest contract. The plugin uses `api.document.sections` (the file's
sections as bytes, and raw edits to them) and `api.names` (the names behind the numbers).

## Development

```sh
npm install
npm run typecheck
npm test
```

`dist/plugin.js` is what the editor loads (`build` in the manifest): `npm run build` writes
it with esbuild, and CI commits it on every push to `main` and checks at a tag that it is
what the source builds to. Run `npm run dev` while you work so the bundle follows your
edits. To try local changes, serve this directory with CORS enabled (`npx serve --cors .`)
and add `http://localhost:3000/` in Manage Plugins, then use **Reload** after each edit.

A plugin runs with the editor's own privileges. There is no sandbox.

See [`docs/plugins.md`](https://github.com/jeany55/scm-js/blob/main/docs/plugins.md) in the editor
for the API tour; this plugin is the worked example for `api.document.sections` and `api.names`.

## Licence

MIT — see [LICENSE](LICENSE).
