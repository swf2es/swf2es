import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// The test build of codegen (assembly/testing.ts) exposes the ABC reader.
const wasmPath = fileURLToPath(
  new URL("../../../packages/codegen/dist-test/testing.wasm", import.meta.url),
);
const { instantiate } = await import(
  new URL("../../../packages/codegen/dist-test/testing.js", import.meta.url).href
);
const wasm = await instantiate(await WebAssembly.compile(await readFile(wasmPath)), { env: {} });
const kind = (name: string): number => wasm[name].value;

interface Read {
  values: number[];
  pos: number;
  failed: boolean;
}

function read(bytes: number[], kinds: string[]): Read {
  const out: Float64Array = wasm.readAll(new Uint8Array(bytes), new Uint8Array(kinds.map(kind)));
  const values = [...out];
  const failed = values.pop() === 1;
  const pos = values.pop() ?? -1;

  return { values, pos, failed };
}

const one = (bytes: number[], k: string) => read(bytes, [k]).values[0];

test("u8, u16 and s24 are little-endian", () => {
  assert.deepEqual(read([0xfe, 0x34, 0x12], ["U8", "U16"]).values, [0xfe, 0x1234]);
  assert.equal(one([0x56, 0x34, 0x12], "S24"), 0x123456);
  assert.equal(one([0xff, 0xff, 0xff], "S24"), -1);
  assert.equal(one([0x00, 0x00, 0x80], "S24"), -0x800000);
});

test("u32 uses 1 to 5 bytes, low 7 bits first", () => {
  const cases: [number[], number][] = [
    [[0x00], 0],
    [[0x7f], 127],
    [[0x80, 0x01], 128],
    [[0xff, 0x7f], 16383],
    [[0x80, 0x80, 0x01], 16384],
    [[0xff, 0xff, 0xff, 0x7f], 0x0fffffff],
    [[0x80, 0x80, 0x80, 0x80, 0x01], 0x10000000],
    [[0xff, 0xff, 0xff, 0xff, 0x0f], 0xffffffff],
  ];
  for (const [bytes, value] of cases) {
    assert.deepEqual(read(bytes, ["U32"]), { values: [value], pos: bytes.length, failed: false });
  }
});

test("u32 drops bits past 32 in the fifth byte, as avmplus does", () => {
  assert.equal(one([0xff, 0xff, 0xff, 0xff, 0xff], "U32"), 0xffffffff);
  assert.equal(one([0x80, 0x80, 0x80, 0x80, 0x71], "U32"), 0x10000000);
});

test("s32 is the u32 bit pattern, not sign-extended", () => {
  assert.equal(one([0xff, 0xff, 0xff, 0xff, 0x0f], "S32"), -1);
  assert.equal(one([0x80, 0x80, 0x80, 0x80, 0x08], "S32"), -0x80000000);
  assert.equal(one([0x7f], "S32"), 127);
});

test("u30 rejects values with either top bit set", () => {
  assert.deepEqual(read([0xff, 0xff, 0xff, 0xff, 0x03], ["U30"]).values, [0x3fffffff]);
  assert.equal(read([0x80, 0x80, 0x80, 0x80, 0x04], ["U30"]).failed, true);
  assert.equal(read([0x80, 0x80, 0x80, 0x80, 0x08], ["U30"]).failed, true);
});

test("d64 is a little-endian IEEE double", () => {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setFloat64(0, -1234.5, true);
  assert.equal(one([...bytes], "D64"), -1234.5);
});

test("utf8 reads the byte length and skips the bytes", () => {
  const bytes = [3, 0x61, 0x62, 0x63, 9];
  assert.deepEqual(read(bytes, ["UTF8", "U8"]), { values: [3, 9], pos: 5, failed: false });
});

test("reads past the end fail, park at the end and stay failed", () => {
  assert.deepEqual(read([0x80], ["U32"]), { values: [0], pos: 1, failed: true });
  assert.deepEqual(read([0x01], ["U16", "U8"]), { values: [0, 0], pos: 1, failed: true });
  assert.deepEqual(read([0x05, 0x61], ["UTF8"]), { values: [0], pos: 2, failed: true });
  assert.deepEqual(read([1, 2, 3], ["D64"]), { values: [0], pos: 3, failed: true });
  assert.equal(read([], ["U8"]).failed, true);
});
