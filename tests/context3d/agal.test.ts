import assert from "node:assert/strict";
import { test } from "node:test";
import {
  Context3DError,
  type Profile,
  type ProgramType,
  SamplerBiasError,
  translate,
} from "@swf2es/context3d";

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
  const vertex = new Uint8Array(55);
  vertex.set(mov());
  vertex.set(mov().subarray(7), 31);
  // Both writes together define the complete vertex output.
  const view = new DataView(vertex.buffer);
  view.setUint32(35, 0x030c0000, true);
  view.setUint32(39, 0xc6000003, true);
  view.setUint32(11, 0x03030000, true);
  view.setUint32(15, 0xc6000003, true);
  const result = translate(vertex, "vertex");
  assert.deepEqual(result.attributes, [3]);
  assert.deepEqual(result.constants, []);
  assert.match(result.source, /result\.xy = va3\.zyxw\.xy/);
  assert.match(result.source, /result\.z \* 2\.0 - result\.w/);
  const fragment = translate(mov(true), "fragment");
  assert.deepEqual(fragment.constants, [0]);
  assert.equal(fragment.indirect, false);
  assert.match(fragment.source, /result\.xyzw = fc0\.xyzw/);
  // ByteArray storage need not start at byte zero.
  const larger = new Uint8Array(vertex.length + 20);
  larger.set(vertex, 9);
  assert.deepEqual(translate(larger.subarray(9, 9 + vertex.length), "vertex"), result);
});

test("indirect vertex reads share a bank with direct reads and register their index inputs", () => {
  for (const type of [0, 1, 2]) {
    for (let lane = 0; lane < 4; lane++) {
      const bytes = new Uint8Array(55);
      bytes.set(mov());
      bytes.set(mov().subarray(7), 31);
      const view = new DataView(bytes.buffer);
      view.setUint32(19, 1, true); // Direct vc0 read before the indexed read.
      view.setUint32(35, 0x04050000, true);
      view.setUint32(39, 0xc6040007, true);
      view.setUint32(43, 0x80000001 | (type << 8) | (lane << 16), true);
      const result = translate(initialized(bytes, "vertex"), "vertex");
      assert.equal(result.indirect, true);
      assert.deepEqual(result.constants, []);
      assert.deepEqual(result.attributes, type === 0 ? [0, 7] : [0]);
      assert.match(result.source, /uniform vec4 vc\[128\];/);
      assert.doesNotMatch(result.source, /uniform vec4 vc\d/);
      assert.match(result.source, /result\.xyzw = vc\[0\]\.xyzw/);
      const index = type === 0 ? "va7" : type === 1 ? "vc[7]" : "t7";
      assert.ok(
        result.source.includes(`v0.xz = readConstant(${index}.${"xyzw"[lane]}, 4.0).zyxw.xz;`),
      );
      assert.match(result.source, /roundEven\(address\) \+ offset/);
    }
  }
});

test("indirect sources reject unverified stages, offsets, register types and reserved bits", () => {
  const valid = mov();
  new DataView(valid.buffer).setUint32(19, 0x80000001, true);
  translate(valid, "vertex");
  for (const [offset, value] of [
    [15, 8],
    [19, 0],
    [19, 2],
    [20, 3],
    [20, 16],
    [21, 4],
    [22, 129],
    [22, 1],
    [22, 0],
  ]) {
    const bytes = valid.slice();
    bytes[offset] = value;
    // With no indirect flag the nonzero offset is still invalid.
    if (offset === 22 && value === 0) {
      bytes[17] = 1;
    }
    assert.throws(
      () => translate(initialized(bytes, "vertex"), "vertex"),
      `byte ${offset}: ${value}`,
    );
  }
  for (const [type, limit] of [
    [0, 8],
    [1, 128],
    [2, 8],
  ]) {
    const bytes = valid.slice();
    bytes[20] = type;
    bytes[15] = limit - 1;
    translate(initialized(bytes, "vertex"), "vertex");
    bytes[15] = limit;
    assert.throws(() => translate(initialized(bytes, "vertex"), "vertex"));
  }
  valid[6] = 1;
  assert.throws(() => translate(valid, "fragment"), /indirect constant/);
});

test("indirect matrix rows advance the offset without advancing the index register", () => {
  for (const opcode of [0x17, 0x18, 0x19]) {
    const bytes = binary(opcode, 7);
    bytes[13] = opcode === 0x18 ? 15 : 7;
    bytes[25] = 126;
    new DataView(bytes.buffer).setUint32(27, 0x80030201, true);
    const result = translate(computation(bytes, "vertex"), "vertex");
    const rows = opcode === 0x18 ? 4 : 3;
    for (let row = 0; row < rows; row++) {
      assert.ok(result.source.includes(`readConstant(t7.w, ${126 + row}.0)`));
    }
    assert.doesNotMatch(result.source, /t8/);
    if (opcode !== 0x18) {
      bytes[13] = 5;
      assert.throws(() => translate(computation(bytes, "vertex"), "vertex"), /matrix/);
      bytes[13] = 7;
    }
    bytes[26] = 0xc6;
    assert.throws(() => translate(computation(bytes, "vertex"), "vertex"), /matrix/);
  }
});

test("unsupported and malformed AGAL never silently compile", () => {
  const mutations: [number, number][] = [
    [0, 0],
    [1, 2],
    [5, 0],
    [6, 1], // header and stage
    [7, 0x1a], // unsupported opcode
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

function initialized(bytes: Uint8Array, stage: ProgramType): Uint8Array {
  const prefix = new Uint8Array(8 * 24);
  const move = mov(stage === "fragment").subarray(7);
  for (let i = 0; i < 8; i++) {
    prefix.set(move, i * 24);
    new DataView(prefix.buffer).setUint32(i * 24 + 4, 0x020f0000 | i, true);
  }
  const program = new Uint8Array(bytes.length + prefix.length);
  program.set(bytes.subarray(0, 7));
  program.set(prefix, 7);
  program.set(bytes.subarray(7), 7 + prefix.length);

  return program;
}

/** A computation under test writes a temporary, then a complete output. */
function computation(bytes: Uint8Array, stage: ProgramType): Uint8Array {
  const program = new Uint8Array(bytes.length + 24);
  program.set(bytes);
  program[14] = 2;
  program.set(mov(stage === "fragment").subarray(7), bytes.length);
  new DataView(program.buffer).setUint32(bytes.length + 12, 2, true);

  return initialized(program, stage);
}

/** `opcode` of va0 (v0 in a fragment program, which AIR refuses two constants) and vc/fc `first`. */
function binary(opcode: number, first: number, fragment = false): Uint8Array {
  const bytes = mov(fragment);
  const view = new DataView(bytes.buffer);
  view.setUint32(7, opcode, true);
  view.setUint32(19, fragment ? 4 : 0, true);
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
      const translated = translate(computation(bytes, stage), stage);
      const expected = Array.from({ length: rows }, (_, i) => end - rows + i);
      assert.deepEqual(translated.constants, fragment ? [0, ...expected] : expected);
      // Even a masked matrix read must not hide an out-of-range register span.
      bytes[13] = 1;
      bytes[23]++;
      assert.throws(() => translate(computation(bytes, stage), stage));
    }
  }
});

test("pow raises the base's magnitude, as Direct3D's pow does", () => {
  for (const stage of ["vertex", "fragment"] as const) {
    const bytes = binary(0x0b, 27, stage === "fragment");
    bytes[13] = 7;
    const { source } = translate(computation(bytes, stage), stage);
    // GLSL's pow leaves a negative base undefined, and a GPU gives NaN.
    assert.match(source, /= pow\(abs\((va|v)0\.xyzw\), [vf]c27\.xyzw\)/);
  }
});

test("arithmetic validates both sources and rejects unsupported matrix encodings", () => {
  for (const opcode of [1, 2, 3, 4, 6, 7, 0x0b, 0x11, 0x12, 0x13]) {
    const bytes = binary(opcode, 27, true);
    bytes[13] = 7;
    assert.deepEqual(translate(computation(bytes, "fragment"), "fragment").constants, [0, 27]);
    bytes[23] = 28;
    assert.throws(() => translate(computation(bytes, "fragment"), "fragment"));
    bytes[23] = 0;
    bytes[30] = 128;
    assert.throws(() => translate(computation(bytes, "fragment"), "fragment"));
  }
  for (const [offset, value] of [
    [27, 4],
    [26, 0],
    [25, 1],
    [30, 129],
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
      const translated = translate(computation(bytes, stage), stage);
      assert.deepEqual(translated.constants, fragment ? [0] : []);
      for (let row = 8 - rows; row < 8; row++) {
        assert.match(translated.source, new RegExp(`vec4 t${row};`));
      }
      if (rows === 3) {
        bytes[13] = 5;
        assert.throws(() => translate(computation(bytes, stage), stage), /Unsupported AGAL matrix/);
        bytes[13] = 7;
      }
      bytes[23]++;
      assert.throws(() => translate(computation(bytes, stage), stage), /Invalid AGAL temporary/);
      bytes[23]--;
      bytes[26] = 0xc6;
      assert.throws(() => translate(computation(bytes, stage), stage), /Unsupported AGAL matrix/);
    }
  }
});

test("scalar-math overlaps retain the lane being written", () => {
  for (const fragment of [false, true]) {
    for (const opcode of [5, 9, 0x0b, 0x0c, 0x0d]) {
      for (let lane = 0; lane < 4; lane++) {
        const bytes = new Uint8Array(55);
        bytes.set(binary(opcode, 1, fragment));
        bytes.set(mov(fragment).subarray(7), 31);
        const view = new DataView(bytes.buffer);
        view.setUint32(11, 0x02000000 | ((1 << lane) << 16), true);
        view.setUint32(15, (lane * 0x55) << 24, true);
        view.setUint32(19, 2, true);
        if (opcode !== 0x0b) {
          view.setUint32(23, 0, true);
          view.setUint32(27, 0, true);
        }
        const stage = fragment ? "fragment" : "vertex";
        translate(initialized(bytes, stage), stage);
        if (opcode === 0x0b) {
          view.setUint32(23, (lane * 0x55) << 24, true);
          view.setUint32(27, 2, true);
          translate(initialized(bytes, stage), stage);
          view.setUint32(23, (((lane + 1) % 4) * 0x55) << 24, true);
          assert.throws(
            () => translate(initialized(bytes, stage), stage),
            /swizzled scalar-math overlap/,
          );
          view.setUint32(27, 1, true);
        }
        view.setUint32(15, (((lane + 1) % 4) * 0x55) << 24, true);
        assert.throws(
          () => translate(initialized(bytes, stage), stage),
          /swizzled scalar-math overlap/,
        );
      }
    }
  }
});

test("unsupported instruction layouts are not reported as malformed arithmetic", () => {
  const bytes = mov(true);
  const view = new DataView(bytes.buffer);
  view.setUint32(7, 0xffff, true); // Unknown instructions may have no destination
  view.setUint32(11, 0, true);
  assert.throws(() => translate(bytes, "fragment"), /AGAL opcode/);
});

test("2D texture samplers preserve filtering/wrapping and reject unsupported encodings", () => {
  const bytes = mov(true);
  const view = new DataView(bytes.buffer);
  view.setUint32(7, 0x28, true);
  view.setUint32(23, 7, true);
  for (let filter = 0; filter < 6; filter++) {
    for (let wrap = 0; wrap < 4; wrap++) {
      for (let mip = 0; mip < 3; mip++) {
        view.setUint32(27, 5 | (filter << 28) | (wrap << 20) | (mip << 24), true);
        const result = translate(bytes, "fragment");
        assert.deepEqual(result.samplers, [
          { index: 7, format: 0, filter, wrap, mip, cube: false, ignore: false, bias: 0 },
        ]);
        assert.match(result.source, /uniform sampler2D fs7/);
        assert.match(result.source, /texture\(fs7, fc0\.xyzw\.xy\)/);
      }
    }
  }
  // Formats past DXT5 (video's, and others AIR takes) only fail where a texture is drawn.
  for (const flags of [0x305, 0xf05]) {
    view.setUint32(27, flags, true);
    translate(bytes, "fragment");
  }
  for (const flags of [6, 0x2005, 0x10005, 0x20005, 0x80005, 0x400005, 0x3000005, 0x4000005]) {
    view.setUint32(27, flags, true);
    assert.throws(() => translate(bytes, "fragment"), /AGAL sampler/);
  }
  for (let filter = 6; filter < 16; filter++) {
    view.setUint32(27, 5 | (filter << 28), true);
    assert.throws(() => translate(bytes, "fragment"), /AGAL sampler filter/);
  }
  view.setUint32(27, 5, true);
  for (const index of [8, 0x1000000, 0xff000007]) {
    view.setUint32(23, index, true);
    assert.throws(() => translate(bytes, "fragment"), /AGAL sampler/);
  }
  view.setUint32(23, 0, true);
  bytes[6] = 0;
  assert.throws(() => translate(bytes, "vertex"), /Unsupported AGAL sampler/);
  bytes[6] = 1;
  const doubled = new Uint8Array(55);
  doubled.set(bytes);
  doubled.set(bytes.subarray(7), 31);
  doubled[14] = 2;
  new DataView(doubled.buffer).setUint32(51, 0x10000005, true);
  assert.throws(() => translate(doubled, "fragment"), /Conflicting AGAL sampler/);
  new DataView(doubled.buffer).setUint32(51, 0x01000005, true);
  assert.throws(() => translate(doubled, "fragment"), /Conflicting AGAL sampler/);
  new DataView(doubled.buffer).setUint32(27, 0x20000005, true);
  new DataView(doubled.buffer).setUint32(51, 0x30000005, true);
  assert.throws(() => translate(doubled, "fragment"), /Conflicting AGAL sampler/);
});

test("unary math validates unused operands and three-lane vector destinations", () => {
  for (const fragment of [false, true]) {
    const stage = fragment ? "fragment" : "vertex";
    for (const opcode of [5, 8, 9, 0x0a, 0x0c, 0x0d, 0x0e, 0x0f, 0x10]) {
      const bytes = mov(fragment);
      const view = new DataView(bytes.buffer);
      view.setUint32(7, opcode, true);
      bytes[13] = 7;
      translate(computation(bytes, stage), stage);
      bytes[23] = 1;
      assert.throws(
        () => translate(computation(bytes, stage), stage),
        /Nonempty unused AGAL source/,
      );
      bytes[23] = 0;
      bytes[22] = 128;
      assert.throws(
        () => translate(computation(bytes, stage), stage),
        /Unsupported AGAL (source encoding|indirect constant)/,
      );
    }
    for (const opcode of [0x0e, 0x11]) {
      const bytes = opcode === 0x11 ? binary(opcode, 1, fragment) : mov(fragment);
      new DataView(bytes.buffer).setUint32(7, opcode, true);
      assert.throws(() => translate(computation(bytes, stage), stage), /vector write mask/);
      bytes[13] = 2;
      assert.throws(() => translate(computation(bytes, stage), stage), /vector write mask/);
      bytes[13] = 7;
      translate(computation(bytes, stage), stage);
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

test("comparisons support both stages and validate the constant bank", () => {
  for (const opcode of [0x29, 0x2a, 0x2c, 0x2d]) {
    const bytes = binary(opcode, 127);
    const vertex = translate(bytes, "vertex");
    assert.deepEqual(vertex.constants, [127]);
    if (opcode === 0x2c) {
      assert.match(vertex.source, /vec4\(equal\(va0\.xyzw, vc127\.xyzw\)\)/);
    }

    bytes[23] = 128;
    assert.throws(() => translate(bytes, "vertex"), /constant/);
    const fragment = binary(opcode, 27, true);
    const result = translate(fragment, "fragment");
    assert.deepEqual(result.constants, [27]);
    if (opcode === 0x2c) {
      assert.match(result.source, /vec4\(equal\(v0\.xyzw, fc27\.xyzw\)\)/);
    }

    fragment[23] = 28;
    assert.throws(() => translate(fragment, "fragment"), /constant/);
  }
});

test("unverified scalar-math overlaps fail explicitly", () => {
  for (const opcode of [5, 9, 0x0b, 0x0c, 0x0d]) {
    const bytes = opcode === 0x0b ? binary(opcode, 1, true) : mov(true);
    const view = new DataView(bytes.buffer);
    view.setUint32(7, opcode, true);
    view.setUint32(11, 0x02070000, true);
    view.setUint32(15, 0xc6000000, true);
    view.setUint32(19, 2, true);
    assert.throws(
      () => translate(initialized(bytes, "fragment"), "fragment"),
      /scalar-math overlap/,
    );
    if (opcode === 0x0b) {
      view.setUint32(19, 1, true);
      view.setUint32(23, 0, true);
      view.setUint32(27, 2, true);
      assert.throws(
        () => translate(initialized(bytes, "fragment"), "fragment"),
        /scalar-math overlap/,
      );
    }
  }
});

test("samplers read RGBA, DXT1 or DXT5, and a slot reads one", () => {
  const bytes = mov(true);
  const view = new DataView(bytes.buffer);
  view.setUint32(7, 0x28, true);
  for (const format of [0, 1, 2]) {
    view.setUint32(27, 5 | (format << 8), true);
    assert.equal(translate(bytes, "fragment").samplers[0].format, format);
    view.setUint32(27, 0x1005 | (format << 8), true);
    assert.equal(translate(bytes, "fragment").samplers[0].format, format);
  }
  const doubled = new Uint8Array(55);
  view.setUint32(27, 0x105, true);
  doubled.set(bytes);
  doubled.set(bytes.subarray(7), 31);
  doubled[14] = 2;
  new DataView(doubled.buffer).setUint32(51, 0x205, true);
  assert.throws(() => translate(doubled, "fragment"), /Conflicting AGAL sampler/);
});

test("cube samplers use three coordinates and cannot share a slot with 2D samplers", () => {
  const bytes = mov(true);
  const view = new DataView(bytes.buffer);
  view.setUint32(7, 0x28, true);
  for (let mip = 0; mip < 3; mip++) {
    view.setUint32(27, 0x10001005 | (mip << 24), true);
    const result = translate(bytes, "fragment");
    assert.deepEqual(result.samplers, [
      { index: 0, format: 0, cube: true, filter: 1, wrap: 0, mip, ignore: false, bias: 0 },
    ]);
    assert.match(result.source, /uniform samplerCube fs0/);
    assert.match(result.source, /texture\(fs0, fc0\.xyzw\.xyz\)/);
  }
  const doubled = new Uint8Array(55);
  doubled.set(bytes);
  doubled.set(bytes.subarray(7), 31);
  doubled[14] = 2;
  new DataView(doubled.buffer).setUint32(51, 0x12000005, true);
  assert.throws(() => translate(doubled, "fragment"), /Conflicting AGAL sampler/);
});

test("ignoresampler preserves dimensionality and cannot silently conflict within a shader", () => {
  for (const cube of [false, true]) {
    const bytes = mov(true);
    const view = new DataView(bytes.buffer);
    view.setUint32(7, 0x28, true);
    view.setUint32(27, 0x12140005 | (cube ? 0x1000 : 0), true);
    const translated = translate(bytes, "fragment");
    assert.deepEqual(translated.samplers, [
      { index: 0, format: 0, cube, filter: 1, wrap: 1, mip: 2, ignore: true, bias: 0 },
    ]);
    assert.match(translated.source, cube ? /samplerCube fs0/ : /sampler2D fs0/);
    const doubled = new Uint8Array(55);
    doubled.set(bytes);
    doubled.set(bytes.subarray(7), 31);
    doubled[14] = 2;
    doubled[14] = 2;
    translate(doubled, "fragment");
    doubled[53] ^= 4;
    assert.throws(() => translate(doubled, "fragment"), /Conflicting AGAL sampler/);
    for (const bit of [0x10000, 0x20000, 0x80000]) {
      view.setUint32(27, 0x40005 | bit, true);
      assert.throws(() => translate(bytes, "fragment"), /sampler encoding/);
    }
  }
});

test("sampler bias is signed eighths, independent of sampler flags and register index", () => {
  for (const cube of [false, true]) {
    const bytes = mov(true);
    const view = new DataView(bytes.buffer);
    view.setUint32(7, 0x28, true);
    view.setUint32(27, 0x02040005 | (cube ? 0x1000 : 0), true);
    for (let raw = -128; raw < 128; raw++) {
      view.setUint32(23, ((raw & 255) << 16) | 7, true);
      const result = translate(bytes, "fragment");
      assert.deepEqual(result.samplers, [
        {
          index: 7,
          format: 0,
          filter: 0,
          wrap: 0,
          mip: 2,
          cube,
          ignore: true,
          bias: raw / 8,
        },
      ]);
      const bias = raw === 0 ? "" : `, ${(raw / 8).toFixed(3)}`;
      assert.ok(result.source.includes(`texture(fs7, fc0.xyzw.${cube ? "xyz" : "xy"}${bias})`));
    }

    const doubled = new Uint8Array(55);
    doubled.set(bytes);
    doubled.set(bytes.subarray(7), 31);
    doubled[14] = 2;
    doubled[14] = 2;
    assert.equal(translate(doubled, "fragment").samplers.length, 1);
    doubled[49] = 128;
    assert.throws(() => translate(doubled, "fragment"), SamplerBiasError);
    doubled[47] = 6;
    assert.deepEqual(
      translate(doubled, "fragment").samplers.map((s) => s.bias),
      [15.875, -16],
    );
    doubled[50] = 1;
    assert.throws(() => translate(doubled, "fragment"), /Unsupported AGAL sampler/);
  }
});

test("AIR rejects unwritten temporary lanes and incomplete outputs during upload", () => {
  const untouched = mov();
  untouched[19] = 2;
  assert.throws(
    () => translate(untouched, "vertex"),
    (error) => error instanceof Context3DError && error.reason === "agalTemporaryRead",
  );
  const partial = mov();
  partial[13] = 3;
  assert.throws(
    () => translate(partial, "vertex"),
    (error) => error instanceof Context3DError && error.reason === "agalVertexOutput",
  );
  const color = mov(true);
  color[13] = 3;
  assert.throws(
    () => translate(color, "fragment"),
    (error) => error instanceof Context3DError && error.reason === "agalColorMask",
  );
});

/** A program of `version` for `stage`: its rows of six words each. */
function program(version: number, fragment: boolean, rows: number[][]): Uint8Array {
  const bytes = new Uint8Array(7 + rows.length * 24);
  const view = new DataView(bytes.buffer);
  bytes[0] = 0xa0;
  view.setUint32(1, version, true);
  bytes[5] = 0xa1;
  bytes[6] = fragment ? 1 : 0;
  for (let i = 0; i < rows.length; i++) {
    for (let j = 0; j < 6; j++) {
      view.setUint32(7 + i * 24 + j * 4, rows[i][j], true);
    }
  }

  return bytes;
}

test("each profile takes the AGAL versions AIR gives it, version 0 as 1", () => {
  const output = [[0, 0x030f0000, 0xe4000000, 1, 0, 0]];
  const allowed = {
    baselineConstrained: 1,
    baseline: 1,
    baselineExtended: 1,
    standardConstrained: 2,
    standard: 2,
    standardExtended: 3,
  } as const;
  for (const [profile, newest] of Object.entries(allowed)) {
    for (let version = 0; version <= 4; version++) {
      const run = () => translate(program(version, true, output), "fragment", profile as Profile);
      if (version <= newest) {
        run();
      } else {
        assert.throws(run, (e) => e instanceof Context3DError && e.reason === "agalProfileVersion");
      }
    }
  }
});

test("conditionals predicate writes, and texture reads in them happen for every pixel", () => {
  const rows = [
    [0, 0x020f0000, 0xe4000000, 1, 0, 0], // mov ft0, fc0
    [0x1e, 0, 0x00000000, 4, 0x55000000, 1], // ifg v0.x, fc0.y
    [0x28, 0x020f0000, 0xe4000000, 4, 0, 5], // tex ft0, v0, fs0
    [0x20, 0, 0, 0, 0, 0], // els
    [0x27, 0, 0xff000000, 2, 0, 0], // kil ft0.w
    [0x21, 0, 0, 0, 0, 0], // eif
    [0, 0x030f0000, 0xe4000000, 2, 0, 0],
  ];
  const { source } = translate(program(2, true, rows), "fragment", "standard");
  assert.match(source, /bool c\d+ = v0\.xxxx\.x > fc0\.yyyy\.x;/);
  assert.match(
    source,
    /vec4 h0 = texture\(fs0, v0\.xyzw\.xy\);\n {2}if \(p\d+\) \{ t0\.xyzw = h0\.xyzw; \}/,
  );
  assert.match(source, /bool p\d+ = !c\d+;/);
  assert.match(source, /if \(p\d+ && t0\.wwww\.x < 0\.0\) \{ discard; \}/);
  // A temporary only the if branch writes is not written after the eif.
  const inside = [
    [0x1c, 0, 0x00000000, 1, 0x55000000, 1],
    [0, 0x020f0000, 0xe4000000, 1, 0, 0],
    [0x21, 0, 0, 0, 0, 0],
    [0, 0x030f0000, 0xe4000000, 2, 0, 0],
  ];
  assert.throws(
    () => translate(program(2, true, inside), "fragment", "standard"),
    (e) => e instanceof Context3DError && e.reason === "agalTemporaryRead",
  );
});

test("derivatives, depth and colour outputs of AGAL 2", () => {
  const rows = [
    [0x1a, 0x020f0000, 0xe4000000, 4, 0, 0], // ddx ft0, v0
    [0x1b, 0x020f0001, 0xe4000000, 4, 0, 0], // ddy ft1, v0
    [0, 0x030f0000, 0xe4000000, 2, 0, 0], // mov oc0, ft0
    [0, 0x030f0001, 0xe4000001, 2, 0, 0], // mov oc1, ft1
    [0, 0x06010000, 0x00000000, 4, 0, 0], // mov od.x, v0.x
  ];
  const result = translate(program(2, true, rows), "fragment", "standard");
  assert.equal(result.outputs, 2);
  assert.match(result.source, /dFdx\(v0\.xyzw\)/);
  assert.match(result.source, /\(-targetY \* dFdy\(v0\.xyzw\)\)/);
  assert.match(result.source, /layout\(location = 1\) out vec4 color1;/);
  assert.match(result.source, /gl_FragDepth = depth\.x;/);
  // standardConstrained has one colour output and no depth.
  assert.throws(() => translate(program(2, true, rows), "fragment", "standardConstrained"));
});
