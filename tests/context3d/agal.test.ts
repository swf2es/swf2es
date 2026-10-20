import assert from "node:assert/strict";
import { test } from "node:test";
import { translate } from "./agal.ts";

function mov(fragment = false): Uint8Array {
  const bytes = new Uint8Array(31);
  const view = new DataView(bytes.buffer);
  bytes[0] = 0xa0;
  view.setUint32(1, 1, true);
  bytes[5] = 0xa1;
  bytes[6] = fragment ? 1 : 0;
  view.setUint32(11, 0x030f0000, true);
  view.setUint32(15, 0xe4000000, true);
  view.setUint32(19, fragment ? 1 : 0, true);
  return bytes;
}

test("AGAL stage, masks, swizzles, constants and clip-depth mapping", () => {
  const vertex = mov();
  // va3.zyxw to op.xy: only the two selected destination lanes are read.
  const view = new DataView(vertex.buffer);
  view.setUint32(11, 0x03030000, true);
  view.setUint32(15, 0xc6000003, true);
  const result = translate(vertex, "vertex");
  assert.deepEqual(result.attributes, [3]);
  assert.deepEqual(result.constants, []);
  assert.match(result.source, /result\.xy = va3\.zyxw\.xy/);
  assert.match(result.source, /result\.z \* 2\.0 - result\.w/);
  const fragment = translate(mov(true), "fragment");
  assert.deepEqual(fragment.constants, [0]);
  assert.match(fragment.source, /result\.xyzw = fc0\.xyzw/);
  // ByteArray storage need not start at byte zero.
  const larger = new Uint8Array(50);
  larger.set(vertex, 9);
  assert.deepEqual(translate(larger.subarray(9, 40), "vertex"), result);
});

test("unsupported and malformed AGAL never silently compile", () => {
  const mutations: [number, number][] = [
    [0, 0],
    [1, 2],
    [5, 0],
    [6, 1], // header and stage
    [7, 5], // unsupported opcode
    [13, 0],
    [13, 16], // empty/invalid destination mask
    [14, 1], // constant destination
    [17, 1],
    [20, 1],
    [22, 128], // indexing/indirect source
    [23, 1], // nonempty unused source
    [15, 8], // attribute outside baseline
    [19, 5], // sampler where a MOV source was needed
  ];
  for (const [offset, value] of mutations) {
    const bytes = mov();
    bytes[offset] = value;
    assert.throws(() => translate(bytes, "vertex"), `byte ${offset}`);
  }
  for (let length = 0; length < 31; length++) {
    assert.throws(() => translate(mov().subarray(0, length), "vertex"));
  }
  const excessive = new Uint8Array(7 + 201 * 24);
  excessive.set(mov());
  assert.throws(() => translate(excessive, "vertex"));
  const fragment = mov(true);
  fragment[15] = 28;
  assert.throws(() => translate(fragment, "fragment"));
});

function binary(opcode: number, first: number, fragment = false): Uint8Array {
  const bytes = mov(fragment);
  const view = new DataView(bytes.buffer);
  view.setUint32(7, opcode, true);
  view.setUint32(23, 0xe4000000 | first, true);
  view.setUint32(27, 1, true);
  return bytes;
}

test("matrix register spans respect stage limits and retain every referenced row", () => {
  for (const fragment of [false, true]) {
    const stage = fragment ? "fragment" : "vertex";
    const end = fragment ? 28 : 128;
    for (const opcode of [0x17, 0x18, 0x19]) {
      const rows = opcode === 0x18 ? 4 : 3;
      const bytes = binary(opcode, end - rows, fragment);
      bytes[13] = rows === 4 ? 15 : 7;
      const translated = translate(bytes, stage);
      const expected = Array.from({ length: rows }, (_, i) => end - rows + i);
      assert.deepEqual(translated.constants, fragment ? [0, ...expected] : expected);
      // Even a masked matrix read must not hide an out-of-range register span.
      bytes[13] = 1;
      bytes[23]++;
      assert.throws(() => translate(bytes, stage));
    }
  }
});

test("arithmetic validates both sources and rejects unsupported matrix encodings", () => {
  for (const opcode of [1, 2, 3, 4, 6, 7, 0x12, 0x13]) {
    const bytes = binary(opcode, 27, true);
    assert.deepEqual(translate(bytes, "fragment").constants, [0, 27]);
    bytes[23] = 28;
    assert.throws(() => translate(bytes, "fragment"));
    bytes[23] = 0;
    bytes[30] = 128;
    assert.throws(() => translate(bytes, "fragment"));
  }
  for (const [offset, value] of [
    [27, 2],
    [26, 0],
    [25, 1],
    [30, 128],
  ]) {
    const bytes = binary(0x18, 4);
    bytes[offset] = value;
    assert.throws(() => translate(bytes, "vertex"));
  }
  for (const opcode of [0x17, 0x19]) {
    assert.throws(() => translate(binary(opcode, 4), "vertex"), "three-row matrix writes w");
  }
});

test("unsupported instruction layouts are not reported as malformed arithmetic", () => {
  const bytes = mov(true);
  const view = new DataView(bytes.buffer);
  view.setUint32(7, 0x27, true); // kil has no destination
  view.setUint32(11, 0, true);
  assert.throws(() => translate(bytes, "fragment"), /Unsupported AGAL opcode/);
});

test("2D texture samplers preserve filtering/wrapping and reject unsupported encodings", () => {
  const bytes = mov(true);
  const view = new DataView(bytes.buffer);
  view.setUint32(7, 0x28, true);
  view.setUint32(23, 7, true);
  for (const linear of [false, true]) {
    for (const repeat of [false, true]) {
      view.setUint32(27, 5 | (Number(linear) << 28) | (Number(repeat) << 20), true);
      const result = translate(bytes, "fragment");
      assert.deepEqual(result.samplers, [{ index: 7, linear, repeat }]);
      assert.match(result.source, /uniform sampler2D fs7/);
      assert.match(result.source, /texture\(fs7, fc0\.xyzw\.xy\)/);
    }
  }
  for (const flags of [6, 0x105, 0x1005, 0x10005, 0x200005, 0x1000005, 0x20000005]) {
    view.setUint32(27, flags, true);
    assert.throws(() => translate(bytes, "fragment"), /Unsupported AGAL sampler/);
  }
  view.setUint32(27, 5, true);
  for (const index of [8, 0x10000, 0x1000000]) {
    view.setUint32(23, index, true);
    assert.throws(() => translate(bytes, "fragment"), /Unsupported AGAL sampler/);
  }
  view.setUint32(23, 0, true);
  bytes[6] = 0;
  assert.throws(() => translate(bytes, "vertex"), /Unsupported AGAL sampler/);
  bytes[6] = 1;
  const doubled = new Uint8Array(55);
  doubled.set(bytes);
  doubled.set(bytes.subarray(7), 31);
  new DataView(doubled.buffer).setUint32(51, 0x10000005, true);
  assert.throws(() => translate(doubled, "fragment"), /Conflicting AGAL sampler/);
});
