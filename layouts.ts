/**
 * What every CHK section looks like, as schemas over `layout.ts`.
 *
 * The layouts follow the community's Scenario.chk reference
 * (https://wiki.staredit.net/wiki/Scenario.chk) and the editor's own codecs; the
 * meanings — which byte is a unit id, which a string index, which a player — come from
 * the same place. `sectionLayout(name, bytes, ctx)` picks the layout for a section and
 * fits it to the bytes at hand: list sections get as many records as fit, a section
 * longer than its layout gets a trailing-bytes leaf, and a name nothing here knows gets
 * null (the explorer then shows plain bytes).
 */
import {
  array, chars, i32, instantiate, leaf, sequence, sizeOf, struct, u16, u32, u8,
  type Ctx, type Env, type Node, type Schema, type Semantic, type Siblings,
} from "./layout";

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
export const PX: Semantic = { edit: "number", describe: (v) => `tile ${Math.floor(v / 32)}` };
export const TILE: Semantic = {
  edit: "number", hex: true,
  describe: (v, ctx) => { const name = ctx.names.tile(v); return `group ${v >> 4}, tile ${v & 0xf}${name ? ` — ${name}` : ""}`; },
};
export const AI_SCRIPT: Semantic = { edit: "number", hex: true, describe: (v, ctx) => `"${aiChars(v)}" — ${ctx.names.aiScript(v)}` };
const aiChars = (code: number) => String.fromCharCode(code & 0xff, (code >>> 8) & 0xff, (code >>> 16) & 0xff, (code >>> 24) & 0xff).replace(/[^\x20-\x7e]/g, ".");
export const TILESETS = ["Badlands", "Space Platform", "Installation", "Ashworld", "Jungle", "Desert", "Ice", "Twilight"];
export const ERA: Semantic = { edit: "select", options: () => TILESETS.map((label, value) => ({ value, label })), describe: (v) => `${TILESETS[v & 7]}${v > 7 ? ` (only the low 3 bits count)` : ""}` };
export const VER: Semantic = {
  edit: "select",
  options: () => [{ value: 59, label: "59 — StarCraft 1.00" }, { value: 63, label: "63 — Hybrid 1.04" }, { value: 205, label: "205 — Brood War 1.04" }, { value: 206, label: "206 — Remastered 1.21+" }],
  describe: (v) => ({ 59: "StarCraft 1.00 (original)", 63: "Hybrid 1.04", 205: "Brood War 1.04", 206: "Remastered 1.21+" } as Record<number, string>)[v] ?? "unknown revision",
};
export const MAP_TYPE: Semantic = { edit: "text", describe: (_v, _ctx, _s, text) => ({ RAWS: "StarCraft (original / hybrid)", RAWB: "Brood War" } as Record<string, string>)[text ?? ""] ?? "unknown type" };
export const COLOR_NAMES = ["Red", "Blue", "Teal", "Purple", "Orange", "Brown", "White", "Yellow", "Green", "Pale Yellow", "Tan", "Dark Aqua", "Pale Green", "Bluish Grey", "Pale Yellow II", "Cyan", "Pink", "Olive", "Lime", "Navy", "Dark Green", "Black"];
export const COLOR: Semantic = { edit: "select", options: () => COLOR_NAMES.map((label, value) => ({ value, label })), describe: (v) => COLOR_NAMES[v] ?? `colour ${v}` };
export const COLOR_MODE: Semantic = { edit: "select", options: () => [{ value: 0, label: "Random" }, { value: 1, label: "Player choice" }, { value: 2, label: "Custom RGB" }, { value: 3, label: "Palette (COLR)" }], describe: (v) => ["Random", "Player choice", "Custom RGB", "Palette (COLR)"][v] ?? "?" };
export const FORCE: Semantic = { edit: "select", options: () => [0, 1, 2, 3].map((i) => ({ value: i, label: `Force ${i + 1}` })), describe: (v) => `Force ${v + 1}` };
export const PERCENT: Semantic = { edit: "number", describe: (v) => `${v}%` };
export const FRAMES: Semantic = { edit: "number", describe: (v) => `${(v / 15).toFixed(1)} s at Fastest` };
export const MS: Semantic = { edit: "number", describe: (v) => `${(v / 1000).toFixed(2)} s` };
export const SWITCH_STATE_ACTION: Semantic = {
  edit: "select",
  options: () => [{ value: 4, label: "Set" }, { value: 5, label: "Clear" }, { value: 6, label: "Toggle" }, { value: 11, label: "Randomize" }],
  describe: (v) => ({ 4: "Set", 5: "Clear", 6: "Toggle", 11: "Randomize" } as Record<number, string>)[v] ?? "?",
};

/* ── Flag tables ────────────────────────────────────────── */

export const UNIT_VALID_BITS = bits(["Cloak", "Burrow", "In transit", "Hallucinated", "Invincible"]);
export const UNIT_USED_BITS = bits(["Owner", "Hit points", "Shields", "Energy", "Resources", "Hangar", "State"]);
export const UNIT_STATE_BITS = bits(["Cloaked", "Burrowed", "In transit", "Hallucinated", "Invincible"]);
export const UNIT_RELATION_BITS = [{ bit: 0x200, label: "Nydus link" }, { bit: 0x400, label: "Add-on" }];
export const SPRITE_FLAG_BITS = [{ bit: 0x1000, label: "Pure sprite (not a unit)" }, { bit: 0x4000, label: "Flipped" }, { bit: 0x8000, label: "Disabled" }];
export const ELEVATION_BITS = bits(["Low ground excluded", "Medium ground excluded", "High ground excluded", "Low air excluded", "Medium air excluded", "High air excluded"]);
export const TRIGGER_FLAG_BITS = bits(["Conditions met (game)", "Ignore game end", "Preserve trigger", "Disabled", "Ignore display (game)", "Paused (game)", "Wait skip disabled (game)"]);
export const CONDITION_FLAG_BITS = bits(["Unknown (game)", "Disabled", "Always display", "Unit properties used", "Unit type used", "Unit id used"]);
export const ACTION_FLAG_BITS = bits(["Ignore wait once (game)", "Disabled", "Always display", "Unit properties used", "Unit type used", "Unit id used"]);
export const FORCE_FLAG_BITS = bits(["Random start location", "Allies", "Allied victory", "Shared vision"]);
export const MASK_BITS = bits(Array.from({ length: 8 }, (_, i) => `Player ${i + 1} starts unexplored`));
export const CUWP_VALID_BITS = bits(["Cloak", "Burrow", "In transit", "Hallucinated", "Invincible"]);
export const CUWP_ELEMENT_BITS = bits(["Owner", "Hit points", "Shields", "Energy", "Resources", "Hangar", "State"]);

/* ── Trigger argument tables ────────────────────────────── */

type Arg = "player" | "player2" | "unit" | "count" | "location" | "location2" | "text" | "wav" | "time" | "modifier" | "amount" | "percent" | "resource" | "score" | "switch" | "switchAction" | "unitState" | "order" | "alliance" | "aiScript" | "cuwp" | "cmp" | "camount" | "cresource" | "cscore" | "cswitch" | "cswitchState" | "slot";

const CONDITION_ARGS: Record<number, Arg[]> = {
  1: ["cmp", "camount"], 2: ["player", "unit", "cmp", "camount"], 3: ["player", "unit", "location", "cmp", "camount"], 4: ["player", "cmp", "camount", "cresource"],
  5: ["player", "unit", "cmp", "camount"], 6: ["unit"], 7: ["unit", "location"], 8: ["unit"], 9: ["cscore"], 10: ["cresource"], 11: ["cswitch", "cswitchState"],
  12: ["cmp", "camount"], 13: [], 14: ["player", "cmp", "camount"], 15: ["player", "unit", "cmp", "camount"], 16: ["unit"], 17: ["unit", "location"], 18: ["unit"],
  19: ["cscore"], 20: ["cresource"], 21: ["player", "cscore", "cmp", "camount"], 22: [], 23: [],
};

const ACTION_ARGS: Record<number, Arg[]> = {
  1: [], 2: [], 3: [], 4: ["time"], 5: [], 6: [], 7: ["text", "unit", "location", "modifier", "amount", "wav", "time"], 8: ["wav", "time"], 9: ["text"], 10: ["location"],
  11: ["player", "unit", "count", "location", "cuwp"], 12: ["text"], 13: ["switch", "switchAction"], 14: ["modifier", "time"], 15: ["aiScript"], 16: ["aiScript", "location"],
  17: ["text", "unit"], 18: ["text", "unit", "location"], 19: ["text", "resource"], 20: ["text", "unit"], 21: ["text", "score"], 22: ["player", "unit"], 23: ["player", "unit", "count", "location"],
  24: ["player", "unit"], 25: ["player", "unit", "count", "location"], 26: ["player", "modifier", "amount", "resource"], 27: ["player", "modifier", "amount", "score"], 28: ["location"],
  29: ["unit", "time"], 30: [], 31: [], 32: ["unitState"], 33: ["text", "unit", "amount"], 34: ["text", "unit", "amount", "location"], 35: ["text", "amount", "resource"],
  36: ["text", "unit", "amount"], 37: ["text", "score", "amount"], 38: ["player", "unit", "location", "location2"], 39: ["player", "unit", "count", "location", "location2"], 40: ["amount"],
  41: ["text"], 42: ["player", "unit", "location", "unitState"], 43: ["player", "unit", "location", "unitState"], 44: ["player", "unit", "count", "location"], 45: ["player", "unit", "modifier", "amount"],
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

const loc = (ctx: Ctx, v: number) => (v === 0 ? "no location" : ctx.names.location(v - 1));

/** One argument of a condition or action, read off its record. */
function argText(arg: Arg, s: Siblings, ctx: Ctx): string {
  switch (arg) {
    case "player": return ctx.names.playerGroup(s("player"));
    case "player2": return `to ${ctx.names.playerGroup(s("target"))}`;
    case "unit": return ctx.names.unit(s("unitId"));
    case "count": return s("modifier") === 0 ? "all" : `×${s("modifier")}`;
    case "location": return `at ${loc(ctx, s("location"))}`;
    case "location2": return `→ ${loc(ctx, s("target"))}`;
    case "text": return quote(ctx.names.string(s("text")), 32);
    case "wav": { const w = s("wav"); return w === 0 ? "no WAV" : `WAV ${quote(ctx.names.string(w), 24)}`; }
    case "time": return `${s("time")} ms`;
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
    case "cuwp": return `properties slot ${s("target")}`;
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
  const args = (table[t] ?? []).map((a) => argText(a, s, ctx));
  return `${name(t, ctx)}${args.length ? ` — ${args.join(", ")}` : ""}`;
};

/* ── Record schemas ─────────────────────────────────────── */

export const UNIT_RECORD = struct("Unit", [
  u32("serial", HEX, "Unique per unit within the map; Nydus and add-on links refer to it."),
  u16("x", PX, "Centre, in map pixels."), u16("y", PX, "Centre, in map pixels."),
  u16("unitId", UNIT, "units.dat id."),
  u16("relationType", flags(UNIT_RELATION_BITS), "How relatedSerial is linked."),
  u16("validProperties", flags(UNIT_VALID_BITS), "Which special properties the game may read for this unit."),
  u16("validStates", flags(UNIT_USED_BITS), "Which of the fields below are set."),
  u8("owner", PLAYER), u8("hitPoints", PERCENT), u8("shields", PERCENT), u8("energy", PERCENT),
  u32("resources", NUM, "Minerals or gas held by a resource unit."), u16("hangar", NUM, "Interceptors or Scarabs."),
  u16("stateFlags", flags(UNIT_STATE_BITS)), u32("unused", HEX), u32("relatedSerial", HEX, "The unit this one is linked to (a Nydus exit, an add-on's building)."),
], { summary: (r, ctx) => `${ctx.names.unit(r("unitId"))} — ${ctx.names.player(r("owner"))} at (${r("x")}, ${r("y")})` });

export const SPRITE_RECORD = struct("Sprite", [
  u16("spriteId", { edit: "number", describe: (v, ctx, s) => (s("flags") & 0x1000 ? `sprites.dat #${v}` : `unit: ${ctx.names.unit(v)}`) }, "A sprites.dat id for a pure sprite; a units.dat id when the pure-sprite flag is off (doors, traps)."),
  u16("x", PX), u16("y", PX), u8("owner", PLAYER), u8("unused", HEX), u16("flags", flags(SPRITE_FLAG_BITS)),
], { summary: (r, ctx) => `${r("flags") & 0x1000 ? `sprite #${r("spriteId")}` : ctx.names.unit(r("spriteId"))} at (${r("x")}, ${r("y")})` });

export const DOODAD_RECORD = struct("Doodad", [
  u16("doodadId", NUM, "Index into the tileset's dddata.bin."), u16("x", PX, "Centre of the footprint."), u16("y", PX), u8("owner", PLAYER), u8("disabled", BOOL),
], { summary: (r) => `doodad #${r("doodadId")} at (${r("x")}, ${r("y")})` });

export const LOCATION_RECORD = struct("Location", [
  i32("left", PX), i32("top", PX), i32("right", PX), i32("bottom", PX),
  u16("nameIndex", STRING), u16("elevationFlags", flags(ELEVATION_BITS), "A set bit excludes that elevation; 0 is everywhere."),
], { summary: (r, ctx) => `${r("nameIndex") ? quote(ctx.names.string(r("nameIndex")), 24) : "(unnamed)"} — (${r("left")}, ${r("top")})–(${r("right")}, ${r("bottom")})` });

const CONDITION_RECORD = struct("Condition", [
  u32("location", LOCATION1), u32("player", PLAYER_GROUP), u32("amount", NUM), u16("unitId", UNIT),
  u8("comparison", COMPARISON), u8("type", CONDITION_TYPE),
  u8("resource", perType(CONDITION_ARGS, ["cresource", "cscore", "cswitch"], "unused for this type"), "Resource, score type or switch number, per type."),
  u8("flags", flags(CONDITION_FLAG_BITS)), u16("mask", HEX, "EUD mask; 0 in ordinary maps."),
], { summary: (r, ctx) => TYPE_LOOKUP(CONDITION_ARGS, (t, c) => c.names.condition(t))(r, ctx) });

const actionRecord = (briefing: boolean) => struct("Action", [
  u32("location", LOCATION1), u32("text", STRING), u32("wav", STRING), u32("time", MS),
  u32("player", PLAYER_GROUP),
  u32("target", perType(briefing ? BRIEFING_ARGS : ACTION_ARGS, ["player2", "location2", "amount", "percent", "switch", "aiScript", "cuwp", "slot"], "unused for this type"), "Second player, destination location, amount, switch, AI script or properties slot, per type."),
  u16("unitId", perType(briefing ? BRIEFING_ARGS : ACTION_ARGS, ["unit", "resource", "score", "alliance"], "unused for this type"), "Unit id, resource, score type or alliance status, per type."),
  u8("type", briefing ? BRIEFING_TYPE : ACTION_TYPE),
  u8("modifier", perType(briefing ? BRIEFING_ARGS : ACTION_ARGS, ["count", "modifier", "switchAction", "unitState", "order"], "unused for this type"), "Unit count (0 = all), set/add/subtract, switch action, state or order, per type."),
  u8("flags", flags(ACTION_FLAG_BITS)), u8("padding", HEX), u16("mask", HEX, "EUD mask; 0 in ordinary maps."),
], { summary: (r, ctx) => TYPE_LOOKUP(briefing ? BRIEFING_ARGS : ACTION_ARGS, (t, c) => c.names.action(t, briefing))(r, ctx) });

const triggerRecord = (briefing: boolean) => struct(briefing ? "Briefing" : "Trigger", [
  array("conditions", CONDITION_RECORD, 16, { colors: "cycle", item: (i) => `condition ${i}` }),
  array("actions", actionRecord(briefing), 64, { colors: "cycle", item: (i) => `action ${i}` }),
  u32("flags", flags(TRIGGER_FLAG_BITS)),
  array("players", u8("runs for", BOOL), 27, { item: (i, ctx) => ctx.names.playerGroup(i), doc: "One byte per player group; non-zero means the trigger runs for that group." }),
  u8("currentAction", NUM, "The game's bookkeeping; StarEdit writes 0."),
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
  u8("owner", PLAYER), u8("hitPoints", PERCENT), u8("shields", PERCENT), u8("energy", PERCENT),
  u32("resources", NUM), u16("hangar", NUM), u16("flags", flags(UNIT_STATE_BITS)), u32("unused", HEX),
]);

/* ── Whole sections ─────────────────────────────────────── */

export const SECTION_DOCS: Record<string, string> = {
  "TYPE": "The map type: RAWS for an original or hybrid map, RAWB for Brood War.",
  "VER ": "The file format revision. Decides which settings sections the game reads.",
  "IVER": "The StarEdit version that wrote the file (obsolete; 9 or 10). Not required.",
  "IVE2": "The StarEdit version that wrote the file (11 for every release version).",
  "VCOD": "The verification table: 256 seed values and 16 operation codes the game hashes the map's sections with. StarEdit writes the same table into every map; a map with a different one is refused.",
  "IOWN": "StarEdit's copy of the player controllers. The game reads OWNR.",
  "OWNR": "Who controls each of the twelve player slots: human, computer, rescuable, neutral, …",
  "ERA ": "The tileset, as a 16-bit value the game masks to its low three bits.",
  "DIM ": "Map width and height in tiles.",
  "SIDE": "The race of each of the twelve player slots.",
  "MTXM": "The terrain the game draws: one 16-bit tile id per cell, row by row, doodads stamped in. An id is a CV5 group (high 12 bits) and a tile within it (low 4).",
  "PUNI": "Unit availability: for each player and unit type whether it can be built, a global default per type, and whether each player follows the default.",
  "UPGR": "Upgrade restrictions, original layout (46 upgrades): per-player maximum and start levels, global defaults, and whether each player uses them.",
  "PTEC": "Technology restrictions, original layout (24 technologies): per-player availability and researched state, global defaults, and whether each player uses them.",
  "UNIT": "Placed units, 36 bytes each, in the order they were placed.",
  "ISOM": "The isometric terrain lattice StarEdit's isometric brush works on: one cell per diamond, four edge values each. The game ignores it.",
  "TILE": "StarEdit's copy of the terrain without doodads: what is under each doodad. Same layout as MTXM. The game ignores it.",
  "DD2 ": "Placed doodads, 8 bytes each. The game never reads this; it sees the tiles in MTXM and the overlay sprites in THG2.",
  "THG2": "Sprites, 10 bytes each: pure sprites (a sprites.dat id with the pure flag) and unit sprites (doors and traps by units.dat id), plus doodad overlays.",
  "MASK": "Fog of war: one byte per cell, one bit per player 1–8, set where that player starts unexplored. A map without MASK is fully fogged.",
  "STR ": "The string table: a 16-bit count, one 16-bit offset per string (1-based indices), then NUL-terminated latin-1 strings. Index 0 means no string.",
  "STRx": "The Remastered string table: like STR with 32-bit count and offsets, so a map may carry more than 65,535 bytes of text.",
  "UPRP": "The 64 Create Unit with Properties slots (CUWP), 20 bytes each; the action refers to them by slot number.",
  "UPUS": "Which of the 64 CUWP slots are in use (StarEdit's bookkeeping).",
  "MRGN": "Locations, 20 bytes each: 64 slots in an original map, 255 in Brood War. Slot 63 is Anywhere.",
  "TRIG": "Triggers, 2400 bytes each: 16 conditions, 64 actions, flags, one byte per player group and the game's current-action byte.",
  "MBRF": "Mission briefings: the same record as TRIG with briefing action types.",
  "SPRP": "The string indices of the scenario's name and description.",
  "FORC": "Forces: which force each of the eight playable slots belongs to, the four force names, and per-force flags.",
  "WAV ": "The sound table: 512 string indices of the sound files in the archive (staredit\\wav\\…). Play WAV actions store the string index itself.",
  "UNIS": "Unit settings, original layout: per unit type a use-default byte, hit points (×256), shields, armour, build time, costs, name string; then 100 weapon damage and bonus values.",
  "UPGS": "Upgrade settings, original layout (46 upgrades): use-default, then mineral, gas and time base costs and per-level factors.",
  "TECS": "Technology settings, original layout (24 technologies): use-default, then mineral, gas, time and energy costs.",
  "SWNM": "Switch names: 256 string indices, 0 for an unnamed switch.",
  "COLR": "The colour of each of the eight playable slots, as an index into the game's colour table.",
  "PUPx": "Upgrade restrictions, Brood War layout (61 upgrades).",
  "PTEx": "Technology restrictions, Brood War layout (44 technologies).",
  "UNIx": "Unit settings, Brood War layout: as UNIS with 130 weapons.",
  "UPGx": "Upgrade settings, Brood War layout (61 upgrades, one pad byte after the use-default column).",
  "TECx": "Technology settings, Brood War layout (44 technologies).",
  "CRGB": "Remastered player colours: an RGB triple per playable slot, then a mode byte per slot saying whether the game uses it, the lobby choice, a random colour or COLR.",
};

const UNIT_TYPES = 228;
const PLAYERS = 12;

const perUnit = (of: Schema, label: string, doc?: string) => array(label, of, UNIT_TYPES, { item: (i, ctx) => ctx.names.unit(i), doc });
const perUpgrade = (of: Schema, label: string, n: number, doc?: string) => array(label, of, n, { item: (i, ctx) => ctx.names.upgrade(i), doc });
const perTech = (of: Schema, label: string, n: number, doc?: string) => array(label, of, n, { item: (i, ctx) => ctx.names.tech(i), doc });
const perPlayer = (of: Schema, label: string, doc?: string) => array(label, of, PLAYERS, { item: (i, ctx) => ctx.names.player(i), doc });
const perWeapon = (of: Schema, label: string, n: number) => array(label, of, n, { item: (i, ctx) => ctx.names.weapon(i) });
const cell = (i: number, ctx: Ctx) => `(${ctx.width ? i % ctx.width : i}, ${ctx.width ? Math.floor(i / ctx.width) : 0})`;

function unitSettings(weapons: number): Schema {
  return struct("Unit settings", [
    perUnit(u8("useDefault", BOOL), "useDefault", "1 = the game uses units.dat / weapons.dat for this type."),
    perUnit(u32("hitPoints", FIXED256), "hitPoints", "Hit points × 256."),
    perUnit(u16("shields", NUM), "shields"),
    perUnit(u8("armor", NUM), "armor"),
    perUnit(u16("buildTime", FRAMES), "buildTime", "Game frames."),
    perUnit(u16("minerals", NUM), "minerals"),
    perUnit(u16("gas", NUM), "gas"),
    perUnit(u16("name", STRING), "name", "String index of a custom name, 0 for the default."),
    perWeapon(u16("damage", NUM), "weaponDamage", weapons),
    perWeapon(u16("bonus", NUM), "weaponBonus", weapons),
  ]);
}

function upgradeSettings(n: number, pad: boolean): Schema {
  return struct("Upgrade settings", [
    perUpgrade(u8("useDefault", BOOL), "useDefault", n),
    ...(pad ? [u8("pad", HEX, "Alignment byte.")] : []),
    perUpgrade(u16("mineralBase", NUM), "mineralBase", n), perUpgrade(u16("mineralFactor", NUM), "mineralFactor", n),
    perUpgrade(u16("gasBase", NUM), "gasBase", n), perUpgrade(u16("gasFactor", NUM), "gasFactor", n),
    perUpgrade(u16("timeBase", FRAMES), "timeBase", n), perUpgrade(u16("timeFactor", FRAMES), "timeFactor", n),
  ]);
}

function techSettings(n: number): Schema {
  return struct("Technology settings", [
    perTech(u8("useDefault", BOOL), "useDefault", n),
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
    perPlayer(perUpgrade(u8("usesDefault", BOOL), "uses default", n), "playerUsesDefault"),
  ]);
}

function techRestrictions(n: number): Schema {
  return struct("Technology restrictions", [
    perPlayer(perTech(u8("available", BOOL), "available", n), "playerAvailable"),
    perPlayer(perTech(u8("researched", BOOL), "researched", n), "playerResearched"),
    perTech(u8("defaultAvailable", BOOL), "defaultAvailable", n),
    perTech(u8("defaultResearched", BOOL), "defaultResearched", n),
    perPlayer(perTech(u8("usesDefault", BOOL), "uses default", n), "playerUsesDefault"),
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
      perPlayer(perUnit(u8("usesDefault", BOOL), "uses default"), "playerUsesDefault"),
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
    case "COLR": return array("Colours", u8("colour", COLOR), 8, { item: (i, c) => c.names.player(i) });
    case "CRGB": return struct("Remastered colours", [
      array("rgb", struct("RGB", [u8("r", NUM), u8("g", NUM), u8("b", NUM)], { summary: (r) => `#${[r("r"), r("g"), r("b")].map((c) => c.toString(16).padStart(2, "0")).join("")}` }), 8, { item: (i, c) => c.names.player(i) }),
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
      doc: `String index${indices.length > 1 ? "es" : ""} ${indices.join(", ")}, NUL-terminated.`,
      semantic: { edit: "text" },
      color: blobs.indexOf(off) % 8,
    });
  });
  const strings: Node = { label: "strings", start: blobs[0] ?? (listed + 1) * width, size: 0, type: "array", color: 0, band: 0, count: blobNodes.length, child: (i) => blobNodes[i], doc: "The text, in offset order. A blob shared by several indices is listed once." };
  const last = blobNodes[blobNodes.length - 1];
  strings.size = last ? last.start + last.size - strings.start : 0;
  const header = instantiate(struct("header", [wide ? u32("count", NUM) : u16("count", NUM)]), 0, env, 0, 0);
  const offsets = instantiate(array("offsets", wide ? u32("offset", HEX) : u16("offset", HEX), listed, {
    item: (i) => `#${i + 1}`, colors: "alternate",
    doc: "Byte offset of each string from the start of the section; index 0 has no entry.",
  }), width, env, 1, 0);
  // The offsets' meaning is the string they point at.
  offsets.child = ((inner) => (i: number) => {
    const n = inner(i);
    n.semantic = { edit: "number", hex: true, describe: (v) => (v < bytes.length ? `→ ${quote(readNul(bytes, v))}` : "past the end") };
    return n;
  })(offsets.child!);
  return sequence(wide ? "String table (32-bit)" : "String table", [header, offsets, strings]);
}

const readNul = (bytes: Uint8Array, at: number) => { let s = ""; for (let i = at; i < bytes.length && bytes[i] !== 0; i++) s += String.fromCharCode(bytes[i]); return s; };

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
    const rest = leaf("trailing bytes", root.size, bytes.length - root.size, "bytes", { doc: "Bytes past the end of the layout. The game ignores what it does not read.", color: 7 });
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
