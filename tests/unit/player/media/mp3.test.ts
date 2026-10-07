import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { mp3Frames } from "../../../../packages/player/dist/media/mp3.js";

const tone = new Uint8Array(
  readFileSync(new URL("../../../player/sounds/tone.mp3", import.meta.url)),
);

test("an MP3's frames are counted by their headers, a frame cut short too", () => {
  assert.deepEqual(mp3Frames(tone), {
    rate: 44100,
    channels: 2,
    samplesPerFrame: 1152,
    frames: 11,
    start: 0,
    end: tone.length,
    header: null,
  });
  const cut = mp3Frames(tone.subarray(0, 1000));
  assert.deepEqual([cut?.frames, cut?.end], [4, 940]);
  assert.equal(mp3Frames(new TextEncoder().encode("not an mp3")), null);
});
