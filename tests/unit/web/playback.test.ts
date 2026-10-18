import assert from "node:assert/strict";
import { test } from "node:test";
import { fittingSamples } from "../../../packages/web/dist/playback.js";

test("a canvas takes the most samples whose buffers fit, and 4 at least", () => {
  // A 960x550 stage shown 1.6 times larger, 1080p, 1440p and 4K.
  assert.equal(fittingSamples(1536 * 880), 16);
  assert.equal(fittingSamples(1920 * 1080), 16);
  assert.equal(fittingSamples(2560 * 1440), 8);
  assert.equal(fittingSamples(3840 * 2160), 4);
  // Larger still: as many as before samples could be chosen.
  assert.equal(fittingSamples(7680 * 4320), 4);
});
