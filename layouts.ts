/**
 * What every CHK section looks like, as schemas over `layout.ts`.
 *
 * The layouts and their meanings follow the editor's CHK reference
 * (https://docs.scmjs.dev/chk/, `docs/chk-format.md` in scm-js/scm-js), which was
 * checked against what StarCraft 1.16.1 and Remastered do with each byte; where the game
 * ignores a field or reads it differently from what older references say, the text here
 * says what the game does. `sectionLayout(name, bytes, ctx)` picks the layout for a section and
 * fits it to the bytes at hand: list sections get as many records as fit, a section
 * longer than its layout gets a trailing-bytes leaf, and a name nothing here knows gets
 * null (the explorer then shows plain bytes).
 */
import {
  array, chars, i32, instantiate, leaf, sequence, sizeOf, struct, u16, u32, u8,
  type Ctx, type Env, type Node, type Schema, type Semantic, type Siblings,
} from "./layout";
import { msg, t } from "./i18n";

/* ── Semantics ──────────────────────────────────────────── */

const quote = (s: string | null, max = 48) => (s === null ? "(no such string)" : JSON.stringify(s.length > max ? `${s.slice(0, max)}…` : s));

export const NUM: Semantic = { edit: "number" };
export const HEX: Semantic = { edit: "number", hex: true };
export const NONE: Semantic = { edit: "none" };
export const BOOL: Semantic = { edit: "select", options: () => [{ value: 0, label: "0 — no" }, { value: 1, label: "1 — yes" }], describe: (v) => (v === 0 ? "no" : v === 1 ? "yes" : "?") };
export const STRING: Semantic = { edit: "number", describe: (v, ctx) => (v === 0 ? "none" : `→ ${quote(ctx.names.string(v))}`) };
export const UNIT: Semantic = { edit: "select", options: (ctx) => ctx.names.units(), describe: (v, ctx) => ctx.names.unit(v) };
export const UPGRADE: Semantic = { edit: "select", options: (ctx) => ctx.names.upgrades(), describe: (v, ctx) => ctx.names.upgrade(v) };
export const TECH: Semantic = { edit: "select", options: (ctx) => ctx.names.techs(), describe: (v, ctx) => ctx.names.tech(v) };
export const WEAPON: Semantic = { edit: "select", options: (ctx) => ctx.names.weapons(), describe: (v, ctx) => ctx.names.weapon(v) };
export const PLAYER: Semantic = { edit: "select", options: (ctx) => Array.from({ length: 12 }, (_, i) => ({ value: i, label: ctx.names.player(i) })), describe: (v, ctx) => (v < 12 ? ctx.names.player(v) : `slot ${v}`) };
export const PLAYER_TYPE: Semantic = { edit: "select", options: (ctx) => ctx.names.playerTypes(), describe: (v, ctx) => ctx.names.playerType(v) };
export const RACE: Semantic = { edit: "select", options: (ctx) => ctx.names.races(), describe: (v, ctx) => ctx.names.race(v) };
export const PLAYER_GROUP: Semantic = { edit: "select", options: (ctx) => ctx.names.playerGroups(), describe: (v, ctx) => ctx.names.playerGroup(v) };
/** A 1-based location number, 0 = none, as triggers store them. */
export const LOCATION1: Semantic = {
  edit: "select",
  options: (ctx) => [{ value: 0, label: "none" }, ...Array.from({ length: 255 }, (_, i) => ({ value: i + 1, label: `${i + 1}: ${ctx.names.location(i)}` }))],
  describe: (v, ctx) => (v === 0 ? "none" : ctx.names.location(v - 1)),
};
export const CONDITION_TYPE: Semantic = { edit: "select", options: (ctx) => ctx.names.conditions(), describe: (v, ctx) => ctx.names.condition(v) };
export const ACTION_TYPE: Semantic = { edit: "select", options: (ctx) => ctx.names.actions(), describe: (v, ctx) => ctx.names.action(v) };
export const BRIEFING_TYPE: Semantic = { edit: "select", options: (ctx) => ctx.names.actions(true), describe: (v, ctx) => ctx.names.action(v, true) };
export const COMPARISON: Semantic = {
  edit: "select",
  options: () => [{ value: 0, label: "At least" }, { value: 1, label: "At most" }, { value: 10, label: "Exactly" }, { value: 2, label: "Set (switch)" }, { value: 3, label: "Cleared (switch)" }],
  describe: (v) => ({ 0: "At least", 1: "At most", 10: "Exactly", 2: "Set", 3: "Cleared" } as Record<number, string>)[v] ?? "?",
};
const bits = (labels: string[], from = 0): { bit: number; label: string }[] => labels.map((label, i) => ({ bit: 1 << (i + from), label }));
export const flags = (list: { bit: number; label: string }[]): Semantic => ({
  edit: "flags", bits: list, hex: true,
  describe: (v) => { const on = list.filter((b) => v & b.bit).map((b) => b.label); const rest = v & ~list.reduce((m, b) => m | b.bit, 0); return [...on, ...(rest ? [`+0x${rest.toString(16)}`] : [])].join(", ") || "none"; },
});
export const FIXED256: Semantic = { edit: "number", describe: (v) => `${v / 256}` };
/** A use-default byte: 0 takes the section's values, anything else the game's own. */
export const USE_DEFAULT: Semantic = { edit: "select", options: () => [{ value: 0, label: "0 — this section's values" }, { value: 1, label: "1 — the game's own" }], describe: (v) => (v === 0 ? "this section's values" : "the game's own") };
/** A per-player uses-the-defaults byte: 0 takes the player's own values, anything else the defaults. */
export const USES_DEFAULTS: Semantic = { edit: "select", options: () => [{ value: 0, label: "0 — the player's own" }, { value: 1, label: "1 — the defaults" }], describe: (v) => (v === 0 ? "the player's own" : "the defaults") };
export const PX: Semantic = { edit: "number", describe: (v) => `tile ${Math.floor(v / 32)}` };
/** Groups a tile number can name while bit 15 is not part of the group: the game's tilesets have fewer. */
const CLASSIC_TILE_GROUPS = 0x800;
/**
 * A tile number: group × 16 + variation. The game reads the group from bits 4–14; bit 15
 * takes no part. A tileset of more than 2,048 groups (a mod's extended one) reads the group
 * from all twelve bits 4–15, as the editor draws it.
 */
export const TILE: Semantic = {
  edit: "number", hex: true,
  describe: (v, ctx) => {
    const wide = (ctx.tileGroups ?? 0) > CLASSIC_TILE_GROUPS;
    const id = wide ? v & 0xffff : v & 0x7fff;
    const name = ctx.names.tile(id);
    const note = !(v & 0x8000) ? "" : wide ? ` (bit 15 is part of the group: the tileset has ${ctx.tileGroups!.toLocaleString("en-US")} groups)` : " (bit 15 set: no effect in play)";
    return `group ${id >> 4}, tile ${id & 0xf}${name ? ` — ${name}` : ""}${note}`;
  },
};
export const AI_SCRIPT: Semantic = { edit: "number", hex: true, describe: (v, ctx) => `"${aiChars(v)}" — ${ctx.names.aiScript(v)}` };
const aiChars = (code: number) => String.fromCharCode(code & 0xff, (code >>> 8) & 0xff, (code >>> 16) & 0xff, (code >>> 24) & 0xff).replace(/[^\x20-\x7e]/g, ".");
export const TILESETS = ["Badlands", "Space Platform", "Installation", "Ashworld", "Jungle", "Desert", "Ice", "Twilight"];
export const ERA: Semantic = {
  edit: "select", options: () => TILESETS.map((label, value) => ({ value, label })),
  describe: (v) => `${TILESETS[v & 7]}${(v & 7) === 2 ? " (Use Map Settings only)" : ""}${v > 7 ? " (Brood War reads only the low 3 bits; the original StarCraft refuses it)" : v > 4 ? " (Brood War only)" : ""}`,
};
export const VER: Semantic = {
  edit: "select",
  options: () => [{ value: 59, label: "59 — StarCraft 1.00" }, { value: 63, label: "63 — Hybrid 1.04" }, { value: 205, label: "205 — Brood War 1.04" }, { value: 64, label: "64 — Remastered 1.21+ without Brood War" }, { value: 206, label: "206 — Remastered 1.21+" }],
  describe: (v) => ({ 59: "StarCraft 1.00 (original)", 63: "Hybrid 1.04", 205: "Brood War 1.04", 64: "Remastered 1.21+ without Brood War (Remastered only)", 206: "Remastered 1.21+ (Remastered only)" } as Record<number, string>)[v] ?? "a revision neither game knows: the map is refused",
};
export const MAP_TYPE: Semantic = { edit: "text", describe: (_v, _ctx, _s, text) => ({ RAWS: "StarCraft (original / hybrid)", RAWB: "Brood War" } as Record<string, string>)[text ?? ""] ?? "unknown type (the game never reads it)" };
export const COLOR_NAMES = ["Red", "Blue", "Teal", "Purple", "Orange", "Brown", "White", "Yellow", "Green", "Pale Yellow", "Tan", "Dark Aqua", "Pale Green", "Bluish Grey", "Pale Yellow II", "Cyan", "Pink", "Olive", "Lime", "Navy", "Dark Green", "Black"];
/** A colour number, 0–21: the third byte of a CRGB Palette entry. */
export const COLOR: Semantic = { edit: "select", options: () => COLOR_NAMES.map((label, value) => ({ value, label })), describe: (v) => COLOR_NAMES[v] ?? `colour ${v}` };
/**
 * A COLR byte: a colour slot, 0–11. The player takes the colour that slot had before COLR
 * was read, so the slots are named by their usual colour. 1.16.1 shows a wrong colour for
 * 12 and up, and Remastered skips such a byte.
 */
export const COLR_SLOT: Semantic = {
  edit: "select",
  options: () => COLOR_NAMES.slice(0, 12).map((label, value) => ({ value, label: `${value} — Player ${value + 1}'s slot (${label})` })),
  describe: (v) => (v < 12 ? `the colour of Player ${v + 1}'s slot (usually ${COLOR_NAMES[v]})` : "not a colour slot: 1.16.1 shows a wrong colour, Remastered keeps the usual one"),
};
const COLOR_MODES = ["Random", "Player choice", "Custom RGB", "Palette"];
export const COLOR_MODE: Semantic = {
  edit: "select", options: () => COLOR_MODES.map((label, value) => ({ value, label })),
  describe: (v) => (v < 3 ? COLOR_MODES[v] : v === 3 ? "Palette" : "Palette (any mode above 3)"),
};
export const FORCE: Semantic = { edit: "select", options: () => [0, 1, 2, 3].map((i) => ({ value: i, label: `Force ${i + 1}` })), describe: (v) => `Force ${v + 1}` };
export const PERCENT: Semantic = { edit: "number", describe: (v) => `${v}%` };
/** Game frames: 1/15 s at Normal speed, 42 ms at Fastest. */
export const FRAMES: Semantic = { edit: "number", describe: (v) => `${(v / 15).toFixed(1)} s at Normal, ${(v * 0.042).toFixed(1)} s at Fastest` };
export const SWITCH_STATE_ACTION: Semantic = {
  edit: "select",
  options: () => [{ value: 4, label: "Set" }, { value: 5, label: "Clear" }, { value: 6, label: "Toggle" }, { value: 11, label: "Randomize" }],
  describe: (v) => ({ 4: "Set", 5: "Clear", 6: "Toggle", 11: "Randomize" } as Record<number, string>)[v] ?? "?",
};

/* ── Flag tables ────────────────────────────────────────── */

export const UNIT_VALID_BITS = bits(["Cloak", "Burrow", "In transit", "Hallucinated", "Invincible"]);
export const UNIT_USED_BITS = bits(["Owner (never read)", "Hit points", "Shields", "Energy", "Resources", "Hangar", "0x40 (never read)"]);
export const UNIT_STATE_BITS = bits(["Cloaked", "Burrowed", "In transit", "Hallucinated", "Invincible"]);
export const UNIT_RELATION_BITS = [{ bit: 0x200, label: "Linked pair (ignored by the game)" }, { bit: 0x400, label: "Add-on, in old references (ignored by the game)" }];
export const SPRITE_FLAG_BITS = [{ bit: 0x1000, label: "Pure sprite (not a unit)" }, { bit: 0x4000, label: "Flipped, to editors (no effect in play)" }, { bit: 0x8000, label: "Disabled (a unit sprite starts disabled)" }];
export const ELEVATION_BITS = bits(["Low ground excluded", "Medium ground excluded", "High ground excluded", "Low air excluded", "Medium air excluded", "High air excluded"]);
export const TRIGGER_FLAG_BITS = bits([
  "Part way through its actions (game)", "Counts as won: defeats the other players", "Preserved", "Disabled, or finished",
  "Esc is skipping its Waits (game)", "Paused the game (game)", "Esc may not skip it (game)",
]);
export const CONDITION_FLAG_BITS = bits(["Unknown (game)", "Disabled", "Always display", "Unit properties used", "Unit type used", "Unit id used"]);
export const ACTION_FLAG_BITS = bits(["Ignore wait once (game)", "Disabled", "Always display", "Unit properties used", "Unit type used", "Unit id used"]);
export const FORCE_FLAG_BITS = bits(["Random start location", "Allies", "Allied victory", "Shared vision"]);
export const MASK_BITS = bits(Array.from({ length: 8 }, (_, i) => `Player ${i + 1} starts unexplored`));
export const CUWP_VALID_BITS = bits(["Cloak", "Burrow", "In transit", "Hallucinated", "Invincible"]);
export const CUWP_ELEMENT_BITS = bits(["Owner (unused)", "Hit points", "Shields", "Energy", "Resources", "Hangar"]);

/* ── Trigger argument tables ────────────────────────────── */

type Arg = "player" | "player2" | "unit" | "count" | "location" | "location2" | "text" | "wav" | "time" | "modifier" | "amount" | "percent" | "resource" | "score" | "switch" | "switchAction" | "unitState" | "order" | "alliance" | "aiScript" | "cuwp" | "createSlot" | "seconds" | "cmp" | "camount" | "cresource" | "cscore" | "cswitch" | "cswitchState" | "slot";

const CONDITION_ARGS: Record<number, Arg[]> = {
  1: ["cmp", "camount"], 2: ["player", "unit", "cmp", "camount"], 3: ["player", "unit", "location", "cmp", "camount"], 4: ["player", "cmp", "camount", "cresource"],
  5: ["player", "unit", "cmp", "camount"], 6: ["unit"], 7: ["unit", "location"], 8: ["unit"], 9: ["cscore"], 10: ["cresource"], 11: ["cswitch", "cswitchState"],
  12: ["cmp", "camount"], 13: [], 14: ["player", "cmp", "camount"], 15: ["player", "unit", "cmp", "camount"], 16: ["unit"], 17: ["unit", "location"], 18: ["unit"],
  19: ["cscore"], 20: ["cresource"], 21: ["player", "cscore", "cmp", "camount"], 22: [], 23: [],
};

const ACTION_ARGS: Record<number, Arg[]> = {
  1: [], 2: [], 3: [], 4: ["time"], 5: [], 6: [], 7: ["text", "unit", "location", "modifier", "amount", "wav", "time"], 8: ["wav", "time"], 9: ["text"], 10: ["location"],
  11: ["player", "unit", "count", "location", "cuwp"], 12: ["text"], 13: ["switch", "switchAction"], 14: ["modifier", "seconds"], 15: ["aiScript"], 16: ["aiScript", "location"],
  17: ["text", "unit"], 18: ["text", "unit", "location"], 19: ["text", "resource"], 20: ["text", "unit"], 21: ["text", "score"], 22: ["player", "unit"], 23: ["player", "unit", "count", "location"],
  24: ["player", "unit"], 25: ["player", "unit", "count", "location"], 26: ["player", "modifier", "amount", "resource"], 27: ["player", "modifier", "amount", "score"], 28: ["location"],
  29: ["unit", "time"], 30: [], 31: [], 32: ["unitState"], 33: ["text", "unit", "amount"], 34: ["text", "unit", "amount", "location"], 35: ["text", "amount", "resource"],
  36: ["text", "unit", "amount"], 37: ["text", "score", "amount"], 38: ["player", "unit", "location", "location2"], 39: ["player", "unit", "count", "location", "location2"], 40: ["amount"],
  41: ["text"], 42: ["player", "unit", "location", "unitState"], 43: ["player", "unit", "location", "unitState"], 44: ["player", "unit", "count", "location", "createSlot"], 45: ["player", "unit", "modifier", "amount"],
  46: ["player", "unit", "location", "location2", "order"], 47: ["text"], 48: ["player", "player2", "unit", "count", "location"], 49: ["player", "unit", "percent", "count", "location"],
  50: ["player", "unit", "percent", "count", "location"], 51: ["player", "unit", "percent", "count", "location"], 52: ["player", "amount", "count", "location"], 53: ["player", "unit", "amount", "count", "location"],
  54: [], 55: [], 56: [], 57: ["player", "alliance"], 58: [], 59: [],
};

const BRIEFING_ARGS: Record<number, Arg[]> = {
  1: ["time"], 2: ["wav", "time"], 3: ["text", "time"], 4: ["text"], 5: ["unit", "slot"], 6: ["slot"], 7: ["slot", "time"], 8: ["text", "slot", "modifier", "time", "wav"], 9: [],
};

const MODIFIERS: Record<number, string> = { 7: "Set to", 8: "Add", 9: "Subtract" };
const UNIT_STATES: Record<number, string> = { 4: "Enable", 5: "Disable", 6: "Toggle" };
const ORDERS: Record<number, string> = { 0: "Move", 1: "Patrol", 2: "Attack" };
const ALLIANCES: Record<number, string> = { 0: "Enemy", 1: "Ally", 2: "Allied victory" };
const RESOURCES: Record<number, string> = { 0: "Ore", 1: "Gas", 2: "Ore and gas" };
const SCORES: Record<number, string> = { 0: "Total", 1: "Units", 2: "Buildings", 3: "Units and buildings", 4: "Kills", 5: "Razings", 6: "Kills and razings", 7: "Custom" };

/** Create Unit and Create Unit with Properties: a count of 0 makes one unit, not all. */
const CREATES = new Set([11, 44]);
/** A properties slot as Create Unit and Create Unit with Properties read it: 1 to 64, anything else none. */
const propertiesSlot = (v: number) => (v >= 1 && v <= 64 ? `properties slot ${v}` : v === 0 ? "no properties slot" : `no properties slot (${v} is not 1–64)`);

const loc = (ctx: Ctx, v: number) => (v === 0 ? "no location" : ctx.names.location(v - 1));

/** One argument of a condition or action, read off its record. */
function argText(arg: Arg, s: Siblings, ctx: Ctx): string {
  switch (arg) {
    case "player": return ctx.names.playerGroup(s("player"));
    case "player2": return `to ${ctx.names.playerGroup(s("target"))}`;
    case "unit": return ctx.names.unit(s("unitId"));
    case "count": { const n = s("modifier"); return n !== 0 ? `×${n}` : CREATES.has(s("type")) ? "×1 (0 makes one)" : "all"; }
    case "location": return `at ${loc(ctx, s("location"))}`;
    case "location2": return `→ ${loc(ctx, s("target"))}`;
    case "text": return quote(ctx.names.string(s("text")), 32);
    case "wav": { const w = s("wav"); return w === 0 ? "no WAV" : `WAV ${quote(ctx.names.string(w), 24)}`; }
    case "time": return `${s("time")} ms`;
    case "seconds": return `${s("time")} s`;
    case "modifier": return MODIFIERS[s("modifier")] ?? `modifier ${s("modifier")}`;
    case "amount": return String(s("target"));
    case "percent": return `${s("target")}%`;
    case "resource": return RESOURCES[s("unitId")] ?? `resource ${s("unitId")}`;
    case "score": return SCORES[s("unitId")] ?? `score ${s("unitId")}`;
    case "switch": return ctx.names.switch(s("target"));
    case "switchAction": return ({ 4: "set", 5: "clear", 6: "toggle", 11: "randomize" } as Record<number, string>)[s("modifier")] ?? "?";
    case "unitState": return UNIT_STATES[s("modifier")] ?? "?";
    case "order": return ORDERS[s("modifier")] ?? "?";
    case "alliance": return ALLIANCES[s("unitId")] ?? "?";
    case "aiScript": return ctx.names.aiScript(s("target"));
    case "cuwp": case "createSlot": return propertiesSlot(s("target"));
    case "cmp": return ({ 0: "at least", 1: "at most", 10: "exactly" } as Record<number, string>)[s("comparison")] ?? "?";
    case "camount": return String(s("amount"));
    case "cresource": return RESOURCES[s("resource")] ?? `resource ${s("resource")}`;
    case "cscore": return SCORES[s("resource")] ?? `score ${s("resource")}`;
    case "cswitch": return ctx.names.switch(s("resource"));
    case "cswitchState": return s("comparison") === 2 ? "is set" : s("comparison") === 3 ? "is cleared" : "?";
    case "slot": return `slot ${s("target")}`;
  }
}

/** A trigger record field whose meaning follows the record's type byte. */
const perType = (table: Record<number, Arg[]>, mine: Arg[], fallback: string): Semantic => ({
  edit: "number",
  describe: (_v, ctx, s) => {
    const args = table[s("type")] ?? [];
    const used = mine.filter((a) => args.includes(a));
    return used.length ? used.map((a) => argText(a, s, ctx)).join("; ") : fallback;
  },
});

const TYPE_LOOKUP = (table: Record<number, Arg[]>, name: (t: number, ctx: Ctx) => string) => (s: Siblings, ctx: Ctx) => {
  const t = s("type");
  if (t === 0) return "(empty slot)";
  // Editors write 0 in Create Unit's properties field; only a slot there is worth a mention.
  const args = (table[t] ?? []).filter((a) => a !== "createSlot" || s("target") !== 0).map((a) => argText(a, s, ctx));
  return `${name(t, ctx)}${args.length ? ` — ${args.join(", ")}` : ""}`;
};

/* ── Record schemas ─────────────────────────────────────── */

export const UNIT_RECORD = struct("Unit", [
  u32("serial", HEX, msg("Unique per unit within the map; Nydus and add-on links refer to it.")),
  u16("x", PX, msg("Centre, in map pixels.")), u16("y", PX, msg("Centre, in map pixels.")),
  u16("unitId", UNIT, msg("units.dat id.")),
  u16("relationType", flags(UNIT_RELATION_BITS), msg("Link flags editors write. The game never reads them: it links an add-on to its building, or a nydus canal to its exit, only when each of the two records names the other's serial.")),
  u16("validProperties", flags(UNIT_VALID_BITS), msg("Which special states the record sets. A state is applied only when its bit is set both here and in stateFlags.")),
  u16("validStates", flags(UNIT_USED_BITS), msg("Which of the fields below the record sets. The game never reads the owner bit or 0x40: the owner byte always counts.")),
  u8("owner", PLAYER), u8("hitPoints", PERCENT, msg("Per cent of the unit's maximum, and capped at it.")), u8("shields", PERCENT), u8("energy", PERCENT),
  u32("resources", NUM, msg("Minerals or gas held by a resource unit. The game keeps only the low 16 bits, so 70,000 becomes 4,464.")),
  u16("hangar", NUM, msg("Interceptors or Scarabs. Read only for Carriers, Reavers and their heroes: the low byte, and no more than the unit can hold.")),
  u16("stateFlags", flags(UNIT_STATE_BITS), msg("The special states themselves. A Ghost starts cloaked only if its owner has Personal Cloaking, and a Zerg unit burrowed only if its owner has Burrowing.")),
  u32("unused", HEX), u32("relatedSerial", HEX, msg("The serial of the linked unit: an add-on's building, or the other end of a nydus canal. The link holds only when both records name each other, in the same UNIT section.")),
], { summary: (r, ctx) => `${ctx.names.unit(r("unitId"))} — ${ctx.names.player(r("owner"))} at (${r("x")}, ${r("y")})` });

export const SPRITE_RECORD = struct("Sprite", [
  u16("spriteId", { edit: "number", describe: (v, ctx, s) => (s("flags") & 0x1000 ? `sprites.dat #${v}` : `unit: ${ctx.names.unit(v)}`) }, msg("A sprites.dat id for a pure sprite; a units.dat id when the pure-sprite flag is off (doors, traps).")),
  u16("x", PX), u16("y", PX), u8("owner", PLAYER), u8("unused", HEX),
  u16("flags", flags(SPRITE_FLAG_BITS), msg("The game reads only 0x1000 and 0x8000. Editors call 0x4000 flipped, but it has no effect in play.")),
], { summary: (r, ctx) => `${r("flags") & 0x1000 ? `sprite #${r("spriteId")}` : ctx.names.unit(r("spriteId"))} at (${r("x")}, ${r("y")})` });

export const DOODAD_RECORD = struct("Doodad", [
  u16("doodadId", NUM, msg("Index into the tileset's dddata.bin.")), u16("x", PX, msg("Centre of the footprint.")), u16("y", PX), u8("owner", PLAYER), u8("disabled", BOOL),
], { summary: (r) => `doodad #${r("doodadId")} at (${r("x")}, ${r("y")})` });

export const LOCATION_RECORD = struct("Location", [
  i32("left", PX), i32("top", PX), i32("right", PX), i32("bottom", PX),
  u16("nameIndex", STRING), u16("elevationFlags", flags(ELEVATION_BITS), msg("A set bit excludes that elevation; 0 is everywhere.")),
], { summary: (r, ctx) => `${r("nameIndex") ? quote(ctx.names.string(r("nameIndex")), 24) : "(unnamed)"} — (${r("left")}, ${r("top")})–(${r("right")}, ${r("bottom")})` });

const CONDITION_RECORD = struct("Condition", [
  u32("location", LOCATION1), u32("player", PLAYER_GROUP), u32("amount", NUM), u16("unitId", UNIT),
  u8("comparison", COMPARISON), u8("type", CONDITION_TYPE),
  u8("resource", perType(CONDITION_ARGS, ["cresource", "cscore", "cswitch"], "unused for this type"), msg("Resource, score type or switch number, per type.")),
  u8("flags", flags(CONDITION_FLAG_BITS), msg("0x02 disables the condition; the other bits are editor and game bookkeeping.")), u16("mask", HEX, msg("EUD mask; 0 in ordinary maps.")),
], { summary: (r, ctx) => TYPE_LOOKUP(CONDITION_ARGS, (t, c) => c.names.condition(t))(r, ctx) });

const actionRecord = (briefing: boolean) => struct("Action", [
  u32("location", LOCATION1), u32("text", STRING), u32("wav", STRING),
  u32("time", perType(briefing ? BRIEFING_ARGS : ACTION_ARGS, ["time", "seconds"], "unused for this type"), msg("Milliseconds, or seconds for Set Countdown Timer.")),
  u32("player", PLAYER_GROUP),
  u32("target", perType(briefing ? BRIEFING_ARGS : ACTION_ARGS, ["player2", "location2", "amount", "percent", "switch", "aiScript", "cuwp", "createSlot", "slot"], "unused for this type"), msg("Second player, destination location, amount, switch, AI script or properties slot, per type. Create Unit reads a properties slot here too: 1 to 64 uses that slot, anything else none.")),
  u16("unitId", perType(briefing ? BRIEFING_ARGS : ACTION_ARGS, ["unit", "resource", "score", "alliance"], "unused for this type"), msg("Unit id, resource, score type or alliance status, per type.")),
  u8("type", briefing ? BRIEFING_TYPE : ACTION_TYPE),
  u8("modifier", perType(briefing ? BRIEFING_ARGS : ACTION_ARGS, ["count", "modifier", "switchAction", "unitState", "order"], "unused for this type"), msg("Unit count (0 = all, except Create Unit, where 0 makes one), set/add/subtract, switch action, state or order, per type.")),
  u8("flags", flags(ACTION_FLAG_BITS), msg("0x02 disables the action and 0x04 always displays its text; the other bits are editor and game bookkeeping.")), u8("padding", HEX), u16("mask", HEX, msg("EUD mask; 0 in ordinary maps.")),
], { summary: (r, ctx) => TYPE_LOOKUP(briefing ? BRIEFING_ARGS : ACTION_ARGS, (t, c) => c.names.action(t, briefing))(r, ctx) });

const triggerRecord = (briefing: boolean) => struct(briefing ? "Briefing" : "Trigger", [
  array("conditions", CONDITION_RECORD, 16, { colors: "cycle", item: (i) => `condition ${i}` }),
  array("actions", actionRecord(briefing), 64, { colors: "cycle", item: (i) => `action ${i}` }),
  u32("flags", flags(TRIGGER_FLAG_BITS), msg("0x02 makes the player count as having won each time the actions run: every other player still in the game is defeated, and the player plays on. The game sets 0x01, 0x10, 0x20 and 0x40 itself while the trigger runs; StarEdit saves them as 0, but a file that sets them is obeyed.")),
  array("players", u8("runs for", BOOL), 27, { item: (i, ctx) => ctx.names.playerGroup(i), doc: msg("One byte per player group; non-zero means the trigger runs for that group.") }),
  u8("currentAction", NUM, msg("The game's bookkeeping: with flag 0x01 set, the next action to run. StarEdit writes 0.")),
], {
  summary: (_r, ctx, data, start) => {
    const conditions: string[] = [];
    for (let i = 0; i < 16; i++) { const t = data[start + i * 20 + 15]; if (t) conditions.push(ctx.names.condition(t)); }
    const actions: string[] = [];
    for (let i = 0; i < 64; i++) { const t = data[start + 320 + i * 32 + 26]; if (t) actions.push(ctx.names.action(t, briefing)); }
    const owners: string[] = [];
    for (let i = 0; i < 27; i++) if (data[start + 2372 + i]) owners.push(ctx.names.playerGroup(i));
    return `${owners.join(", ") || "nobody"}: ${conditions.length} condition${conditions.length === 1 ? "" : "s"}, ${actions.slice(0, 3).join(", ")}${actions.length > 3 ? ` +${actions.length - 3}` : actions.length ? "" : "no actions"}`;
  },
});

export const CUWP_RECORD = struct("Unit properties", [
  u16("validSpecialProperties", flags(CUWP_VALID_BITS)), u16("validElements", flags(CUWP_ELEMENT_BITS)),
  u8("owner", PLAYER, msg("Unused: the action's player owns the units.")), u8("hitPoints", PERCENT), u8("shields", PERCENT), u8("energy", PERCENT),
  u32("resources", NUM, msg("Only the low 16 bits are kept.")), u16("hangar", NUM, msg("Only the low byte is kept.")),
  u16("flags", flags(UNIT_STATE_BITS), msg("The special states. Cloaked and burrowed apply only if the owner has the ability that allows it.")), u32("unused", HEX),
]);

/* ── Whole sections ─────────────────────────────────────── */

export const SECTION_DOCS: Record<string, string> = {
  "TYPE": msg("The map type: RAWS for a StarCraft file, RAWB for Brood War. The game looks for it but never reads what it holds."),
  "VER ": msg("The file's revision. The game reads it first, and it decides which sections the game reads next."),
  "IVER": msg("An older StarEdit version stamp. Only editors read it, and StarEdit no longer writes it."),
  "IVE2": msg("StarEdit's version stamp (11 in a map StarEdit saves for Brood War). Only editors read it."),
  "VCOD": msg("The verification table: 256 seeds and 16 operations. When it reads a map, the game hashes the player types (OWNR) and races (SIDE) with this table and with its own, and refuses the map when the answers differ. Nothing else in the map goes in. StarEdit writes the game's own table, the only one that passes for every set of players."),
  "IOWN": msg("StarEdit's copy of the player types. The game reads OWNR, never this."),
  "OWNR": msg("Who controls each of the twelve player slots: human, computer, rescuable, neutral, … The game does not check the values; with SIDE, it is what VCOD covers."),
  "ERA ": msg("The tileset. Brood War reads the low three bits; the original StarCraft refuses a value above 4. An Installation map can be played only as Use Map Settings."),
  "DIM ": msg("Map width and height in tiles. The game checks the section's length, not the values; Remastered refuses a side above 256."),
  "SIDE": msg("The race of each of the twelve player slots. In Use Map Settings, a User Selectable player gets melee starting units, and the units the map places for them are left out, all but the neutral kinds."),
  "MTXM": msg("The terrain the game draws: one 16-bit tile number per tile, row by row, doodads included. A number is a tile group times 16 plus a variation, 0 to 15; the top bit, 0x8000, takes no part, except on a mod's tileset of more than 2,048 groups, where it is part of the group. The game accepts up to 131,072 bytes and uses the first width × height tiles."),
  "PUNI": msg("Unit availability: for each player and unit type whether it can be built, a default per type, and whether each player takes the default. Only Use Map Settings reads it."),
  "UPGR": msg("Upgrade restrictions, original layout (46 upgrades): per-player highest and starting levels, defaults, and whether each player takes them. Read in a VER 59, 63 or 64 file; a Brood War file's copy is never read."),
  "PTEC": msg("Technology restrictions, original layout (24 technologies): per-player availability and researched state, defaults, and whether each player takes them. Read in a VER 59, 63 or 64 file; a Brood War file's copy is never read."),
  "UNIT": msg("Placed units, 36 bytes each. When a game starts, start locations make no unit, units of a player not in the game are dropped, and melee keeps only Player 12's resources and critters. Start locations come from the last UNIT section alone."),
  "ISOM": msg("The isometric terrain lattice the isometric brush works on: one rect per diamond, four edge values each. Only editors read it."),
  "TILE": msg("StarEdit's copy of the terrain without doodads: what is under each doodad. Same layout as MTXM. Only editors read it."),
  "DD2 ": msg("Placed doodads, 8 bytes each. Only editors read it; the game sees a doodad as its tiles in MTXM and its sprite in THG2."),
  "THG2": msg("Sprites, 10 bytes each. A pure sprite (flag 0x1000) is a picture: a tree top, a glow, a doodad's overlay. Without it the record is a unit sprite, which the game makes into a unit of that type: doors and traps. A unit sprite is made only in Use Map Settings or for Player 12."),
  "MASK": msg("Fog of war: one byte per tile, one bit per player 1–8, set where that player starts unexplored. Only Use Map Settings reads it, and it needs it: without MASK a Use Map Settings game does not start. Tiles past the end of a short MASK start unexplored."),
  "STR ": msg("The string table: a 16-bit count, one 16-bit offset per string (string 1 first), then the text, each string ending in a 0 byte. Number 0 means no string. The table does not say how its bytes spell characters: StarEdit wrote the code page of its Windows, and Remastered reads each string as UTF-8, then Korean (CP949), then Windows-1252."),
  "STRx": msg("The Remastered string table: like STR with a 32-bit count and offsets, so it has no 64 KB limit. Only Remastered reads it, and only in a VER 64 or 206 file, where it replaces STR whatever the order in the file."),
  "UPRP": msg("The 64 unit properties slots, 20 bytes each. Create Unit with Properties names a slot from 1 to 64, and so can plain Create Unit, in the same field."),
  "UPUS": msg("Which of the 64 UPRP slots StarEdit considers in use. Only editors read it."),
  "MRGN": msg("Locations, 20 bytes each: exactly 64 in a VER 59 file and 255 from VER 63 up; any other length refuses the map. Slot 63, counting from 0, is Anywhere, which triggers store as location 64. The game takes each box as stored, so one with its edges swapped never finds units."),
  "TRIG": msg("Triggers, 2400 bytes each: 16 conditions, 64 actions, flags, one byte per player group and the game's current-action byte. Only Use Map Settings runs them, but Remastered's map list reads them for every map."),
  "MBRF": msg("Mission briefings: the same record as TRIG with briefing action types. Without it, or at a length that is not whole records, the map plays without a briefing."),
  "SPRP": msg("The string numbers of the scenario's name and description. For a name of 0, past the table or empty, the map list shows the file name."),
  "FORC": msg("Forces: which force each of Players 1 to 8 belongs to, the four force names, and per-force flags. A shorter section is filled out with zeros; a longer one refuses the map."),
  "WAV ": msg("StarEdit's list of the sound files in the archive (staredit\\wav\\…): 512 string numbers. The game never reads it; Play WAV and Transmission store the string number of their sound themselves."),
  "UNIS": msg("Unit settings, original layout: per unit type a use-default byte, hit points (×256), shields, armour, build time, costs and name; then 100 weapons' damage and bonus. Read in a VER 59, 63 or 64 file; a Brood War file's copy is never read."),
  "UPGS": msg("Upgrade settings, original layout (46 upgrades): use-default, then mineral, gas and time costs for the first level and for each level after. Read in a VER 59, 63 or 64 file; a Brood War file's copy is never read."),
  "TECS": msg("Technology settings, original layout (24 technologies): use-default, then mineral, gas, time and energy costs. Read in a VER 59, 63 or 64 file; a Brood War file's copy is never read."),
  "SWNM": msg("Switch names: 256 string numbers, 0 for an unnamed switch. Only editors read it."),
  "COLR": msg("The colours of Players 1 to 8. Each byte names a colour slot, 0 to 11, and the player takes the colour that slot had, so two players naming each other's slots swap colours. Read only in a VER 205 or 206 file."),
  "PUPx": msg("Upgrade restrictions, Brood War layout (61 upgrades). In a VER 59, 63 or 64 file the game reads it on top of UPGR."),
  "PTEx": msg("Technology restrictions, Brood War layout (44 technologies). In a VER 59, 63 or 64 file the game reads it on top of PTEC."),
  "UNIx": msg("Unit settings, Brood War layout: as UNIS with 130 weapons. In a VER 59, 63 or 64 file the game reads it on top of UNIS."),
  "UPGx": msg("Upgrade settings, Brood War layout (61 upgrades, one unused byte after the use-default column). In a VER 59, 63 or 64 file the game reads it on top of UPGS."),
  "TECx": msg("Technology settings, Brood War layout (44 technologies). In a VER 59, 63 or 64 file the game reads it on top of TECS."),
  "CRGB": msg("Remastered's player colours: three bytes per player, then a mode per player. Random and Player choice ignore the bytes; Custom uses them as red, green and blue; Palette (3, or any mode above) takes the third byte as a colour number, 0 to 21, and in a VER 205 or 206 file COLR is applied over it."),
};

const UNIT_TYPES = 228;
const PLAYERS = 12;

const perUnit = (of: Schema, label: string, doc?: string) => array(label, of, UNIT_TYPES, { item: (i, ctx) => ctx.names.unit(i), doc });
const perUpgrade = (of: Schema, label: string, n: number, doc?: string) => array(label, of, n, { item: (i, ctx) => ctx.names.upgrade(i), doc });
const perTech = (of: Schema, label: string, n: number, doc?: string) => array(label, of, n, { item: (i, ctx) => ctx.names.tech(i), doc });
const perPlayer = (of: Schema, label: string, doc?: string) => array(label, of, PLAYERS, { item: (i, ctx) => ctx.names.player(i), doc });
const perWeapon = (of: Schema, label: string, n: number, doc?: string) => array(label, of, n, { item: (i, ctx) => ctx.names.weapon(i), doc });
const cell = (i: number, ctx: Ctx) => `(${ctx.width ? i % ctx.width : i}, ${ctx.width ? Math.floor(i / ctx.width) : 0})`;

/** A CRGB entry, read by its player's mode byte (at 24 + player): its colour, or what the mode does instead. */
const crgbSummary = (r: (label: string) => number, _ctx: Ctx, data: Uint8Array, start: number): string => {
  const mode = data[24 + Math.floor(start / 3)] ?? 0;
  const hex = `#${[r("r"), r("g"), r("b")].map((c) => c.toString(16).padStart(2, "0")).join("")}`;
  if (mode === 2) return `${hex} (Custom)`;
  if (mode >= 3) return `Palette: ${COLOR_NAMES[r("b")] ?? `colour ${r("b")}`} (the third byte)`;
  return `${mode === 0 ? "Random" : "Player choice"}: the bytes are not used`;
};
/** The third byte of a CRGB entry: blue for Custom, a colour number for Palette. */
const PALETTE_BYTE: Semantic = { edit: "number", describe: (v) => `blue for Custom; for Palette, ${COLOR_NAMES[v] ?? `colour ${v}`}` };

function unitSettings(weapons: number): Schema {
  return struct("Unit settings", [
    perUnit(u8("useDefault", USE_DEFAULT), "useDefault", msg("0 = this section's values for the type; anything else = the game's own, and the rest of the section is ignored for it, the name included.")),
    perUnit(u32("hitPoints", FIXED256), "hitPoints", msg("Hit points × 256.")),
    perUnit(u16("shields", NUM), "shields"),
    perUnit(u8("armor", NUM), "armor"),
    perUnit(u16("buildTime", FRAMES), "buildTime", msg("Game frames.")),
    perUnit(u16("minerals", NUM), "minerals"),
    perUnit(u16("gas", NUM), "gas"),
    perUnit(u16("name", STRING), "name", msg("String index of a custom name, 0 for the default.")),
    perWeapon(u16("damage", NUM), "weaponDamage", weapons, msg("Set only while the game sets up a unit type that fires the weapon and does not use the game's own values; a unit with a turret takes its weapons from the turret.")),
    perWeapon(u16("bonus", NUM), "weaponBonus", weapons),
  ]);
}

function upgradeSettings(n: number, pad: boolean): Schema {
  return struct("Upgrade settings", [
    perUpgrade(u8("useDefault", USE_DEFAULT), "useDefault", n, msg("0 = this section's values; anything else = the game's own.")),
    ...(pad ? [u8("pad", HEX, msg("Unused."))] : []),
    perUpgrade(u16("mineralBase", NUM), "mineralBase", n), perUpgrade(u16("mineralFactor", NUM), "mineralFactor", n),
    perUpgrade(u16("gasBase", NUM), "gasBase", n), perUpgrade(u16("gasFactor", NUM), "gasFactor", n),
    perUpgrade(u16("timeBase", FRAMES), "timeBase", n), perUpgrade(u16("timeFactor", FRAMES), "timeFactor", n),
  ]);
}

function techSettings(n: number): Schema {
  return struct("Technology settings", [
    perTech(u8("useDefault", USE_DEFAULT), "useDefault", n, msg("0 = this section's values; anything else = the game's own.")),
    perTech(u16("minerals", NUM), "minerals", n), perTech(u16("gas", NUM), "gas", n),
    perTech(u16("time", FRAMES), "time", n), perTech(u16("energy", NUM), "energy", n),
  ]);
}

function upgradeRestrictions(n: number): Schema {
  return struct("Upgrade restrictions", [
    perPlayer(perUpgrade(u8("maxLevel", NUM), "max level", n), "playerMaxLevel"),
    perPlayer(perUpgrade(u8("startLevel", NUM), "start level", n), "playerStartLevel"),
    perUpgrade(u8("defaultMax", NUM), "defaultMaxLevel", n),
    perUpgrade(u8("defaultStart", NUM), "defaultStartLevel", n),
    perPlayer(perUpgrade(u8("usesDefault", USES_DEFAULTS), "uses default", n), "playerUsesDefault"),
  ]);
}

function techRestrictions(n: number): Schema {
  return struct("Technology restrictions", [
    perPlayer(perTech(u8("available", BOOL), "available", n), "playerAvailable"),
    perPlayer(perTech(u8("researched", BOOL), "researched", n), "playerResearched"),
    perTech(u8("defaultAvailable", BOOL), "defaultAvailable", n),
    perTech(u8("defaultResearched", BOOL), "defaultResearched", n),
    perPlayer(perTech(u8("usesDefault", USES_DEFAULTS), "uses default", n), "playerUsesDefault"),
  ]);
}

/** A fixed schema for a section name, or null when the layout depends on the bytes. */
export function schemaFor(name: string, ctx: Ctx): Schema | null {
  const w = ctx.width, h = ctx.height;
  switch (name) {
    case "TYPE": return struct("Map type", [chars("type", 4, MAP_TYPE)]);
    case "VER ": return struct("Version", [u16("version", VER)]);
    case "IVER": return struct("StarEdit version", [u16("version", NUM)]);
    case "IVE2": return struct("StarEdit version", [u16("version", NUM)]);
    case "VCOD": return struct("Verification", [array("seeds", u32("seed", HEX), 256, { colors: "alternate" }), array("opcodes", u8("op", NUM), 16)]);
    case "IOWN": case "OWNR": return perPlayer(u8("controller", PLAYER_TYPE), "Controllers");
    case "ERA ": return struct("Tileset", [u16("tileset", ERA)]);
    case "DIM ": return struct("Dimensions", [u16("width", NUM), u16("height", NUM)]);
    case "SIDE": return perPlayer(u8("race", RACE), "Races");
    case "MTXM": case "TILE": return array("Tiles", u16("tile", TILE), w * h, { item: cell });
    case "MASK": return array("Fog", u8("fog", flags(MASK_BITS)), w * h, { item: cell });
    case "ISOM": return array("Diamonds", struct("Diamond", [u16("left", HEX), u16("top", HEX), u16("right", HEX), u16("bottom", HEX)]), (Math.floor(w / 2) + 1) * (h + 1), { item: (i) => { const iw = Math.floor(w / 2) + 1; return `(${i % iw}, ${Math.floor(i / iw)})`; } });
    case "PUNI": return struct("Unit availability", [
      perPlayer(perUnit(u8("available", BOOL), "can build"), "playerAvailable"),
      perUnit(u8("defaultAvailable", BOOL), "defaultAvailable"),
      perPlayer(perUnit(u8("usesDefault", USES_DEFAULTS), "uses default"), "playerUsesDefault"),
    ]);
    case "UPGR": return upgradeRestrictions(46);
    case "PUPx": return upgradeRestrictions(61);
    case "PTEC": return techRestrictions(24);
    case "PTEx": return techRestrictions(44);
    case "UPRP": return array("CUWP slots", CUWP_RECORD, 64, { item: (i) => `slot ${i + 1}` });
    case "UPUS": return array("CUWP slots used", u8("used", BOOL), 64, { item: (i) => `slot ${i + 1}` });
    case "SPRP": return struct("Scenario properties", [u16("name", STRING), u16("description", STRING)]);
    case "FORC": return struct("Forces", [
      array("playerForce", u8("force", FORCE), 8, { item: (i, c) => c.names.player(i) }),
      array("forceName", u16("name", STRING), 4, { item: (i) => `Force ${i + 1}` }),
      array("forceFlags", u8("flags", flags(FORCE_FLAG_BITS)), 4, { item: (i) => `Force ${i + 1}` }),
    ]);
    case "WAV ": return array("Sounds", u32("path", STRING), 512, { item: (i) => `slot ${i}` });
    case "UNIS": return unitSettings(100);
    case "UNIx": return unitSettings(130);
    case "UPGS": return upgradeSettings(46, false);
    case "UPGx": return upgradeSettings(61, true);
    case "TECS": return techSettings(24);
    case "TECx": return techSettings(44);
    case "SWNM": return array("Switch names", u32("name", STRING), 256, { item: (i) => `Switch ${i + 1}` });
    case "COLR": return array("Colours", u8("colour", COLR_SLOT), 8, { item: (i, c) => c.names.player(i) });
    case "CRGB": return struct("Remastered colours", [
      array("rgb", struct("RGB", [u8("r", NUM), u8("g", NUM), u8("b", PALETTE_BYTE)], { summary: crgbSummary }), 8, { item: (i, c) => c.names.player(i) }),
      array("mode", u8("mode", COLOR_MODE), 8, { item: (i, c) => c.names.player(i) }),
    ]);
    default: return null;
  }
}

/** Record schemas for the list sections: as many records as fit. */
export function recordFor(name: string): Schema | null {
  switch (name) {
    case "UNIT": return UNIT_RECORD;
    case "THG2": return SPRITE_RECORD;
    case "DD2 ": return DOODAD_RECORD;
    case "MRGN": return LOCATION_RECORD;
    case "TRIG": return triggerRecord(false);
    case "MBRF": return triggerRecord(true);
    default: return null;
  }
}

const listLabel: Record<string, [string, (i: number, ctx: Ctx) => string]> = {
  "UNIT": ["Units", (i) => `unit ${i}`],
  "THG2": ["Sprites", (i) => `sprite ${i}`],
  "DD2 ": ["Doodads", (i) => `doodad ${i}`],
  "MRGN": ["Locations", (i, ctx) => `${i}: ${ctx.names.location(i)}`],
  "TRIG": ["Triggers", (i) => `trigger ${i}`],
  "MBRF": ["Briefings", (i) => `briefing ${i}`],
};

/** STR / STRx: the count, the offsets, and one leaf per distinct string blob the offsets point at. */
function stringTable(bytes: Uint8Array, env: Env, wide: boolean): Node {
  const width = wide ? 4 : 2;
  const read = (at: number) => (at + width <= bytes.length ? (wide ? (bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16) | (bytes[at + 3] << 24)) >>> 0 : bytes[at] | (bytes[at + 1] << 8)) : 0);
  const count = read(0);
  const listed = Math.max(0, Math.min(count, Math.floor((bytes.length - width) / width)));
  const offsetOf = (i: number) => read(i * width);
  const users = new Map<number, number[]>();
  for (let i = 1; i <= listed; i++) {
    const off = offsetOf(i);
    const list = users.get(off);
    if (list) list.push(i); else users.set(off, [i]);
  }
  const blobs = [...users.keys()].filter((o) => o < bytes.length).sort((a, b) => a - b);
  const blobNodes: Node[] = blobs.map((off) => {
    let end = off;
    while (end < bytes.length && bytes[end] !== 0) end++;
    const indices = users.get(off)!;
    return leaf(`#${indices[0]}${indices.length > 1 ? ` (+${indices.length - 1})` : ""}`, off, Math.min(bytes.length, end + 1) - off, "chars", {
      doc: t("{n, plural, one {String index {list}} other {String indexes {list}}}, NUL-terminated. The text box shows and edits one character per byte.", { n: indices.length, list: indices.join(", ") }),
      semantic: { edit: "text", describe: () => readsAs(bytes, off, end, env.ctx.encoding) },
      color: blobs.indexOf(off) % 8,
    });
  });
  const strings: Node = { label: "strings", start: blobs[0] ?? (listed + 1) * width, size: 0, type: "array", color: 0, band: 0, count: blobNodes.length, child: (i) => blobNodes[i], doc: msg("The text, in offset order. A blob shared by several indices is listed once.") };
  const last = blobNodes[blobNodes.length - 1];
  strings.size = last ? last.start + last.size - strings.start : 0;
  const header = instantiate(struct("header", [wide ? u32("count", NUM) : u16("count", NUM)]), 0, env, 0, 0);
  const offsets = instantiate(array("offsets", wide ? u32("offset", HEX) : u16("offset", HEX), listed, {
    item: (i) => `#${i + 1}`, colors: "alternate",
    doc: msg("Byte offset of each string from the start of the section; index 0 has no entry."),
  }), width, env, 1, 0);
  // The offsets' meaning is the string they point at.
  offsets.child = ((inner) => (i: number) => {
    const n = inner(i);
    n.semantic = { edit: "number", hex: true, describe: (v) => (v < bytes.length ? `→ ${quote(readNul(bytes, v, env.ctx.encoding))}` : "past the end: no string") };
    return n;
  })(offsets.child!);
  return sequence(wide ? "String table (32-bit)" : "String table", [header, offsets, strings]);
}

/** The bytes from `from` to `to` as the editor reads the map's text: in its encoding, latin-1 when it has none or the label is unknown. */
function decodeText(bytes: Uint8Array, from: number, to: number, encoding?: string): string {
  const slice = bytes.subarray(from, to);
  if (encoding) {
    try { return new TextDecoder(encoding).decode(slice); } catch { /* an unknown label: fall through */ }
  }
  let s = "";
  for (const b of slice) s += String.fromCharCode(b);
  return s;
}

const nulFrom = (bytes: Uint8Array, at: number) => { let end = at; while (end < bytes.length && bytes[end] !== 0) end++; return end; };
const readNul = (bytes: Uint8Array, at: number, encoding?: string) => decodeText(bytes, at, nulFrom(bytes, at), encoding);

/** A string blob's text in the map's encoding, when that differs from its bytes taken one character each. */
function readsAs(bytes: Uint8Array, from: number, to: number, encoding?: string): string {
  if (!encoding || bytes.subarray(from, to).every((b) => b < 0x80)) return "";
  return `reads as ${quote(decodeText(bytes, from, to, encoding), 64)} (${encoding})`;
}

/** What the game does with a section's length, by name: the CHK reference's "The game accepts". */
type LengthRule = "exact" | "editors" | "any" | "atMost" | "records" | "briefings" | "terrain";
const LENGTH_RULES: Record<string, LengthRule> = {
  "VER ": "exact", "VCOD": "exact", "OWNR": "exact", "ERA ": "exact", "DIM ": "exact", "SIDE": "exact", "PUNI": "exact",
  "UPGR": "exact", "PTEC": "exact", "UPRP": "exact", "MRGN": "exact", "SPRP": "exact", "UNIS": "exact", "UPGS": "exact",
  "TECS": "exact", "COLR": "exact", "PUPx": "exact", "PTEx": "exact", "UNIx": "exact", "UPGx": "exact", "TECx": "exact", "CRGB": "exact",
  "TYPE": "any", "MASK": "any", "STR ": "any", "STRx": "any",
  "IVER": "editors", "IVE2": "editors", "IOWN": "editors", "ISOM": "editors", "TILE": "editors", "DD2 ": "editors",
  "UPUS": "editors", "WAV ": "editors", "SWNM": "editors",
  "FORC": "atMost", "UNIT": "records", "THG2": "records", "TRIG": "records", "MBRF": "briefings", "MTXM": "terrain",
};

function trailingDoc(name: string): string {
  switch (LENGTH_RULES[name]) {
    case "exact": return msg("Bytes past the end of the layout. The game takes this section only at exactly its size: with these bytes it refuses the map.");
    case "atMost": return msg("Bytes past the end of the layout. The game takes this section up to its size and fills a short one with zeros, but a longer one refuses the map.");
    case "records": return msg("Bytes past the last whole record. The game takes only whole records here: a length like this refuses the map.");
    case "briefings": return msg("Bytes past the last whole briefing. With a length like this the map plays without a briefing.");
    case "terrain": return msg("Tiles past the map's width × height. The game uses only the first width × height, and refuses the map when the section is longer than 131,072 bytes.");
    case "editors": return msg("Bytes past the end of the layout. Only editors read this section, so they make no difference to the game.");
    case "any": return msg("Bytes past the end of the layout. The game accepts this section at any length and does not use them.");
    default: return msg("Bytes past the end of the layout.");
  }
}

/**
 * The layout of one section's bytes, or null for a name nothing here knows. The root
 * covers the whole section: a layout shorter than the bytes gets a trailing leaf, one
 * longer than them keeps its full shape (the inspector says which fields lie past the end).
 */
export function sectionLayout(name: string, bytes: Uint8Array, ctx: Ctx): Node | null {
  const env: Env = { bytes: () => bytes, ctx };
  let root: Node;
  if (name === "STR " || name === "STRx") {
    root = stringTable(bytes, env, name === "STRx");
  } else {
    const record = recordFor(name);
    if (record) {
      const stride = sizeOf(record);
      const count = Math.floor(bytes.length / stride);
      const [label, item] = listLabel[name];
      root = instantiate(array(label, record, count, { item }), 0, env);
    } else {
      const schema = schemaFor(name, ctx);
      if (!schema) return null;
      root = instantiate(schema, 0, env);
    }
  }
  root.doc = root.doc ?? SECTION_DOCS[name];
  if (root.size < bytes.length) {
    const rest = leaf("trailing bytes", root.size, bytes.length - root.size, "bytes", { doc: trailingDoc(name), color: 7 });
    const seq = sequence(root.label, [root, rest], root.doc);
    return seq;
  }
  return root;
}

/** The byte length the layout expects for a whole-section schema, or null for lists and unknown names. */
export function expectedSize(name: string, ctx: Ctx): number | null {
  const s = schemaFor(name, ctx);
  return s ? sizeOf(s) : null;
}

/** The record length of a list section, or null. */
export function recordSize(name: string): number | null {
  const r = recordFor(name);
  return r ? sizeOf(r) : null;
}

/** A blank record for a list section (Insert record), or a zero-filled block for a fixed one. */
export function blankRecord(name: string): Uint8Array | null {
  const n = recordSize(name);
  return n ? new Uint8Array(n) : null;
}

/** Every name with a layout here, for the Add Section list. */
export function knownLayouts(): string[] {
  return Object.keys(SECTION_DOCS);
}
