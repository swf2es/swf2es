import assert from "node:assert/strict";
import { test } from "node:test";
import {
  denseSamples,
  displayInterval,
  fittingSamples,
  stageSamples,
  tooLate,
} from "../../../packages/web/dist/playback.js";

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

test("the display's interval is the mean time between animation frames, those out of step left out", () => {
  // Chrome at 60 Hz, the first frame after a still period early.
  assert.ok(Math.abs(displayInterval([11.1, 16.7, 16.6, 16.7, 16.7, 16.6, 16.7]) - 16.67) < 0.05);
  // Firefox: two frames at once, then 16 and 17 ms by turns, 60 a second, not the median's 58.
  const firefox = displayInterval([0.26, 16.12, 17.12, 16.26, 17.14, 16.1, 17.2, 16.08, 17.12]);
  assert.ok(Math.abs(firefox - 16.64) < 0.05, `${firefox}`);
  // A frame the page missed is no display's interval either.
  assert.ok(Math.abs(displayInterval([8.3, 8.4, 16.7, 8.3, 8.3]) - 8.33) < 0.05);
  assert.ok(Math.abs(displayInterval([16, 17, 33, 17, 16, 34, 17, 16, 17]) - 16.6) < 0.1);
  assert.equal(displayInterval([16, 16, 16]), 16);
});

test("timers are too late to tick a still stage by only where most of their ticks are", () => {
  const interval = 16.2;
  // A busy thread: four ticks in a row late, the rest on time, as a loaded machine has them.
  assert.equal(tooLate([0, 0, 9, 12, 30, 9, 0, 1, 0], interval), false);
  // Coarse timers, most ticks half an interval late or more: the player would batch its frames.
  assert.equal(tooLate([9, 12, 0, 8.5, 10, 0, 9, 1, 11], interval), true);
  assert.equal(tooLate([16, 17, 16, 17, 16, 17, 16, 17, 16], interval), true);
});
