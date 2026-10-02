// BitmapData.applyFilter on the CPU: what a destination shows is computed
// as far as the filter reaches into it, no further, and comes out as the
// whole rect's would.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BitmapStore } from "../../../packages/player/dist/bitmap.js";
import { applyFilter } from "../../../packages/player/dist/bitmap-filters.js";
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
