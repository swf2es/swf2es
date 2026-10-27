import assert from "node:assert/strict";
import { test } from "node:test";
import { denseSamples, fittingSamples } from "../../../packages/web/dist/playback.js";

test("a canvas takes the most samples whose buffers fit, and 4 at least", () => {
  // A 960x550 stage shown 1.6 times larger, 1080p, 1440p and 4K.
  assert.equal(fittingSamples(1536 * 880), 16);
  assert.equal(fittingSamples(1920 * 1080), 16);
  assert.equal(fittingSamples(2560 * 1440), 8);
  assert.equal(fittingSamples(3840 * 2160), 4);
  // Larger still: as many as before samples could be chosen.
  assert.equal(fittingSamples(7680 * 4320), 4);
});

test("a canvas whose pixels are smaller than the stage's takes fewer samples each", () => {
  // At a pixel a stage pixel or less, as many as the quality asks.
  assert.equal(denseSamples(8, 1), 8);
  assert.equal(denseSamples(16, 0.5), 16);
  assert.equal(denseSamples(4, 3), 4);
  // Finer, as many as cover a stage pixel with as many as at one, 4 at least.
  assert.equal(denseSamples(16, 1.5), 8);
  assert.equal(denseSamples(8, 1.5), 4);
  assert.equal(denseSamples(16, 2), 4);
  assert.equal(denseSamples(8, 2.79), 4);
  assert.equal(denseSamples(16, 3), 4);
});
