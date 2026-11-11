import assert from "node:assert/strict";
import { test } from "node:test";
import { binary } from "../../packages/native/dist/compress/binary.js";
import {
  CORRUPT,
  DONE,
  deflate,
  FULL,
  inflate,
  lzmaDecode,
  lzmaEncode,
  MEMORY_KEPT,
  memoryInUse,
  pngEncode,
  TRUNCATED,
} from "../../packages/native/dist/compress/index.js";

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
