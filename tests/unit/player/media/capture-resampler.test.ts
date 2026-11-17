import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CaptureResampler,
  microphoneRates,
} from "../../../../packages/player/dist/media/capture-resampler.js";

function wave(rate: number, hz: number, count = rate): Float32Array {
  const samples = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    samples[i] = Math.sin((2 * Math.PI * hz * i) / rate);
  }
  return samples;
}
function rms(samples: Float32Array): number {
  let sum = 0;
  for (let i = 100; i < samples.length; i++) {
    sum += samples[i] * samples[i];
  }
  return Math.sqrt(sum / (samples.length - 100));
}

test("capture conversion preserves phase and count across uneven worklet blocks at every Flash rate", () => {
  const input = wave(48000, 440);
  for (const rate of microphoneRates.values()) {
    const reference = new CaptureResampler(48000, rate).push(input);
    assert.equal(reference.length, Math.ceil(rate));
    const chunked = new CaptureResampler(48000, rate);
    const result: number[] = [];
    for (let i = 0; i < input.length; i += 137) {
      result.push(...chunked.push(input.subarray(i, i + 137)));
    }
    assert.deepEqual(new Float32Array(result), reference);
    assert.ok(rms(reference) > 0.68 && rms(reference) < 0.72, String(rate));
  }
});

test("downsampling rejects frequencies above the destination Nyquist frequency", () => {
  const high = new CaptureResampler(48000, 8000).push(wave(48000, 10000));
  assert.ok(rms(high) < 0.002, String(rms(high)));
  const unity = new CaptureResampler(48000, 5512.5).push(new Float32Array(48000).fill(0.25));
  assert.ok(Math.abs(unity[unity.length - 1] - 0.25) < 1e-6);
});
