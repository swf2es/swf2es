// Nellymoser decoding (@swf2es/native/audio, src/audio/nellymoser.zig)
// against FFmpeg's: tests/player/sounds/tone22.nelly is FFmpeg's encoding of a
// mixed 440 and 660 Hz tone, tone22-nelly.pcm its own decoder's samples
// (README.md there). The bands given no bits are noise whose signs come
// from another generator than FFmpeg's, so the samples are compared by
// their correlation and their level rather than one by one.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  decodeAdpcm,
  NELLYMOSER_SAMPLES,
  NellymoserDecoder,
} from "../../packages/native/dist/audio/index.js";

const sounds = new URL("../player/sounds/", import.meta.url);
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
  assert.equal(samples.length, (encoded.length / 64) * NELLYMOSER_SAMPLES);
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
    [5 * NELLYMOSER_SAMPLES, 7 * NELLYMOSER_SAMPLES, 10 * NELLYMOSER_SAMPLES],
  );
  const joined = new Float32Array(whole.length);
  joined.set(parts[0]);
  joined.set(parts[1], parts[0].length);
  joined.set(parts[2], parts[0].length + parts[1].length);
  assert.deepEqual(joined, whole);
});

test("a block's worth of bytes or none decodes to nothing, and ADPCM too short for its header", () => {
  assert.equal(new NellymoserDecoder().decode(encoded.subarray(0, 63)).length, 0);
  assert.equal(new NellymoserDecoder().decode(new Uint8Array(0)).length, 0);
  assert.equal(decodeAdpcm(new Uint8Array(0), 1).length, 0);
  // A code size and part of a header: no samples.
  assert.equal(decodeAdpcm(new Uint8Array(2), 2).length, 0);
});

test("a large ADPCM sound decodes whole", () => {
  // Stereo, 4-bit codes, all zeros: each packet a header and 4095 codes a
  // channel, 32804 bits for 8192 samples, each sample 0.
  const bytes = new Uint8Array(6 << 20);
  bytes[0] = 0b10_000000;
  const samples = decodeAdpcm(bytes, 2);
  const packets = Math.floor((bytes.length * 8 - 2) / 32804);
  const rest = bytes.length * 8 - 2 - packets * 32804;
  assert.equal(samples.length, packets * 8192 + 2 + 2 * Math.floor((rest - 44) / 8));
  assert.ok(samples.every((v) => v === 0));
});
