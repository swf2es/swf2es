// The bitmap tags read as Flash reads them (the bitmap-symbols player case
// has adl's word on each): lossless pixels, the image bytes a decoder gets,
// and what Flash refuses.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type Bitmap,
  readBitmap,
  readSwf,
  zlibCompress,
} from "../../../packages/format/dist/index.js";
import * as w from "../../swf-writer.ts";

const u16 = (v: number) => [v & 0xff, v >> 8];
const u32 = (v: number) => [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, v >>> 24];
const zlib = (bytes: number[]) => [...zlibCompress(Uint8Array.from(bytes))];

/** The bitmaps of a SWF holding `tags`, read with the JPEGTables before each. */
function bitmaps(...tags: Uint8Array[]): Bitmap[] {
  const swf = readSwf(w.swf({ width: 10, height: 10, frameCount: 1, tags: [...tags, w.end()] }));
  let tables: Uint8Array | null = null;
  const out: Bitmap[] = [];
  for (const t of swf.tags) {
    if (t.code === 8) {
      tables = swf.bytes.slice(t.offset, t.offset + t.length);
    } else if (t.code !== 0) {
      out.push(readBitmap(swf.bytes, t, tables));
    }
  }

  return out;
}

const hex = (b: Bitmap) =>
  b.type === "pixels" ? [...b.pixels].map((p) => p.toString(16)) : b.type;

test("the lossless formats read to premultiplied ARGB", () => {
  const [palette, rgb15, xrgb, argb, palette2] = bitmaps(
    w.tag(
      20,
      Uint8Array.from([
        ...u16(1),
        3,
        ...u16(3),
        ...u16(2),
        1,
        ...zlib([10, 20, 30, 200, 100, 50, 0, 1, 0, 0, 1, 0, 9, 0]),
      ]),
      true,
    ),
    w.tag(
      20,
      Uint8Array.from([
        ...u16(2),
        4,
        ...u16(1),
        ...u16(2),
        ...zlib([0x7c, 0x00, 0, 0, 0x04, 0x43, 0, 0]),
      ]),
      true,
    ),
    w.tag(
      20,
      Uint8Array.from([...u16(3), 5, ...u16(1), ...u16(1), ...zlib([0x12, 1, 2, 3])]),
      true,
    ),
    w.tag(
      36,
      Uint8Array.from([...u16(4), 5, ...u16(1), ...u16(1), ...zlib([0x80, 0x40, 0x20, 0x10])]),
      true,
    ),
    w.tag(
      36,
      Uint8Array.from([
        ...u16(5),
        3,
        ...u16(2),
        ...u16(1),
        1,
        ...zlib([255, 0, 0, 255, 0, 128, 0, 128, 1, 0, 0, 0]),
      ]),
      true,
    ),
  );
  // Rows of indices padded to 4 bytes; an index past the palette is 0.
  assert.deepEqual(hex(palette), ["ff0a141e", "ffc86432", "ff0a141e", "ffc86432", "ff0a141e", "0"]);
  assert.equal(palette.type === "pixels" && palette.transparent, false);
  // 5-bit channels widened to v * 8 + 7, 0 kept at 0.
  assert.deepEqual(hex(rgb15), ["ffff0000", "ff0f171f"]);
  // The first byte of xRGB is not alpha.
  assert.deepEqual(hex(xrgb), ["ff010203"]);
  assert.deepEqual(hex(argb), ["80402010"]);
  assert.equal(argb.type === "pixels" && argb.transparent, true);
  // Lossless2's palette is premultiplied, as its pixels are.
  assert.deepEqual(hex(palette2), ["80008000", "ffff0000"]);
});

test("Flash refuses a bitmap tag with the short header, corrupt data and DefineBits without tables", () => {
  const body = Uint8Array.from([...u16(1), 5, ...u16(1), ...u16(1), ...zlib([0, 1, 2, 3])]);
  const [short, long, corrupt, empty, noTables] = bitmaps(
    w.tag(20, body),
    w.tag(20, body, true),
    w.tag(20, Uint8Array.from([...u16(3), 5, ...u16(1), ...u16(1), 1, 2, 3]), true),
    w.tag(20, Uint8Array.from([...u16(4), 5, ...u16(0), ...u16(1), ...zlib([])]), true),
    w.tag(6, Uint8Array.from([...u16(5), 0xff, 0xd8, 0xff, 0xda, 0, 2, 0xff, 0xd9]), true),
  );
  assert.deepEqual(
    [short.type, long.type, corrupt.type, empty.type, noTables.type],
    ["invalid", "pixels", "invalid", "invalid", "invalid"],
  );
});

test("a JPEG reaches the decoder whole: stray markers dropped, tables spliced in", () => {
  const dqt = [0xff, 0xdb, 0, 3, 7];
  const sos = [0xff, 0xda, 0, 2, 1, 2, 3, 0xff, 0xd9];
  const [prefixed, spliced] = bitmaps(
    w.tag(
      21,
      Uint8Array.from([...u16(1), 0xff, 0xd9, 0xff, 0xd8, 0xff, 0xd8, ...dqt, ...sos]),
      true,
    ),
    w.tag(8, Uint8Array.from([0xff, 0xd8, ...dqt, 0xff, 0xd9]), true),
    w.tag(6, Uint8Array.from([...u16(2), 0xff, 0xd8, ...sos]), true),
  );
  const whole = [0xff, 0xd8, ...dqt, ...sos];
  for (const b of [prefixed, spliced]) {
    assert.equal(b.type, "image");
    assert.deepEqual(b.type === "image" && [b.format, [...b.data]], ["jpeg", whole]);
  }
});

test("DefineBitsJPEG3's alpha is a JPEG's alone; JPEG4's is none", () => {
  const jpeg = [0xff, 0xd8, 0xff, 0xda, 0, 2, 9, 0xff, 0xd9];
  const png = [0x89, 0x50, 0x4e, 0x47, 1, 2];
  const alpha = zlib([1, 2, 3]);
  const [j3, p3, j4, gif] = bitmaps(
    w.tag(35, Uint8Array.from([...u16(1), ...u32(jpeg.length), ...jpeg, ...alpha]), true),
    w.tag(35, Uint8Array.from([...u16(2), ...u32(png.length), ...png, ...alpha]), true),
    w.tag(
      90,
      Uint8Array.from([...u16(3), ...u32(jpeg.length), ...u16(0x100), ...jpeg, ...alpha]),
      true,
    ),
    w.tag(21, Uint8Array.from([...u16(4), 0x47, 0x49, 0x46, 0x38, 0x39, 0x61]), true),
  );
  assert.deepEqual(j3.type === "image" && [j3.format, [...(j3.alpha ?? [])], j3.opaque], [
    "jpeg",
    [1, 2, 3],
    false,
  ]);
  assert.deepEqual(p3.type === "image" && [p3.format, p3.alpha, [...p3.data]], ["png", null, png]);
  assert.deepEqual(j4.type === "image" && [j4.alpha, j4.opaque], [null, true]);
  assert.equal(gif.type === "image" && gif.format, "gif");
});
