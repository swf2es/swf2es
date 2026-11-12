// BitmapData.encode's JPEG XR: the files Flash writes, byte for byte, for
// pictures and flat bitmaps, opaque and transparent, at the quantizations,
// colour spaces and trims Flash's steps turn on (adl's files, summed); and
// what the files decode to through jxrlib's decoder, the one ATF's
// textures take.
import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeJxr, JXR_BGR, JXR_BGRA } from "../../../../packages/native/dist/atf/jxr.js";
import { BitmapStore } from "../../../../packages/player/dist/bitmap/bitmap.js";
import { encodeJpegXr } from "../../../../packages/player/dist/bitmap/jpegxr.js";

/** Fletcher's sum of the bytes, as the player case traces it. */
function sum(bytes: Uint8Array): string {
  let s1 = 1;
  let s2 = 0;
  for (const b of bytes) {
    s1 = (s1 + b) % 65521;
    s2 = (s2 + s1) % 65521;
  }

  return ((s2 * 65536 + s1) >>> 0).toString(16);
}

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");

const whole = (store: BitmapStore) => ({ x: 0, y: 0, width: store.width, height: store.height });

/** The case's picture (scripts/BitmapEncodeJpegXr.as), set a pixel at a time as there. */
function picture(w: number, h: number, transparent: boolean): BitmapStore {
  const store = new BitmapStore(w, h, transparent, 0xff000000);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = Math.trunc((x * 255) / (w - 1));
      let g = Math.trunc((y * 255) / (h - 1));
      let b = 255 - r;
      if (x >= 4 && x < 20 && y >= 4 && y < 12) {
        [r, g, b] = [200, 40, 90];
      }

      if (x + y > 50) {
        [r, g, b] = [30, 160, 220];
      }

      // AS3's int of the difference, not the difference of ints.
      const a = transparent ? Math.trunc(255 - (x * 255) / (w - 1)) : 255;
      store.setPixel32(x, y, ((a << 24) | (r << 16) | (g << 8) | b) >>> 0);
    }
  }

  return store;
}

test("a picture's files are Flash's at each quantization, colour space and trim", () => {
  const opaque = picture(40, 24, false);
  const transparent = picture(40, 24, true);
  // adl's files: quantization, colour space, trim, their length and sum.
  const cases: [BitmapStore, number, string, number, number, string][] = [
    [opaque, 0, "auto", 0, 1251, "a491a874"],
    [opaque, 1, "auto", 0, 1357, "7c27e253"],
    [opaque, 2, "auto", 0, 1211, "54daadee"],
    [opaque, 5, "auto", 0, 993, "4b174bf4"],
    [opaque, 10, "auto", 0, 785, "cc0e3ccb"],
    [opaque, 20, "auto", 0, 637, "8a65eb44"],
    [opaque, 30, "auto", 0, 555, "bdc5b709"],
    [opaque, 50, "auto", 0, 385, "c1a387cd"],
    [opaque, 70, "auto", 0, 267, "4dc14967"],
    [opaque, 80, "auto", 0, 249, "9aa54058"],
    [opaque, 90, "auto", 0, 237, "3e643c21"],
    [opaque, 99, "auto", 0, 221, "e1d305b"],
    [opaque, 100, "auto", 0, 219, "fac62dfe"],
    [opaque, 20, "4:4:4", 0, 637, "8a65eb44"],
    [opaque, 20, "4:2:2", 0, 531, "4670b8a0"],
    [opaque, 20, "4:2:0", 0, 461, "3755a546"],
    [opaque, 20, "auto", 1, 637, "c385dfac"],
    [opaque, 20, "auto", 2, 637, "e3a5dfbc"],
    [opaque, 20, "auto", 7, 637, "8454e00c"],
    [opaque, 20, "auto", 14, 637, "6543e07c"],
    [opaque, 20, "auto", 15, 637, "8563e08c"],
    [transparent, 0, "auto", 0, 1673, "1cd96fc3"],
    [transparent, 20, "auto", 0, 617, "969dbfd4"],
    [transparent, 50, "auto", 0, 345, "91ec5f15"],
    [transparent, 20, "4:2:2", 0, 503, "fc729f00"],
    [transparent, 20, "4:2:0", 0, 465, "52e58e42"],
  ];
  for (const [store, quantization, space, trim, length, flash] of cases) {
    const file = encodeJpegXr(store, whole(store), quantization, space, trim);
    const name = `${store.transparent ? "transparent" : "opaque"} ${quantization} ${space} ${trim}`;
    assert.equal(file.length, length, name);
    assert.equal(sum(file), flash, name);
  }
});

test("flat bitmaps' files are Flash's: lossless, alpha, an edge past the size, a long size", () => {
  // adl's files, whole.
  const cases: [BitmapStore, number, string][] = [
    [
      new BitmapStore(1, 1, false, 0xff336699),
      20,
      "4949bc0108000000050001bc0100100000004a00000080bc0400010000000100000081bc04000100000001000000c0bc0400010000005a000000c1bc0400010000003e0000000000000024c3dd6f034efe4bb1853d77768dc90c574d50484f544f001900c07100000000700084c84c84c000046fff00010000010089a012800000000000000000000000000000000000000000000008e40000",
    ],
    [
      new BitmapStore(17, 9, false, 0xffcc8844),
      20,
      "4949bc0108000000050001bc0100100000004a00000080bc0400010000001100000081bc04000100000009000000c0bc0400010000005a000000c1bc040001000000520000000000000024c3dd6f034efe4bb1853d77768dc90c574d50484f544f001900c07100100008700084c84c84c000046fff000100000100830018d00000000000000000000000000000000000000000000008e480000000000000000000000000000000000000010000",
    ],
    [
      new BitmapStore(16, 16, false, 0xff808080),
      0,
      "4949bc0108000000050001bc0100100000004a00000080bc0400010000001000000081bc04000100000010000000c0bc0400010000005a000000c1bc040001000000400000000000000024c3dd6f034efe4bb1853d77768dc90c574d50484f544f001900c071000f000f6000a0000a0000a0000000046fff0001000001008000000000000000000000000000000000000000000000000000239000",
    ],
    [
      new BitmapStore(16, 16, true, 0),
      20,
      "4949bc0108000000050001bc0100100000004a00000080bc0400010000001000000081bc04000100000010000000c0bc0400010000005a000000c1bc0400010000004c0000000000000024c3dd6f034efe4bb1853d77768dc910574d50484f544f001900c171000f000f700084c84c84c0109324c93000046fff000100000100aea000000000000000000000000000000000000000000000000011c8ba80000000000000012000",
    ],
    [
      new BitmapStore(16, 16, true, 0xff336699),
      20,
      "4949bc0108000000050001bc0100100000004a00000080bc0400010000001000000081bc04000100000010000000c0bc0400010000005a000000c1bc0400010000004c0000000000000024c3dd6f034efe4bb1853d77768dc910574d50484f544f001900c171000f000f700084c84c84c0109324c93000046fff00010000010089a012800000000000000000000000000000000000000000000008e45c80000000000000009000",
    ],
    // new BitmapData(16, 16, true, 0x80FF8040): the colours times alpha, as the store keeps them.
    [
      new BitmapStore(16, 16, true, 0x80ff8040),
      0,
      "4949bc0108000000050001bc0100100000004a00000080bc0400010000001000000081bc04000100000010000000c0bc0400010000005a000000c1bc040001000000520000000000000024c3dd6f034efe4bb1853d77768dc910574d50484f544f001900c171000f000f6000a0000a0000a00000008020080000046fff0001000001007a02804a0100000000000000000000000000000000000000000000008e40000000000000000012000000",
    ],
  ];
  for (const [store, quantization, flash] of cases) {
    assert.equal(hex(encodeJpegXr(store, whole(store), quantization, "auto", 0)), flash);
  }

  // 4097 pixels are 257 macroblocks, past which jxrlib writes the size in 32 bits; Flash
  // writes it in 16 whatever it is.
  const wide = new BitmapStore(4097, 2, false, 0xff336699);
  const file = encodeJpegXr(wide, whole(wide), 20, "auto", 0);
  assert.equal(file.length, 325);
  assert.equal(sum(file), "cb815012");
  assert.equal(
    hex(file.subarray(0, 122)),
    "4949bc0108000000050001bc0100100000004a00000080bc0400010000000110000081bc04000100000002000000c0bc0400010000005a000000c1bc040001000000ea0000000000000024c3dd6f034efe4bb1853d77768dc90c574d50484f544f001900c07110000001700084c84c84c000046fff0001000001",
  );
});

test("a rect encodes its part alone, at its own size", () => {
  const store = picture(40, 24, false);
  const part = new BitmapStore(17, 10, false, 0xff000000);
  for (let y = 0; y < 10; y++) {
    for (let x = 0; x < 17; x++) {
      part.setPixel32(x, y, store.getPixel32(x + 3, y + 2));
    }
  }

  assert.deepEqual(
    encodeJpegXr(store, { x: 3, y: 2, width: 17, height: 10 }, 20, "4:2:0", 0),
    encodeJpegXr(part, whole(part), 20, "4:2:0", 0),
  );
});

test("lossless files decode to the very pixels, premultiplied where there is alpha", () => {
  let seed = 7;
  const random = () => {
    seed = (seed * 1103515245 + 12345) >>> 0;
    return seed >>> 8;
  };

  for (const [w, h] of [
    [1, 1],
    [16, 16],
    [33, 17],
    [70, 41],
  ]) {
    for (const transparent of [false, true]) {
      const store = new BitmapStore(w, h, transparent, 0);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          store.setPixel32(x, y, random() | (transparent ? (random() & 0xff) << 24 : 0xff000000));
        }
      }

      const file = encodeJpegXr(store, whole(store), 0, "auto", 0);
      // The decoder takes alpha as straight: the same samples, under BGRA's name.
      if (transparent) {
        file[89] = 0x0f;
      }

      const image = decodeJxr(file, transparent ? JXR_BGRA : JXR_BGR, 1 << 16);
      assert.ok(image, `${w} by ${h}`);
      const kept = store.drawable;
      const pixels = new Uint32Array(image.pixels.buffer, image.pixels.byteOffset, w * h);
      for (let i = 0; i < w * h; i++) {
        const expected = transparent ? kept[i] : (kept[i] | 0xff000000) >>> 0;
        assert.equal(pixels[i], expected, `${w} by ${h}, pixel ${i}`);
      }
    }
  }
});

test("lossy files decode near the picture, nearer as the quantization falls", () => {
  const store = picture(40, 24, false);
  const kept = store.drawable;
  const errors: string[] = [];
  for (const space of ["4:4:4", "4:2:0"]) {
    let previous = Number.POSITIVE_INFINITY;
    for (const quantization of [90, 50, 20, 5, 1]) {
      const image = decodeJxr(
        encodeJpegXr(store, whole(store), quantization, space, 0),
        JXR_BGR,
        1 << 16,
      );
      assert.ok(image);
      // The mean difference of a channel.
      let total = 0;
      for (let i = 0; i < kept.length * 4; i++) {
        if (i % 4 !== 3) {
          total += Math.abs(image.pixels[i] - ((kept[i >> 2] >>> ((i % 4) * 8)) & 0xff));
        }
      }

      const error = total / (kept.length * 3);
      errors.push(`${space} ${quantization}: ${error.toFixed(2)}`);
      assert.ok(error <= previous, errors.join(", "));
      previous = error;
    }

    // 4:2:0's floor is its chroma's, a quarter as many samples on edges between colours.
    assert.ok(previous < (space === "4:4:4" ? 0.5 : 8), errors.join(", "));
  }
});
