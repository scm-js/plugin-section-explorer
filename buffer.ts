/**
 * The bytes of one section while they are being edited, with an undo history of its own.
 *
 * The editor's undo model covers typed edits (a brush stroke, a unit); a raw edit to the
 * file drops that history, because any part of the document may have changed. So the
 * explorer keeps its edits here — overwrites, inserts and removals, each invertible —
 * and hands the document a finished section on Apply. Pure: no DOM, tested on its own.
 */

/** One invertible step. `at` is where it happened; `before` and `after` are the bytes there. */
export interface Step {
  at: number;
  before: Uint8Array;
  after: Uint8Array;
}

export type BufferListener = () => void;

export class EditBuffer {
  private data: Uint8Array;
  private original: Uint8Array;
  private undoStack: Step[] = [];
  private redoStack: Step[] = [];
  private listeners = new Set<BufferListener>();
  /** Steps within this many ms of each other at adjacent offsets merge into one, so typing a value is one undo. */
  private coalesceMs = 600;
  private lastAt = 0;

  constructor(bytes: Uint8Array) {
    this.original = bytes.slice();
    this.data = bytes.slice();
  }

  get bytes(): Uint8Array { return this.data; }
  get length(): number { return this.data.length; }
  get canUndo(): boolean { return this.undoStack.length > 0; }
  get canRedo(): boolean { return this.redoStack.length > 0; }

  /** Whether the bytes differ from what the buffer started with. */
  get modified(): boolean {
    if (this.data.length !== this.original.length) return true;
    for (let i = 0; i < this.data.length; i++) if (this.data[i] !== this.original[i]) return true;
    return false;
  }

  onChange(l: BufferListener): () => void {
    this.listeners.add(l);
    return () => { this.listeners.delete(l); };
  }

  private notify() { for (const l of this.listeners) l(); }

  /** Overwrite `bytes` at `at`, growing the buffer if they run past the end. */
  set(at: number, bytes: Uint8Array | number[]) {
    const after = bytes instanceof Uint8Array ? bytes.slice() : new Uint8Array(bytes);
    if (after.length === 0 || at < 0 || at > this.data.length) return;
    const end = Math.min(this.data.length, at + after.length);
    const before = this.data.slice(at, end);
    if (before.length === after.length && before.every((b, i) => b === after[i])) return;
    this.apply({ at, before, after }, true);
  }

  /** Insert `bytes` before `at`. */
  insert(at: number, bytes: Uint8Array | number[]) {
    const after = bytes instanceof Uint8Array ? bytes.slice() : new Uint8Array(bytes);
    if (after.length === 0 || at < 0 || at > this.data.length) return;
    this.apply({ at, before: new Uint8Array(0), after }, false);
  }

  /** Remove `count` bytes at `at`. */
  remove(at: number, count: number) {
    if (at < 0 || at >= this.data.length || count <= 0) return;
    const before = this.data.slice(at, Math.min(this.data.length, at + count));
    this.apply({ at, before, after: new Uint8Array(0) }, false);
  }

  /** Replace everything. */
  replace(bytes: Uint8Array) {
    this.apply({ at: 0, before: this.data.slice(), after: bytes.slice() }, false);
  }

  /** Grow or shrink to `length`, zero-filled. */
  resize(length: number) {
    if (length === this.data.length || length < 0) return;
    if (length < this.data.length) this.remove(length, this.data.length - length);
    else this.insert(this.data.length, new Uint8Array(length - this.data.length));
  }

  undo(): boolean {
    const step = this.undoStack.pop();
    if (!step) return false;
    this.run({ at: step.at, before: step.after, after: step.before });
    this.redoStack.push(step);
    this.lastAt = 0;
    this.notify();
    return true;
  }

  redo(): boolean {
    const step = this.redoStack.pop();
    if (!step) return false;
    this.run(step);
    this.undoStack.push(step);
    this.lastAt = 0;
    this.notify();
    return true;
  }

  /** Forget the history but keep the bytes (after an Apply). */
  markClean() {
    this.original = this.data.slice();
    this.undoStack = [];
    this.redoStack = [];
    this.lastAt = 0;
  }

  private apply(step: Step, coalesce: boolean) {
    const now = Date.now();
    const prev = this.undoStack[this.undoStack.length - 1];
    // A run of overwrites at consecutive offsets (typing hex digits, an inspector field) is one step.
    if (coalesce && prev && now - this.lastAt < this.coalesceMs && prev.before.length === prev.after.length
      && step.before.length === step.after.length && step.at >= prev.at && step.at <= prev.at + prev.after.length) {
      const end = Math.max(prev.at + prev.after.length, step.at + step.after.length);
      const before = new Uint8Array(end - prev.at);
      const after = new Uint8Array(end - prev.at);
      before.set(prev.before);
      after.set(prev.after);
      // Bytes past the previous step's reach were untouched until now: their "before" is the current data.
      for (let i = prev.at + prev.after.length; i < end; i++) before[i - prev.at] = this.data[i];
      for (let i = 0; i < step.before.length; i++) if (step.at + i >= prev.at + prev.after.length) before[step.at + i - prev.at] = step.before[i];
      after.set(step.after, step.at - prev.at);
      this.run(step);
      this.undoStack[this.undoStack.length - 1] = { at: prev.at, before, after };
    } else {
      this.run(step);
      this.undoStack.push(step);
    }
    this.redoStack = [];
    this.lastAt = now;
    this.notify();
  }

  private run(step: Step) {
    if (step.before.length === step.after.length) {
      this.data.set(step.after, step.at);
      return;
    }
    const out = new Uint8Array(this.data.length - step.before.length + step.after.length);
    out.set(this.data.subarray(0, step.at), 0);
    out.set(step.after, step.at);
    out.set(this.data.subarray(step.at + step.before.length), step.at + step.after.length);
    this.data = out;
  }
}

/* ── Hex text ───────────────────────────────────────────── */

/** `"0a ff 10"` (any spacing, with or without `0x`, `\x` or commas) → bytes; null when it is not hex. */
export function parseHex(text: string): Uint8Array | null {
  const clean = text.replace(/0x|\\x/gi, "").replace(/[\s,;:_-]+/g, "");
  if (clean.length === 0 || clean.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(clean)) return null;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function toHex(bytes: Uint8Array | ArrayLike<number>, separator = " "): string {
  const parts: string[] = [];
  for (let i = 0; i < bytes.length; i++) parts.push(bytes[i].toString(16).padStart(2, "0"));
  return parts.join(separator);
}

/** Find `needle` in `hay` from `from` (wrapping when `wrap`), or -1. */
export function findBytes(hay: Uint8Array, needle: Uint8Array, from = 0, wrap = true): number {
  if (needle.length === 0 || needle.length > hay.length) return -1;
  const scan = (start: number, end: number) => {
    outer: for (let i = start; i <= end - needle.length; i++) {
      for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
      return i;
    }
    return -1;
  };
  const hit = scan(Math.max(0, from), hay.length);
  if (hit >= 0 || !wrap) return hit;
  return scan(0, Math.min(hay.length, from + needle.length - 1));
}

/** Latin-1 text → bytes, for searching. */
export function latin1(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
  return out;
}
