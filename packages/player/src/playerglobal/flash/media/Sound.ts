// flash.media.Sound and SoundChannel: a SWF's embedded sound or a host-fetched
// MP3, with playback through the host's audio device and frame-delivered events;
// and the timeline's own sounds, which no script sees: StartSound, the stream,
// and a button's.
import type { SoundInfo, StartSound } from "@swf2es/format";
import { avm2 } from "@swf2es/runtime";
import {
  type DecodedSound,
  type PlayingSound,
  type PlayShape,
  type SoundMix,
  streamSound,
} from "../../../audio.js";
import type { DisplayObject, MovieClip } from "../../../display.js";
import type { Scripting } from "../../../scripting.js";
import type { Library, SoundCharacter, SoundStream, TimelineSounds } from "../../../timeline.js";
import { dispatchEvent } from "../events/EventDispatcher.js";

type AsObject = avm2.AsObject;
type Value = avm2.Value;

interface SoundState {
  character: SoundCharacter | null;
  bytes: Uint8Array | null;
  url: string | null;
  loaded: number;
  total: number;
  length: number;
  used: boolean;
  generation: number;
  abort: AbortController | null;
  clip: Promise<DecodedSound> | null;
}

interface ChannelState {
  sound: SoundState;
  started: number;
  start: number;
  loops: number;
  mix: SoundMix;
  playing: PlayingSound | null;
  stopped: boolean;
  /** Where a stopped channel's position stays. */
  stoppedAt: number;
}

const channels = new WeakMap<Scripting, Set<AsObject>>();

/** SoundMixer's transform, applied over every channel's own. */
const mixerMixes = new WeakMap<Scripting, SoundMix>();

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

export const mixOf = (o: AsObject | null): SoundMix => ({
  volume: o?.$soundVolume ?? 1,
  leftToLeft: o?.$soundLeftToLeft ?? 1,
  leftToRight: o?.$soundLeftToRight ?? 0,
  rightToLeft: o?.$soundRightToLeft ?? 0,
  rightToRight: o?.$soundRightToRight ?? 1,
});

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

/**
 * What a channel sends to the device: its own transform and the mixer's,
 * combined as Ruffle's SoundTransform::concat computes them. Only
 * transforms that both cross channels depend on the order, which no trace
 * can show; Ruffle's is kept.
 */
export function outputMix(local: SoundMix, global: SoundMix): SoundMix {
  return {
    volume: Math.abs(local.volume * global.volume),
    leftToLeft: local.leftToLeft * global.leftToLeft + local.rightToLeft * global.leftToRight,
    leftToRight: local.leftToRight * global.leftToLeft + local.rightToRight * global.leftToRight,
    rightToLeft: local.leftToLeft * global.rightToLeft + local.rightToLeft * global.rightToRight,
    rightToRight: local.leftToRight * global.rightToLeft + local.rightToRight * global.rightToRight,
  };
}

const mixerMix = (s: Scripting): SoundMix => mixerMixes.get(s) ?? mixOf(null);

const positionOf = (s: Scripting, state: ChannelState): number =>
  state.stopped
    ? state.stoppedAt
    : Math.min(state.sound.length, state.start + Math.max(0, s.now - state.started));

function stopChannel(s: Scripting, state: ChannelState): void {
  state.stoppedAt = positionOf(s, state);
  state.stopped = true;
  state.playing?.stop();
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

/**
 * SoundMixer.stopAll: every channel stays where it was, and none completes;
 * the timeline's sounds stop too, though a stream starts again at the next
 * block its clip plays on to, as Ruffle has it.
 */
export function stopAllSounds(s: Scripting): void {
  const active = channels.get(s);
  for (const channel of active ?? []) {
    stopChannel(s, channel.$channel as ChannelState);
  }

  active?.clear();
  for (const sound of [...(timelineSounds.get(s) ?? [])]) {
    stopTimelineSound(s, sound);
  }
}

/** A sound the timeline started: an event sound, a button's, or a clip's stream. */
interface TimelineSound {
  owner: DisplayObject;
  character: SoundCharacter;
  /** The clip whose stream it is; null for an event sound. */
  clip: MovieClip | null;
  started: number;
  /** How long it plays, all loops, by the player's clock. */
  duration: number;
  playing: PlayingSound | null;
  stopped: boolean;
}

const timelineSounds = new WeakMap<Scripting, Set<TimelineSound>>();

/** SOUNDINFO's points and envelope are in samples at 44.1 kHz, whatever the sound's rate. */
const ENVELOPE_RATE = 44.1;

/**
 * What a timeline sound sends to the device: the transforms of its owner
 * and each ancestor, then the mixer's, concatenated as Ruffle's
 * transform_for_sound does. A sprite's is its soundTransform; a button's
 * is the mixer's, so it has none of its own.
 */
function timelineMix(s: Scripting, owner: DisplayObject): SoundMix {
  let mix = mixOf(null);
  for (let o: DisplayObject | null = owner; o; o = o.parent) {
    const own: SoundMix | undefined = o.object?.$soundMix;
    if (own) {
      mix = outputMix(mix, own);
    }
  }

  return outputMix(mix, mixerMix(s));
}

/** A sprite's transform or the mixer's changed: every timeline sound's mix follows. */
export function updateTimelineMixes(s: Scripting): void {
  for (const sound of timelineSounds.get(s) ?? []) {
    sound.playing?.setMix(timelineMix(s, sound.owner));
  }
}

function stopTimelineSound(s: Scripting, sound: TimelineSound): void {
  sound.stopped = true;
  sound.playing?.stop();
  timelineSounds.get(s)?.delete(sound);
  if (sound.clip?.stream === sound) {
    sound.clip.stream = null;
  }
}

function playTimelineSound(
  s: Scripting,
  owner: DisplayObject,
  character: SoundCharacter,
  clip: MovieClip | null,
  start: number,
  loops: number,
  shape: PlayShape,
  duration: number,
): TimelineSound | null {
  const task = s.soundClip(character);
  if (!task) {
    return null;
  }

  const sound: TimelineSound = {
    owner,
    character,
    clip,
    started: s.now,
    duration,
    playing: null,
    stopped: false,
  };
  let active = timelineSounds.get(s);
  if (!active) {
    active = new Set();
    timelineSounds.set(s, active);
  }

  active.add(sound);
  void task.then(
    (decoded) => {
      if (!sound.stopped) {
        sound.playing = decoded.play(start, loops, timelineMix(s, owner), shape);
      }
    },
    () => {},
  );
  return sound;
}

/**
 * An event sound, as StartSound and a button start one: SyncStop stops
 * every instance of the sound the timeline started, SyncNoMultiple starts
 * none while one plays, and otherwise it plays from its in point to its
 * out point, as many loops as it says, under its envelope. AS3's channels
 * of the sound are left be: adl plays one on through a SyncStop of it.
 */
function startEventSound(
  s: Scripting,
  owner: DisplayObject,
  character: SoundCharacter,
  info: SoundInfo,
): void {
  const active = timelineSounds.get(s);
  if (info.stop) {
    for (const sound of [...(active ?? [])]) {
      if (sound.character === character) {
        stopTimelineSound(s, sound);
      }
    }

    return;
  }

  if (info.noMultiple && active && [...active].some((sound) => sound.character === character)) {
    return;
  }

  const definition = character.definition;
  const length = (definition.sampleCount * 1000) / definition.sampleRate;
  const start = (info.inPoint ?? 0) / ENVELOPE_RATE;
  const end = info.outPoint === null ? length : Math.min(length, info.outPoint / ENVELOPE_RATE);
  const loops = Math.max(1, info.loops);
  const shape: PlayShape = {};
  if (info.outPoint !== null) {
    shape.endMs = end;
  }

  if (info.envelope) {
    shape.envelope = info.envelope.map((point) => ({
      ms: point.sample / ENVELOPE_RATE,
      left: point.left,
      right: point.right,
    }));
  }

  playTimelineSound(
    s,
    owner,
    character,
    null,
    start,
    loops,
    shape,
    Math.max(0, end - start) * loops,
  );
}

/** The DefineSound a StartSound names, by id or, for StartSound2, by the class bound to it. */
function startSoundCharacter(library: Library, start: StartSound): SoundCharacter | null {
  let id = start.id;
  if (start.className !== null) {
    const dot = start.className.lastIndexOf(".");
    const name =
      dot < 0
        ? start.className
        : `${start.className.slice(0, dot)}::${start.className.slice(dot + 1)}`;
    id = null;
    for (const [bound, className] of library.classes) {
      if (className === name) {
        id = bound;
        break;
      }
    }
  }

  const character = id === null ? undefined : library.characters.get(id);
  return character?.type === "sound" ? character : null;
}

/** A stream's blocks made one sound on its first play, shared by every clip of its timeline. */
function streamOf(stream: SoundStream): NonNullable<SoundStream["sound"]> {
  if (!stream.sound) {
    const { sound, starts } = streamSound(stream.head, stream.blocks);
    stream.sound = { character: { type: "sound", id: 0, definition: sound }, starts };
  }

  return stream.sound;
}

/**
 * The block on `frame` of a playing clip with no stream playing starts it
 * from there, as Ruffle's sound_stream_block does, to the end of the run of
 * frames with blocks after it, where Ruffle's stream ends; MP3's runs on
 * over gaps, to its last block. It keeps on as the clip plays on; Flash's
 * skipping of frames to keep the timeline with it is not done.
 */
function startStream(s: Scripting, clip: MovieClip, stream: SoundStream, frame: number): void {
  const block = stream.byFrame.get(frame);
  if (block === undefined || !clip.playing || clip.stream) {
    return;
  }

  // What the timeline took off plays the frame it went in, but its streams no more.
  let top: DisplayObject = clip;
  while (top.parent) {
    top = top.parent;
  }

  if (unloaded.get(top) === s.frames) {
    return;
  }

  const { character, starts } = streamOf(stream);
  let last = block + 1;
  if (stream.head.format === 2) {
    last = stream.blocks.length;
  } else {
    while (stream.byFrame.get(frame + last - block) === last) {
      last++;
    }
  }

  const rate = character.definition.sampleRate;
  const start = (starts[block] * 1000) / rate;
  const end = (starts[last] * 1000) / rate;
  clip.stream = playTimelineSound(s, clip, character, clip, start, 1, { endMs: end }, end - start);
}

/** What the timeline took off, by the frame it did. */
const unloaded = new WeakMap<DisplayObject, number>();

/** Whether `inner` is `outer` or under it. */
function within(inner: DisplayObject, outer: DisplayObject): boolean {
  for (let o: DisplayObject | null = inner; o; o = o.parent) {
    if (o === outer) {
      return true;
    }
  }

  return false;
}

/** unloadAndStop: the sounds of the timelines under `display` stop, its event sounds too. */
export function stopTimelineSoundsUnder(s: Scripting, display: DisplayObject): void {
  for (const sound of [...(timelineSounds.get(s) ?? [])]) {
    if (within(sound.owner, display)) {
      stopTimelineSound(s, sound);
    }
  }
}

/** What plays the timelines' sounds of every library a Scripting loads. */
export function timelineSoundsOf(s: Scripting): TimelineSounds {
  return {
    frame(clip, frame) {
      if (!s.audio) {
        return;
      }

      const timeline = clip.timeline;
      for (const start of timeline.sounds.get(frame) ?? []) {
        const character = startSoundCharacter(clip.library, start);
        if (character) {
          startEventSound(s, clip, character, start.info);
        }
      }

      if (timeline.stream) {
        startStream(s, clip, timeline.stream, frame);
      }
    },
    stopStream(clip) {
      const sound = clip.stream as TimelineSound | null;
      clip.stream = null;
      if (sound) {
        stopTimelineSound(s, sound);
      }
    },
    start(owner, library, id, info) {
      const character = library.characters.get(id);
      if (s.audio && character?.type === "sound") {
        startEventSound(s, owner, character, info);
      }
    },
    removed(display) {
      if (!s.audio) {
        return;
      }

      unloaded.set(display, s.frames);
      for (const sound of [...(timelineSounds.get(s) ?? [])]) {
        if (sound.clip && within(sound.clip, display)) {
          stopTimelineSound(s, sound);
        }
      }
    },
  };
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

/** Sound completions run with the next SWF frame, even if the device ended between frames. */
export function finishSounds(s: Scripting): void {
  // A timeline sound that has played its time is over: a NoMultiple may start
  // it again, and its clip's stream at the next block.
  for (const sound of timelineSounds.get(s) ?? []) {
    if (s.now - sound.started >= sound.duration) {
      timelineSounds.get(s)?.delete(sound);
      if (sound.clip?.stream === sound) {
        sound.clip.stream = null;
      }
    }
  }

  const active = channels.get(s);
  if (!active) {
    return;
  }

  for (const channel of active) {
    const state = channel.$channel as ChannelState;
    if (state.stopped || state.sound.length <= 0) {
      continue;
    }

    const duration = (state.sound.length - state.start) * Math.max(1, state.loops);
    if (s.now - state.started < duration) {
      continue;
    }

    stopChannel(s, state);
    active.delete(channel);
    dispatchEvent(s, channel, s.event("soundComplete"));
  }
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
    const task = sound.character ? s.soundClip(sound.character) : sound.clip;
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

      const channel = s.rt.construct(s.rt.classNamed("flash.media::SoundChannel")) as AsObject;
      const state: ChannelState = {
        sound,
        started: s.now,
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
        const character = s.soundSymbol(traits);
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
