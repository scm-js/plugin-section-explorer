import { describe, expect, it } from "vitest";
import { describe as describeLeaf, leafAt, leavesIn, pathAt, readPrim, siblingsOf, sizeOf, type Ctx, type Names, type Node } from "../layout";
import { blankRecord, expectedSize, knownLayouts, recordSize, schemaFor, SECTION_DOCS, sectionLayout, UNIT_RECORD } from "../layouts";

/** A stand-in for `api.names` with just enough behaviour to see the meanings come through. */
const names: Names = {
  unit: (id) => (id === 0 ? "Terran Marine" : id === 228 ? "Any unit" : `Unit ${id}`),
  units: () => [{ value: 0, label: "Terran Marine" }],
  upgrade: (id) => `Upgrade ${id}`, upgrades: () => [],
  tech: (id) => `Tech ${id}`, techs: () => [],
  weapon: (id) => `Weapon ${id}`, weapons: () => [],
  playerType: (v) => (v === 6 ? "Human" : `Type ${v}`), playerTypes: () => [],
  race: (v) => (v === 1 ? "Terran" : `Race ${v}`), races: () => [],
  playerGroup: (v) => (v < 12 ? `Player ${v + 1}` : v === 17 ? "All Players" : `Group ${v}`), playerGroups: () => [],
  condition: (t) => (t === 3 ? "Bring" : t === 0 ? "None" : `Condition ${t}`), conditions: () => [],
  action: (t, b) => (b ? `Briefing ${t}` : t === 44 ? "Create Unit" : t === 0 ? "None" : `Action ${t}`), actions: () => [],
  aiScript: () => "Terran Custom Level",
  string: (i) => (i === 1 ? "Hello" : i === 2 ? "A long description of the map" : null),
  location: (i) => (i === 63 ? "Anywhere" : `Location ${i}`),
  switch: (i) => `Switch ${i + 1}`,
  player: (s) => `Player ${s + 1}`,
  tile: (id) => (id >> 4 === 2 ? "Dirt" : null),
};

const ctx: Ctx = { names, width: 4, height: 2 };

const le16 = (v: number) => [v & 0xff, (v >> 8) & 0xff];
const le32 = (v: number) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];

function unitBytes(unitId: number, owner: number, x: number, y: number): number[] {
  return [...le32(1), ...le16(x), ...le16(y), ...le16(unitId), ...le16(0), ...le16(0x1f), ...le16(0x7f), owner, 100, 100, 100, ...le32(0), ...le16(0), ...le16(0), ...le32(0), ...le32(0)];
}

const leafText = (root: Node, bytes: Uint8Array, at: number) => {
  const hit = leafAt(root, at)!;
  return describeLeaf(hit.leaf, bytes, ctx, siblingsOf(hit.path, bytes));
};

describe("record layouts", () => {
  it("size the records the way the file does", () => {
    expect(sizeOf(UNIT_RECORD)).toBe(36);
    expect(recordSize("UNIT")).toBe(36);
    expect(recordSize("THG2")).toBe(10);
    expect(recordSize("DD2 ")).toBe(8);
    expect(recordSize("MRGN")).toBe(20);
    expect(recordSize("TRIG")).toBe(2400);
    expect(recordSize("MBRF")).toBe(2400);
    expect(recordSize("MTXM")).toBeNull();
    expect(blankRecord("UNIT")).toHaveLength(36);
  });

  it("size the fixed sections the way the game's buffers are", () => {
    const at = (name: string) => expectedSize(name, ctx);
    expect(at("TYPE")).toBe(4);
    expect(at("VER ")).toBe(2);
    expect(at("VCOD")).toBe(1040);
    expect(at("OWNR")).toBe(12);
    expect(at("DIM ")).toBe(4);
    expect(at("MTXM")).toBe(4 * 2 * 2);
    expect(at("MASK")).toBe(8);
    expect(at("ISOM")).toBe((Math.floor(4 / 2) + 1) * (2 + 1) * 8);
    expect(at("PUNI")).toBe(5700);
    expect(at("UPGR")).toBe(1748);
    expect(at("PUPx")).toBe(2318);
    expect(at("PTEC")).toBe(912);
    expect(at("PTEx")).toBe(1672);
    expect(at("UNIS")).toBe(4048);
    expect(at("UNIx")).toBe(4168);
    expect(at("UPGS")).toBe(598);
    expect(at("UPGx")).toBe(794);
    expect(at("TECS")).toBe(216);
    expect(at("TECx")).toBe(396);
    expect(at("UPRP")).toBe(1280);
    expect(at("UPUS")).toBe(64);
    expect(at("SPRP")).toBe(4);
    expect(at("FORC")).toBe(20);
    expect(at("WAV ")).toBe(2048);
    expect(at("SWNM")).toBe(1024);
    expect(at("COLR")).toBe(8);
    expect(at("CRGB")).toBe(32);
    expect(at("UNIT")).toBeNull();
    expect(at("STR ")).toBeNull();
    expect(at("NOPE")).toBeNull();
    expect(schemaFor("NOPE", ctx)).toBeNull();
  });

  it("documents every section it lays out", () => {
    for (const name of knownLayouts()) {
      const has = schemaFor(name, ctx) !== null || recordSize(name) !== null || name === "STR " || name === "STRx";
      expect(has, name).toBe(true);
      expect(SECTION_DOCS[name].length).toBeGreaterThan(20);
    }
  });
});

describe("sectionLayout", () => {
  it("lays out a UNIT list with names, coordinates and a summary per record", () => {
    const bytes = new Uint8Array([...unitBytes(0, 0, 96, 64), ...unitBytes(7, 3, 32, 32), 1, 2, 3]);
    const root = sectionLayout("UNIT", bytes, ctx)!;
    expect(root.size).toBe(bytes.length);
    // Two records and the three trailing bytes.
    expect(root.count).toBe(2);
    const list = root.child!(0);
    expect(list.count).toBe(2);
    expect(list.stride).toBe(36);
    expect(list.child!(0).label).toBe("unit 0");
    expect(list.child!(0).summary!()).toBe("Terran Marine — Player 1 at (96, 64)");
    expect(list.child!(1).summary!()).toBe("Unit 7 — Player 4 at (32, 32)");
    const rest = root.child!(1);
    expect(rest).toMatchObject({ label: "trailing bytes", start: 72, size: 3, type: "bytes" });
    // The unit id of the second record: offset 36 + 8.
    const id = leafText(root, bytes, 44);
    expect(id).toEqual({ value: 7, text: "7", meaning: "Unit 7" });
    expect(pathAt(root, 44).map((n) => n.label)).toEqual(["Units", "Units", "unit 1", "unitId"]);
    expect(leafText(root, bytes, 4)).toEqual({ value: 96, text: "96", meaning: "tile 3" });
    expect(leafText(root, bytes, 12).meaning).toBe("Cloak, Burrow, In transit, Hallucinated, Invincible");
    expect(leafText(root, bytes, 14).meaning).toBe("Owner, Hit points, Shields, Energy, Resources, Hangar, State");
    expect(leafText(root, bytes, 73).text).toBe("3 bytes");
    // Bytes past the end of the section are not in any leaf.
    expect(leafAt(root, 75)).toBeNull();
    // Fields cycle through the palette; records alternate bands.
    expect(list.child!(0).child!(0).color).toBe(0);
    expect(list.child!(0).child!(3).color).toBe(3);
    expect(list.child!(0).band).not.toBe(list.child!(1).band);
  });

  it("walks the leaves in a range without touching the rest", () => {
    const bytes = new Uint8Array(36 * 100);
    const root = sectionLayout("UNIT", bytes, ctx)!;
    const seen: string[] = [];
    leavesIn(root, 36 * 50 + 6, 36 * 50 + 12, (leaf, path) => seen.push(`${path[path.length - 1].label}.${leaf.label}`));
    expect(seen).toEqual(["unit 50.y", "unit 50.unitId", "unit 50.relationType"]);
  });

  it("annotates the terrain by cell", () => {
    const bytes = new Uint8Array(16);
    bytes[2 * 5] = 0x23; bytes[2 * 5 + 1] = 0x00;
    const root = sectionLayout("MTXM", bytes, ctx)!;
    expect(root.count).toBe(8);
    expect(root.stride).toBe(2);
    expect(root.child!(5).label).toBe("(1, 1)");
    expect(leafText(root, bytes, 10)).toEqual({ value: 0x23, text: "0x0023", meaning: "group 2, tile 3 — Dirt" });
    const mask = sectionLayout("MASK", new Uint8Array([0b101, 0, 0, 0, 0, 0, 0, 0]), ctx)!;
    expect(leafText(mask, mask && new Uint8Array([0b101, 0, 0, 0, 0, 0, 0, 0]), 0).meaning).toBe("Player 1 starts unexplored, Player 3 starts unexplored");
  });

  it("reads the string table off its own offsets", () => {
    // count 2; offsets 6, 12; "Hello\0", "World\0"
    const bytes = new Uint8Array([...le16(2), ...le16(6), ...le16(12), ...[72, 101, 108, 108, 111, 0], ...[87, 111, 114, 108, 100, 0]]);
    const root = sectionLayout("STR ", bytes, ctx)!;
    expect(root.count).toBe(3);
    const [header, offsets, strings] = [0, 1, 2].map((i) => root.child!(i));
    expect(header.child!(0)).toMatchObject({ label: "count", start: 0, size: 2 });
    expect(offsets.count).toBe(2);
    expect(leafText(root, bytes, 2)).toMatchObject({ value: 6, text: "0x0006", meaning: '→ "Hello"' });
    expect(strings.count).toBe(2);
    expect(strings.child!(0)).toMatchObject({ label: "#1", start: 6, size: 6, type: "chars" });
    expect(strings.child!(1)).toMatchObject({ label: "#2", start: 12, size: 6 });
    expect(leafText(root, bytes, 13).text).toBe('"World"');
    expect(root.size).toBe(bytes.length);
    // Two indices sharing a blob list it once; a count past the data is clipped.
    const shared = new Uint8Array([...le16(3), ...le16(8), ...le16(8), ...le16(200), 65, 0]);
    const r2 = sectionLayout("STR ", shared, ctx)!;
    expect(r2.child!(2).count).toBe(1);
    expect(r2.child!(2).child!(0).label).toBe("#1 (+1)");
    expect(leafText(r2, shared, 6).meaning).toBe("past the end");
    const wide = sectionLayout("STRx", new Uint8Array([...le32(1), ...le32(8), 72, 105, 0]), ctx)!;
    expect(wide.child!(2).child!(0)).toMatchObject({ start: 8, size: 3 });
  });

  it("explains trigger records through their type bytes", () => {
    const bytes = new Uint8Array(2400);
    // condition 0: Bring(All Players, Terran Marine, at location 64, at least 1)
    bytes.set([...le32(64), ...le32(17), ...le32(1), ...le16(0), 0, 3, 0, 0, ...le16(0)], 0);
    // action 0 at 320: Create Unit — Player 1, 5 marines, at location 1
    bytes.set([...le32(1), ...le32(0), ...le32(0), ...le32(0), ...le32(0), ...le32(0), ...le16(0), 44, 5, 0, 0, ...le16(0)], 320);
    bytes[2368] = 0x04; // preserve
    bytes[2372 + 17] = 1; // runs for All Players
    const root = sectionLayout("TRIG", bytes, ctx)!;
    const trig = root.child!(0);
    expect(trig.label).toBe("trigger 0");
    expect(trig.summary!()).toBe("All Players: 1 condition, Create Unit");
    const conditions = trig.child!(0);
    expect(conditions.child!(0).summary!()).toBe("Bring — All Players, Terran Marine, at Anywhere, at least, 1");
    expect(conditions.child!(1).summary!()).toBe("(empty slot)");
    const actions = trig.child!(1);
    expect(actions.child!(0).summary!()).toBe("Create Unit — Player 1, Terran Marine, ×5, at Location 0");
    // The modifier byte's meaning follows the action's type.
    expect(leafText(root, bytes, 320 + 27)).toEqual({ value: 5, text: "5", meaning: "×5" });
    expect(leafText(root, bytes, 320 + 24).meaning).toBe("Terran Marine");
    expect(leafText(root, bytes, 320 + 20).meaning).toBe("unused for this type");
    expect(leafText(root, bytes, 15)).toEqual({ value: 3, text: "3", meaning: "Bring" });
    expect(leafText(root, bytes, 2368).meaning).toBe("Preserve trigger");
    expect(pathAt(root, 2372 + 17).map((n) => n.label)).toEqual(["Triggers", "trigger 0", "players", "All Players"]);
    expect(leafText(root, bytes, 2372 + 17).meaning).toBe("yes");
    const brief = sectionLayout("MBRF", bytes, ctx)!;
    expect(brief.child!(0).child!(1).child!(0).summary!()).toContain("Briefing 44");
  });

  it("lays out the fixed tables by name", () => {
    const own = sectionLayout("OWNR", new Uint8Array([6, 5, 0, 0, 0, 0, 0, 0, 7, 7, 7, 7]), ctx)!;
    expect(own.child!(0).label).toBe("Player 1");
    expect(leafText(own, own && new Uint8Array([6, 5, 0, 0, 0, 0, 0, 0, 7, 7, 7, 7]), 0).meaning).toBe("Human");
    const sprp = sectionLayout("SPRP", new Uint8Array([1, 0, 2, 0]), ctx)!;
    expect(leafText(sprp, new Uint8Array([1, 0, 2, 0]), 0).meaning).toBe('→ "Hello"');
    const type = sectionLayout("TYPE", new Uint8Array([82, 65, 87, 66]), ctx)!;
    expect(leafText(type, new Uint8Array([82, 65, 87, 66]), 0)).toEqual({ value: 0, text: '"RAWB"', meaning: "Brood War" });
    const ver = sectionLayout("VER ", new Uint8Array([205, 0]), ctx)!;
    expect(leafText(ver, new Uint8Array([205, 0]), 0).meaning).toBe("Brood War 1.04");
    const era = sectionLayout("ERA ", new Uint8Array([12, 0]), ctx)!;
    expect(leafText(era, new Uint8Array([12, 0]), 0).meaning).toBe("Jungle (only the low 3 bits count)");
    const unix = sectionLayout("UNIx", new Uint8Array(4168), ctx)!;
    expect(unix.count).toBe(10);
    expect(unix.child!(1).child!(0).label).toBe("Terran Marine");
    expect(unix.child!(8).count).toBe(130);
    const puni = sectionLayout("PUNI", new Uint8Array(5700), ctx)!;
    expect(pathAt(puni, 228 * 3 + 0).map((n) => n.label)).toEqual(["Unit availability", "playerAvailable", "Player 4", "Terran Marine"]);
    const pupx = sectionLayout("PUPx", new Uint8Array(2318), ctx)!;
    expect(pupx.size).toBe(2318);
    const crgb = sectionLayout("CRGB", new Uint8Array([255, 0, 128, ...new Array(21).fill(0), 2, 3, 3, 3, 3, 3, 3, 3]), ctx)!;
    expect(crgb.child!(0).child!(0).summary!()).toBe("#ff0080");
    expect(leafText(crgb, new Uint8Array([255, 0, 128, ...new Array(21).fill(0), 2, 3, 3, 3, 3, 3, 3, 3]), 24).meaning).toBe("Custom RGB");
    expect(sectionLayout("ZZZZ", new Uint8Array(3), ctx)).toBeNull();
    // A section shorter than its layout keeps the layout; the reader answers 0 past the end.
    const short = sectionLayout("DIM ", new Uint8Array([4, 0]), ctx)!;
    expect(short.size).toBe(4);
    expect(readPrim(new Uint8Array([4, 0]), "u16", 2, 2)).toBe(0);
  });
});
