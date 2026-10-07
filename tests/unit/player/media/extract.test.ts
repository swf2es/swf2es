// Sound.extract's counting, as adl counts (the player's sound-extract case
// has the rest).
import assert from "node:assert/strict";
import { test } from "node:test";
import { extractSamples } from "../../../../packages/player/dist/media/extract.js";

const ramp = (n: number) => Float32Array.from({ length: n }, (_, i) => i);

test("a sound under 44.1 kHz holds each sample, whole ones only, and counts its own at its end", () => {
  const source = { rate: 11025, channels: [ramp(50)], skip: 0, whole: true };
  const first = extractSamples(source, 0, 10);
  assert.deepEqual([first.count, first.position], [8, 2]);
  assert.deepEqual([...first.samples.subarray(0, 10)], [0, 0, 0, 0, 0, 0, 0, 0, 1, 1]);
  assert.equal(extractSamples(source, 2, 3).count, 0);

  // Past its end it gives what it has, and counts the samples it read.
  const last = extractSamples(source, 49, 100);
  assert.deepEqual([last.count, last.samples.length / 2, last.position], [1, 4, 50]);
  assert.equal(extractSamples(source, 50, 100).count, 0);
});

test("an MP3's samples come singly, after its skipped ones, in stereo from either channel count", () => {
  const source = {
    rate: 22050,
    channels: [ramp(10), ramp(10).map((v) => -v)],
    skip: 2,
    whole: false,
  };
  const some = extractSamples(source, 0, 3);
  assert.deepEqual([some.count, some.position], [3, 2]);
  assert.deepEqual([...some.samples], [2, -2, 2, -2, 3, -3]);
  assert.equal(extractSamples(source, 0, Number.NaN).count, 0);
  assert.equal(extractSamples(source, 0, 100).count, 8);
});
