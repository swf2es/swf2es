import assert from "node:assert/strict";
import { test } from "node:test";
import { binary } from "../../packages/native/dist/compress/binary.js";
import {
  CORRUPT,
  DONE,
  deflate,
  FULL,
  inflate,
  jpegEncode,
  lzmaDecode,
  lzmaEncode,
  MEMORY_KEPT,
  memoryInUse,
  pngEncode,
  TRUNCATED,
} from "../../packages/native/dist/compress/index.js";
import { decodeJpeg } from "../player/jpeg.ts";

/** Bytes that compress, but not to nothing: a seeded walk over a small alphabet. */
function sample(length: number, seed = 1): Uint8Array {
  const out = new Uint8Array(length);
  let x = seed;
  for (let i = 0; i < length; i++) {
    x = (Math.imul(x, 1103515245) + 12345) >>> 0;
    out[i] = 97 + ((x >>> 24) % 7);
  }

  return out;
}

test("the module imports nothing", async () => {
  const module = await WebAssembly.compile(Buffer.from(binary, "base64"));
  assert.deepEqual(WebAssembly.Module.imports(module), []);
});

test("zlib and raw deflate round trip at every level", () => {
  const data = sample(100_000);
  for (let level = 0; level <= 9; level++) {
    for (const raw of [false, true]) {
      const z = deflate(data, level, raw);
      const back = inflate(z, raw, 2 ** 32 - 1);
      assert.equal(back.status, DONE);
      assert.equal(back.used, z.length);
      assert.deepEqual(back.bytes, data);
    }
  }
});

/**
 * PNG's rows filtered a byte at a time, as the encoder did it before the
 * module: each row the filter of the five whose output, taken as signed,
 * sums smallest, the first of equals, bottom up.
 */
function filteredRows(raw: Uint8Array, stride: number, bpp: number): Uint8Array {
  const out = raw.slice();
  const length = stride - 1;
  const candidates = Array.from({ length: 5 }, () => new Uint8Array(length));
  for (let y = raw.length / stride - 1; y >= 0; y--) {
    const row = y * stride + 1;
    const up = y > 0 ? row - stride : -1;
    let best = 0;
    let bestSum = Number.POSITIVE_INFINITY;
    for (let f = 0; f < 5; f++) {
      let sum = 0;
      for (let i = 0; i < length; i++) {
        const x = out[row + i];
        const a = i >= bpp ? out[row + i - bpp] : 0;
        const b = up >= 0 ? out[up + i] : 0;
        const c = up >= 0 && i >= bpp ? out[up + i - bpp] : 0;
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        const paeth = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
        candidates[f][i] = [x, x - a, x - b, x - ((a + b) >> 1), x - paeth][f];
        const s = candidates[f][i];
        sum += s < 128 ? s : 256 - s;
      }

      if (sum < bestSum) {
        bestSum = sum;
        best = f;
      }
    }

    out[row - 1] = best;
    out.set(candidates[best], row);
  }

  return out;
}

/** Pixels, premultiplied ARGB, as a PNG's unfiltered rows: Flash's division out of alpha. */
function rawRows(pixels: Uint32Array, width: number, channels: number): Uint8Array {
  const stride = 1 + width * channels;
  const raw = new Uint8Array((pixels.length / width) * stride);
  for (let i = 0; i < pixels.length; i++) {
    const p = pixels[i];
    const a = p >>> 24;
    const at = Math.floor(i / width) * stride + 1 + (i % width) * channels;
    for (let k = 0; k < 3; k++) {
      const c = (p >>> (16 - 8 * k)) & 0xff;
      raw[at + k] = a === 0 ? 0 : a === 255 ? c : Math.min(255, ((c << 8) / a) | 0);
    }

    if (channels === 4) {
      raw[at + 3] = a;
    }
  }

  return raw;
}

test("a PNG's rows are made, filtered and deflated as a byte at a time makes them", () => {
  let seed = 7;
  const random = () => {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    return (seed >>> 16) & 0xff;
  };
  for (const channels of [3, 4] as const) {
    // Widths under, at and over the module's sixteen bytes at a time, and their tails.
    for (const width of [1, 2, 5, 6, 16, 17, 33, 200]) {
      const height = 9;
      const pixels = new Uint32Array(width * height);
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          // Noise, a flat row, a ramp and a row like the one above, so that every filter
          // wins; alpha clear, opaque and between, its colours no more than it.
          const a = [random(), 255, 0, 128][(x + y) % 4];
          const c = [
            random(),
            200,
            x * 3 + y * 5,
            y ? (pixels[(y - 1) * width + x] & 0xff) + 1 : 9,
          ];
          const v = Math.floor(((c[y % 4] & 0xff) * a) / 255);
          pixels[y * width + x] = ((a << 24) | (v << 16) | ((v >> 1) << 8) | (v >> 2)) >>> 0;
        }
      }

      const raw = rawRows(pixels, width, channels);
      const stride = 1 + width * channels;
      const filtered = inflate(
        pngEncode(pixels, width, height, channels, 6, true),
        false,
        raw.length,
      );
      assert.equal(filtered.status, DONE);
      const expected = filteredRows(raw, stride, channels);
      assert.deepEqual(filtered.bytes, expected, `${width} wide, ${channels} channels`);
      const plain = inflate(
        pngEncode(pixels, width, height, channels, 1, false),
        false,
        raw.length,
      );
      assert.deepEqual(plain.bytes, raw, `${width} wide, ${channels} channels, unfiltered`);
    }
  }

  // Pixels that are not the size given are refused, not read past.
  assert.throws(() => pngEncode(new Uint32Array(10), 4, 3, 4, 6, true), RangeError);
});

/** A picture a JPEG holds well: gradients, a flat area with hard edges, and a soft disc. */
function smooth(width: number, height: number): Uint32Array {
  const pixels = new Uint32Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let r = Math.min(255, 40 + x * 2);
      let g = Math.min(255, 30 + y * 3);
      let b = 200 - Math.min(200, x + y);
      if (x >= 8 && x < 24 && y >= 8 && y < 24) {
        [r, g, b] = [200, 40, 90];
      }

      const d = Math.hypot(x - 40, y - 20) / 12;
      if (d < 1) {
        [r, g, b] = [Math.floor(255 - 200 * d), Math.floor(240 - 100 * d), 60];
      }

      pixels[y * width + x] = ((0xff << 24) | (r << 16) | (g << 8) | b) >>> 0;
    }
  }

  return pixels;
}

/**
 * How far a decoded picture is from its pixels: the worst luma, which a JPEG keeps at full
 * size, and the mean over the three colours, whose chroma it keeps at half.
 */
function distance(data: Uint8Array, pixels: Uint32Array): { luma: number; mean: number } {
  const y = (r: number, g: number, b: number) => 0.299 * r + 0.587 * g + 0.114 * b;
  let luma = 0;
  let sum = 0;
  for (let i = 0; i < pixels.length; i++) {
    const p = pixels[i];
    const got = data.subarray(i * 4, i * 4 + 3);
    const colour = [(p >>> 16) & 0xff, (p >>> 8) & 0xff, p & 0xff];
    for (let c = 0; c < 3; c++) {
      sum += Math.abs(got[c] - colour[c]);
    }

    // Where the decoded colour is not clamped to a byte, which moves its luma.
    if (Math.min(...got) > 0 && Math.max(...got) < 255) {
      luma = Math.max(
        luma,
        Math.abs(y(got[0], got[1], got[2]) - y(colour[0], colour[1], colour[2])),
      );
    }
  }

  return { luma, mean: sum / (pixels.length * 3) };
}

test("a JPEG has Flash's segments, sampling and tables at each quality", () => {
  const pixels = smooth(21, 13);
  // Annex K's tables in a block's rows, which quality 50 leaves as they are.
  const luma = [
    16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55, 14, 13, 16, 24, 40, 57, 69, 56,
    14, 17, 22, 29, 51, 87, 80, 62, 18, 22, 37, 56, 68, 109, 103, 77, 24, 35, 55, 64, 81, 104, 113,
    92, 49, 64, 78, 87, 103, 121, 120, 101, 72, 92, 95, 98, 112, 100, 103, 99,
  ];
  const chroma = [
    17, 18, 24, 47, 99, 99, 99, 99, 18, 21, 26, 66, 99, 99, 99, 99, 24, 26, 56, 99, 99, 99, 99, 99,
    47, 66, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99,
    99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99,
  ];
  // The IJG's scale: 5000 / quality percent under 50, 200 - 2 * quality from there; 0 is 1.
  const scaled = (table: number[], quality: number) => {
    const q = Math.max(1, quality);
    const percent = q < 50 ? Math.floor(5000 / q) : 200 - 2 * q;
    return table.map((v) => Math.min(32767, Math.max(1, Math.floor((v * percent + 50) / 100))));
  };
  for (const quality of [0, 1, 10, 19, 20, 23, 24, 49, 50, 51, 80, 99, 100]) {
    const jpeg = decodeJpeg(jpegEncode(pixels, 21, 13, quality));
    const tables = [scaled(luma, quality), scaled(chroma, quality)];
    // A value past 255 puts its table in 16 bits and makes the frame extended sequential.
    const wide = tables.map((t) => (t.some((v) => v > 255) ? 1 : 0));
    assert.deepEqual(
      jpeg.markers,
      [0xd8, 0xe0, 0xdb, 0xdb, wide[0] ? 0xc1 : 0xc0, 0xc4, 0xc4, 0xc4, 0xc4, 0xda, 0xd9],
      `quality ${quality}`,
    );
    assert.deepEqual(wide, [quality < 24 ? 1 : 0, quality < 20 ? 1 : 0], `quality ${quality}`);
    assert.deepEqual(
      jpeg.quantization,
      tables.map((values, id) => ({ id, precision: wide[id], values })),
      `quality ${quality}`,
    );
    // JFIF 1.01, no unit, density 1:1, no thumbnail.
    assert.deepEqual(
      [...(jpeg.jfif ?? [])],
      [0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0],
    );
    assert.deepEqual([jpeg.width, jpeg.height, jpeg.restartInterval], [21, 13, 0]);
    // 4:2:0: two MCUs of 16 by 16 across and one down.
    assert.deepEqual(
      jpeg.components.map((c) => [c.id, c.h, c.v, c.table, c.dc, c.ac, c.columns, c.rows]),
      [
        [1, 2, 2, 0, 0, 0, 4, 2],
        [2, 1, 1, 1, 1, 1, 2, 1],
        [3, 1, 1, 1, 1, 1, 2, 1],
      ],
    );
    assert.deepEqual(
      jpeg.huffman.map((h) => [h.kind, h.id, h.values.length]),
      [
        [0, 0, 12],
        [1, 0, 162],
        [0, 1, 12],
        [1, 1, 162],
      ],
    );
  }
});

test("a JPEG decodes to its picture, the closer the higher the quality, at any size", () => {
  // The worst luma and the mean colour a quality may leave. Chroma is kept at half the size,
  // so the colours on a hard edge are some way off whatever the quality; luma is not.
  const limits: [number, number, number][] = [
    [100, 2.5, 4],
    [90, 12, 7],
    [50, 16, 15],
    [10, 30, 22],
  ];
  const sizes = [
    [1, 1],
    [2, 3],
    [7, 5],
    [8, 8],
    [15, 17],
    [16, 16],
    [17, 9],
    [33, 31],
    [100, 37],
  ];
  for (const [width, height] of sizes) {
    const pixels = smooth(width, height);
    for (const [quality, luma, mean] of limits) {
      const jpeg = decodeJpeg(jpegEncode(pixels, width, height, quality));
      assert.deepEqual([jpeg.width, jpeg.height], [width, height]);
      const d = distance(jpeg.data, pixels);
      const where = `${width} by ${height} at ${quality}: luma ${d.luma}, mean ${d.mean}`;
      assert.ok(d.luma <= luma && d.mean <= mean, where);
    }
  }

  // A flat picture is itself at any quality but the lowest, whose steps are past its colours.
  const flat = new Uint32Array(20 * 20).fill(0xff336699);
  for (const quality of [100, 80, 30]) {
    const d = distance(decodeJpeg(jpegEncode(flat, 20, 20, quality)).data, flat);
    assert.ok(d.luma <= 3 && d.mean <= 3, `flat at ${quality}: ${d.luma}, ${d.mean}`);
  }
});

test("a JPEG leaves alpha out, and noise fits however little it compresses", () => {
  // Premultiplied pixels, as a transparent BitmapData keeps them: the alpha changes nothing.
  const pixels = smooth(40, 24);
  const faded = pixels.map((p, i) => {
    const a = 255 - (i % 40) * 6;
    const part = (shift: number) => Math.round((((p >>> shift) & 0xff) * a) / 255) << shift;
    return ((a << 24) | part(16) | part(8) | part(0)) >>> 0;
  });
  const opaque = faded.map((p) => (p | 0xff000000) >>> 0);
  assert.deepEqual(jpegEncode(faded, 40, 24, 90), jpegEncode(opaque, 40, 24, 90));
  const d = distance(decodeJpeg(jpegEncode(faded, 40, 24, 100)).data, opaque);
  assert.ok(d.luma <= 2.5 && d.mean <= 4, `luma ${d.luma}, mean ${d.mean}`);

  // Noise: more bytes than the output starts with, bytes of 0xff in the scan, and every luma
  // sample still its pixel's.
  let x = 7;
  const noise = new Uint32Array(300 * 200).map(() => {
    x = (Math.imul(x, 1103515245) + 12345) >>> 0;
    return (x | 0xff000000) >>> 0;
  });
  const file = jpegEncode(noise, 300, 200, 100);
  assert.ok(file.length > 300 * 200 * 2, `${file.length} bytes`);
  const luma = distance(decodeJpeg(file).data, noise).luma;
  assert.ok(luma <= 2.5, `luma off by ${luma}`);
});

test("a JPEG of the wrong size or a quality past 100 is refused, and the module lives on", () => {
  const pixels = new Uint32Array(12).fill(0xff808080);
  assert.throws(() => jpegEncode(new Uint32Array(10), 4, 3, 80), RangeError);
  assert.throws(() => jpegEncode(pixels, 4, 3, 101), RangeError);
  assert.throws(() => jpegEncode(pixels, 4, 3, -1), RangeError);
  assert.throws(() => jpegEncode(pixels, 4, 3, Number.NaN), RangeError);
  assert.throws(() => jpegEncode(new Uint32Array(0), 0, 3, 80), RangeError);
  assert.throws(() => jpegEncode(new Uint32Array(65536), 65536, 1, 80), RangeError);
  // The longest side a JPEG holds.
  const wide = decodeJpeg(jpegEncode(new Uint32Array(65535).fill(0xff102030), 65535, 1, 80));
  assert.deepEqual([wide.width, wide.height], [65535, 1]);
  assert.equal(decodeJpeg(jpegEncode(pixels, 4, 3, 80)).data[0], 0x80);
});

test("inflate stops at its limit, leaves room before its output and reports what it read", () => {
  const data = sample(300_000);
  const z = deflate(data, 6, false);
  const part = inflate(z, false, 1000, { offset: 8 });
  assert.equal(part.status, FULL);
  assert.equal(part.bytes.length, 1008);
  assert.deepEqual(part.bytes.subarray(8), data.subarray(0, 1000));

  const cut = inflate(z.subarray(0, z.length >> 1), false, 2 ** 32 - 1, { partial: true });
  assert.equal(cut.status, TRUNCATED);
  assert.deepEqual(cut.bytes, data.subarray(0, cut.bytes.length));

  const bad = z.slice();
  bad[bad.length - 1] ^= 1;
  const checked = inflate(bad, false, 2 ** 32 - 1);
  assert.equal(checked.status, CORRUPT);
  assert.equal(checked.message, "incorrect data check");
});

test("LZMA round trips, and its decoder stops at a size or where its input does", () => {
  const data = sample(50_000);
  const l = lzmaEncode(data);
  // lc 3, lp 0, pb 2, and a dictionary as large as the data needs.
  assert.equal(l[0], 0x5d);
  assert.equal(new DataView(l.buffer).getUint32(1, true), 1 << 16);
  assert.equal(new DataView(l.buffer).getUint32(5, true), data.length);

  const whole = lzmaDecode(l, 0, 13, data.length, { offset: 3 });
  assert.equal(whole.status, DONE);
  assert.deepEqual(whole.bytes.subarray(3), data);

  const prefix = lzmaDecode(l, 0, 13, 100);
  assert.equal(prefix.status, DONE);
  assert.deepEqual(prefix.bytes, data.subarray(0, 100));

  const cut = lzmaDecode(l.subarray(0, 1000), 0, 13, data.length);
  assert.equal(cut.status, TRUNCATED);

  const props = l.slice();
  props[0] = 225;
  assert.equal(lzmaDecode(props, 0, 13, data.length).status, CORRUPT);
});

test("an instance that grew past what is kept is let go, and the next call starts afresh", () => {
  // The LZMA encoder's match finder alone is more than MEMORY_KEPT.
  const data = sample(1 << 20, 7);
  const l = lzmaEncode(data);
  assert.equal(memoryInUse(), 0);

  const small = deflate(sample(1000), 9, false);
  assert.ok(memoryInUse() > 0 && memoryInUse() <= MEMORY_KEPT);
  assert.deepEqual(inflate(small, false, 1000).bytes, sample(1000));
  assert.deepEqual(lzmaDecode(l, 0, 13, data.length).bytes, data);
});

test("a header that names far more than the stream holds allocates only what decodes", () => {
  const z = deflate(sample(1000), 9, false);
  const l = lzmaEncode(sample(1000));
  // A new instance: the larger encoding grows past what is kept.
  lzmaEncode(sample(1 << 20));
  assert.equal(memoryInUse(), 0);

  assert.equal(inflate(z, false, 2 ** 32 - 1).status, DONE);
  assert.equal(lzmaDecode(l.subarray(0, 40), 0, 13, 2 ** 32 - 1).status, TRUNCATED);
  assert.ok(memoryInUse() < 1 << 20);
});

test("a bomb that fails is not copied out, and its instance is let go", () => {
  // 64 MB of zeros in some 64 KB, its checksum cut off: zlib inflates it all, then fails.
  const zeros = new Uint8Array(64 << 20);
  const cut = deflate(zeros, 1, false).slice(0, -4);

  const failed = inflate(cut, false, 2 ** 32 - 1);
  assert.equal(failed.status, TRUNCATED);
  assert.equal(failed.bytes.length, 0);
  assert.equal(memoryInUse(), 0);

  const asked = inflate(cut, false, 2 ** 32 - 1, { offset: 8, partial: true });
  assert.equal(asked.bytes.length, 8 + zeros.length);
});

test("an instance whose call threw is let go", () => {
  deflate(new Uint8Array(10), 9, false);
  assert.ok(memoryInUse() > 0);
  assert.throws(() => inflate(null as unknown as Uint8Array, false, 100), TypeError);
  assert.equal(memoryInUse(), 0);
});
