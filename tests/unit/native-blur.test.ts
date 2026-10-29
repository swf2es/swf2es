// BitmapData.applyFilter's blur, glow, drop shadow, bevel and gradient glow
// and bevel, by the render module (blur.zig), held to the JS the player had
// (blur-reference.ts) bit for bit: random sources, rects, destinations and
// filters, their values as the player's filter objects hold them (alphas
// in 255ths, strength in 256ths, blurs to 255 or NaN, quality to 15),
// distances and angles anything.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BitmapStore } from "../../packages/player/dist/bitmap/bitmap.js";
import { applyFilter } from "../../packages/player/dist/bitmap/filters.js";
import { type FilterKind, filterDefaults } from "../../packages/player/dist/display/filters.js";
import { applyBlurFamily } from "./player/bitmap/blur-reference.ts";

const KINDS: FilterKind[] = [
  "blur",
  "glow",
  "dropShadow",
  "bevel",
  "gradientGlow",
  "gradientBevel",
];

function random(seed: number): () => number {
  let state = seed;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

// More steps, or another seed, as player/playerglobal/flash/display/BitmapData.test.ts takes them.
const STEPS = Number(process.env.SWF2ES_FUZZ_STEPS ?? 3000);
const SEED = Number(process.env.SWF2ES_FUZZ_SEED ?? 52021);

test("the kernels filter as the JS reference does, to the bit, whatever the filter", () => {
  const r = random(SEED);
  const pick = <T>(values: readonly T[]) => values[Math.floor(r() * values.length)];
  const blurs = [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.7, 4, 6, 7.25, 9, 16, NaN];
  const written = Object.fromEntries(KINDS.map((kind) => [kind, 0]));
  for (let k = 0; k < STEPS; k++) {
    const kind = KINDS[k % KINDS.length];
    const sw = 1 + Math.floor(r() * 24);
    const sh = 1 + Math.floor(r() * 20);
    const transparent = r() < 0.85;
    const pixels = Uint32Array.from({ length: sw * sh }, () => {
      const a = pick([0, 0, 255, 255, 128, Math.floor(r() * 256)]);
      const c = () => Math.floor((Math.floor(r() * 256) * a) / 255);
      return ((a << 24) | (c() << 16) | (c() << 8) | c()) >>> 0;
    });
    const colors = Array.from({ length: Math.floor(r() * 4) }, () => Math.floor(r() * 0x1000000));
    const f = {
      ...filterDefaults(kind),
      // A big blur of many passes now and then: the work grows with both.
      blurX: k % 61 === 0 ? 255 : pick(blurs),
      blurY: k % 67 === 0 ? 120 : pick(blurs),
      quality: k % 61 === 0 || k % 67 === 0 ? 1 : pick([0, 1, 1, 2, 3, 4, 15]),
      strength: pick([0, 1, 2, 0.5, 255, Math.floor(r() * 255 * 256) / 256]),
      alpha: Math.floor(r() * 256) / 255,
      highlightAlpha: Math.floor(r() * 256) / 255,
      shadowAlpha: Math.floor(r() * 256) / 255,
      color: Math.floor(r() * 0x1000000),
      highlightColor: Math.floor(r() * 0x1000000),
      shadowColor: Math.floor(r() * 0x1000000),
      distance: pick([0, 1, 2.5, 4, -3, 7.75, 1e5, 4e9, NaN, Infinity, -Infinity]),
      angle: pick([0, 30, 45, 90, 135, 180, 300.00000000000006, -60, Math.floor(r() * 360), NaN]),
      inner: r() < 0.4,
      knockout: r() < 0.3,
      hideObject: r() < 0.3,
      type: pick(["inner", "outer", "full"]),
      colors,
      alphas: colors.map(() => Math.floor(r() * 256) / 255),
      ratios: colors.map(() => Math.floor(r() * 256)).sort((a, b) => a - b),
    };
    const rect = {
      x: Math.floor(r() * (sw + 8)) - 4,
      y: Math.floor(r() * (sh + 8)) - 4,
      width: Math.floor(r() * (sw + 4)),
      height: Math.floor(r() * (sh + 4)),
    };
    const dx = Math.floor(r() * 12) - 5;
    const dy = Math.floor(r() * 12) - 5;
    const dw = 1 + Math.floor(r() * 24);
    const dh = 1 + Math.floor(r() * 20);
    const destTransparent = r() < 0.7;
    const alias = r() < 0.15;
    const ground = Uint32Array.from({ length: dw * dh }, () => (r() * 2 ** 32) >>> 0);
    const run = (by: typeof applyFilter) => {
      const source = new BitmapStore(sw, sh, transparent, 0);
      source.pixels.set(pixels);
      const dest = alias ? source : new BitmapStore(dw, dh, destTransparent, 0);
      if (!alias) {
        dest.pixels.set(ground);
      }

      const drawn = by(dest, source, rect, dx, dy, f);
      return { drawn, version: dest.version, pixels: Array.from(dest.pixels) };
    };
    const expected = run(applyBlurFamily);
    assert.deepEqual(
      run(applyFilter),
      expected,
      `case ${k}, seed ${SEED}: ${JSON.stringify({ f, rect })}`,
    );
    // Cases whose filter wrote something other than what the destination held.
    if (!alias && expected.pixels.some((p, i) => p !== ground[i])) {
      written[kind]++;
    }
  }

  // Each kind wrote in many of its cases (a shadow cast to NaN or infinity writes what it held),
  // so the comparisons are of pixels filtered.
  for (const kind of KINDS) {
    assert.ok(written[kind] > STEPS / 20, `${kind} wrote in ${written[kind]} cases`);
  }
});

test("rects far past the bitmap filter as the reference does there, beyond the kernels' bounds", () => {
  const source = new BitmapStore(6, 6, true, 0);
  source.fillRect({ x: 1, y: 1, width: 4, height: 4 }, 0xff336699);
  for (const kind of KINDS) {
    const f = { ...filterDefaults(kind), blurX: 3, blurY: 3, distance: 2, type: "outer" };
    for (const x of [-0x3fffffff - 7, 0x3fffffff + 7]) {
      const rect = { x, y: 0, width: 6, height: 6 };
      const native = new BitmapStore(6, 6, true, 0x12345678);
      const reference = new BitmapStore(6, 6, true, 0x12345678);
      applyFilter(native, source, rect, 0, 0, f);
      applyBlurFamily(reference, source, rect, 0, 0, f);
      assert.deepEqual(native.pixels, reference.pixels, `${kind} at ${x}`);
    }
  }
});
