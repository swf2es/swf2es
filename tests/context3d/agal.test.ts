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
  assert.match(result.source, /result\.xy = va3\.zy/);
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
    [7, 1], // unsupported opcode
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
