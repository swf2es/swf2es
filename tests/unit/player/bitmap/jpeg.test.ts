// BitmapData.encode's JPEG: read by an independent decoder (tests/player/jpeg.ts),
// it holds the store's colours as they are kept, alpha left out; where
// the picture is flat it is the file Flash writes, byte for byte; and a
// picture's files decode to what Flash drew of its own.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { BitmapStore } from "../../../../packages/player/dist/bitmap/bitmap.js";
import { encodeJpeg } from "../../../../packages/player/dist/bitmap/jpeg.js";
import { decodePng } from "../../../player/image.ts";
import { decodeJpeg } from "../../../player/jpeg.ts";

test("a one-pixel bitmap encodes to the file Flash's encoder writes", () => {
  // adl's output for new BitmapData(1, 1, false, 0x336699) at quality 80.
  const flash =
    "ffd8ffe000104a46494600010100000100010000ffdb00430006040506050406060506070706080a100a0a09090a140e0f0c1017141818171416161a1d251f1a1b231c1616202c20232627292a29191f2d302d283025282928ffdb0043010707070a080a130a0a13281a161a2828282828282828282828282828282828282828282828282828282828282828282828282828282828282828282828282828ffc00011080001000103012200021101031101ffc4001f0000010501010101010100000000000000000102030405060708090a0bffc400b5100002010303020403050504040000017d01020300041105122131410613516107227114328191a1082342b1c11552d1f02433627282090a161718191a25262728292a3435363738393a434445464748494a535455565758595a636465666768696a737475767778797a838485868788898a92939495969798999aa2a3a4a5a6a7a8a9aab2b3b4b5b6b7b8b9bac2c3c4c5c6c7c8c9cad2d3d4d5d6d7d8d9dae1e2e3e4e5e6e7e8e9eaf1f2f3f4f5f6f7f8f9faffc4001f0100030101010101010101010000000000000102030405060708090a0bffc400b51100020102040403040705040400010277000102031104052131061241510761711322328108144291a1b1c109233352f0156272d10a162434e125f11718191a262728292a35363738393a434445464748494a535455565758595a636465666768696a737475767778797a82838485868788898a92939495969798999aa2a3a4a5a6a7a8a9aab2b3b4b5b6b7b8b9bac2c3c4c5c6c7c8c9cad2d3d4d5d6d7d8d9dae2e3e4e5e6e7e8e9eaf2f3f4f5f6f7f8f9faffda000c03010002110311003f00e428a28afa73e74fffd9";
  const store = new BitmapStore(1, 1, false, 0xff336699);
  const jpeg = encodeJpeg(store, { x: 0, y: 0, width: 1, height: 1 }, 80);
  assert.equal(Buffer.from(jpeg).toString("hex"), flash);
});

test("flat bitmaps' scans are Flash's: a block past the edge, a stuffed byte, premultiplied alpha", () => {
  // What follows the 623 bytes of segments in adl's files.
  const cases: [BitmapStore, number, string][] = [
    [new BitmapStore(8, 8, false, 0xff808080), 80, "28a28a00ffd9"],
    [new BitmapStore(8, 8, false, 0xffffffff), 80, "faa68a28a00fffd9"],
    [new BitmapStore(8, 8, false, 0xffff0000), 100, "fc5fa28a2bfca73fefe0ffd9"],
    [new BitmapStore(8, 8, false, 0xff0000ff), 100, "fe39e8a28aff00bf83f95cffd9"],
    [new BitmapStore(16, 16, true, 0), 90, "fcaaa28a2803ffd9"],
    // new BitmapData(16, 16, true, 0x80FF8040): the colours times alpha, as the store keeps them.
    [new BitmapStore(16, 16, true, 0x80ff8040), 90, "f9f28a28afcdcfd74fffd9"],
  ];
  for (const [store, quality, scan] of cases) {
    const jpeg = encodeJpeg(
      store,
      { x: 0, y: 0, width: store.width, height: store.height },
      quality,
    );
    assert.equal(Buffer.from(jpeg.subarray(623)).toString("hex"), scan);
  }
});

test("a rect encodes its part alone, at its own size", () => {
  const store = new BitmapStore(40, 30, false, 0xff204060);
  for (let y = 10; y < 30; y++) {
    for (let x = 20; x < 40; x++) {
      store.setPixel32(x, y, 0xffc08040);
    }
  }

  const part = decodeJpeg(encodeJpeg(store, { x: 20, y: 10, width: 17, height: 9 }, 90));
  assert.deepEqual([part.width, part.height], [17, 9]);
  for (let i = 0; i < 17 * 9; i++) {
    assert.deepEqual([...part.data.subarray(i * 4, i * 4 + 3)], [0xc0, 0x80, 0x40]);
  }

  // The whole, its rows the store's own: both colours, each on its side of the edge.
  const whole = decodeJpeg(encodeJpeg(store, { x: 0, y: 0, width: 40, height: 30 }, 100));
  const at = (x: number, y: number) => [
    ...whole.data.subarray((y * 40 + x) * 4, (y * 40 + x) * 4 + 3),
  ];
  for (const [x, y, colour] of [
    [2, 2, [0x20, 0x40, 0x60]],
    [36, 26, [0xc0, 0x80, 0x40]],
    [36, 2, [0x20, 0x40, 0x60]],
  ] as [number, number, number[]][]) {
    at(x, y).forEach((v, c) => {
      assert.ok(Math.abs(v - colour[c]) <= 3, `(${x}, ${y}): ${at(x, y)}`);
    });
  }
});

test("a picture's files, decoded as Flash decodes, are the pictures Flash drew of its own files", () => {
  // The player's bitmap-encode-jpeg case (tests/player/scripts/BitmapEncodeJpeg.as): Flash
  // encoded this picture at 100, 80 and 30, and with alpha at 90, loaded the files and drew
  // them side by side. That frame is compared here with the files made here, so that no
  // browser's decoder, which makes chroma its own way, comes between. What is left is a
  // coefficient in a hundred a step away, where the two encoders' DCTs round apart.
  const picture = (transparent: boolean): BitmapStore => {
    const store = new BitmapStore(96, 64, transparent, 0xff000000);
    for (let y = 0; y < 64; y++) {
      for (let x = 0; x < 96; x++) {
        let r = Math.trunc((x * 255) / 95);
        let g = Math.trunc((y * 255) / 63);
        let b = 255 - r;
        if (x >= 8 && x < 40 && y >= 8 && y < 24) {
          [r, g, b] = [200, 40, 90];
        }

        if (x + y > 120) {
          [r, g, b] = [30, 160, 220];
        }

        const d = Math.sqrt((x - 64) * (x - 64) + (y - 22) * (y - 22));
        if (d < 14) {
          [r, g, b] = [Math.trunc(255 - (200 * d) / 14), Math.trunc(240 - (100 * d) / 14), 60];
        }

        const a = transparent ? Math.trunc(255 - (x * 255) / 95) : 255;
        store.setPixel32(x, y, ((a << 24) | (r << 16) | (g << 8) | b) >>> 0);
      }
    }

    return store;
  };
  const frame = decodePng(
    readFileSync(
      new URL("../../../player/references/bitmap-encode-jpeg/frame-6.png", import.meta.url),
    ),
  );
  const shown: [BitmapStore, number, number, number][] = [
    [picture(false), 100, 2, 4],
    [picture(false), 80, 102, 8],
    [picture(false), 30, 202, 10],
    [picture(true), 90, 302, 12],
  ];
  for (const [store, quality, left, most] of shown) {
    const jpeg = decodeJpeg(
      encodeJpeg(store, { x: 0, y: 0, width: 96, height: 64 }, quality),
      true,
    );
    let worst = 0;
    for (let y = 0; y < 64; y++) {
      for (let x = 0; x < 96; x++) {
        for (let c = 0; c < 3; c++) {
          const flash = frame.data[((y + 2) * frame.width + left + x) * 4 + c];
          worst = Math.max(worst, Math.abs(flash - jpeg.data[(y * 96 + x) * 4 + c]));
        }
      }
    }

    assert.ok(worst <= most, `at ${quality}, off by ${worst}`);
  }
});
