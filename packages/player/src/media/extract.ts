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
  /** Where a script may start it, short of its end: an ADPCM sound's samples, not the silence after them. */
  starts?: number;
  /** Where a start lands, for a sound whose seeking adl gets wrong. */
  seek?: (start: number) => number;
}

/** An uncompressed or ADPCM DefineSound's samples to extract, or null for another format. */
export function embeddedSource(sound: Sound): ExtractSource | null {
  const n = sound.channels;
  const source = { rate: sound.sampleRate, skip: 0, whole: true };
  if (sound.format === 1) {
    return { ...source, ...adpcmSource(sound.data, n) };
  }

  if (sound.format !== 0 && sound.format !== 3) {
    return null;
  }

  const view = new DataView(sound.data.buffer, sound.data.byteOffset, sound.data.byteLength);
  const size = sound.sampleSize / 8;
  const frames = Math.min(sound.sampleCount, Math.floor(sound.data.byteLength / (size * n)));
  return {
    ...source,
    channels: deinterleave(frames, n, (i) =>
      size === 1 ? (view.getUint8(i) - 128) / 128 : view.getInt16(i * 2, true) / 32768,
    ),
  };
}

/** Samples adl decodes in blocks of 2048, the last run on past the data as if its bits went on as zeros. */
const ADPCM_BLOCK = 2048;

/** Samples a packet: its header's and 4095 codes'. */
const ADPCM_PACKET = 4096;

/**
 * An ADPCM sound's samples as adl extracts them: blocks of samples, the
 * last running on as if the data's bits went on as zeros (where adl reads
 * on into whatever follows the data), though a script may start only
 * within the data. A start's packet's offset in bits is reckoned in 32
 * bits: where that wraps negative, adl starts from the first packet, as
 * far into it as the start is into its own.
 */
function adpcmSource(
  data: Uint8Array,
  n: 1 | 2,
): Pick<ExtractSource, "channels" | "starts" | "seek"> {
  const frames = decodeAdpcm(data, n).length / n;
  const padded = (Math.floor(frames / ADPCM_BLOCK) + 1) * ADPCM_BLOCK;
  const bits = data.length ? (data[0] >> 6) + 2 : 4;
  const more = new Uint8Array(data.length + Math.ceil(((padded - frames) * bits * n) / 8) + 8 * n);
  more.set(data);
  const samples = decodeAdpcm(more, n);
  const packetBits = 22 * n + (ADPCM_PACKET - 1) * bits * n;
  return {
    channels: deinterleave(padded, n, (i) => samples[i] / 32768),
    starts: frames,
    seek: (start) =>
      Math.imul(Math.floor(start / ADPCM_PACKET), packetBits) < 0 ? start % ADPCM_PACKET : start,
  };
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
