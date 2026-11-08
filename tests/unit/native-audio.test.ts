// Nellymoser decoding (packages/player/src/media/nellymoser.ts) against
// FFmpeg's: tests/player/sounds/tone22.nelly is FFmpeg's encoding of a
// mixed 440 and 660 Hz tone, tone22-nelly.pcm its own decoder's samples
// (README.md there). The bands given no bits are noise whose signs come
// from another generator than FFmpeg's, so the samples are compared by
// their correlation and their level rather than one by one.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  NELLY_SAMPLES,
  NellymoserDecoder,
} from "../../../../packages/player/dist/media/nellymoser.js";

const sounds = new URL("../../../player/sounds/", import.meta.url);
const encoded = new Uint8Array(readFileSync(new URL("tone22.nelly", sounds)));
const reference = (() => {
  const bytes = readFileSync(new URL("tone22-nelly.pcm", sounds));
  return Float32Array.from(
    { length: bytes.length / 2 },
    (_, i) => bytes.readInt16LE(i * 2) / 32768,
  );
})();

test("Nellymoser blocks decode as FFmpeg decodes them", () => {
  const samples = new NellymoserDecoder().decode(encoded);
  assert.equal(samples.length, (encoded.length / 64) * NELLY_SAMPLES);
  assert.equal(samples.length, reference.length);

  let ours = 0;
  let theirs = 0;
  let dot = 0;
  for (let i = 0; i < samples.length; i++) {
    ours += samples[i] ** 2;
    theirs += reference[i] ** 2;
    dot += samples[i] * reference[i];
  }

  assert.ok(dot / Math.sqrt(ours * theirs) > 0.99, `correlation ${dot / Math.sqrt(ours * theirs)}`);
  assert.ok(Math.abs(Math.sqrt(ours / theirs) - 1) < 0.01, `level ${Math.sqrt(ours / theirs)}`);
});

test("a stream's blocks decode one call after another as they do at once", () => {
  const whole = new NellymoserDecoder().decode(encoded);
  const decoder = new NellymoserDecoder();
  const parts = [
    decoder.decode(encoded.subarray(0, 64 * 5)),
    // A part short of a whole block leaves the rest for none.
    decoder.decode(encoded.subarray(64 * 5, 64 * 12 + 10)),
    decoder.decode(encoded.subarray(64 * 12)),
  ];
  assert.deepEqual(
    parts.map((p) => p.length),
    [5 * NELLY_SAMPLES, 7 * NELLY_SAMPLES, 10 * NELLY_SAMPLES],
  );
  const joined = new Float32Array(whole.length);
  joined.set(parts[0]);
  joined.set(parts[1], parts[0].length);
  joined.set(parts[2], parts[0].length + parts[1].length);
  assert.deepEqual(joined, whole);
});
