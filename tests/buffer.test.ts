import { describe, expect, it } from "vitest";
import { EditBuffer, findBytes, latin1, parseHex, toHex } from "../buffer";

const bytes = (...b: number[]) => new Uint8Array(b);

describe("EditBuffer", () => {
  it("overwrites, inserts, removes and resizes, and knows when it is modified", () => {
    const buf = new EditBuffer(bytes(1, 2, 3, 4));
    expect(buf.modified).toBe(false);
    buf.set(1, [9, 9]);
    expect([...buf.bytes]).toEqual([1, 9, 9, 4]);
    expect(buf.modified).toBe(true);
    buf.insert(4, [5]);
    expect([...buf.bytes]).toEqual([1, 9, 9, 4, 5]);
    buf.remove(0, 2);
    expect([...buf.bytes]).toEqual([9, 4, 5]);
    buf.resize(5);
    expect([...buf.bytes]).toEqual([9, 4, 5, 0, 0]);
    buf.resize(2);
    expect([...buf.bytes]).toEqual([9, 4]);
    // Writing past the end grows the buffer.
    buf.set(1, [7, 8, 9]);
    expect([...buf.bytes]).toEqual([9, 7, 8, 9]);
    // A no-op write records nothing.
    const before = buf.canUndo;
    buf.set(0, [9]);
    expect(buf.canUndo).toBe(before);
    buf.replace(bytes(1, 2, 3, 4));
    expect(buf.modified).toBe(false);
  });

  it("undoes and redoes each step, and merges a run of typing into one", () => {
    const buf = new EditBuffer(bytes(0, 0, 0, 0));
    let changes = 0;
    buf.onChange(() => changes++);
    buf.set(0, [0xa0]);
    buf.set(0, [0xab]);
    buf.set(1, [0xc0]);
    buf.set(1, [0xcd]);
    expect([...buf.bytes]).toEqual([0xab, 0xcd, 0, 0]);
    expect(changes).toBe(4);
    // Four nibble writes at adjacent offsets within the coalescing window are one undo step.
    expect(buf.undo()).toBe(true);
    expect([...buf.bytes]).toEqual([0, 0, 0, 0]);
    expect(buf.undo()).toBe(false);
    expect(buf.redo()).toBe(true);
    expect([...buf.bytes]).toEqual([0xab, 0xcd, 0, 0]);
    // A structural step never merges, and a new edit clears the redo stack.
    buf.insert(2, [7, 7]);
    buf.remove(0, 1);
    expect([...buf.bytes]).toEqual([0xcd, 7, 7, 0, 0]);
    buf.undo();
    expect([...buf.bytes]).toEqual([0xab, 0xcd, 7, 7, 0, 0]);
    buf.undo();
    expect([...buf.bytes]).toEqual([0xab, 0xcd, 0, 0]);
    expect(buf.canRedo).toBe(true);
    buf.set(3, [1]);
    expect(buf.canRedo).toBe(false);
    buf.markClean();
    expect(buf.modified).toBe(false);
    expect(buf.canUndo).toBe(false);
  });

  it("keeps a merged step's before-image right when the run extends past the first write", () => {
    const buf = new EditBuffer(bytes(0x11, 0x22, 0x33));
    buf.set(0, [0xaa]);
    buf.set(1, [0xbb]);
    buf.set(2, [0xcc]);
    expect([...buf.bytes]).toEqual([0xaa, 0xbb, 0xcc]);
    buf.undo();
    expect([...buf.bytes]).toEqual([0x11, 0x22, 0x33]);
    buf.redo();
    expect([...buf.bytes]).toEqual([0xaa, 0xbb, 0xcc]);
  });
});

describe("hex text", () => {
  it("parses and prints", () => {
    expect([...parseHex("0a ff 10")!]).toEqual([10, 255, 16]);
    expect([...parseHex("0x0A,0xFF")!]).toEqual([10, 255]);
    expect([...parseHex("\\x41\\x42")!]).toEqual([0x41, 0x42]);
    expect(parseHex("abc")).toBeNull();
    expect(parseHex("zz")).toBeNull();
    expect(parseHex("")).toBeNull();
    expect(toHex(bytes(0, 255, 16))).toBe("00 ff 10");
    expect([...latin1("Aé")]).toEqual([0x41, 0xe9]);
  });

  it("finds bytes, wrapping around", () => {
    const hay = latin1("hello world hello");
    expect(findBytes(hay, latin1("hello"), 0)).toBe(0);
    expect(findBytes(hay, latin1("hello"), 1)).toBe(12);
    expect(findBytes(hay, latin1("hello"), 13)).toBe(0);
    expect(findBytes(hay, latin1("hello"), 13, false)).toBe(-1);
    expect(findBytes(hay, latin1("nope"))).toBe(-1);
    expect(findBytes(hay, new Uint8Array(0))).toBe(-1);
  });
});
