// flash.media.Sound and SoundChannel: a SWF's embedded sound or a host-fetched
// MP3, with playback through the host's audio device and frame-delivered
// events; the channels themselves, and the timeline's sounds, are the
// player's (media/sounds.ts).
import { avm2 } from "@swf2es/runtime";
import type { SoundMix } from "../../../media/audio.js";
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

  class SoundNatives {
    declare $sound: SoundState | undefined;

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
      s.requestBytes(request as AsObject, abort.signal, ({ bytes, local }, url) => {
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
              s.streamError(url, local),
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
            s.deferHostEvent(() => {
              if (sound.generation === generation) {
                dispatchEvent(s, this as AsObject, s.event("complete"));
              }
            });
          },
          () => {
            discardPending(sound);
            s.deferHostEvent(() => {
              if (sound.generation === generation) {
                dispatchEvent(
                  s,
                  this as AsObject,
                  s.rt.construct(
                    s.rt.classNamed("flash.events::IOErrorEvent"),
                    "ioError",
                    false,
                    false,
                    s.streamError(url, local),
                  ) as AsObject,
                );
              }
            });
          },
        );
        s.trackRequest(completed);
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
          length: data ? (data.sampleCount * 1000) / data.sampleRate : 0,
          used: !!data,
          generation: 0,
          abort: null,
          clip: null,
        } satisfies SoundState;
        return o;
      },
    },
  };
}
