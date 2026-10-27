import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

test("gradient filters detach their owned textures before destroying them", async (t) => {
  const { filterDefaults } = await import("../../../../packages/player/dist/display/filters.js");
  const { displayFilters } = await import("../../../../packages/player/dist/render/filters.js");
  const cjs = createRequire(new URL("../../../../packages/player/package.json", import.meta.url));
  const entry = pathToFileURL(cjs.resolve("pixi.js").replace(/\.js$/, ".mjs")).href;
  const pixi = await import(entry);
  const adapter = pixi.DOMAdapter.get();
  pixi.DOMAdapter.set({ ...adapter, createCanvas: () => ({ getContext: () => null }) });
  t.after(() => pixi.DOMAdapter.set(adapter));
  const warnings: unknown[][] = [];
  t.mock.method(console, "warn", (...args: unknown[]) => warnings.push(args));

  for (const kind of ["gradientGlow", "gradientBevel"] as const) {
    const [filter] = displayFilters([filterDefaults(kind)]);
    const gradient = filter.resources.uGradient;
    const idle = filter.resources.uBlurred;
    assert.equal(gradient.destroyed, false);
    assert.equal(gradient.listenerCount("change"), 1);
    filter.destroy();
    assert.equal(gradient.destroyed, true);
    assert.equal(gradient.listenerCount("change"), 0);
    assert.equal(idle.destroyed, true);
    assert.equal(idle.listenerCount("change"), 0);
    assert.equal(filter.groups, null);
  }

  assert.deepEqual(warnings, []);
});

test("blurs run coarser only where the screen has texels to spare and the error stays small", async () => {
  const { blurShrink } = await import("../../../../packages/player/dist/render/filters.js");
  // A texel a stage pixel, no blur that way, or no passes, as ever.
  assert.equal(blurShrink(68, 2, 1, 1), 1);
  assert.equal(blurShrink(0, 2, 1, 3), 1);
  assert.equal(blurShrink(1, 2, 1, 3), 1);
  assert.equal(blurShrink(68, 0, 1, 3), 1);
  assert.equal(blurShrink(Number.NaN, 2, 1, 3), 1);
  // Narrow boxes keep every texel; a single box's sharp ends need a wider one.
  assert.equal(blurShrink(2, 2, 1, 3), 1);
  assert.equal(blurShrink(5, 2, 2, 3), 1);
  assert.equal(blurShrink(20, 1, 1, 3), 1);
  assert.equal(blurShrink(4, 1, 3, 11.2), 1);
  // Wide ones go to a texel a stage pixel at most.
  assert.equal(blurShrink(27, 2, 2.37, 3), 3);
  assert.equal(blurShrink(70, 1, 2, 3), 3);
  assert.equal(blurShrink(7, 3, 1.9, 3), 2);
  assert.equal(blurShrink(68, 2, 1, 2.5), 2);
  assert.equal(blurShrink(255, 3, 1, 40), 16);
  // A strong glow multiplies the error, truncation's included: it stays finer however wide.
  assert.equal(blurShrink(27, 2, 255, 3), 1);
  assert.equal(blurShrink(45, 2, 255, 3), 1);
  assert.equal(blurShrink(70, 2, 255, 3), 1);
  assert.equal(blurShrink(68, 2, 4, 3), 1);
  assert.equal(blurShrink(64, 3, 50, 3), 1);
});

// A CPU model of a glow's or a blur's runs, at the screen's texels and shrunk (render/filters.ts,
// blurShrink): what the GPU's passes compute, each run truncated to a 255th as the BOX shader does,
// the shrunk runs drawn back between their texels as the READ_BACK pass's linear read does.

/** One run of the box `width` texels wide along rows (`along` 0) or columns, truncated. */
function boxRun(image: Float64Array, size: number, width: number, along: number): Float64Array {
  const out = new Float64Array(size * size);
  const half = width / 2;
  // The BOX shader's weights: 1 for the taps the box covers whole, `end` for the two past them.
  const whole = Math.floor(half - 0.5);
  const end = half - whole - 0.5;
  const reach = whole + 1;
  const prefix = new Float64Array(size + 1);
  const at = (line: number, k: number) =>
    along === 0 ? image[line * size + k] : image[k * size + line];
  for (let line = 0; line < size; line++) {
    for (let k = 0; k < size; k++) {
      prefix[k + 1] = prefix[k] + at(line, k);
    }

    for (let k = 0; k < size; k++) {
      const lo = Math.max(0, k - reach + 1);
      const hi = Math.min(size, k + reach);
      let sum = hi > lo ? prefix[hi] - prefix[lo] : 0;
      if (k - reach >= 0) {
        sum += end * at(line, k - reach);
      }

      if (k + reach < size) {
        sum += end * at(line, k + reach);
      }

      const c = sum / width;
      out[along === 0 ? line * size + k : k * size + line] = Math.floor(c * 255 + 0.001) / 255;
    }
  }

  return out;
}

/** The runs a blur takes, across then down `quality` times, as blur() orders them. */
function boxRuns(
  image: Float64Array,
  size: number,
  widthX: number,
  widthY: number,
  quality: number,
): Float64Array {
  let out = image;
  for (let q = 0; q < quality; q++) {
    if (widthX > 1) {
      out = boxRun(out, size, widthX, 0);
    }

    if (widthY > 1) {
      out = boxRun(out, size, widthY, 1);
    }
  }

  return out;
}

/** The same shrunk `kx` by `ky`: the mean of each block, stored in 8 bits, runs, then read back linearly. */
function shrunkRuns(
  image: Float64Array,
  size: number,
  widthX: number,
  widthY: number,
  quality: number,
  kx: number,
  ky: number,
): Float64Array {
  // A square grid as wide as the wider shrunk side: the extra rows or columns stay clear.
  const coarse = size / Math.min(kx, ky);
  const small = new Float64Array(coarse * coarse);
  for (let y = 0; y < size / ky; y++) {
    for (let x = 0; x < size / kx; x++) {
      let sum = 0;
      for (let j = 0; j < ky; j++) {
        for (let i = 0; i < kx; i++) {
          sum += image[(y * ky + j) * size + x * kx + i];
        }
      }

      small[y * coarse + x] = Math.round((sum / (kx * ky)) * 255) / 255;
    }
  }

  const ran = boxRuns(small, coarse, widthX / kx, widthY / ky, quality);
  const out = new Float64Array(size * size);
  const tap = (x: number, y: number) =>
    ran[Math.max(0, Math.min(coarse - 1, y)) * coarse + Math.max(0, Math.min(coarse - 1, x))];
  for (let y = 0; y < size; y++) {
    const v = (y + 0.5) / ky - 0.5;
    const y0 = Math.floor(v);
    const fy = v - y0;
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / kx - 0.5;
      const x0 = Math.floor(u);
      const fx = u - x0;
      const top = tap(x0, y0) * (1 - fx) + tap(x0 + 1, y0) * fx;
      const bottom = tap(x0, y0 + 1) * (1 - fx) + tap(x0 + 1, y0 + 1) * fx;
      out[y * size + x] = top * (1 - fy) + bottom * fy;
    }
  }

  return out;
}

test("shrunk blurs stay within twice the shrink's bound however their input sits in a block", async () => {
  const { blurShrink } = await import("../../../../packages/player/dist/render/filters.js");
  // SHRUNK_ERROR in render/filters.ts, a level each way: the two ways together.
  const bound = 2 * 2;
  // Blurs and glows as animations carry them, at the texels a stage pixel a page at a device
  // pixel ratio of 2 or 3 gives.
  const filters = [
    { blurX: 27, blurY: 27, quality: 2, strength: 2.37, texels: 3 },
    { blurX: 27, blurY: 27, quality: 2, strength: 2.37, texels: 2.79 },
    { blurX: 68, blurY: 5, quality: 2, strength: 2.27, texels: 3 },
    { blurX: 70, blurY: 0, quality: 1, strength: 2, texels: 3 },
    { blurX: 7, blurY: 7, quality: 3, strength: 1.9, texels: 3 },
    { blurX: 30, blurY: 30, quality: 3, strength: 1, texels: 2 },
    { blurX: 24, blurY: 24, quality: 3, strength: 3, texels: 3 },
    { blurX: 40, blurY: 40, quality: 1, strength: 1, texels: 3 },
    { blurX: 68, blurY: 5, quality: 2, strength: 2.27, texels: 2 },
  ];
  let checked = 0;
  for (const f of filters) {
    const kx = blurShrink(f.blurX, f.quality, f.strength, f.texels);
    const ky = blurShrink(f.blurY, f.quality, f.strength, f.texels);
    assert.ok(kx > 1 || ky > 1, `${JSON.stringify(f)} shrinks`);
    const widthX = f.blurX * f.texels;
    const widthY = f.blurY * f.texels;
    // Room for the blur's reach each side, in whole blocks of both shrinks.
    const reach = Math.ceil((f.quality * Math.max(widthX, widthY)) / 2) + 8;
    const block = kx * ky;
    const size = Math.ceil((2 * reach + 24) / block) * block;
    const c = reach;
    const patterns: Record<string, (x: number, y: number, sx: number, sy: number) => number> = {
      impulse: (x, y, sx, sy) => (x === c + sx && y === c + sy ? 1 : 0),
      "line down": (x, y, sx, sy) => (x === c + sx && y >= c + sy && y < c + sy + 16 ? 1 : 0),
      "line across": (x, y, sx, sy) => (y === c + sy && x >= c + sx && x < c + sx + 16 ? 1 : 0),
      edges: (x, y, sx, sy) => (x >= c + sx && y >= c + sy && x < c + 20 && y < c + 20 ? 1 : 0),
      checkerboard: (x, y, sx, sy) =>
        x >= c && y >= c && x < c + 20 && y < c + 20 ? (x + sx + y + sy) % 2 : 0,
      "coarse checkerboard": (x, y, sx, sy) =>
        x >= c && y >= c && x < c + 20 && y < c + 20
          ? (Math.floor((x + sx) / 3) + Math.floor((y + sy) / 3)) % 2
          : 0,
    };
    for (const [name, pattern] of Object.entries(patterns)) {
      for (let sy = 0; sy < ky; sy++) {
        for (let sx = 0; sx < kx; sx++) {
          const image = new Float64Array(size * size);
          for (let y = 0; y < size; y++) {
            for (let x = 0; x < size; x++) {
              image[y * size + x] = pattern(x, y, sx, sy);
            }
          }

          const full = boxRuns(image, size, widthX, widthY, f.quality);
          const shrunk = shrunkRuns(image, size, widthX, widthY, f.quality, kx, ky);
          let worst = 0;
          for (let i = 0; i < full.length; i++) {
            const a = Math.round(Math.min(1, full[i] * f.strength) * 255);
            const b = Math.round(Math.min(1, shrunk[i] * f.strength) * 255);
            worst = Math.max(worst, Math.abs(a - b));
          }

          assert.ok(
            worst <= bound,
            `${name} at ${sx},${sy} under ${JSON.stringify(f)} (${kx}x${ky}): off by ${worst}`,
          );
          checked++;
        }
      }
    }
  }

  assert.ok(checked > 100);
});
