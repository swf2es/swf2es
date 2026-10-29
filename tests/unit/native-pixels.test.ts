// BitmapData's pixel operations in the render module (pixels.zig), held to
// the JS the player had (player/bitmap/pixels-reference.ts) on random
// bitmaps, rects and arguments: copies onto other bitmaps and onto their
// own, moved any way, so that a pixel reads what the pixels before it wrote;
// bitmaps large enough to be done in several bands; transparent and opaque.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BitmapKernel } from "@swf2es/native/render";
import { BitmapStore } from "../../packages/player/dist/bitmap/bitmap.js";
import { applyFilter } from "../../packages/player/dist/bitmap/filters.js";
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
