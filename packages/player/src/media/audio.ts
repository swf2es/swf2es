// Browser audio behind a small host boundary. A player can run without an
// audio device, as the trace tests do, and an embedding page may supply one.
// ADPCM, Nellymoser and the blocks of a timeline's stream become a sound
// the host decodes as it decodes any other: PCM, or MP3 frames back to
// back.
import type { Sound, SoundStreamBlock, SoundStreamHead } from "@swf2es/format";
import { decodeAdpcm, NellymoserDecoder } from "@swf2es/native/audio";
import { mp3HeaderFrame } from "./mp3.js";
import { browserStream } from "./streaming-audio.js";

/** Below Firefox's limit for a scheduled stop, 2^23 s, with room for the context's own clock. */
const SCHEDULED_STOP_LIMIT = 2 ** 22;

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
  /** Elapsed playback in ms, including atMs; NaN until started. Optional for hosts without a cursor. */
  readonly positionMs?: number;
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

export interface AudioHost {
  decode(source: Sound | Uint8Array): Promise<DecodedSound>;
  /** Stereo float PCM at 44.1 kHz, supplied as SampleDataEvent requests are answered. */
  stream?(mix: SoundMix, refill: () => void): StreamingSound;
  /**
   * Open the device now, where a sound is to come: opening it can take half
   * a second on some systems (PulseAudio or PipeWire under Linux), better
   * spent as the movie loads than at its first sound. Nothing once closed.
   */
  warm?(): void;
  /** Let the device go, as the player is destroyed: nothing plays on it after. */
  close?(): void;
}

export interface StreamingSound extends PlayingSound {
  readonly positionMs: number;
  append(channels: Float32Array[]): void;
  finish(): void;
}

/** The browser's decoder handles MP3; SWF's two uncompressed forms need no codec. */
export function browserAudioHost(): AudioHost | null {
  const Context = globalThis.AudioContext;
  if (!Context) {
    return null;
  }

  let context: AudioContext | null = null;
  let closed = false;
  const streams = new Set<StreamingSound>();
  // Closed, it decodes nothing more: a new context would outlive the player.
  const getContext = () => {
    if (closed) {
      throw new Error("the audio host is closed");
    }

    context ??= new Context();
    return context;
  };
  return {
    stream(mix, refill) {
      const stream = browserStream(getContext(), mix, refill, () => streams.delete(stream));
      streams.add(stream);
      return stream;
    },
    warm() {
      if (closed) {
        return;
      }

      try {
        context ??= new Context();
      } catch {
        // A browser out of contexts refuses one: the first decode asks again, and fails there.
      }
    },
    close() {
      // A browser keeps a context, and its thread, until it is closed.
      closed = true;
      for (const stream of streams) {
        stream.stop();
      }
      void context?.close().catch(() => {});
      context = null;
    },
    async decode(given) {
      const ctx = getContext();
      const source =
        given instanceof Uint8Array
          ? given
          : given.format === 1
            ? adpcmSound(given)
            : isNellymoser(given.format)
              ? nellymoserSound(given)
              : given;
      let buffer: AudioBuffer;
      if (source instanceof Uint8Array || source.format === 2) {
        const data = (source instanceof Uint8Array ? source : source.data).slice();
        if (!(source instanceof Uint8Array)) {
          // SWF supplies the delay itself. Keep the header frame's silence,
          // without letting the browser trim it by Xing/LAME metadata too.
          const header = mp3HeaderFrame(data);
          if (header) {
            data.fill(0, header[0] + 4, header[1]);
          }
        }

        buffer = await ctx.decodeAudioData(data.buffer);
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

      // DefineSound's offsets count from after the encoder delay, in its
      // own sample rate; Web Audio may have resampled the decoded buffer.
      const origin =
        !(source instanceof Uint8Array) && source.format === 2
          ? Math.max(0, source.seekSamples) / source.sampleRate
          : 0;
      const duration =
        !(source instanceof Uint8Array) && source.format === 2
          ? Math.max(0, Math.min(buffer.duration - origin, source.sampleCount / source.sampleRate))
          : buffer.duration;

      return {
        durationMs: duration * 1000,
        play(startMs, loops, mix, shape) {
          const offset = Math.max(0, startMs / 1000);
          const end = Math.min(duration, (shape?.endMs ?? Infinity) / 1000);
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
          let beganAt = 0;
          let from = 0;
          let position = Number.NaN;
          const positionMs = () =>
            started && !ended
              ? Math.min(total, from + Math.max(0, ctx.currentTime - beganAt)) * 1000
              : position;
          const finish = () => {
            if (ended) {
              return;
            }

            position = positionMs();
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
          sourceNode.loopStart = origin + offset;
          sourceNode.loopEnd = origin + end;
          const asked = performance.now();
          // `late` seconds after it was asked for, as a stream waits for the device to run.
          const begin = (late: number) => {
            from = at + late;
            if (from >= total) {
              position = total * 1000;
              finish();
              return;
            }

            started = true;
            beganAt = ctx.currentTime;
            if (shape?.envelope) {
              envelopeLevels(levels[0].gain, levels[1].gain, shape.envelope, ctx.currentTime, from);
            }

            if (loops > 1) {
              sourceNode.start(0, origin + offset + (from % length));
              // Firefox refuses a stop time past 2^23 s (about 97 days) with a RangeError,
              // which a loop count such as 999999 asks for; a loop that long is ended by
              // stop() instead, and the channel's completion is timed by the player's clock.
              const remaining = total - from;
              if (ctx.currentTime + remaining < SCHEDULED_STOP_LIMIT) {
                sourceNode.stop(ctx.currentTime + remaining);
              }
            } else if (origin + end < buffer.duration) {
              sourceNode.start(0, origin + offset + from, length - from);
            } else {
              sourceNode.start(0, origin + offset + from);
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
                  try {
                    sourceNode.stop();
                  } catch {
                    // Already stopped, or stopped by the browser: disconnected all the same.
                  }
                }

                finish();
              }
            },
            setMix,
            get ended() {
              return ended;
            },
            get positionMs() {
              return positionMs();
            },
          };
        },
      };
    },
  };
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

/** 16-bit samples as uncompressed little-endian bytes, SWF's format 3. */
function pcmBytes(samples: Int16Array): Uint8Array {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < samples.length; i++) {
    view.setInt16(i * 2, samples[i], true);
  }

  return bytes;
}

/** Whether `format` is Nellymoser's: 4 and 5 at 16 and 8 kHz, 6 at any rate. */
function isNellymoser(format: number): boolean {
  return format === 4 || format === 5 || format === 6;
}

/** The sample rate of Nellymoser in `format`: 16 or 8 kHz for 4 and 5 whatever their flags say, `flagged` for 6. */
function nellymoserRate(format: number, flagged: number): number {
  return format === 4 ? 16000 : format === 5 ? 8000 : flagged;
}

/** Samples from -1 to 1 as 16-bit ones. */
function int16Samples(samples: Float32Array): Int16Array {
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.round(samples[i] * 32768);
    out[i] = v > 32767 ? 32767 : v < -32768 ? -32768 : v;
  }

  return out;
}

/** A Nellymoser DefineSound, which is mono, as the uncompressed sound it decodes to, cut to its count. */
function nellymoserSound(sound: Sound): Sound {
  const decoded = new NellymoserDecoder().decode(sound.data);
  const samples = decoded.subarray(0, Math.min(decoded.length, sound.sampleCount));
  return {
    ...sound,
    format: 3,
    sampleRate: nellymoserRate(sound.format, sound.sampleRate),
    sampleSize: 16,
    channels: 1,
    sampleCount: samples.length,
    data: pcmBytes(int16Samples(samples)),
  };
}

/** An ADPCM DefineSound as the uncompressed sound it decodes to. */
function adpcmSound(sound: Sound): Sound {
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
 * is a sound of its own, headers and all; Nellymoser's decode one after
 * another, each block's overlap carried into the next.
 */
export function streamSound(
  head: SoundStreamHead,
  blocks: readonly SoundStreamBlock[],
): { sound: Sound; starts: number[] } {
  const parts: Uint8Array[] = [];
  const starts = [0];
  const adpcm = head.format === 1;
  const nellymoser = isNellymoser(head.format) ? new NellymoserDecoder() : null;
  const decoded = adpcm || nellymoser !== null;
  const sampleSize = decoded ? 16 : head.sampleSize;
  const channels = nellymoser ? 1 : head.channels;
  const frameBytes = channels * (sampleSize / 8);
  let samples = 0;
  for (const block of blocks) {
    let data = block.data;
    let count: number;
    if (head.format === 2) {
      count = block.sampleCount ?? 0;
    } else {
      if (adpcm) {
        data = pcmBytes(decodeAdpcm(data, head.channels));
      } else if (nellymoser) {
        data = pcmBytes(int16Samples(nellymoser.decode(data)));
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
      format: decoded ? 3 : head.format,
      sampleRate: nellymoser ? nellymoserRate(head.format, head.sampleRate) : head.sampleRate,
      sampleSize,
      channels,
      sampleCount: samples,
      seekSamples: 0,
      data,
    },
    starts,
  };
}
