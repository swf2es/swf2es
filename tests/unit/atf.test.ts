import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { binary } from "../../packages/native/dist/atf/binary.js";
import {
  AtfError,
  type AtfFailure,
  atfEncoding,
  atfKind,
  decodeAtf,
  jxrTraps,
  readAtfBlocks,
  readAtfHeader,
} from "../../packages/native/dist/atf/index.js";
import { oldHeader } from "../context3d/atf/old-header.ts";

/** A fixture of tests/context3d/atf, made by its make.ts from PNGs of its own. */
const fixture = (name: string) =>
  new Uint8Array(readFileSync(new URL(`../context3d/atf/${name}.atf`, import.meta.url)));

const decode = (atf: Uint8Array, offset = 0) => decodeAtf(atf, readAtfHeader(atf, offset));

/** The reason decoding refuses, or null where it decodes. */
function refusal(atf: Uint8Array, offset = 0): AtfFailure | null {
  try {
    decode(atf, offset);
    return null;
  } catch (error) {
    assert.ok(error instanceof AtfError, String(error));
    return error.reason;
  }
}

/** A version 3 fixture with its length field set to end at `end`. */
function withLength(atf: Uint8Array, end: number): Uint8Array {
  const out = atf.slice();
  new DataView(out.buffer).setUint32(8, end - 12);
  return out;
}

/** Where a version 3 fixture's level `levels` starts. */
function levelStart(atf: Uint8Array, levels: number): number {
  const header = readAtfHeader(atf, 0);
  const faces = readAtfBlocks(atf, header);
  const blocks = faces[0][levels - 1];
  assert.ok(blocks);
  const last = blocks[blocks.length - 1];
  return last.byteOffset - atf.byteOffset + last.length;
}

/** Pixel `i` of BGRA bytes as 0xAARRGGBB. */
const argb = (bgra: Uint8Array, i: number) =>
  ((bgra[i * 4 + 3] << 24) | (bgra[i * 4 + 2] << 16) | (bgra[i * 4 + 1] << 8) | bgra[i * 4]) >>> 0;

test("the module imports nothing", async () => {
  const module = await WebAssembly.compile(Buffer.from(binary, "base64"));
  assert.deepEqual(WebAssembly.Module.imports(module), []);
});

test("headers name their format, size, levels and faces, in both layouts", () => {
  const cases: [string, number, string, number, number, number, boolean][] = [
    ["rgb", 0, "bgra", 64, 64, 7, false],
    ["rgba", 1, "bgra", 32, 32, 6, false],
    ["rgb-cube", 0, "bgra", 16, 16, 5, true],
    ["compressed", 2, "compressed", 64, 64, 7, false],
    ["raw", 3, "compressed", 64, 64, 7, false],
    ["compressed-alpha", 4, "compressedAlpha", 32, 32, 6, false],
    ["raw-alpha", 5, "compressedAlpha", 32, 32, 6, false],
    ["compressed-cube", 2, "compressed", 16, 16, 5, true],
    ["compressed-wide", 2, "compressed", 64, 32, 7, false],
  ];
  for (const [name, format, kind, width, height, count, cube] of cases) {
    for (const atf of [fixture(name), oldHeader(fixture(name))]) {
      const header = readAtfHeader(atf, 0);
      assert.equal(header.format, format, name);
      assert.equal(atfKind(header.format), kind, name);
      assert.deepEqual(
        [header.width, header.height, header.count, header.cube],
        [width, height, count, cube],
      );
      assert.equal(header.end, atf.length, name);
      const images = decodeAtf(atf, header);
      assert.equal(images.length, count * (cube ? 6 : 1), name);
    }
  }

  assert.equal(readAtfHeader(fixture("rgb"), 0).version, 3);
  assert.equal(readAtfHeader(oldHeader(fixture("rgb")), 0).version, 0);
});

test("RGB888 and RGBA8888 decode to BGRA, alpha straight, every level", () => {
  const rgb = decode(fixture("rgb"));
  // Red, green, blue and yellow quadrants, opaque.
  assert.deepEqual(
    [0, 63, 64 * 63, 64 * 64 - 1].map((i) => argb(rgb[0].bytes, i)),
    [0xffff0000, 0xff00ff00, 0xff0000ff, 0xffffff00],
  );
  assert.deepEqual(
    rgb.map((image) => [image.level, image.width, image.height, image.bytes.length]),
    [0, 1, 2, 3, 4, 5, 6].map((level) => [
      level,
      64 >> level,
      64 >> level,
      (16384 >> level) >> level,
    ]),
  );
  // Alpha rises to the right, 8 a pixel, the colour not multiplied by it, and
  // the edge between quadrants as AIR draws it (png2atf's chroma bleeds).
  const rgba = decode(fixture("rgba"))[0].bytes;
  assert.equal(argb(rgba, 0), 0x00ff0000);
  assert.equal(argb(rgba, 24), 0xc000ff00);
  assert.equal(argb(rgba, 32 * 31 + 31), 0xf8ffff00);
  assert.deepEqual(
    [28, 29, 30, 31, 32, 33, 34, 35].map((x) => argb(rgb[0].bytes, 64 * 2 + x) & 0xffffff),
    [0xff0000, 0xf50600, 0xeb0c00, 0x874800, 0x63c314, 0x32e10a, 0x00ff00, 0x00ff00],
  );
});

test("Compressed and CompressedAlpha rebuild the very blocks raw ATFs hold", () => {
  for (const [packed, raw, encoding] of [
    ["compressed", "raw", "dxt1"],
    ["compressed-alpha", "raw-alpha", "dxt5"],
  ]) {
    const a = decode(fixture(packed));
    const b = decode(fixture(raw));
    assert.equal(atfEncoding(readAtfHeader(fixture(packed), 0).format), encoding);
    assert.equal(a.length, b.length);
    for (let i = 0; i < a.length; i++) {
      const blocks = Math.max(1, a[i].width >> 2) * Math.max(1, a[i].height >> 2);
      assert.equal(a[i].bytes.length, blocks * (encoding === "dxt1" ? 8 : 16));
      assert.deepEqual(a[i].bytes, b[i].bytes, `${packed} level ${i}`);
    }
  }

  // DXT1's first block: red both ends (RGB565 0xf800), indices all 2.
  assert.deepEqual(
    [...decode(fixture("compressed"))[0].bytes.subarray(0, 8)],
    [0x00, 0xf8, 0x00, 0xf8, 0xaa, 0xaa, 0xaa, 0xaa],
  );
});

test("the old header decodes to the same images", () => {
  for (const name of [
    "rgb",
    "compressed",
    "raw",
    "compressed-alpha",
    "raw-alpha",
    "compressed-cube",
  ]) {
    assert.deepEqual(decode(oldHeader(fixture(name))), decode(fixture(name)), name);
  }
});

test("cube maps give each face its levels, in ATF's order", () => {
  const images = decode(fixture("rgb-cube"));
  // -X, +X, -Y, +Y, -Z, +Z were drawn red, green, blue, yellow, cyan and magenta.
  assert.deepEqual(
    images.filter((image) => image.level === 0).map((image) => argb(image.bytes, 0)),
    [0xffff0000, 0xff00ff00, 0xff0000ff, 0xffffff00, 0xff00ffff, 0xffff00ff],
  );
  assert.deepEqual(
    decode(fixture("compressed-cube")).map((image) => [image.face, image.level]),
    [0, 1, 2, 3, 4, 5].flatMap((face) => [0, 1, 2, 3, 4].map((level) => [face, level])),
  );
});

test("levels whose blocks are empty are left out", () => {
  // png2atf -n 0,2: the levels past 2 have empty blocks.
  assert.deepEqual(
    decode(fixture("compressed-range")).map((image) => image.level),
    [0, 1, 2],
  );
});

test("an upload is read at its offset, and what follows the length is not read", () => {
  const atf = fixture("compressed");
  const shifted = new Uint8Array(atf.length + 7);
  shifted.set(atf, 3);
  assert.deepEqual(decode(shifted, 3), decode(atf));
  assert.equal(refusal(shifted, 0), "decode");
  assert.equal(refusal(shifted, 2), "decode");
});

test("refusals are AIR's: signature, size, format, level count, blocks", () => {
  const atf = fixture("compressed");
  const changed = (at: number, value: number, from = atf) => {
    const out = from.slice();
    out[at] = value;
    return out;
  };

  // Nothing to read, or less than the header or length: #3669.
  assert.equal(refusal(new Uint8Array(0)), "size");
  assert.equal(refusal(atf.subarray(0, 2)), "size");
  assert.equal(refusal(atf.subarray(0, 12)), "size");
  assert.equal(refusal(atf.subarray(0, atf.length - 1)), "size");
  assert.equal(refusal(atf, atf.length + 4), "size");
  assert.equal(refusal(changed(8, 0x7f)), "size");
  assert.equal(refusal(oldHeader(atf).subarray(0, 2000)), "size");
  // The signature comes first, short or not: #3677.
  assert.equal(refusal(changed(0, 0x42)), "decode");
  assert.equal(refusal(changed(0, 0x42).subarray(0, 100)), "decode");
  // Formats past 13, sizes past 4096 and level counts the size has not: #3677.
  for (const format of [14, 15, 0x7f]) {
    assert.equal(refusal(changed(12, format)), "decode");
  }
  assert.equal(refusal(changed(13, 13)), "decode");
  for (const count of [0, 8, 13, 14, 20]) {
    assert.equal(refusal(changed(15, count)), "decode", `count ${count}`);
  }
  // Formats 6 to 11 are known but no texture's: the caller's mismatch, #3675.
  for (const format of [6, 7, 11]) {
    assert.equal(atfKind(format), null);
    assert.equal(refusal(changed(12, format)), "format");
  }
  assert.equal(atfKind(14), undefined);
  // Another layout read as this one: the version's block lengths and ETC2's blocks.
  assert.equal(refusal(changed(7, 0)), "decode");
  assert.equal(refusal(changed(7, 2)), "decode");
  assert.equal(refusal(changed(7, 4)), null);
  assert.equal(refusal(changed(12, 3)), "decode");
  assert.equal(refusal(changed(12, 12)), "decode");
  // A block whose length runs past the data.
  const empty = atf.slice();
  empty.fill(0, 16, 20);
  assert.equal(refusal(empty), "decode");
  // Reserved bytes and trailing data are not read.
  assert.equal(refusal(changed(3, 1)), null);
  assert.equal(refusal(changed(5, 0x40)), null);
  const longer = new Uint8Array(atf.length + 4);
  longer.set(atf);
  assert.equal(refusal(longer), null);
});

test("a corrupt LZMA or JPEG XR block is #3677, and the module still decodes", () => {
  const atf = fixture("compressed");
  const lzma = atf.slice();
  lzma.fill(0xff, 25, 60);
  assert.equal(refusal(lzma), "decode");

  const length = new DataView(atf.buffer).getUint32(16);
  const jxr = atf.slice();
  jxr.fill(0x5a, 20 + length + 4 + 40, 20 + length + 4 + 90);
  assert.equal(refusal(jxr), "decode");
  const container = atf.slice();
  container[20 + length + 4] = 0;
  assert.equal(refusal(container), "decode");

  const rgb = fixture("rgb");
  const image = rgb.slice();
  image.fill(0x5a, 60, 140);
  assert.equal(refusal(image), "decode");

  assert.equal(decode(atf).length, 7);
  assert.equal(jxrTraps(), 0);
});

test("a length that ends early streams the levels before it, as AIR does", () => {
  const atf = fixture("compressed");
  // Header alone: no level.
  assert.deepEqual(decode(withLength(atf, 16).subarray(0, 16)), []);
  assert.deepEqual(decode(withLength(atf, 16)), []);
  // Ending after level 0, with the rest still there or cut away.
  const one = levelStart(atf, 1);
  assert.deepEqual(
    decode(withLength(atf, one)).map((image) => image.level),
    [0],
  );
  assert.deepEqual(
    decode(withLength(atf, one).subarray(0, one)).map((image) => image.level),
    [0],
  );
  // Ending inside level 1: that level is not whole within the length.
  assert.deepEqual(
    decode(withLength(atf, one + 10)).map((image) => image.level),
    [0],
  );
});
