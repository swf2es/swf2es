// BitmapData.applyFilter on the CPU: what a destination shows is computed
// as far as the filter reaches into it, no further, and comes out as the
// whole rect's would; a convolution's two ways, as adl takes them.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BitmapStore } from "../../../packages/player/dist/bitmap.js";
import { applyFilter, integerKernel } from "../../../packages/player/dist/bitmap-filters.js";
import { filterDefaults } from "../../../packages/player/dist/filters.js";

/** A 40 by 40 source: a half-alpha red square and an opaque green one. */
function source(): BitmapStore {
  const s = new BitmapStore(40, 40, true, 0);
  s.fillRect({ x: 12, y: 10, width: 14, height: 16 }, 0x80ff0000);
  s.fillRect({ x: 20, y: 18, width: 6, height: 6 }, 0xff00ff00);
  return s;
}

test("a destination showing part of a filter's result shows what the whole result has there", () => {
  const filters = [
    { ...filterDefaults("blur"), blurX: 7, blurY: 3.5, quality: 2 },
    { ...filterDefaults("glow"), blurX: 5, blurY: 5, strength: 3 },
    { ...filterDefaults("glow"), blurX: 4, blurY: 4, inner: true },
    { ...filterDefaults("dropShadow"), distance: 4.5, angle: 30, blurX: 3, blurY: 3 },
    {
      ...filterDefaults("convolution"),
      matrixX: 3,
      matrixY: 3,
      matrix: [1, 2, 1, 2, 4, 2, 1, 2, 1],
      divisor: 16,
    },
    {
      ...filterDefaults("convolution"),
      matrixX: 5,
      matrixY: 2,
      matrix: [1, 0, -1, 0, 2, 0, 0, 3, 0, 0],
      bias: 9,
      preserveAlpha: false,
    },
  ];
  for (const f of filters) {
    const whole = new BitmapStore(60, 60, true, 0xff0000ff);
    applyFilter(whole, source(), { x: 0, y: 0, width: 40, height: 40 }, 10, 10, f);
    // A window of 9 by 7, at a corner of the squares, where the filter reaches past it.
    const part = new BitmapStore(9, 7, true, 0xff0000ff);
    applyFilter(part, source(), { x: 0, y: 0, width: 40, height: 40 }, 10 - 31, 10 - 25, f);
    for (let y = 0; y < 7; y++) {
      for (let x = 0; x < 9; x++) {
        assert.equal(
          part.pixels[y * 9 + x],
          whole.pixels[(y + 25) * 60 + (x + 31)],
          `${f.kind} at ${x}, ${y}`,
        );
      }
    }
  }
});

test("a rect far larger than the destination is filtered as far as the destination shows", () => {
  const dest = new BitmapStore(1, 1, true, 0);
  const tiny = new BitmapStore(1, 1, true, 0xffffffff);
  const started = performance.now();
  applyFilter(dest, tiny, { x: 0, y: 0, width: 1_000_000, height: 1_000_000 }, 0, 0, {
    ...filterDefaults("blur"),
    blurX: 4,
    blurY: 4,
  });
  // The pixel's own share of a 4 by 4 box, a quarter each way: 255 to 63, then to 15.
  assert.equal(dest.pixels[0] >>> 24, 15);
  assert.ok(performance.now() - started < 200);
});

/** A 5 by 5 opaque black source with one pixel of red `red`, convolved by a 3 by 3 kernel with a bias of 128. */
function spot(red: number, matrix: number[], divisor: number): number[] {
  const s = new BitmapStore(5, 5, false, 0);
  s.setPixel32(2, 2, (0xff000000 | (red << 16)) >>> 0);
  const d = new BitmapStore(5, 5, true, 0);
  applyFilter(d, s, { x: 0, y: 0, width: 5, height: 5 }, 0, 0, {
    ...filterDefaults("convolution"),
    matrixX: 3,
    matrixY: 3,
    matrix,
    divisor,
    bias: 128,
  });
  return [...d.pixels].map((p) => (p >>> 16) & 0xff);
}

test("a 3 by 3 kernel of whole weights takes adl's fixed-point way inside the bitmap", () => {
  // From 1.1 for weights all positive, past 2.0001 with a negative one, within 127 each way.
  assert.equal(integerKernel([1, 1, 1, 1, 1, 1, 1, 1, 1], 1.05), null);
  assert.equal(integerKernel([1, 1, 1, 1, 1, 1, 1, 1, 1], Math.fround(1.1)), -5957);
  assert.equal(integerKernel([1, 1, 1, 1, 1, 1, 1, 1, 1], 2), -32767);
  assert.equal(integerKernel([1, 1, 1, 1, 1, 1, 1, 1, 1], 9), 7282);
  assert.equal(integerKernel([1, 1, 1, 1, 1, 1, 1, 1, -1], 2), null);
  assert.equal(integerKernel([1, 1, 1, 1, 1, 1, 1, 1, -1], 3), 21846);
  assert.equal(integerKernel([0.5, 1, 1, 1, 1, 1, 1, 1, 1], 9), null);
  assert.equal(integerKernel([14, 14, 14, 14, 14, 14, 14, 14, 14], 100), 656);
  assert.equal(integerKernel([15, 15, 15, 15, 15, 15, 15, 15, 15], 100), null);

  // Its last tap reads the centre: the spot's mirror at (1, 1) has none of it, the centre twice.
  const box = spot(144, [1, 1, 1, 1, 1, 1, 1, 1, 1], 9);
  assert.equal(box[1 * 5 + 1], 128);
  assert.equal(box[2 * 5 + 2], 128 + 32);
  assert.equal(box[2 * 5 + 3], 128 + 16);
  // A divisor of 2 wraps the reciprocal to -1/2: the weights' sign turns.
  assert.equal(spot(64, [1, 1, 1, 1, 1, 1, 1, 1, 1], 2)[2 * 5 + 3], 128 - 32);
  // Past the bitmap's edge pixels the general way divides as it should.
  assert.equal(spot(64, [1, 1, 1, 1, 1, 1, 1, 1, 1], 2)[0], 128);
});

test("a convolution reads the source past its rect, and clamps or colours past the bitmap", () => {
  const s = new BitmapStore(4, 1, false, 0);
  for (let x = 0; x < 4; x++) {
    s.setPixel32(x, 0, (0xff000000 | ((x * 40) << 16)) >>> 0);
  }

  const shift = { ...filterDefaults("convolution"), matrixX: 3, matrixY: 1, matrix: [1, 0, 0] };
  const d = new BitmapStore(4, 1, true, 0);
  applyFilter(d, s, { x: 1, y: 0, width: 2, height: 1 }, 1, 0, shift);
  // Grown a pixel each way: x 0 to 3 of the source, each the pixel left of it, the first clamped.
  assert.deepEqual(
    [...d.pixels].map((p) => (p >>> 16) & 0xff),
    [0, 0, 40, 80],
  );

  applyFilter(d, s, { x: 1, y: 0, width: 2, height: 1 }, 1, 0, {
    ...shift,
    clamp: false,
    color: 0x00ff00,
    alpha: 1,
  });
  assert.equal(d.pixels[0], 0xff00ff00);
});
