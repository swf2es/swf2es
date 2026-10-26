// Sound.extract's counting, as adl counts (the player's sound-extract case
// has the rest).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { prepareMp3 } from "../../../../packages/native/dist/mp3/index.js";
import { extractSamples, mp3Source } from "../../../../packages/player/dist/media/extract.js";

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

await prepareMp3();
const tone = new Uint8Array(
  readFileSync(new URL("../../../player/sounds/tone.mp3", import.meta.url)),
);

test("MP3 extraction is synchronous, untrimmed, and independent of prior decoders", () => {
  const first = mp3Source(tone);
  assert.ok(first);
  assert.equal(first.rate, 44100);
  assert.equal(first.channels.length, 2);
  assert.equal(first.channels[0].length, 12672);
  assert.ok(first.channels[0].some((value) => Math.abs(value) > 0.01));
  assert.deepEqual(mp3Source(tone), first);
  assert.equal(mp3Source(new TextEncoder().encode("not an MP3")), null);

  const mono = mp3Source(
    new Uint8Array(readFileSync(new URL("../../../player/sounds/tone22.mp3", import.meta.url))),
  );
  assert.ok(mono);
  assert.equal(mono.rate, 22050);
  assert.equal(mono.channels.length, 1);
  assert.equal(mono.channels[0].length, 6912);
});

test("tagged and incomplete MP3s keep whole frames, including a header frame", () => {
  const tagged = mp3Source(
    new Uint8Array(
      readFileSync(new URL("../../../player/sounds/tone-tagged.mp3", import.meta.url)),
    ),
  );
  assert.ok(tagged);
  assert.equal(tagged.channels[0].length, 13824);
  assert.ok(tagged.channels[0].subarray(0, 1152).every((value) => value === 0));
  assert.equal(mp3Source(tone.subarray(0, 1000))?.channels[0].length, 3456);
});
