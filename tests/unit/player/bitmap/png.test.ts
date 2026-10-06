// BitmapData.encode's PNG: decoded by an independent reader (zlib's inflate
// and the PNG filters), it holds Flash's colours, divided out of alpha as
// Flash's encoder does, floor(c * 256 / a) up to 255, which adl showed for
// every alpha and value.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BitmapStore, premultiply } from "../../../../packages/player/dist/bitmap/bitmap.js";
import { encodePng } from "../../../../packages/player/dist/bitmap/png.js";
import { decodePng } from "../../../player/image.ts";

test("a transparent store encodes as RGBA, its colours divided out as Flash's encoder does", () => {
  const store = new BitmapStore(256, 256, true, 0);
  for (let a = 0; a < 256; a++) {
    for (let c = 0; c < 256; c++) {
      store.pixels[a * 256 + c] = premultiply(((a << 24) | (c << 16) | ((255 - c) << 8) | c) >>> 0);
    }
  }

  for (const fast of [true, false]) {
    const png = encodePng(store, { x: 0, y: 0, width: 256, height: 256 }, fast);
    assert.equal(png[25], 6, "colour type RGBA");
    const image = decodePng(png);
    for (let a = 0; a < 256; a++) {
      for (let c = 0; c < 256; c++) {
        const p = store.pixels[a * 256 + c];
        const expected = (v: number) => (a === 0 ? 0 : Math.min(255, Math.floor((v * 256) / a)));
        const i = (a * 256 + c) * 4;
        assert.deepEqual(
          [...image.data.subarray(i, i + 4)],
          [expected((p >>> 16) & 0xff), expected((p >>> 8) & 0xff), expected(p & 0xff), a],
          `alpha ${a} value ${c} fast ${fast}`,
        );
      }
    }
  }
});

test("an opaque store encodes as RGB, and a rect encodes its part alone", () => {
  const store = new BitmapStore(4, 3, false, 0xff123456);
  store.setPixel32(2, 1, 0xffabcdef);
  const png = encodePng(store, { x: 1, y: 1, width: 2, height: 2 }, true);
  assert.equal(png[25], 2, "colour type RGB");
  const image = decodePng(png);
  assert.deepEqual([image.width, image.height], [2, 2]);
  assert.deepEqual(
    [...image.data],
    [0x12, 0x34, 0x56, 255, 0xab, 0xcd, 0xef, 255, 0x12, 0x34, 0x56, 255, 0x12, 0x34, 0x56, 255],
  );
});

test("a small bitmap encodes to what Flash's encoder writes", () => {
  // adl's output for a 3 x 2 bitmap of 0x80FF8040 with (1, 0) 0xFF102030 and (2, 1) clear.
  const flash =
    "89504e470d0a1a0a0000000d49484452000000030000000208060000009d74661a000000214944415478da63fedfe0d030f181c0feef051a8c4c0c40f03e41a091b1e14003008c7a09b66c3cb79e0000000049454e44ae426082";
  const store = new BitmapStore(3, 2, true, 0x80ff8040);
  store.setPixel32(1, 0, 0xff102030);
  store.setPixel32(2, 1, 0);
  for (const fast of [true, false]) {
    const png = encodePng(store, { x: 0, y: 0, width: 3, height: 2 }, fast);
    // The same IHDR, and the same pixels; the compressed bytes may differ.
    assert.equal(Buffer.from(png.subarray(0, 33)).toString("hex"), flash.slice(0, 66));
    assert.deepEqual(decodePng(png), decodePng(new Uint8Array(Buffer.from(flash, "hex"))));
  }
});
