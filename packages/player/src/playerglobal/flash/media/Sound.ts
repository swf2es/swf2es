// flash.media.Sound and SoundChannel: a SWF's embedded sound, a host-fetched
// MP3, or MP3 or PCM bytes a script hands it, with playback through the
// host's audio device and frame-delivered events; the channels themselves,
// and the timeline's sounds, are the player's (media/sounds.ts), and what
// extract reads is media/extract.ts'.
import type { Sound } from "@swf2es/format";
import { avm2 } from "@swf2es/runtime";
import type { SoundCharacter } from "../../../display/timeline.js";
import type { ExtractedSamples, SoundMix } from "../../../media/audio.js";
import {
  EXTRACT_RATE,
  type ExtractSource,
  embeddedSource,
  extractSamples,
  toExtractRate,
} from "../../../media/extract.js";
import { mp3Frames } from "../../../media/mp3.js";
import {
  type ChannelState,
  channels,
  liveSounds,
  MAX_SOUNDS,
  mixerMix,
  mixerMixes,
  mixOf,
  outputMix,
  positionOf,
  type SoundState,
  stopChannel,
  updateTimelineMixes,
} from "../../../media/sounds.js";
import { dispatchEvent } from "../../../scripting/events.js";
import type { Scripting } from "../../../scripting.js";

type AsObject = avm2.AsObject;
type Value = avm2.Value;

/** An uncompressed or ADPCM DefineSound's samples, decoded once for extract; null for another format. */
const embeddedSources = new WeakMap<SoundCharacter, ExtractSource | null>();

/**
 * An MP3's samples as Flash decodes them, by its DefineSound or by the
 * Sound it was loaded into: decoded the first time a script extracts
 * them, apart from the decode it plays, and kept for the extracts after.
 */
const mp3Decodes = new WeakMap<object, { samples: ExtractedSamples | null }>();

/** 44.1 kHz samples as an uncompressed 16-bit DefineSound, for the host to play. */
function pcmSound(channels: Float32Array[]): Sound {
  const frames = channels[0].length;
  const data = new Uint8Array(frames * channels.length * 2);
  const view = new DataView(data.buffer);
  for (let i = 0; i < frames; i++) {
    for (const [c, channel] of channels.entries()) {
      const v = Math.max(-1, Math.min(1, channel[i]));
      view.setInt16((i * channels.length + c) * 2, Math.round(v * 32767), true);
    }
  }

  return {
    id: 0,
    format: 3,
    sampleRate: EXTRACT_RATE,
    sampleSize: 16,
    channels: channels.length === 1 ? 1 : 2,
    sampleCount: frames,
    seekSamples: 0,
    data,
  };
}

function stateOf(o: AsObject): SoundState {
  if (o.$sound) {
    return o.$sound;
  }

  const state: SoundState = {
    character: null,
    bytes: null,
    url: null,
    loaded: 0,
    total: 0,
    length: 0,
    used: false,
    generation: 0,
    abort: null,
    clip: null,
    compressed: false,
    pcm: null,
    extracted: 0,
  };
  o.$sound = state;
  return state;
}

/** The mixer stores channel coefficients in hundredths when a transform is assigned. */
export function channelMix(mix: SoundMix): SoundMix {
  // Whole percents, as Ruffle's i32: NaN is 0 and the range saturates.
  const hundredths = (value: number) =>
    Number.isNaN(value)
      ? 0
      : Math.max(-(2 ** 31), Math.min(2 ** 31 - 1, Math.trunc(value * 100))) / 100;
  return {
    volume: hundredths(mix.volume),
    leftToLeft: hundredths(mix.leftToLeft),
    leftToRight: hundredths(mix.leftToRight),
    rightToLeft: hundredths(mix.rightToLeft),
    rightToRight: hundredths(mix.rightToRight),
  };
}

/** SoundMixer.soundTransform: a copy, as Flash returns. */
export function mixerTransform(s: Scripting): AsObject {
  return transformOf(s, mixerMix(s));
}

/** Set SoundMixer's transform, for the channels playing and those to come. */
export function setMixerTransform(s: Scripting, transform: Value): void {
  if (transform === null || transform === undefined) {
    throw s.rt.error("TypeError", 2007, "sndTransform");
  }

  const global = channelMix(mixOf(transform as AsObject));
  mixerMixes.set(s, global);
  for (const channel of channels.get(s) ?? []) {
    const state = channel.$channel as ChannelState;
    state.playing?.setMix(outputMix(state.mix, global));
  }

  updateTimelineMixes(s);
}

export function transformOf(s: Scripting, mix: SoundMix): AsObject {
  const o = s.rt.construct(s.rt.classNamed("flash.media::SoundTransform")) as AsObject;
  o.$soundVolume = mix.volume;
  o.$soundLeftToLeft = mix.leftToLeft;
  o.$soundLeftToRight = mix.leftToRight;
  o.$soundRightToLeft = mix.rightToLeft;
  o.$soundRightToRight = mix.rightToRight;
  return o;
}

export function soundNatives(s: Scripting): avm2.Natives {
  const natives: avm2.Natives = {};
  const discardPending = (sound: SoundState): void => {
    const active = channels.get(s);
    for (const channel of active ?? []) {
      const state = channel.$channel as ChannelState;
      if (state.sound === sound && !state.playing) {
        stopChannel(s, state);
        active?.delete(channel);
      }
    }
  };
  const discardChannel = (state: ChannelState): void => {
    stopChannel(s, state);
    const active = channels.get(s);
    for (const channel of active ?? []) {
      if ((channel.$channel as ChannelState) === state) {
        active?.delete(channel);
        break;
      }
    }
  };
  const startAudio = (state: ChannelState): void => {
    const sound = state.sound;
    const task = sound.character ? s.symbols.soundClip(sound.character) : sound.clip;
    void task
      ?.then(
        (clip) => {
          if (!state.stopped) {
            state.playing = clip.play(state.start, state.loops, outputMix(state.mix, mixerMix(s)));
          }
        },
        () => {
          if (!sound.character) {
            discardChannel(state);
          }
        },
      )
      .catch(() => {
        if (!sound.character) {
          discardChannel(state);
        }
      });
  };

  /**
   * What extract reads of a sound now: an MP3's decode only once it is
   * done, which the browser's decoder gives late where Flash's gives at
   * once, so that an MP3's first extract starts its decode and gives
   * nothing.
   */
  const extractSource = (sound: SoundState): ExtractSource | null => {
    if (sound.pcm) {
      return { rate: EXTRACT_RATE, channels: sound.pcm, skip: 0, whole: false };
    }

    const character = sound.character;
    const definition = character?.definition;
    if (character && definition && definition.format !== 2) {
      let source = embeddedSources.get(character);
      if (source === undefined) {
        source = embeddedSource(definition);
        embeddedSources.set(character, source);
      }

      return source;
    }

    const key = character ?? sound;
    const bytes = definition ? definition.data : sound.bytes;
    let decode = mp3Decodes.get(key);
    if (!decode && bytes?.length) {
      const entry: { samples: ExtractedSamples | null } = { samples: null };
      decode = entry;
      mp3Decodes.set(key, entry);
      const task = s.audio?.extractSamples?.(bytes);
      if (task) {
        s.loads.trackRequest(
          task.then(
            (samples) => {
              entry.samples = samples;
            },
            () => {},
          ),
        );
      }
    }

    const samples = decode?.samples;
    return samples
      ? {
          rate: samples.rate,
          channels: samples.channels,
          skip: definition ? Math.max(0, definition.seekSamples) : 0,
          whole: false,
        }
      : null;
  };

  class SoundNatives {
    declare $sound: SoundState | undefined;

    /**
     * Up to `length` samples at 44.1 kHz into `target` at its position, a
     * float each for left and right in its byte order, from `startPosition`
     * or, for -1, from where the last extract stopped.
     */
    extract(target: Value, length: Value, startPosition: Value = -1): number {
      const sound = stateOf(this as AsObject);
      if (target === null || target === undefined) {
        return 0;
      }

      const source = extractSource(sound);
      const start = s.rt.toNumber(startPosition);
      if (start >= 0) {
        // Past 32 bits a start is from the beginning, as in adl.
        const at = start >= 2 ** 31 ? 0 : Math.floor(start);
        sound.extracted = source?.seek ? source.seek(at) : at;
        if (source && sound.extracted >= (source.starts ?? Number.POSITIVE_INFINITY)) {
          sound.extracted = source.channels[0].length;
          return 0;
        }
      }

      if (!source) {
        return 0;
      }

      const { samples, position, count } = extractSamples(
        source,
        sound.extracted,
        s.rt.toNumber(length),
      );
      sound.extracted = position;
      const b = avm2.bytesOf(s.rt, target as AsObject);
      const bytes = new Uint8Array(samples.length * 4);
      const view = new DataView(bytes.buffer);
      for (let i = 0; i < samples.length; i++) {
        view.setFloat32(i * 4, samples[i], b.littleEndian);
      }

      if (bytes.length) {
        b.write(bytes);
      }

      return count;
    }

    /**
     * MP3 frames from `bytes`, added to any it was given before, as adl
     * has it: its length counts a frame cut short, its decode does not,
     * and a sound of the SWF's keeps its own samples.
     */
    loadCompressedDataFromByteArray(bytes: Value, bytesLength: Value): void {
      if (bytes === null || bytes === undefined) {
        throw s.rt.error("TypeError", 2007, "bytes");
      }

      const sound = stateOf(this as AsObject);
      const b = avm2.bytesOf(s.rt, bytes as AsObject);
      const n = s.rt.toUint(bytesLength);
      if (n === 0 || n > b.length - b.position) {
        throw s.rt.error("ArgumentError", 2084);
      }

      const data = b.read(n);
      if (sound.character) {
        return;
      }

      const before = sound.compressed && sound.bytes ? sound.bytes : new Uint8Array(0);
      const all = new Uint8Array(before.length + data.length);
      all.set(before);
      all.set(data, before.length);
      const mp3 = mp3Frames(all);
      sound.bytes = all;
      sound.compressed = true;
      sound.pcm = null;
      sound.used = true;
      sound.loaded = n;
      sound.total = n;
      sound.length = mp3 ? (mp3.frames * mp3.samplesPerFrame * 1000) / mp3.rate : 0;
      sound.clip = s.audio ? s.audio.decode(all) : null;
      mp3Decodes.delete(sound);
      dispatchEvent(
        s,
        this as AsObject,
        s.rt.construct(
          s.rt.classNamed("flash.events::ProgressEvent"),
          "progress",
          false,
          false,
          n,
          n,
        ) as AsObject,
      );
    }

    /**
     * `samples` samples of 32-bit floats or 16-bit integers from `bytes`,
     * in its byte order, brought to 44.1 kHz: they take the place of
     * whatever the sound had, a SWF's sound too.
     */
    loadPCMFromByteArray(
      bytes: Value,
      samples: Value,
      format: Value = "float",
      stereo: Value = true,
      sampleRate: Value = EXTRACT_RATE,
    ): void {
      if (bytes === null || bytes === undefined) {
        throw s.rt.error("TypeError", 2007, "bytes");
      }

      if (format === null || format === undefined) {
        throw s.rt.error("TypeError", 2007, "format");
      }

      const kind = s.rt.toString(format);
      if (kind !== "float" && kind !== "short") {
        throw s.rt.error("ArgumentError", 2005);
      }

      const b = avm2.bytesOf(s.rt, bytes as AsObject);
      const n = s.rt.toUint(samples);
      const rate = s.rt.toNumber(sampleRate);
      const channels = stereo ? 2 : 1;
      const size = kind === "float" ? 4 : 2;
      const available = b.length - b.position;
      // adl weighs the samples against the bytes, not the bytes they take,
      // and then reads what there is before it finds them short.
      if (n === 0 || !(rate > 0) || n > available) {
        throw s.rt.error("ArgumentError", 2084);
      }

      // Faster than 44.1 kHz, it reads only as many as it gives out.
      const outputs = Math.floor((n * EXTRACT_RATE) / rate);
      const count = Math.min(n, outputs);
      if (count * channels * size > available) {
        b.position += Math.floor(available / size) * size;
        throw s.rt.error("flash.errors::EOFError", 2030);
      }

      const little = b.littleEndian;
      const view = new DataView(b.read(count * channels * size).buffer);
      const raw = Array.from({ length: channels }, () => new Float32Array(count));
      for (let i = 0; i < count * channels; i++) {
        raw[i % channels][Math.floor(i / channels)] =
          size === 4 ? view.getFloat32(i * 4, little) : view.getInt16(i * 2, little) / 32768;
      }

      const sound = stateOf(this as AsObject);
      const pcm = toExtractRate(raw, count < n ? EXTRACT_RATE : rate);
      sound.character = null;
      sound.pcm = pcm;
      sound.bytes = new Uint8Array(0);
      sound.compressed = false;
      sound.used = true;
      sound.loaded = n * size;
      sound.total = n * size;
      // In samples a millisecond, to adl's last bit.
      sound.length = pcm[0].length / (EXTRACT_RATE / 1000);
      sound.extracted = 0;
      sound.clip = s.audio ? s.audio.decode(pcmSound(pcm)) : null;
    }

    "flash.media:Sound::_load"(request: Value, _checkPolicyFile: Value, _bufferTime: Value): void {
      // Sound's AS3 constructor always calls load, with null when it was given no request.
      if (request === null || request === undefined) {
        return;
      }

      const sound = stateOf(this as AsObject);
      if (sound.used) {
        throw s.rt.error("Error", 2037);
      }

      sound.used = true;
      const generation = ++sound.generation;
      const abort = new AbortController();
      sound.abort = abort;
      s.loads.requestBytes(request as AsObject, abort.signal, ({ bytes, local }, url) => {
        if (sound.generation !== generation) {
          return;
        }

        sound.abort = null;
        sound.url = url;
        if (!bytes) {
          discardPending(sound);
          dispatchEvent(
            s,
            this as AsObject,
            s.rt.construct(
              s.rt.classNamed("flash.events::IOErrorEvent"),
              "ioError",
              false,
              false,
              s.loads.streamError(url, local),
            ) as AsObject,
          );
          return;
        }

        sound.bytes = bytes;
        sound.loaded = bytes.length;
        sound.total = bytes.length;
        dispatchEvent(s, this as AsObject, s.event("open"));
        if (sound.generation !== generation) {
          return;
        }

        dispatchEvent(
          s,
          this as AsObject,
          s.rt.construct(
            s.rt.classNamed("flash.events::ProgressEvent"),
            "progress",
            false,
            false,
            bytes.length,
            bytes.length,
          ) as AsObject,
        );
        if (sound.generation !== generation) {
          return;
        }

        if (!s.audio) {
          discardPending(sound);
          dispatchEvent(s, this as AsObject, s.event("complete"));
          return;
        }

        sound.clip = s.audio.decode(bytes);
        for (const channel of channels.get(s) ?? []) {
          const state = channel.$channel as ChannelState;
          if (state.sound === sound && !state.stopped) {
            startAudio(state);
          }
        }

        const completed = sound.clip.then(
          (clip) => {
            sound.length = clip.durationMs;
            s.loads.deferHostEvent(() => {
              if (sound.generation === generation) {
                dispatchEvent(s, this as AsObject, s.event("complete"));
              }
            });
          },
          () => {
            discardPending(sound);
            s.loads.deferHostEvent(() => {
              if (sound.generation === generation) {
                dispatchEvent(
                  s,
                  this as AsObject,
                  s.rt.construct(
                    s.rt.classNamed("flash.events::IOErrorEvent"),
                    "ioError",
                    false,
                    false,
                    s.loads.streamError(url, local),
                  ) as AsObject,
                );
              }
            });
          },
        );
        s.loads.trackRequest(completed);
      });
    }

    get url(): string | null {
      return stateOf(this as AsObject).url;
    }

    get isURLInaccessible(): boolean {
      return false;
    }

    get length(): number {
      return stateOf(this as AsObject).length;
    }

    get isBuffering(): boolean {
      return false;
    }

    get bytesLoaded(): number {
      return stateOf(this as AsObject).loaded;
    }

    get bytesTotal(): number {
      return stateOf(this as AsObject).total;
    }

    get id3(): null {
      return null;
    }

    close(): void {
      const sound = stateOf(this as AsObject);
      sound.abort?.abort();
      sound.abort = null;
      sound.generation++;
      discardPending(sound);
    }

    play(startTime: Value, loops: Value, transform: Value): Value {
      const sound = stateOf(this as AsObject);
      if (!sound.character && !sound.bytes && !sound.abort) {
        return null;
      }

      const start = Math.max(0, s.rt.toNumber(startTime) || 0);
      if (sound.length > 0 && start >= sound.length) {
        return null;
      }

      // Past Flash's 32 channels play gives none, as Ruffle's start_sound does.
      if (liveSounds(s) >= MAX_SOUNDS) {
        return null;
      }

      const channel = s.rt.construct(s.rt.classNamed("flash.media::SoundChannel")) as AsObject;
      const state: ChannelState = {
        sound,
        started: s.timers.now,
        start,
        loops: Math.max(0, s.rt.toInt(loops)),
        mix: channelMix(mixOf(transform as AsObject | null)),
        playing: null,
        stopped: false,
        stoppedAt: 0,
      };
      channel.$channel = state;
      let active = channels.get(s);
      if (!active) {
        active = new Set();
        channels.set(s, active);
      }

      active.add(channel);
      startAudio(state);

      return channel;
    }
  }

  class SoundChannelNatives {
    declare $channel: ChannelState | undefined;

    get position(): number {
      const state = this.$channel;
      return state ? positionOf(s, state) : 0;
    }

    get soundTransform(): AsObject {
      return transformOf(s, this.$channel?.mix ?? mixOf(null));
    }

    set soundTransform(value: Value) {
      const state = this.$channel;
      if (state) {
        state.mix = channelMix(mixOf(value as AsObject | null));
        state.playing?.setMix(outputMix(state.mix, mixerMix(s)));
      }
    }

    get leftPeak(): number {
      return 0;
    }

    get rightPeak(): number {
      return 0;
    }

    stop(): void {
      const state = this.$channel;
      if (state && !state.stopped) {
        stopChannel(s, state);
        channels.get(s)?.delete(this as AsObject);
      }
    }
  }

  avm2.registerNativeClass(natives, "flash.media::Sound", SoundNatives);
  avm2.registerNativeClass(natives, "flash.media::SoundChannel", SoundChannelNatives);
  return natives;
}

export function soundHooks(s: Scripting): Record<string, avm2.ClassHook> {
  return {
    "flash.media::Sound": {
      create: (traits) => {
        const o = Object.create(traits.proto);
        const character = s.symbols.soundSymbol(traits);
        const data = character?.definition;
        o.$sound = {
          character,
          bytes: null,
          url: null,
          loaded: data?.data.length ?? 0,
          total: data?.data.length ?? 0,
          // In samples a millisecond, to adl's last bit.
          length: data ? data.sampleCount / (data.sampleRate / 1000) : 0,
          used: !!data,
          generation: 0,
          abort: null,
          clip: null,
          compressed: false,
          pcm: null,
          extracted: 0,
        } satisfies SoundState;
        return o;
      },
    },
  };
}
