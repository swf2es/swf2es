// BitmapData's pixel operations in the render module (pixels.zig), held to
// the JS the player had (player/bitmap/pixels-reference.ts) on random
// bitmaps, rects and arguments: copies onto other bitmaps and onto their
// own, moved any way, so that a pixel reads what the pixels before it wrote;
// bitmaps large enough to be done in several bands; transparent and opaque.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BitmapKernel,
  WORDS_PLAIN,
  WORDS_PREMULTIPLY,
  WORDS_SOLID,
  WORDS_UNMULTIPLY,
} from "@swf2es/native/render";
import { BitmapStore, premultiply, unmultiply } from "../../packages/player/dist/bitmap/bitmap.js";
import { applyFilter } from "../../packages/player/dist/bitmap/filters.js";
import { bitmapKernel } from "../../packages/player/dist/bitmap/kernel.js";
import {
  colorTransform,
  copyChannel,
  merge,
  noise,
  paletteMap,
  perlinNoise,
} from "../../packages/player/dist/bitmap/ops.js";
import { filterDefaults } from "../../packages/player/dist/display/filters.js";
import {
  colorMatrixReference,
  colorTransformReference,
  copyChannelReference,
  mergeReference,
  noiseReference,
  paletteMapReference,
  perlinNoiseReference,
} from "./player/bitmap/pixels-reference.ts";

function random(seed: number): () => number {
  let s = seed;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/** A store of random premultiplied pixels, a third of them translucent. */
function store(r: () => number, w: number, h: number, transparent: boolean): BitmapStore {
  const s = new BitmapStore(w, h, transparent, 0);
  for (let i = 0; i < s.pixels.length; i++) {
    const a = !transparent || r() < 0.6 ? 255 : Math.floor(r() * 256);
    const c = Math.floor(r() * 0x1000000);
    s.pixels[i] = s.premultiplied(((a << 24) | c) >>> 0);
  }

  return s;
}

/** Two pairs of stores alike, the destination either the source or another, for the op and its reference. */
function pairs(r: () => number, w: number, h: number, same: boolean) {
  const transparent = r() < 0.7;
  const source = store(r, w, h, transparent);
  const dest = same ? source : store(r, w + 3, h + 2, r() < 0.7);
  const clone = (s: BitmapStore) => {
    const c = new BitmapStore(s.width, s.height, s.transparent, 0);
    c.pixels.set(s.pixels);
    return c;
  };
  const source2 = clone(source);
  const dest2 = same ? source2 : clone(dest);
  return { source, dest, source2, dest2 };
}

function rect(r: () => number, w: number, h: number) {
  return {
    x: Math.floor(r() * (w + 4)) - 2,
    y: Math.floor(r() * (h + 4)) - 2,
    width: Math.floor(r() * (w + 2)),
    height: Math.floor(r() * (h + 2)),
  };
}

test("copyChannel, merge and paletteMap copy as the reference does, onto their own bitmap too", () => {
  const r = random(41);
  const tables = [0, 1, 2, 3].map(() =>
    Uint32Array.from({ length: 256 }, () => Math.floor(r() * 2 ** 32)),
  ) as [Uint32Array, Uint32Array, Uint32Array, Uint32Array];
  for (let k = 0; k < 1500; k++) {
    const w = 1 + Math.floor(r() * 24);
    const h = 1 + Math.floor(r() * 20);
    const same = r() < 0.4;
    const { source, dest, source2, dest2 } = pairs(r, w, h, same);
    const area = rect(r, w, h);
    const dx = Math.floor(r() * 9) - 4;
    const dy = Math.floor(r() * 9) - 4;
    const kind = k % 3;
    if (kind === 0) {
      const channels = [1, 2, 4, 8, 3, 0];
      const from = channels[Math.floor(r() * channels.length)];
      const to = channels[Math.floor(r() * 4)];
      copyChannel(dest, source, area, dx, dy, from, to);
      copyChannelReference(dest2, source2, area, dx, dy, from, to);
    } else if (kind === 1) {
      const pick = () => [0, 128, 256, 257, -257 >>> 0, 2 ** 32 - 1][Math.floor(r() * 6)];
      const muls: [number, number, number, number] = [pick(), pick(), pick(), pick()];
      merge(dest, source, area, dx, dy, muls);
      mergeReference(dest2, source2, area, dx, dy, muls);
    } else {
      paletteMap(dest, source, area, dx, dy, tables);
      paletteMapReference(dest2, source2, area, dx, dy, tables);
    }

    assert.deepEqual(dest.pixels, dest2.pixels, `case ${k} (kind ${kind}, same ${same})`);
  }
});

test("a copy of a large bitmap onto itself, moved, matches the reference across its bands", () => {
  const r = random(7);
  for (const [dx, dy] of [
    [3, 2],
    [-5, 1],
    [0, -4],
    [200, 0],
  ]) {
    const { source, source2 } = pairs(r, 900, 700, true);
    const area = { x: 0, y: 0, width: 900, height: 700 };
    merge(source, source, area, dx, dy, [100, 200, 30, 256]);
    mergeReference(source2, source2, area, dx, dy, [100, 200, 30, 256]);
    assert.deepEqual(source.pixels, source2.pixels, `moved ${dx}, ${dy}`);
  }
});

test("colorTransform transforms as the reference does, whatever the multipliers", () => {
  const r = random(5);
  const values = [0, 0.5, 1, 1.7, -0.3, 255, 1e12, Number.NaN, Number.POSITIVE_INFINITY];
  const offsets = [0, 10, -20, 300, -300, 0.7, Number.NaN];
  for (let k = 0; k < 600; k++) {
    const w = 1 + Math.floor(r() * 30);
    const h = 1 + Math.floor(r() * 30);
    const { dest, dest2 } = pairs(r, w, h, false);
    const pick = (list: number[]) => list[Math.floor(r() * list.length)];
    const ct = {
      rMul: pick(values),
      gMul: pick(values),
      bMul: pick(values),
      aMul: pick(values),
      rAdd: pick(offsets),
      gAdd: pick(offsets),
      bAdd: pick(offsets),
      aAdd: pick(offsets),
    };
    const area = rect(r, w + 3, h + 2);
    colorTransform(dest, area, ct);
    colorTransformReference(dest2, area, ct);
    assert.deepEqual(dest.pixels, dest2.pixels, `case ${k}: ${JSON.stringify(ct)}`);
  }
});

test("a colour matrix filter maps as the reference does, onto its own bitmap too", () => {
  const r = random(9);
  for (let k = 0; k < 800; k++) {
    const w = 1 + Math.floor(r() * 30);
    const h = 1 + Math.floor(r() * 24);
    const same = r() < 0.4;
    const { source, dest, source2, dest2 } = pairs(r, w, h, same);
    // Mostly clear pixels round some content, as near and empty matter there.
    if (r() < 0.5) {
      for (let i = 0; i < source.pixels.length; i++) {
        if (r() < 0.7) {
          source.pixels[i] = 0;
          source2.pixels[i] = 0;
        }
      }
    }

    const special = [Number.NaN, Number.POSITIVE_INFINITY, 1e308, -1e308, 0.5, -2.5];
    const matrix = Array.from({ length: 20 }, (_, i) =>
      r() < 0.05
        ? special[Math.floor(r() * special.length)]
        : (r() * 4 - 2) * (i % 5 === 4 ? 80 : 1),
    );
    const area = rect(r, w, h);
    const dx = Math.floor(r() * 9) - 4;
    const dy = Math.floor(r() * 9) - 4;
    applyFilter(dest, source, area, dx, dy, { ...filterDefaults("colorMatrix"), matrix });
    colorMatrixReference(dest2, source2, area, dx, dy, matrix);
    assert.deepEqual(dest.pixels, dest2.pixels, `case ${k} (same ${same})`);
  }
});

test("noise draws the reference's sequence, across bands too", () => {
  const r = random(13);
  for (const [w, h] of [
    [1, 1],
    [17, 9],
    [600, 500],
  ]) {
    for (let k = 0; k < 12; k++) {
      const transparent = r() < 0.5;
      const a = new BitmapStore(w, h, transparent, 0);
      const b = new BitmapStore(w, h, transparent, 0);
      const seed = [0, 1, -1, -2147483648, 2147483647, 77, Math.floor(r() * 2 ** 31)][k % 7];
      const low = Math.floor(r() * 300) - 20;
      const high = Math.floor(r() * 300) - 20;
      const channels = Math.floor(r() * 16);
      const gray = r() < 0.3;
      noise(a, seed, low, high, channels, gray);
      noiseReference(b, seed, low, high, channels, gray);
      assert.deepEqual(a.pixels, b.pixels, `${w}x${h} case ${k}`);
    }
  }
});

test("perlinNoise draws the reference's noise, stitched or not, across bands too", () => {
  const r = random(17);
  for (const [w, h] of [
    [1, 1],
    [33, 21],
    [512, 520],
  ]) {
    for (let k = 0; k < 8; k++) {
      const transparent = r() < 0.5;
      const a = new BitmapStore(w, h, transparent, 0);
      const b = new BitmapStore(w, h, transparent, 0);
      const base: [number, number] = [
        [0, 1, 7.5, 64, -30, 1e-9][Math.floor(r() * 6)],
        [0, 1, 7.5, 64, -30][Math.floor(r() * 5)],
      ];
      const octaves = Math.floor(r() * 5) + (k === 7 ? 40 : 0);
      const offsets: [number, number][] = Array.from({ length: octaves }, () => [
        r() * 100 - 50,
        r() * 100 - 50,
      ]);
      const seed = Math.floor(r() * 2 ** 31) - 2 ** 30;
      const stitch = r() < 0.5;
      const fractal = r() < 0.5;
      const channels = Math.floor(r() * 16);
      const gray = r() < 0.3;
      perlinNoise(a, base, offsets, seed, stitch, fractal, channels, gray);
      perlinNoiseReference(b, base, offsets, seed, stitch, fractal, channels, gray);
      assert.deepEqual(a.pixels, b.pixels, `${w}x${h} case ${k}`);
    }
  }
});

test("a band that traps is made again in a new instance, the bands before it not twice", () => {
  const wasm = globalThis.WebAssembly as unknown as {
    Instance: new (module: WebAssembly.Module, imports?: object) => WebAssembly.Instance;
    RuntimeError: new (message: string) => Error;
  };
  const Instance = wasm.Instance;
  let calls = 0;
  let instances = 0;
  wasm.Instance = new Proxy(Instance, {
    construct(target, args) {
      const instance = Reflect.construct(target, args) as WebAssembly.Instance;
      instances++;
      return {
        exports: {
          ...instance.exports,
          mergePixels: (params: number) => {
            // The second band's first try traps.
            if (++calls === 2) {
              throw new wasm.RuntimeError("test trap");
            }

            return (instance.exports.mergePixels as (params: number) => number)(params);
          },
        },
      };
    },
  });
  try {
    const r = random(23);
    const { dest, source, dest2, source2 } = pairs(r, 900, 700, false);
    const muls: [number, number, number, number] = [90, 180, 40, 256];
    const kernel = new BitmapKernel();
    const region = { x: 0, y: 0, width: 900, height: 700 };
    const ok = kernel.copy(
      dest.pixels,
      dest.width,
      source.pixels,
      source.width,
      region,
      0,
      0,
      dest.transparent,
      {
        op: "merge",
        muls,
      },
    );
    assert.ok(ok);
    mergeReference(dest2, source2, region, 0, 0, muls);
    assert.deepEqual(dest.pixels, dest2.pixels);
    assert.equal(instances, 2);
  } finally {
    wasm.Instance = Instance;
  }
});

/** `w` with its bytes in the other order. */
const reversed = (w: number) => new DataView(new Uint32Array([w]).buffer).getUint32(0, false);

test("words are made pixels and values four at a time as one at a time, in either byte order, across bands", () => {
  const r = random(41);
  const kernel = new BitmapKernel();
  // Under a band, a band and three words over, and counts that leave one, two and three after the fours.
  for (const count of [1, 2, 3, 5, 67, 1 << 18, (1 << 18) + 3, 600001]) {
    const from = new Uint32Array(count);
    for (let i = 0; i < count; i++) {
      const x = Math.floor(r() * 2 ** 32);
      from[i] = i % 7 === 0 ? x | 0xff000000 : i % 7 === 1 ? x & 0xffffff : x;
    }

    for (const swap of [false, true]) {
      const value = (w: number) => (swap ? reversed(w) : w);
      const kinds: [number, (w: number) => number][] = [
        [WORDS_SOLID, (w) => (value(w) | 0xff000000) >>> 0],
        [WORDS_PREMULTIPLY, (w) => premultiply(value(w))],
        [WORDS_UNMULTIPLY, (w) => value(unmultiply(w))],
        [WORDS_PLAIN, (w) => value(w)],
      ];
      for (const [kind, one] of kinds) {
        const into = new Uint32Array(count);
        const done = kernel.words(
          new Uint8Array(into.buffer),
          new Uint8Array(from.buffer),
          kind,
          swap,
        );
        assert.equal(done, count * 4);
        assert.deepEqual(into, from.map(one), `${count} words, kind ${kind}, swap ${swap}`);
      }
    }
  }

  // In place, and from bytes that begin at no multiple of four.
  const bytes = new Uint8Array(4 * 300 + 3);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Math.floor(r() * 256);
  }

  const odd = bytes.subarray(3);
  const expected = new Uint32Array(odd.slice().buffer).map((w) => premultiply(reversed(w)));
  assert.equal(kernel.words(odd, odd, WORDS_PREMULTIPLY, true), 1200);
  assert.deepEqual(new Uint32Array(odd.slice().buffer), expected);

  // Bytes that are no whole words, or of another length than their place, are refused.
  assert.equal(kernel.words(new Uint8Array(6), new Uint8Array(6), WORDS_SOLID, false), 0);
  assert.equal(kernel.words(new Uint8Array(8), new Uint8Array(4), WORDS_SOLID, false), 0);
  kernel.dispose();
});

test("words the module refuses or traps on are made by the store's own loops, from where it stopped", () => {
  const wasm = globalThis.WebAssembly as unknown as {
    Instance: new (module: WebAssembly.Module, imports?: object) => WebAssembly.Instance;
    RuntimeError: new (message: string) => Error;
  };
  const Instance = wasm.Instance;
  let calls = 0;
  let fail: (call: number) => "reject" | "trap" | null = () => null;
  wasm.Instance = new Proxy(Instance, {
    construct(target, args) {
      const instance = Reflect.construct(target, args) as WebAssembly.Instance;
      return {
        exports: {
          ...instance.exports,
          wordsPixels: (params: number) => {
            switch (fail(++calls)) {
              case "trap":
                throw new wasm.RuntimeError("test trap");
              case "reject":
                return 0;
              default:
                return (instance.exports.wordsPixels as (params: number) => number)(params);
            }
          },
        },
      };
    },
  });
  try {
    const r = random(57);
    // 1200 by 500 are three bands whole, and 41 of its rows of 1100 as many runs for the module.
    const w = 1200;
    const h = 500;
    const rects = [
      { x: 0, y: 0, width: w, height: h },
      { x: 11, y: 200, width: 1100, height: 41 },
    ];
    const fails: [string, (call: number) => "reject" | "trap" | null][] = [
      ["none", () => null],
      ["the second band on", (call) => (call >= 2 ? "reject" : null)],
      ["every band", () => "reject"],
      ["the second band once", (call) => (call === 2 ? "trap" : null)],
      ["the second band on, by a trap", (call) => (call >= 2 ? "trap" : null)],
      ["every third", (call) => (call % 3 === 0 ? "reject" : null)],
    ];
    for (const [name, failing] of fails) {
      for (const transparent of [true, false]) {
        for (const rect of rects) {
          for (const little of [true, false]) {
            const label = `${name}, ${transparent}, ${rect.width} wide, ${little}`;
            const count = rect.width * rect.height;
            const view = new DataView(new ArrayBuffer(count * 4 + 4));
            const expected = store(r, w, h, transparent);
            const set = new BitmapStore(w, h, transparent, 0);
            set.pixels.set(expected.pixels);
            const values: number[] = [];
            for (let i = 0; i < count; i++) {
              const v = Math.floor(r() * 2 ** 32);
              values.push(v);
              view.setUint32(i * 4, v, little);
              expected.setPixel32(
                rect.x + (i % rect.width),
                rect.y + Math.floor(i / rect.width),
                v,
              );
            }

            // An instance of its own for each, made under the proxy.
            bitmapKernel()?.dispose();
            calls = 0;
            fail = failing;
            // Two pixels short: the last row's run ends within it.
            set.setWords(rect, new Uint8Array(view.buffer), 0, count - 2, little);
            const last = { x: rect.x + rect.width - 2, y: rect.y + rect.height - 1 };
            for (let i = 0; i < 2; i++) {
              set.setPixel32(last.x + i, last.y, values[count - 2 + i]);
            }

            assert.deepEqual(set.pixels, expected.pixels, `setWords: ${label}`);
            assert.ok(calls > 0, label);

            bitmapKernel()?.dispose();
            calls = 0;
            const read = Array.from({ length: count }, (_, i) =>
              expected.getPixel32(rect.x + (i % rect.width), rect.y + Math.floor(i / rect.width)),
            );
            const out = new Uint8Array(count * 4 + 5);
            expected.getWords(rect, out, 5, little);
            const got = new DataView(out.buffer, 5);
            assert.deepEqual(
              read.map((_, i) => got.getUint32(i * 4, little)),
              read,
              `getWords: ${label}`,
            );
            // An opaque store's pixels in the module's order are copied here.
            assert.equal(calls > 0, transparent || !little, label);

            bitmapKernel()?.dispose();
            calls = 0;
            assert.deepEqual(expected.getVector(rect), read, `getVector: ${label}`);
            assert.equal(calls > 0, transparent, label);
          }
        }
      }
    }
  } finally {
    wasm.Instance = Instance;
    bitmapKernel()?.dispose();
  }
});
