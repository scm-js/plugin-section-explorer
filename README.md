# Section Explorer

A plugin for [scmJS](https://github.com/scm-js/scm-js), the browser-based StarCraft 1 /
Brood War map editor. It is a hex editor that knows the map file.

A scenario is a list of sections, such as `DIM `, `MTXM`, `UNIT` and `TRIG`. Each is a run of
bytes the game reads into a fixed structure. Section Explorer shows:

- the list of sections, as Save would write them
- the bytes of the section you pick, coloured by field
- an inspector that explains the byte under the cursor: which record, which field, and what
  the number means. A unit id becomes *Terran Marine*, a string index shows its string, and a
  flag word lists its bits.

You can edit a value through the inspector as a number, a choice, a set of ticks or text. Any
byte can also be edited directly.

It is for map makers who want to see what is in their file, and for anyone curious about how
a `.scx` is put together.

## Install

Section Explorer is not installed by default. Open **Plugins ▸ Browse Plugins…** and press
**Install** on its row.

Or open **Plugins ▸ Manage Plugins…**, paste

```
https://github.com/scm-js/plugin-section-explorer
```

and press **Add**. To pin a version, add a ref: `github:scm-js/plugin-section-explorer@v1.1.0`.

## Use

**Tools ▸ Section Explorer…** (`Ctrl+Shift+H`) opens the explorer for the open map. It has
three columns: Sections, Bytes and Inspector.

### Sections

The left column lists every section in file order, with its size and these badges:

| Badge | Meaning |
| --- | --- |
| *raw* | The editor keeps this section as bytes and writes it back unchanged. |
| *?* | The editor does not know this section. |
| *unsaved* | The editor has changes here that it will write on Save. |
| *edited* | You changed bytes here and have not applied them. |
| *1/2* | A repeated section. The game combines repeats, and the inspector says how. |
| *size* | The length is not what the game reads. |
| *cut* | The file ended before the section did. |

The buttons below the list add, remove, rename and reorder sections, and export or import
one section's bytes. The top bar exports or imports the whole `scenario.chk`.

Removing a section asks first, since it rewrites the file and clears the editor's undo
history.

### Bytes

The middle column is the hex view: the offset, sixteen bytes, and the same bytes as text.
Colours follow the fields and alternate between records. The strip above shows the whole
section; click it to jump. Hover to see the field under the pointer, click to place the
cursor, and drag to select.

- Type hex digits in the byte column, or characters in the text column, to overwrite. `Tab`
  switches columns.
- In `UNIT`, `THG2` and `MRGN`, **Show on map** scrolls the map to the record under the cursor
  and selects it.
- **Insert mode** (the tick, or the `Insert` key) makes typing and pasting insert bytes.
  `Delete` and `Backspace` then remove bytes. In overwrite mode they set the byte to zero.
- `Ctrl+C` copies the selection as hex (or as text, from the text column). `Ctrl+V` pastes hex
  or text. `Ctrl+A` selects all. `Ctrl+Z` and `Ctrl+Y` undo and redo within the section.
- For a list section (units, sprites, doodads, locations, triggers, briefings), the header has
  **Insert record**, **Append** and **Delete record**.
- For a fixed-size section with the wrong length, **Fit to N** pads or cuts it. The length box
  sets any length.

### Inspector

The right column explains the section and the cursor.

- The top says what the section is and how many bytes the game expects.
- **Find** searches for hex, text, or a 16-bit or 32-bit number. `Enter` finds the next match
  and `Shift+Enter` the previous one. The box beside it goes to an offset. `Ctrl+F` and
  `Ctrl+G` jump to these boxes.
- The field panel shows the path to the byte under the cursor (for example
  *Triggers › trigger 3 › actions › action 0 › unitId*), its type and offset, its value and
  meaning, and a control to edit it. Below that are the raw values at the cursor in every
  width.
- The structure tree lays out the whole section, one line per record, and follows the cursor.
  Click a row to select its bytes.

### Applying changes

Nothing reaches the map until you press **Apply** (or `Ctrl+S`). The editor then reads the
whole file again, so the map view and every dialog update. This clears the editor's undo
history, as Resize does.

**Revert** reads every section again and drops your changes. **Close** asks once if there are
changes you have not applied.

The layouts follow the community's
[Scenario.chk reference](https://wiki.staredit.net/wiki/Scenario.chk) and the editor's own
code. A section with no layout (an unknown name, or junk left by a map protector) is shown as
plain bytes and can be edited the same way. The editor's
[section reference](https://docs.scmjs.dev/chk/) describes each section.

## Development

```sh
npm install
npm run typecheck
npm test
npm run build      # dist/plugin.js
npm run dev        # rebuild on change
```

| File | What it holds |
| --- | --- |
| `plugin.ts` | The dialog, the section list and applying changes. |
| `buffer.ts` | The edit buffer: overwrite, insert, remove, resize, undo and redo. |
| `layout.ts` | The field model: schemas, offsets and reading values. |
| `layouts.ts` | Every section's layout and what its fields mean. |
| `hexview.ts` | The hex view. |
| `inspector.ts` | The inspector: find, the field editor, raw values and the structure tree. |
| `dom.ts` | The element builder and the stylesheet. |
| `i18n.ts`, `ko.ts` | Translation helpers and the Korean strings. |
| `dist/plugin.js` | The bundle the editor loads. CI commits it on every push to `main`. |

Tests cover `buffer.ts` and `layouts.ts`, and check that `ko.ts` has every string the plugin
shows.

To try local changes, serve this folder with CORS (`npx serve --cors .`), add
`http://localhost:3000/` in **Manage Plugins…**, and press **Reload** after each edit. A
plugin runs with the editor's own privileges. There is no sandbox.

Types come from [`@scm-js/plugin-api`](https://github.com/scm-js/plugin-api), a devDependency
generated from the editor's plugin contract. `npm update @scm-js/plugin-api` picks up the
newest version. This plugin is the worked example for `api.document.sections` (the file's
sections as bytes) and `api.names` (the names behind the numbers) in the
[plugin guide](https://docs.scmjs.dev/plugins/).

## Licence

MIT. See [LICENSE](LICENSE).
