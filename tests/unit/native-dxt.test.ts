import assert from "node:assert/strict";
import { test } from "node:test";
import { DxtEncoder } from "@swf2es/native/render";
import { encodeDxt } from "../../packages/context3d/dist/dxt.js";
import { renderInstance } from "../../packages/native/dist/render/module.js";

function random(seed: number): () => number {
  let state = seed;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state >>> 24;
  };
}

function compare(
  encoder: DxtEncoder,
  pixels: Uint8Array,
  dxt5: boolean,
  width: number,
  height: number,
  what: string,
): void {
  const before = encoder.encoded;
  const blocks = encoder.encode(pixels, dxt5, width, height);
  assert.ok(blocks, what);
  assert.equal(encoder.encoded, before + 1, `${what}: encoded in Wasm`);
  assert.deepEqual(blocks, encodeDxt(pixels, dxt5, width, height), what);
}

test("native DXT1 and DXT5 blocks match the TS encoder across random levels", () => {
  const encoder = new DxtEncoder();
  const next = random(73);
  for (let i = 0; i < 3000; i++) {
    const width = 1 + (next() % 67);
    const height = 1 + (next() % 67);
    // An offset view must encode its own pixels, not its buffer's prefix.
    const bytes = new Uint8Array(width * height * 4 + 13).fill(0xa5);
    const pixels = bytes.subarray(7, 7 + width * height * 4);
    const pattern = i % 5;
    const flat = [next(), next(), next(), next()];
    for (let p = 0; p < pixels.length; p++) {
      switch (pattern) {
        case 0:
          pixels[p] = next();
          break;
        case 1:
          pixels[p] = flat[p % 4];
          break;
        case 2:
          pixels[p] = (p & 4) === 0 ? 0 : 255;
          break;
        case 3:
          pixels[p] = (p * 7 + i) & 255;
          break;
        default:
          pixels[p] = next() & 0xf8;
          break;
      }
    }

    compare(encoder, pixels, (i & 1) === 0, width, height, `level ${i}: ${width}x${height}`);
  }

  assert.equal(encoder.encoded, 3000);
  encoder.release();
});

test("flat colours, alpha ties and partial blocks choose the same indices", () => {
  const encoder = new DxtEncoder();
  for (const [width, height] of [
    [1, 1],
    [2, 1],
    [1, 3],
    [3, 3],
    [5, 7],
    [4096, 1],
    [1, 4096],
  ]) {
    for (const alpha of [0, 1, 127, 128, 254, 255]) {
      for (const dxt5 of [false, true]) {
        const pixels = new Uint8Array(width * height * 4);
        for (let at = 0; at < pixels.length; at += 4) {
          pixels.set([0, 255, 0, alpha], at);
        }

        compare(encoder, pixels, dxt5, width, height, `${width}x${height}, alpha ${alpha}`);
      }
    }
  }

  encoder.release();
});

test("invalid sizes and short or excess input leave the native instance unmade", () => {
  const encoder = new DxtEncoder();
  for (const size of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 4097, 2 ** 32 + 1]) {
    assert.equal(encoder.encode(new Uint8Array(4), false, size, 1), null);
    assert.equal(encoder.encode(new Uint8Array(4), true, 1, size), null);
  }

  assert.equal(encoder.encode(new Uint8Array(63), false, 4, 4), null);
  assert.equal(encoder.encode(new Uint8Array(65), true, 4, 4), null);
  assert.equal(encoder.capacity, 0);
  assert.equal(encoder.encoded, 0);
});

test("results survive release, and a prior result can be the next level's source", () => {
  const encoder = new DxtEncoder();
  const bytes = new Uint8Array(8 * 8 * 4);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = (i * 29) & 255;
  }

  const first = encoder.encode(bytes, true, 8, 8);
  assert.ok(first);
  const expected = first.slice();
  compare(encoder, first, false, 4, 4, "the prior compressed bytes used as RGBA");
  encoder.release();
  assert.equal(encoder.capacity, 0);
  // The second encode used another part of the input, so this view still owns the first result.
  assert.deepEqual(first, expected);
  compare(encoder, bytes, true, 8, 8, "after release");
  encoder.release();
});

test("a trapped encoder instance is released, and the next level makes another", () => {
  const encoder = new DxtEncoder();
  const bytes = new Uint8Array(64).fill(127);
  compare(encoder, bytes, true, 4, 4, "before trap");
  const internals = encoder as unknown as {
    wasm: {
      memory: WebAssembly.Memory;
      resetArena(bytes: number): number;
      encodeDxt(...args: number[]): number;
    };
  };
  internals.wasm = {
    ...internals.wasm,
    encodeDxt() {
      throw new Error("a trap");
    },
  };
  const before = encoder.encoded;
  assert.equal(encoder.encode(bytes, true, 4, 4), null);
  assert.equal(encoder.encoded, before);
  assert.equal(encoder.capacity, 0);
  compare(encoder, bytes, true, 4, 4, "after trap");
  encoder.release();
});

test("a large level's workspace is replaced before encoding a small one", () => {
  const encoder = new DxtEncoder();
  const blocks = encoder.encode(new Uint8Array(4096 * 1152 * 4), true, 4096, 1152);
  assert.ok(blocks);
  assert.equal(encoder.encoded, 1);
  assert.ok(encoder.capacity > 32 << 20);
  compare(encoder, new Uint8Array(64), false, 4, 4, "after a large level");
  assert.ok(encoder.capacity <= 32 << 20);
  encoder.release();
});

test("a host refusing the module leaves the TS encoder available without retrying", () => {
  const wasm = globalThis.WebAssembly as unknown as {
    Instance: new (module: WebAssembly.Module, imports?: object) => WebAssembly.Instance;
  };
  const original = wasm.Instance;
  let attempts = 0;
  try {
    wasm.Instance = new Proxy(original, {
      construct() {
        attempts++;
        throw new Error("module refused");
      },
    });
    const encoder = new DxtEncoder();
    const bytes = new Uint8Array(64);
    assert.equal(encoder.encode(bytes, false, 4, 4), null);
    assert.equal(encoder.encode(bytes, false, 4, 4), null);
    assert.equal(attempts, 1);
    assert.equal(encoder.encoded, 0);
    assert.equal(encoder.capacity, 0);
    assert.equal(encodeDxt(bytes, false, 4, 4).length, 8);
  } finally {
    wasm.Instance = original;
  }
});

test("the whole-level export refuses stale, overlapping and out-of-range blocks", () => {
  const wasm = renderInstance(() => {
    throw new Error("unused tessellator");
  }) as unknown as {
    memory: WebAssembly.Memory;
    resetArena(bytes: number): number;
    encodeDxt(
      source: number,
      destination: number,
      width: number,
      height: number,
      alpha: number,
    ): number;
  };
  const at = wasm.resetArena(80);
  assert.ok(at);
  assert.equal(wasm.encodeDxt(at, at + 64, 4, 4, 0), 1);
  assert.equal(wasm.encodeDxt(at, at + 64, 4, 4, 1), 1);
  assert.equal(wasm.encodeDxt(at, at + 65, 4, 4, 1), 0);
  assert.equal(wasm.encodeDxt(at + 17, at, 4, 4, 0), 0);
  assert.equal(wasm.encodeDxt(at, at + 32, 4, 4, 0), 0);
  assert.equal(wasm.encodeDxt(at, at + 64, 4, 4, 2), 0);
  assert.equal(wasm.encodeDxt(at, at + 64, 0, 4, 0), 0);
  assert.equal(wasm.encodeDxt(at, at + 64, 4097, 4, 0), 0);
  wasm.resetArena(0);
  assert.equal(wasm.encodeDxt(at, at + 64, 4, 4, 0), 0);
});
