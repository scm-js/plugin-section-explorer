/**
 * The structure of a section's bytes: a tree of nodes, each covering a byte range.
 *
 * A *schema* says what a section looks like (a struct of fields, an array of records)
 * without knowing where it is; `instantiate` puts one at an offset and produces a `Node`
 * tree whose children are made on demand, so a 128 KB terrain section costs nothing
 * until a row of it is on screen. Leaves read their value from the bytes they are given
 * and, through a `Semantic`, say what it means — "Terran Marine", "Location 4", the
 * string behind an index — and how the inspector may edit it.
 *
 * Nothing here knows a UNIT from a TRIG; `layouts.ts` has the sections. `Names` is the
 * slice of the editor's `api.names` the meanings need, so tests can pass a stub.
 */

export type Prim = "u8" | "i8" | "u16" | "i16" | "u32" | "i32" | "chars" | "bytes";

export const PRIM_SIZE: Record<Exclude<Prim, "chars" | "bytes">, number> = { u8: 1, i8: 1, u16: 2, i16: 2, u32: 4, i32: 4 };

export interface NamedValue {
  value: number;
  label: string;
}

/** What the meanings need from the editor (a subset of `api.names`) plus the map's size. */
export interface Names {
  unit(id: number): string;
  units(): NamedValue[];
  upgrade(id: number): string;
  upgrades(): NamedValue[];
  tech(id: number): string;
  techs(): NamedValue[];
  weapon(id: number): string;
  weapons(): NamedValue[];
  playerType(value: number): string;
  playerTypes(): NamedValue[];
  race(value: number): string;
  races(): NamedValue[];
  playerGroup(value: number): string;
  playerGroups(): NamedValue[];
  condition(type: number): string;
  conditions(): NamedValue[];
  action(type: number, briefing?: boolean): string;
  actions(briefing?: boolean): NamedValue[];
  aiScript(code: number): string;
  string(index: number): string | null;
  location(index: number): string;
  switch(index: number): string;
  player(slot: number): string;
  tile(id: number): string | null;
}

export interface Ctx {
  names: Names;
  width: number;
  height: number;
}

/** Sibling values of a leaf, by field label, for meanings that depend on another field (an action's type). */
export type Siblings = (label: string) => number;

/** How a leaf's value is shown and edited. */
export interface Semantic {
  /** The inspector's control: a number box, a drop-down, tick boxes per bit, a text box (chars), or nothing. */
  edit: "number" | "select" | "flags" | "text" | "none";
  /** "Terran Marine", "(3, 4)", "→ \"Hello\"": shown after the raw value. A `chars` leaf gets its text as `text`. */
  describe?: (value: number, ctx: Ctx, siblings: Siblings, text?: string) => string;
  /** The drop-down's entries. */
  options?: (ctx: Ctx) => NamedValue[];
  /** The tick boxes. */
  bits?: { bit: number; label: string }[];
  /** Show the raw value in hex. */
  hex?: boolean;
}

export interface Node {
  label: string;
  /** Absolute offset within the section, and length in bytes. */
  start: number;
  size: number;
  type: Prim | "struct" | "array";
  doc?: string;
  /** Leaves. */
  semantic?: Semantic;
  /** Containers: how many children, and the i-th one. */
  count?: number;
  child?: (i: number) => Node;
  /** Arrays whose elements are all the same size, so the child under an offset is arithmetic. */
  stride?: number;
  /** A one-line account of a container's contents ("Terran Marine, Player 1 at (3, 4)"). */
  summary?: () => string;
  /** Colour index for the hex view: fields cycle through a small palette, records alternate. */
  color: number;
  /** Depth-parity band, so neighbouring records read apart. */
  band: number;
}

/* ── Schemas ────────────────────────────────────────────── */

export interface PrimSchema {
  kind: "prim";
  type: Prim;
  size: number;
  label: string;
  doc?: string;
  semantic?: Semantic;
}

export interface StructSchema {
  kind: "struct";
  label: string;
  fields: Schema[];
  doc?: string;
  summary?: (read: (label: string) => number, ctx: Ctx, bytes: Uint8Array, start: number) => string;
}

export interface ArraySchema {
  kind: "array";
  label: string;
  of: Schema;
  count: number;
  doc?: string;
  /** "Player 3", "(12, 4)", "Terran Marine" — the i-th element's label. */
  item?: (i: number, ctx: Ctx) => string;
  itemDoc?: (i: number, ctx: Ctx) => string | undefined;
  /** Elements take the parent's colour and alternate bands (default), or cycle colours like fields. */
  colors?: "alternate" | "cycle";
}

export type Schema = PrimSchema | StructSchema | ArraySchema;

const sizes = new WeakMap<Schema, number>();

export function sizeOf(s: Schema): number {
  const known = sizes.get(s);
  if (known !== undefined) return known;
  const n = s.kind === "prim" ? s.size : s.kind === "struct" ? s.fields.reduce((sum, f) => sum + sizeOf(f), 0) : sizeOf(s.of) * s.count;
  sizes.set(s, n);
  return n;
}

const prim = (type: Prim, size: number) => (label: string, semantic?: Semantic, doc?: string): PrimSchema => ({ kind: "prim", type, size, label, doc, semantic });

export const u8 = prim("u8", 1);
export const i8 = prim("i8", 1);
export const u16 = prim("u16", 2);
export const i16 = prim("i16", 2);
export const u32 = prim("u32", 4);
export const i32 = prim("i32", 4);
export const chars = (label: string, size: number, semantic?: Semantic, doc?: string): PrimSchema => ({ kind: "prim", type: "chars", size, label, doc, semantic });
export const bytes = (label: string, size: number, doc?: string): PrimSchema => ({ kind: "prim", type: "bytes", size, label, doc, semantic: { edit: "none" } });

export const struct = (label: string, fields: Schema[], extra: Partial<Pick<StructSchema, "doc" | "summary">> = {}): StructSchema =>
  ({ kind: "struct", label, fields, ...extra });

export const array = (label: string, of: Schema, count: number, extra: Partial<Pick<ArraySchema, "doc" | "item" | "itemDoc" | "colors">> = {}): ArraySchema =>
  ({ kind: "array", label, of, count, ...extra });

/* ── Reading values ─────────────────────────────────────── */

export function readPrim(bytes: Uint8Array, type: Prim, at: number, size: number): number {
  const has = (n: number) => at >= 0 && at + n <= bytes.length;
  switch (type) {
    case "u8": return has(1) ? bytes[at] : 0;
    case "i8": return has(1) ? (bytes[at] << 24) >> 24 : 0;
    case "u16": return has(2) ? bytes[at] | (bytes[at + 1] << 8) : 0;
    case "i16": return has(2) ? ((bytes[at] | (bytes[at + 1] << 8)) << 16) >> 16 : 0;
    case "u32": return has(4) ? (bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16) | (bytes[at + 3] << 24)) >>> 0 : 0;
    case "i32": return has(4) ? bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16) | (bytes[at + 3] << 24) : 0;
    case "chars":
    case "bytes":
      return Math.min(size, Math.max(0, bytes.length - at));
  }
}

export function writePrim(bytes: Uint8Array, type: Prim, at: number, value: number): Uint8Array {
  switch (type) {
    case "u8": case "i8": return new Uint8Array([value & 0xff]);
    case "u16": case "i16": return new Uint8Array([value & 0xff, (value >> 8) & 0xff]);
    case "u32": case "i32": return new Uint8Array([value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff]);
    default: return bytes.slice(at, at);
  }
}

/** The text of a `chars` leaf (latin-1, stopping at the first NUL). */
export function readChars(bytes: Uint8Array, at: number, size: number, stopAtNul = true): string {
  let out = "";
  for (let i = at; i < Math.min(bytes.length, at + size); i++) {
    if (stopAtNul && bytes[i] === 0) break;
    out += String.fromCharCode(bytes[i]);
  }
  return out;
}

export const PRIM_RANGE: Record<Exclude<Prim, "chars" | "bytes">, [number, number]> = {
  u8: [0, 0xff], i8: [-128, 127], u16: [0, 0xffff], i16: [-32768, 32767], u32: [0, 0xffffffff], i32: [-2147483648, 2147483647],
};

/* ── Instantiating ──────────────────────────────────────── */

export interface Env {
  bytes: () => Uint8Array;
  ctx: Ctx;
}

export const PALETTE_SIZE = 8;

/** Put a schema at an offset. Children are built when asked for. */
export function instantiate(s: Schema, start: number, env: Env, color = 0, band = 0, label = s.label, doc = s.doc): Node {
  if (s.kind === "prim") return { label, start, size: s.size, type: s.type, doc, semantic: s.semantic, color, band };
  if (s.kind === "struct") {
    const offsets: number[] = [];
    let at = start;
    for (const f of s.fields) { offsets.push(at); at += sizeOf(f); }
    const node: Node = {
      label, start, size: at - start, type: "struct", doc, color, band,
      count: s.fields.length,
      child: (i) => instantiate(s.fields[i], offsets[i], env, i % PALETTE_SIZE, band),
    };
    if (s.summary) {
      const read = (name: string) => {
        const i = s.fields.findIndex((f) => f.label === name);
        const f = s.fields[i];
        return f && f.kind === "prim" ? readPrim(env.bytes(), f.type, offsets[i], f.size) : 0;
      };
      node.summary = () => s.summary!(read, env.ctx, env.bytes(), start);
    }
    return node;
  }
  const stride = sizeOf(s.of);
  const cycle = s.colors === "cycle";
  return {
    label, start, size: stride * s.count, type: "array", doc, color, band, stride,
    count: s.count,
    child: (i) => instantiate(s.of, start + i * stride, env, cycle ? i % PALETTE_SIZE : color, cycle ? band : (band + i) & 1, s.item ? s.item(i, env.ctx) : `${s.of.label} ${i}`, s.itemDoc ? s.itemDoc(i, env.ctx) : s.of.doc),
  };
}

/** A root made of several parts laid end to end (a section that is a few tables in a row). */
export function sequence(label: string, parts: Node[], doc?: string): Node {
  const start = parts[0]?.start ?? 0;
  const end = parts.length ? parts[parts.length - 1].start + parts[parts.length - 1].size : start;
  return { label, start, size: end - start, type: "struct", doc, color: 0, band: 0, count: parts.length, child: (i) => parts[i] };
}

/** A leaf that stands on its own (a remainder, a gap). */
export function leaf(label: string, start: number, size: number, type: Prim, extra: Partial<Node> = {}): Node {
  return { label, start, size, type, color: 0, band: 0, semantic: { edit: "none" }, ...extra };
}

/* ── Walking ────────────────────────────────────────────── */

function childContaining(node: Node, offset: number): Node | null {
  if (!node.count || !node.child) return null;
  if (node.stride) {
    const i = Math.floor((offset - node.start) / node.stride);
    if (i < 0 || i >= node.count) return null;
    const c = node.child(i);
    return offset >= c.start && offset < c.start + c.size ? c : null;
  }
  // Children are in offset order: a binary search finds the one covering the offset.
  let lo = 0, hi = node.count - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const c = node.child(mid);
    if (offset < c.start) hi = mid - 1;
    else if (offset >= c.start + c.size) lo = mid + 1;
    else return c;
  }
  return null;
}

/** The chain of nodes covering an offset, root first; empty when nothing does. */
export function pathAt(root: Node, offset: number): Node[] {
  if (offset < root.start || offset >= root.start + root.size) return [];
  const path: Node[] = [root];
  let node = root;
  for (;;) {
    const c = childContaining(node, offset);
    if (!c) return path;
    path.push(c);
    node = c;
  }
}

/** The leaf at an offset with its record (the nearest ancestor that is a struct) and index in the path. */
export function leafAt(root: Node, offset: number): { leaf: Node; path: Node[] } | null {
  const path = pathAt(root, offset);
  const last = path[path.length - 1];
  return last && !last.child ? { leaf: last, path } : null;
}

/** Every leaf overlapping [from, to), in order. */
export function leavesIn(root: Node, from: number, to: number, visit: (leaf: Node, path: Node[]) => void) {
  const walk = (node: Node, path: Node[]) => {
    if (node.start >= to || node.start + node.size <= from) return;
    if (!node.child || !node.count) { visit(node, path); return; }
    const next = [...path, node];
    let first = 0;
    let last = node.count - 1;
    if (node.stride) {
      first = Math.max(0, Math.floor((from - node.start) / node.stride));
      last = Math.min(node.count - 1, Math.floor((to - 1 - node.start) / node.stride));
    }
    for (let i = first; i <= last; i++) {
      const c = node.child(i);
      if (c.start >= to) break;
      walk(c, next);
    }
  };
  walk(root, []);
}

/** Sibling reader for a leaf: the values of the other fields of its record. */
export function siblingsOf(path: Node[], bytes: Uint8Array): Siblings {
  const record = [...path].reverse().find((n) => n.type === "struct" && n.count);
  return (label) => {
    if (!record?.child || !record.count) return 0;
    for (let i = 0; i < record.count; i++) {
      const c = record.child(i);
      if (c.label === label && !c.child) return readPrim(bytes, c.type as Prim, c.start, c.size);
    }
    return 0;
  };
}

/** A leaf's value, formatted with its meaning. */
export function describe(leaf: Node, bytes: Uint8Array, ctx: Ctx, siblings: Siblings): { value: number; text: string; meaning: string } {
  if (leaf.type === "chars") {
    const text = readChars(bytes, leaf.start, leaf.size);
    const meaning = leaf.semantic?.describe?.(0, ctx, siblings, text) ?? "";
    return { value: 0, text: JSON.stringify(text), meaning };
  }
  if (leaf.type === "bytes") {
    return { value: 0, text: `${Math.min(leaf.size, Math.max(0, bytes.length - leaf.start))} bytes`, meaning: leaf.semantic?.describe?.(0, ctx, siblings) ?? "" };
  }
  const value = readPrim(bytes, leaf.type as Prim, leaf.start, leaf.size);
  const text = leaf.semantic?.hex ? `0x${(value >>> 0).toString(16).toUpperCase().padStart(leaf.size * 2, "0")}` : String(value);
  const meaning = leaf.semantic?.describe?.(value, ctx, siblings) ?? "";
  return { value, text, meaning };
}
