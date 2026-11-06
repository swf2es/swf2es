import assert from "node:assert/strict";
import { test } from "node:test";
import { denseSamples, fittingSamples, stageSamples } from "../../../packages/web/dist/playback.js";

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

test("a stage only zoomed keeps its quality's samples; a finer screen takes fewer", () => {
  // A 960x550 stage zoomed 2.48 times into a window on a screen of ratio 1: 8 at high.
  assert.equal(stageSamples("HIGH", 2377 * 1362, 2.48, 1), 8);
  assert.equal(stageSamples("BEST", 2377 * 1362, 2.48, 1), 8);
  assert.equal(stageSamples("MEDIUM", 2377 * 1362, 2.48, 1), 4);
  // The same canvas on a screen of ratio 2.48, or a phone's of 3: 4.
  assert.equal(stageSamples("HIGH", 2377 * 1362, 2.48, 2.48), 4);
  assert.equal(stageSamples("HIGH", 1170 * 2532, 3, 3), 4);
  // A phone shown the stage smaller than its pixels: as many as the stage's ask.
  assert.equal(stageSamples("HIGH", 1170 * 670, 1.2, 3), 8);
  // A zoom on a screen of ratio 1.25: as fine as its pixels.
  assert.equal(stageSamples("BEST", 1600 * 900, 1.6, 1.25), 16);
  assert.equal(stageSamples("BEST", 2400 * 1375, 2.5, 1.25), 8);
  // 4K still fits only 4.
  assert.equal(stageSamples("HIGH", 3840 * 2160, 4, 1), 4);
});
