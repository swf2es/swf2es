import assert from "node:assert/strict";
import { test } from "node:test";
import type { SoundMix } from "../../../../packages/player/dist/media/audio.js";
import { outputMix } from "../../../../packages/player/dist/media/sounds.js";

const mix = (
  volume: number,
  leftToLeft: number,
  leftToRight: number,
  rightToLeft: number,
  rightToRight: number,
): SoundMix => ({ volume, leftToLeft, leftToRight, rightToLeft, rightToRight });

test("a channel's output is its own transform followed by the mixer's, as Ruffle's concat", () => {
  const identity = mix(1, 1, 0, 0, 1);
  const global = mix(0.5, 0.75, 0.25, 0.5, 0.5);
  assert.deepEqual(outputMix(identity, global), global);
  assert.deepEqual(outputMix(global, identity), global);

  // Ruffle's integer formula over percents, here in fractions.
  assert.deepEqual(outputMix(mix(-0.5, 1, 0.5, 0, 1), global), mix(0.25, 0.75, 0.625, 0.5, 0.75));
});
