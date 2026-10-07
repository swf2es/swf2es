// Sound.extract's samples: a sound's own, at its own rate, given out at
// 44.1 kHz in stereo, each sample held for as many as its rate falls short,
// as adl gives them (the sound-extract case). Where extract is in a sound,
// and where a script tells it to start, count the sound's own samples, not
// those it writes. Ruffle's extract writes zeros (sound.rs's extract is a
// stub).
import type { Sound } from "@swf2es/format";
import { decodeAdpcm } from "./audio.js";

export const EXTRACT_RATE = 44100;

/** A sound's samples to extract from. */
export interface ExtractSource {
  rate: number;
  /** One channel, which extract writes to both, or two. */
  channels: Float32Array[];
  /** Samples at the start that extract never reaches: an MP3 DefineSound's seekSamples. */
  skip: number;
  /**
   * Whether it writes whole samples of its own only, as adl does for a
   * sound uncompressed or ADPCM in the SWF: a length short of one writes
   * none.
   */
  whole: boolean;
}

/** An uncompressed or ADPCM DefineSound's samples, or null for another format. */
export function soundSamples(sound: Sound): Float32Array[] | null {
  const n = sound.channels;
  if (sound.format === 1) {
    const samples = decodeAdpcm(sound.data, n);
    return deinterleave(samples.length / n, n, (i) => samples[i] / 32768);
  }

  if (sound.format !== 0 && sound.format !== 3) {
    return null;
  }

  const view = new DataView(sound.data.buffer, sound.data.byteOffset, sound.data.byteLength);
  const size = sound.sampleSize / 8;
  const frames = Math.min(sound.sampleCount, Math.floor(sound.data.byteLength / (size * n)));
  return deinterleave(frames, n, (i) =>
    size === 1 ? (view.getUint8(i) - 128) / 128 : view.getInt16(i * 2, true) / 32768,
  );
}

function deinterleave(frames: number, n: number, at: (i: number) => number): Float32Array[] {
  const channels = Array.from({ length: n }, () => new Float32Array(frames));
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < n; c++) {
      channels[c][i] = at(i * n + c);
    }
  }

  return channels;
}

/** Samples at `rate` brought to 44.1 kHz as loadPCMFromByteArray does: each output sample the one it falls in. */
export function toExtractRate(channels: Float32Array[], rate: number): Float32Array[] {
  if (rate === EXTRACT_RATE) {
    return channels;
  }

  const frames = Math.floor((channels[0].length * EXTRACT_RATE) / rate);
  return channels.map((channel) => {
    const out = new Float32Array(frames);
    for (let i = 0; i < frames; i++) {
      out[i] = channel[Math.floor((i * rate) / EXTRACT_RATE)];
    }

    return out;
  });
}

/**
 * Up to `length` samples from `position`, interleaved, and the position
 * after them. What extract returns is how many it wrote, but once the
 * sound runs out, how many of its own samples it read, as adl counts them.
 */
export function extractSamples(
  source: ExtractSource,
  position: number,
  length: number,
): { samples: Float32Array; position: number; count: number } {
  const total = source.channels[0].length - source.skip;
  const ratio = EXTRACT_RATE / source.rate;
  const room = Math.max(0, total - position);
  const wanted = Math.floor(length);
  let written = wanted > 0 ? Math.min(wanted, Math.floor(room * ratio)) : 0;
  if (source.whole) {
    written = Math.floor(Math.floor(written / ratio) * ratio);
  }

  const read = Math.min(room, Math.ceil(written / ratio));
  const [left, right = left] = source.channels;
  const samples = new Float32Array(written * 2);
  for (let i = 0; i < written; i++) {
    const at = source.skip + position + Math.floor(i / ratio);
    samples[i * 2] = left[at];
    samples[i * 2 + 1] = right[at];
  }

  const end = position + read >= total;
  return { samples, position: position + read, count: end ? read : written };
}
