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
  for (const opcode of [1, 2, 3, 4, 6, 7, 0x0b, 0x11, 0x12, 0x13]) {
    const bytes = binary(opcode, 27, true);
    bytes[13] = 7;
    assert.deepEqual(translate(bytes, "fragment").constants, [0, 27]);
    bytes[23] = 28;
    assert.throws(() => translate(bytes, "fragment"));
    bytes[23] = 0;
    bytes[30] = 128;
    assert.throws(() => translate(bytes, "fragment"));
  }
  for (const [offset, value] of [
    [27, 4],
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

test("temporary matrix spans are bounded independently of constant registers", () => {
  for (const fragment of [false, true]) {
    for (const opcode of [0x17, 0x18, 0x19]) {
      const rows = opcode === 0x18 ? 4 : 3;
      const bytes = binary(opcode, 8 - rows, fragment);
      bytes[13] = 7;
      bytes[27] = 2;
      const stage = fragment ? "fragment" : "vertex";
      const translated = translate(bytes, stage);
      assert.deepEqual(translated.constants, fragment ? [0] : []);
      for (let row = 8 - rows; row < 8; row++) {
        assert.match(translated.source, new RegExp(`vec4 t${row};`));
      }
      if (rows === 3) {
        bytes[13] = 5;
        assert.throws(() => translate(bytes, stage), /Unsupported AGAL matrix/);
        bytes[13] = 7;
      }
      bytes[23]++;
      assert.throws(() => translate(bytes, stage), /Invalid AGAL temporary/);
      bytes[23]--;
      bytes[26] = 0xc6;
      assert.throws(() => translate(bytes, stage), /Unsupported AGAL matrix/);
    }
  }
});

test("scalar root/power overlaps retain the lane being written", () => {
  for (const fragment of [false, true]) {
    for (const opcode of [9, 0x0b]) {
      for (let lane = 0; lane < 4; lane++) {
        const bytes = new Uint8Array(55);
        bytes.set(binary(opcode, 1, fragment));
        bytes.set(mov(fragment).subarray(7), 31);
        const view = new DataView(bytes.buffer);
        view.setUint32(11, 0x02000000 | ((1 << lane) << 16), true);
        view.setUint32(15, (lane * 0x55) << 24, true);
        view.setUint32(19, 2, true);
        if (opcode === 9) {
          view.setUint32(23, 0, true);
          view.setUint32(27, 0, true);
        }
        const stage = fragment ? "fragment" : "vertex";
        translate(bytes, stage);
        if (opcode === 0x0b) {
          view.setUint32(23, (lane * 0x55) << 24, true);
          view.setUint32(27, 2, true);
          translate(bytes, stage);
          view.setUint32(23, (((lane + 1) % 4) * 0x55) << 24, true);
          assert.throws(() => translate(bytes, stage), /swizzled root\/power overlap/);
          view.setUint32(27, 1, true);
        }
        view.setUint32(15, (((lane + 1) % 4) * 0x55) << 24, true);
        assert.throws(() => translate(bytes, stage), /swizzled root\/power overlap/);
      }
    }
  }
});

test("unsupported instruction layouts are not reported as malformed arithmetic", () => {
  const bytes = mov(true);
  const view = new DataView(bytes.buffer);
  view.setUint32(7, 0xffff, true); // Unknown instructions may have no destination
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
      for (let mip = 0; mip < 3; mip++) {
        view.setUint32(27, 5 | (Number(linear) << 28) | (Number(repeat) << 20) | (mip << 24), true);
        const result = translate(bytes, "fragment");
        assert.deepEqual(result.samplers, [{ index: 7, linear, repeat, mip }]);
        assert.match(result.source, /uniform sampler2D fs7/);
        assert.match(result.source, /texture\(fs7, fc0\.xyzw\.xy\)/);
      }
    }
  }
  for (const flags of [6, 0x105, 0x1005, 0x10005, 0x200005, 0x3000005, 0x4000005, 0x20000005]) {
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
  new DataView(doubled.buffer).setUint32(51, 0x01000005, true);
  assert.throws(() => translate(doubled, "fragment"), /Conflicting AGAL sampler/);
});

test("unary math validates unused operands and three-lane vector destinations", () => {
  for (const fragment of [false, true]) {
    const stage = fragment ? "fragment" : "vertex";
    for (const opcode of [8, 9, 0x0a, 0x0e]) {
      const bytes = mov(fragment);
      const view = new DataView(bytes.buffer);
      view.setUint32(7, opcode, true);
      bytes[13] = 7;
      translate(bytes, stage);
      bytes[23] = 1;
      assert.throws(() => translate(bytes, stage), /Nonempty unused AGAL source/);
      bytes[23] = 0;
      bytes[22] = 128;
      assert.throws(() => translate(bytes, stage), /Unsupported AGAL source encoding/);
    }
    for (const opcode of [0x0e, 0x11]) {
      const bytes = opcode === 0x11 ? binary(opcode, 1, fragment) : mov(fragment);
      new DataView(bytes.buffer).setUint32(7, opcode, true);
      assert.throws(() => translate(bytes, stage), /vector write mask/);
      bytes[13] = 2;
      assert.throws(() => translate(bytes, stage), /vector write mask/);
      bytes[13] = 7;
      translate(bytes, stage);
    }
  }
});

test("discard validates its destination, stage, source and unused operand", () => {
  const bytes = new Uint8Array(55);
  bytes.set(mov(true));
  const view = new DataView(bytes.buffer);
  view.setUint32(31, 0x27, true);
  view.setUint32(39, 0xaa000001, true); // v1.zzzz
  view.setUint32(43, 4, true);
  const result = translate(bytes, "fragment");
  assert.deepEqual(result.constants, [0]);
  assert.match(result.source, /if \(v1\.zzzz\.x < 0\.0\) \{ discard; \}/);
  for (const [offset, value] of [
    [35, 1],
    [47, 1],
    [51, 1],
    [39, 8],
    [46, 128],
    [43, 1], // constant instead of temporary/varying
    [42, 0xe4], // non-scalar swizzle
  ]) {
    const changed = bytes.slice();
    changed[offset] = value;
    assert.throws(() => translate(changed, "fragment"));
  }
  bytes[6] = 0;
  assert.throws(() => translate(bytes, "vertex"), /Invalid AGAL discard/);
});

test("unverified fragment comparisons and root/power overlaps fail explicitly", () => {
  for (const opcode of [0x29, 0x2a]) {
    const bytes = binary(opcode, 127);
    assert.deepEqual(translate(bytes, "vertex").constants, [127]);
    bytes[23] = 128;
    assert.throws(() => translate(bytes, "vertex"), /constant/);
    assert.throws(() => translate(binary(opcode, 1, true), "fragment"), /fragment comparison/);
  }
  for (const opcode of [9, 0x0b]) {
    const bytes = opcode === 9 ? mov(true) : binary(opcode, 1, true);
    const view = new DataView(bytes.buffer);
    view.setUint32(7, opcode, true);
    view.setUint32(11, 0x02070000, true);
    view.setUint32(15, 0xc6000000, true);
    view.setUint32(19, 2, true);
    assert.throws(() => translate(bytes, "fragment"), /root\/power overlap/);
    if (opcode === 0x0b) {
      view.setUint32(19, 1, true);
      view.setUint32(23, 0, true);
      view.setUint32(27, 2, true);
      assert.throws(() => translate(bytes, "fragment"), /root\/power overlap/);
    }
  }
});
