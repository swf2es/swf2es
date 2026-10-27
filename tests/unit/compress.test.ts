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
