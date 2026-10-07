// Browser audio behind a small host boundary. A player can run without an
// audio device, as the trace tests do, and an embedding page may supply one.
// ADPCM and the blocks of a timeline's stream become a sound the host
// decodes as it decodes any other: PCM, or MP3 frames back to back.
import type { Sound, SoundStreamBlock, SoundStreamHead } from "@swf2es/format";
import { mp3Bytes, mp3Frames } from "./mp3.js";

export interface SoundMix {
  volume: number;
  leftToLeft: number;
  leftToRight: number;
  rightToLeft: number;
  rightToRight: number;
}

export interface PlayingSound {
  stop(): void;
  setMix(mix: SoundMix): void;
  /** Whether the device is done with it, stopped or played out; a host that cannot tell leaves it out. */
  readonly ended?: boolean;
}

/** A point of a sound's envelope: its time from the start of playing, in ms, and each channel's level. */
export interface EnvelopePoint {
  ms: number;
  left: number;
  right: number;
}

/** What a timeline asks of a sound beyond where it starts: where each loop ends, and its envelope. */
export interface PlayShape {
  /** Where each loop ends, in ms into the sound; its end if absent. */
  endMs?: number;
  /** The levels of the sound's left and right channels as it plays, linear between points, over all its loops. */
  envelope?: EnvelopePoint[];
  /**
   * Given for a stream, which keeps with its timeline: how far into its
   * playing, all loops, it is due now, in ms, as a decode that took frames
   * leaves it; a device not yet running adds the time it waits to run. A
   * sound without it plays whole, however late.
   */
  atMs?: number;
}

export interface DecodedSound {
  durationMs: number;
  /** Play from `startMs`, where every loop starts again, `loops` times (0 and 1 once). */
  play(startMs: number, loops: number, mix: SoundMix, shape?: PlayShape): PlayingSound | null;
}

/** A sound's samples at its own rate, a channel each. */
export interface ExtractedSamples {
  rate: number;
  channels: Float32Array[];
}

export interface AudioHost {
  decode(source: Sound | Uint8Array): Promise<DecodedSound>;
  /** MP3 bytes' samples as Flash's decoder gives them, for Sound.extract; a host that cannot leaves it out. */
  extractSamples?(bytes: Uint8Array): Promise<ExtractedSamples>;
}

/** The browser's decoder handles MP3; SWF's two uncompressed forms need no codec. */
export function browserAudioHost(): AudioHost | null {
  const Context = globalThis.AudioContext;
  if (!Context) {
    return null;
  }

  let context: AudioContext | null = null;
  const getContext = () => (context ??= new Context());
  return {
    extractSamples: decodeForExtract,
    async decode(given) {
      const ctx = getContext();
      const source = given instanceof Uint8Array || given.format !== 1 ? given : adpcmSound(given);
      let buffer: AudioBuffer;
      if (source instanceof Uint8Array || source.format === 2) {
        const data = source instanceof Uint8Array ? source : source.data;
        buffer = await ctx.decodeAudioData(data.slice().buffer);
      } else if (source.format === 0 || source.format === 3) {
        buffer = ctx.createBuffer(source.channels, source.sampleCount, source.sampleRate);
        const view = new DataView(
          source.data.buffer,
          source.data.byteOffset,
          source.data.byteLength,
        );
        const channels = Array.from({ length: source.channels }, (_, i) =>
          buffer.getChannelData(i),
        );
        const bytesPerFrame = source.channels * (source.sampleSize / 8);
        const frames = Math.min(
          source.sampleCount,
          Math.floor(source.data.byteLength / bytesPerFrame),
        );
        if (source.sampleSize === 8) {
          for (let i = 0; i < frames; i++) {
            for (let channel = 0; channel < source.channels; channel++) {
              channels[channel][i] = (view.getUint8(i * bytesPerFrame + channel) - 128) / 128;
            }
          }
        } else {
          for (let i = 0; i < frames; i++) {
            for (let channel = 0; channel < source.channels; channel++) {
              channels[channel][i] = view.getInt16(i * bytesPerFrame + channel * 2, true) / 32768;
            }
          }
        }
      } else {
        throw new Error(`Unsupported SWF sound format ${source.format}`);
      }

      return {
        durationMs: buffer.duration * 1000,
        play(startMs, loops, mix, shape) {
          const offset = Math.max(0, startMs / 1000);
          const end = Math.min(buffer.duration, (shape?.endMs ?? Infinity) / 1000);
          const keepsTime = shape?.atMs !== undefined;
          const at = Math.max(0, (shape?.atMs ?? 0) / 1000);
          const length = end - offset;
          const total = length * Math.max(1, loops);
          if (length <= 0 || at >= total) {
            return null;
          }

          const sourceNode = ctx.createBufferSource();
          let ended = false;
          let started = false;
          const finish = () => {
            if (ended) {
              return;
            }

            ended = true;
            ctx.removeEventListener?.("statechange", running);
            sourceNode.disconnect();
            splitter.disconnect();
            for (const gain of [...gains, ...levels]) {
              gain.disconnect();
            }

            merger.disconnect();
          };
          sourceNode.buffer = buffer;
          const splitter = ctx.createChannelSplitter(2);
          const merger = ctx.createChannelMerger(2);
          const gains = Array.from({ length: 4 }, () => ctx.createGain());
          const right = buffer.numberOfChannels === 1 ? 0 : 1;
          sourceNode.onended = finish;
          sourceNode.connect(splitter);
          // An envelope scales each source channel, a mono one as both, before the mix crosses them.
          const levels = shape?.envelope ? [ctx.createGain(), ctx.createGain()] : [];
          if (shape?.envelope) {
            splitter.connect(levels[0], 0);
            splitter.connect(levels[1], right);
            levels[0].connect(gains[0]);
            levels[0].connect(gains[1]);
            levels[1].connect(gains[2]);
            levels[1].connect(gains[3]);
          } else {
            splitter.connect(gains[0], 0);
            splitter.connect(gains[1], 0);
            splitter.connect(gains[2], right);
            splitter.connect(gains[3], right);
          }

          gains[0].connect(merger, 0, 0);
          gains[1].connect(merger, 0, 1);
          gains[2].connect(merger, 0, 0);
          gains[3].connect(merger, 0, 1);
          merger.connect(ctx.destination);
          const setMix = (next: SoundMix) => {
            gains[0].gain.value = next.volume * next.leftToLeft;
            gains[1].gain.value = next.volume * next.leftToRight;
            gains[2].gain.value = next.volume * next.rightToLeft;
            gains[3].gain.value = next.volume * next.rightToRight;
          };
          setMix(mix);
          sourceNode.loop = loops > 1;
          sourceNode.loopStart = offset;
          sourceNode.loopEnd = end;
          const asked = performance.now();
          // `late` seconds after it was asked for, as a stream waits for the device to run.
          const begin = (late: number) => {
            const from = at + late;
            if (from >= total) {
              finish();
              return;
            }

            started = true;
            if (shape?.envelope) {
              envelopeLevels(levels[0].gain, levels[1].gain, shape.envelope, ctx.currentTime, from);
            }

            if (loops > 1) {
              sourceNode.start(0, offset + (from % length));
              sourceNode.stop(ctx.currentTime + total - from);
            } else if (end < buffer.duration) {
              sourceNode.start(0, offset + from, length - from);
            } else {
              sourceNode.start(0, offset + from);
            }
          };
          // A suspended context's time stands still, before the page's first
          // gesture or a slow resume: a stream starts when it runs, as far in
          // as the wait; any other sound plays whole once it does.
          function running(): void {
            if (ctx.state === "running" && !started && !ended) {
              ctx.removeEventListener?.("statechange", running);
              begin((performance.now() - asked) / 1000);
            }
          }

          if (keepsTime && ctx.state === "suspended") {
            ctx.addEventListener?.("statechange", running);
          } else {
            begin(0);
          }

          void ctx.resume().catch(() => {});
          return {
            stop: () => {
              if (!ended) {
                if (started) {
                  sourceNode.stop();
                }

                finish();
              }
            },
            setMix,
            get ended() {
              return ended;
            },
          };
        },
      };
    },
  };
}

/**
 * MP3 bytes decoded as Flash decodes them, for Sound.extract alone: at
 * their own rate, their whole frames only, and a Xing, Info or VBRI header
 * a frame of silence, kept out of the browser's sight so that it trims
 * nothing by it. Playback keeps the browser's decode of the whole file at
 * the device's rate, which resamples better than a buffer played at
 * another rate. Bytes it cannot make out as MP3, or whose frames it cannot
 * decode alone, are decoded whole.
 */
async function decodeForExtract(given: Uint8Array): Promise<ExtractedSamples> {
  // A copy: the bytes may grow under it while it waits.
  const data = given.slice();
  const mp3 = mp3Frames(data);
  let buffer: AudioBuffer | null = null;
  let silence = 0;
  if (mp3) {
    const offline = new OfflineAudioContext(mp3.channels, 1, mp3.rate);
    try {
      buffer = await offline.decodeAudioData(mp3Bytes(data, mp3).buffer);
      silence = mp3.header ? mp3.samplesPerFrame : 0;
    } catch {
      buffer = null;
    }
  }

  buffer ??= await new OfflineAudioContext(2, 1, 44100).decodeAudioData(data.buffer);
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, i) => {
    const channel = new Float32Array(buffer.length + silence);
    channel.set(buffer.getChannelData(i), silence);
    return channel;
  });
  return { rate: buffer.sampleRate, channels };
}

/**
 * An envelope as gain automation, `at` seconds into it at `now`: the first
 * point's level held before it, as Ruffle holds it, then lines between
 * points; a late start begins at the level the lines reach by then.
 */
function envelopeLevels(
  left: AudioParam,
  right: AudioParam,
  envelope: EnvelopePoint[],
  now: number,
  at: number,
): void {
  const ms = at * 1000;
  let level = envelope[0] ?? { ms: 0, left: 1, right: 1 };
  for (let i = 0; i < envelope.length && envelope[i].ms <= ms; i++) {
    const next = envelope[i + 1];
    level = envelope[i];
    if (next && next.ms > ms && next.ms > level.ms) {
      const t = (ms - level.ms) / (next.ms - level.ms);
      level = {
        ms,
        left: level.left + (next.left - level.left) * t,
        right: level.right + (next.right - level.right) * t,
      };
      break;
    }
  }

  left.setValueAtTime(level.left, now);
  right.setValueAtTime(level.right, now);
  for (const point of envelope) {
    if (point.ms >= ms) {
      left.linearRampToValueAtTime(point.left, now + (point.ms - ms) / 1000);
      right.linearRampToValueAtTime(point.right, now + (point.ms - ms) / 1000);
    }
  }
}

const ADPCM_INDEX = [
  [-1, 2],
  [-1, -1, 2, 4],
  [-1, -1, -1, -1, 2, 4, 6, 8],
  [-1, -1, -1, -1, -1, -1, -1, -1, 1, 2, 4, 6, 8, 10, 13, 16],
];

const ADPCM_STEPS = [
  7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45, 50, 55, 60, 66, 73,
  80, 88, 97, 107, 118, 130, 143, 157, 173, 190, 209, 230, 253, 279, 307, 337, 371, 408, 449, 494,
  544, 598, 658, 724, 796, 876, 963, 1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066, 2272, 2499,
  2749, 3024, 3327, 3660, 4026, 4428, 4871, 5358, 5894, 6484, 7132, 7845, 8630, 9493, 10442, 11487,
  12635, 13899, 15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794, 32767,
];

/**
 * SWF's ADPCM as 16-bit samples, channels interleaved: a code size, then
 * packets of a header per channel (a 16-bit sample and a 6-bit step index)
 * and 4095 codes, the header's sample the packet's first, as adl gives it
 * (Ruffle's decoder leaves it out). It ends where the bits do.
 */
export function decodeAdpcm(data: Uint8Array, channels: 1 | 2): Int16Array {
  const total = data.length * 8;
  let bit = 0;
  const read = (n: number): number => {
    let v = 0;
    for (let i = 0; i < n; i++, bit++) {
      v = v * 2 + ((data[bit >> 3] >> (7 - (bit & 7))) & 1);
    }

    return v;
  };

  if (total < 2) {
    return new Int16Array(0);
  }

  const bits = read(2) + 2;
  const signBit = 1 << (bits - 1);
  const index = ADPCM_INDEX[bits - 2];
  const out = new Int16Array(Math.ceil(total / bits) + channels);
  const sample = [0, 0];
  const step = [0, 0];
  let n = 0;
  for (let k = 0; ; k = (k + 1) % 4096) {
    if (k === 0) {
      if (bit + 22 * channels > total) {
        break;
      }

      for (let c = 0; c < channels; c++) {
        sample[c] = (read(16) << 16) >> 16;
        step[c] = read(6);
        out[n++] = sample[c];
      }

      continue;
    }

    if (bit + bits * channels > total) {
      break;
    }

    for (let c = 0; c < channels; c++) {
      const value = read(bits);
      const magnitude = value & (signBit - 1);
      const size = ADPCM_STEPS[step[c]];
      let delta = size >> (bits - 1);
      for (let k = 0; k < bits - 1; k++) {
        if (magnitude & (1 << k)) {
          delta += size >> (bits - 2 - k);
        }
      }

      sample[c] =
        value & signBit ? Math.max(-32768, sample[c] - delta) : Math.min(32767, sample[c] + delta);
      step[c] = Math.max(0, Math.min(ADPCM_STEPS.length - 1, step[c] + index[magnitude]));
      out[n++] = sample[c];
    }
  }

  return out.subarray(0, n);
}

/** 16-bit samples as uncompressed little-endian bytes, SWF's format 3. */
function pcmBytes(samples: Int16Array): Uint8Array {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < samples.length; i++) {
    view.setInt16(i * 2, samples[i], true);
  }

  return bytes;
}

/** An ADPCM DefineSound as the uncompressed sound it decodes to. */
export function adpcmSound(sound: Sound): Sound {
  const samples = decodeAdpcm(sound.data, sound.channels);
  return {
    ...sound,
    format: 3,
    sampleSize: 16,
    sampleCount: samples.length / sound.channels,
    data: pcmBytes(samples),
  };
}

/**
 * A timeline's stream as one sound, its blocks back to back, and the
 * sample each block starts at, the last entry the end. MP3 blocks give
 * their counts; PCM's are whole frames of their bytes; each ADPCM block
 * is a sound of its own, headers and all.
 */
export function streamSound(
  head: SoundStreamHead,
  blocks: readonly SoundStreamBlock[],
): { sound: Sound; starts: number[] } {
  const parts: Uint8Array[] = [];
  const starts = [0];
  const adpcm = head.format === 1;
  const sampleSize = adpcm ? 16 : head.sampleSize;
  const frameBytes = head.channels * (sampleSize / 8);
  let samples = 0;
  for (const block of blocks) {
    let data = block.data;
    let count: number;
    if (head.format === 2) {
      count = block.sampleCount ?? 0;
    } else {
      if (adpcm) {
        data = pcmBytes(decodeAdpcm(data, head.channels));
      }

      count = Math.floor(data.length / frameBytes);
      data = data.subarray(0, count * frameBytes);
    }

    parts.push(data);
    samples += count;
    starts.push(samples);
  }

  const data = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    data.set(part, at);
    at += part.length;
  }

  return {
    sound: {
      id: 0,
      format: adpcm ? 3 : head.format,
      sampleRate: head.sampleRate,
      sampleSize,
      channels: head.channels,
      sampleCount: samples,
      seekSamples: 0,
      data,
    },
    starts,
  };
}
