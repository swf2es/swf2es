// The sounds the player plays: the timeline's own, which no script sees
// (StartSound, a clip's stream, a button's), and the channels a script's
// Sound opens, all held to Flash's 32 at once, mixed under the mixer's
// transform, and finished with the frame. playerglobal's Sound and
// SoundMixer are their AS3 side; AVM1's Sound starts its sounds as the
// timeline does, through a SoundHost of its own.
import type { SoundInfo, StartSound } from "@swf2es/format";
import type { avm2 } from "@swf2es/runtime";
import type { DisplayObject, MovieClip } from "../display/display.js";
import type { Library, SoundCharacter, SoundStream, TimelineSounds } from "../display/timeline.js";
import { dispatchEvent } from "../scripting/events.js";
import type { Scripting } from "../scripting.js";
import {
  type AudioHost,
  type DecodedSound,
  type PlayingSound,
  type PlayShape,
  type SoundMix,
  streamSound,
} from "./audio.js";
import type { Mp3Frames } from "./mp3.js";

type AsObject = avm2.AsObject;

/** What the timeline's sounds play by: an AS3 movie's Scripting, or AVM1's movie. */
export interface SoundHost {
  readonly audio: AudioHost | null;
  /** The player's clock, in ms. */
  readonly now: number;
  /** The SWF frames played: what the timeline took off this frame plays its streams no more. */
  readonly frames: number;
  /** A sound decoded for the device, once; null where there is no device. */
  soundClip(character: SoundCharacter): Promise<DecodedSound> | null;
  /** A display object's own transform, where a script gave it one. */
  ownMix(o: DisplayObject): SoundMix | undefined;
  /** The transform over every sound. */
  readonly mixer: SoundMix;
  /** The channels a script opened that hold a sound, outside the timeline's. */
  scriptSounds(): number;
}

export interface SoundState {
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
  /** The MP3 frames of loadCompressedDataFromByteArray's bytes, read so far. */
  frames: Mp3Frames | null;
  /** Whether `bytes` came from loadCompressedDataFromByteArray, which adds to them. */
  compressed: boolean;
  /** loadPCMFromByteArray's samples, at 44.1 kHz. */
  pcm: Float32Array[] | null;
  /** Where extract goes on from, in the sound's own samples. */
  extracted: number;
}

export interface ChannelState {
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

export const channels = new WeakMap<Scripting, Set<AsObject>>();

/** SoundMixer's transform, applied over every channel's own. */
export const mixerMixes = new WeakMap<Scripting, SoundMix>();

export const mixOf = (o: AsObject | null): SoundMix => ({
  volume: o?.$soundVolume ?? 1,
  leftToLeft: o?.$soundLeftToLeft ?? 1,
  leftToRight: o?.$soundLeftToRight ?? 0,
  rightToLeft: o?.$soundRightToLeft ?? 0,
  rightToRight: o?.$soundRightToRight ?? 1,
});

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

export const mixerMix = (s: Scripting): SoundMix => mixerMixes.get(s) ?? mixOf(null);

const hosts = new WeakMap<Scripting, SoundHost>();

/** An AS3 movie's SoundHost: its device, clock and symbols, its sprites' and SoundMixer's transforms. */
export function soundHostOf(s: Scripting): SoundHost {
  let host = hosts.get(s);
  if (!host) {
    host = {
      get audio() {
        return s.audio;
      },
      get now() {
        return s.timers.now;
      },
      get frames() {
        return s.frames;
      },
      soundClip: (character) => s.symbols.soundClip(character),
      ownMix: (o) => o.object?.$soundMix,
      get mixer() {
        return mixerMix(s);
      },
      scriptSounds() {
        let n = 0;
        for (const channel of channels.get(s) ?? []) {
          if ((channel.$channel as ChannelState).sound.length > 0) {
            n++;
          }
        }

        return n;
      },
    };
    hosts.set(s, host);
  }

  return host;
}

export const positionOf = (s: Scripting, state: ChannelState): number =>
  state.stopped
    ? state.stoppedAt
    : Math.min(state.sound.length, state.start + Math.max(0, s.timers.now - state.started));

export function stopChannel(s: Scripting, state: ChannelState): void {
  state.stoppedAt = positionOf(s, state);
  state.stopped = true;
  state.playing?.stop();
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
  stopTimelineSounds(soundHostOf(s));
}

/** Every sound the timeline, or AVM1's Sound, started stops, none completing. */
export function stopTimelineSounds(h: SoundHost): void {
  for (const sound of [...(timelineSounds.get(h) ?? [])]) {
    stopTimelineSound(h, sound);
  }
}

/** A sound the timeline started: an event sound, a button's, a clip's stream, or AVM1 Sound's. */
export interface TimelineSound {
  /** The display object it plays under, whose transforms it takes; null for AVM1's global Sound. */
  owner: DisplayObject | null;
  character: SoundCharacter;
  /** The clip whose stream it is; null for an event sound. */
  clip: MovieClip | null;
  started: number;
  /** How long it plays, all loops, by the player's clock. */
  duration: number;
  playing: PlayingSound | null;
  stopped: boolean;
  /** Whether its decode is still to come. */
  decoding: boolean;
  /**
   * When the player's clock ran its length, or null while it plays: over,
   * it no longer counts for SyncNoMultiple or its clip's stream, but the
   * device may still play it, later than the clock has it where the page
   * held the device, and a stop still reaches it until the device is done
   * with it (`PlayingSound.ended`), or, for a host that cannot tell, until
   * TAIL has passed and it is stopped for good.
   */
  endedAt: number | null;
  /** What hears that its time has run, with the frame: AVM1's onSoundComplete. */
  onEnd: (() => void) | null;
  /** When it was stopped, by the clock, for AVM1 Sound's position; null while it plays. */
  stoppedAt: number | null;
}

const timelineSounds = new WeakMap<SoundHost, Set<TimelineSound>>();

/** How long a sound over by the clock may still sound on the device before it is stopped. */
const TAIL = 100;

/**
 * The sounds that may play at once, timeline and script alike: Flash's 32
 * channels, Ruffle's AudioManager::MAX_SOUNDS. A timeline sound past them
 * does not start, nor queue on a device that is not yet running.
 */
export const MAX_SOUNDS = 32;

/** Whether the device has, or will have, a timeline sound playing. */
function onDevice(sound: TimelineSound): boolean {
  return (
    sound.endedAt === null || sound.decoding || (!!sound.playing && sound.playing.ended !== true)
  );
}

/**
 * The sounds that hold a channel: a script's whose sound is there to play
 * (one still loading holds none until it can start), and the timeline's
 * the device has or will have.
 */
export function liveSounds(s: Scripting): number {
  return liveSoundsOf(soundHostOf(s));
}

function liveSoundsOf(h: SoundHost): number {
  let n = h.scriptSounds();
  for (const sound of timelineSounds.get(h) ?? []) {
    if (onDevice(sound)) {
      n++;
    }
  }

  return n;
}

/** SOUNDINFO's points and envelope are in samples at 44.1 kHz, whatever the sound's rate. */
const ENVELOPE_RATE = 44.1;

/**
 * What a timeline sound sends to the device: the transforms of its owner
 * and each ancestor, then the mixer's, concatenated as Ruffle's
 * transform_for_sound does. A sprite's is its soundTransform; a button's
 * is the mixer's, so it has none of its own.
 */
function timelineMix(h: SoundHost, owner: DisplayObject | null): SoundMix {
  let mix = mixOf(null);
  for (let o: DisplayObject | null = owner; o; o = o.parent) {
    const own = h.ownMix(o);
    if (own) {
      mix = outputMix(mix, own);
    }
  }

  return outputMix(mix, h.mixer);
}

/** A sprite's transform or the mixer's changed: every timeline sound's mix follows. */
export function updateTimelineMixes(s: Scripting): void {
  updateMixes(soundHostOf(s));
}

export function updateMixes(h: SoundHost): void {
  for (const sound of timelineSounds.get(h) ?? []) {
    sound.playing?.setMix(timelineMix(h, sound.owner));
  }
}

export function stopTimelineSound(h: SoundHost, sound: TimelineSound): void {
  sound.stoppedAt ??= h.now;
  sound.stopped = true;
  sound.playing?.stop();
  timelineSounds.get(h)?.delete(sound);
  if (sound.clip?.stream === sound) {
    sound.clip.stream = null;
  }
}

function playTimelineSound(
  h: SoundHost,
  owner: DisplayObject | null,
  character: SoundCharacter,
  clip: MovieClip | null,
  start: number,
  loops: number,
  shape: PlayShape,
  duration: number,
): TimelineSound | null {
  const task = h.soundClip(character);
  if (!task || liveSoundsOf(h) >= MAX_SOUNDS) {
    return null;
  }

  const sound: TimelineSound = {
    owner,
    character,
    clip,
    started: h.now,
    duration,
    playing: null,
    stopped: false,
    decoding: true,
    endedAt: null,
    onEnd: null,
    stoppedAt: null,
  };
  let active = timelineSounds.get(h);
  if (!active) {
    active = new Set();
    timelineSounds.set(h, active);
  }

  active.add(sound);
  void task.then(
    (decoded) => {
      sound.decoding = false;
      // A stream whose decode took frames starts as far in as the clock has
      // run, to keep with its timeline; an event sound plays whole, late.
      const late = Math.max(0, h.now - sound.started);
      if (!sound.stopped && (!clip || late < sound.duration)) {
        sound.playing = decoded.play(
          start,
          loops,
          timelineMix(h, owner),
          clip ? { ...shape, atMs: late } : shape,
        );
      }
    },
    () => {
      sound.decoding = false;
    },
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
  h: SoundHost,
  owner: DisplayObject,
  character: SoundCharacter,
  info: SoundInfo,
): void {
  const active = timelineSounds.get(h);
  if (info.stop) {
    for (const sound of [...(active ?? [])]) {
      if (sound.character === character) {
        stopTimelineSound(h, sound);
      }
    }

    return;
  }

  if (
    info.noMultiple &&
    active &&
    [...active].some((sound) => sound.character === character && sound.endedAt === null)
  ) {
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
    h,
    owner,
    character,
    null,
    start,
    loops,
    shape,
    Math.max(0, end - start) * loops,
  );
}

/**
 * AVM1's Sound.start: an event sound of `character` from `offset` ms, `loops`
 * times, under `owner`'s transforms (none for the global Sound), whose end
 * `onEnd` hears with the frame; null where it cannot play.
 */
export function startScriptSound(
  h: SoundHost,
  owner: DisplayObject | null,
  character: SoundCharacter,
  offset: number,
  loops: number,
  onEnd: () => void,
): TimelineSound | null {
  const definition = character.definition;
  const length = (definition.sampleCount * 1000) / definition.sampleRate;
  const start = Math.min(length, Math.max(0, offset));
  const sound = playTimelineSound(
    h,
    owner,
    character,
    null,
    start,
    loops,
    {},
    (length - start) * loops,
  );
  if (sound) {
    sound.onEnd = onEnd;
  }

  return sound;
}

/** The sounds playing under exactly `owner`, as AVM1's Sound.stop() of a clip stops them; null for the global Sound's. */
export function soundsOf(h: SoundHost, owner: DisplayObject | null): TimelineSound[] {
  return [...(timelineSounds.get(h) ?? [])].filter((sound) => sound.owner === owner);
}

/** Every sound of `character` stops, whoever started it, as AVM1's Sound.stop(name) does. */
export function stopSoundsOf(h: SoundHost, character: SoundCharacter): void {
  for (const sound of [...(timelineSounds.get(h) ?? [])]) {
    if (sound.character === character) {
      stopTimelineSound(h, sound);
    }
  }
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
function startStream(h: SoundHost, clip: MovieClip, stream: SoundStream, frame: number): void {
  const block = stream.byFrame.get(frame);
  if (block === undefined || !clip.playing || clip.stream) {
    return;
  }

  // What the timeline took off plays the frame it went in, but its streams no more.
  let top: DisplayObject = clip;
  while (top.parent) {
    top = top.parent;
  }

  if (unloaded.get(top) === h.frames) {
    return;
  }

  // The last moments of its stream before, over by the clock, give way to this one.
  for (const sound of [...(timelineSounds.get(h) ?? [])]) {
    if (sound.clip === clip) {
      stopTimelineSound(h, sound);
    }
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
  clip.stream = playTimelineSound(h, clip, character, clip, start, 1, { endMs: end }, end - start);
}

/** What the timeline took off, by the frame it did. */
const unloaded = new WeakMap<DisplayObject, number>();

/** Whether `inner` is `outer` or under it. */
function within(inner: DisplayObject | null, outer: DisplayObject): boolean {
  for (let o: DisplayObject | null = inner; o; o = o.parent) {
    if (o === outer) {
      return true;
    }
  }

  return false;
}

/** unloadAndStop: the sounds of the timelines under `display` stop, its event sounds too. */
export function stopTimelineSoundsUnder(s: Scripting, display: DisplayObject): void {
  const h = soundHostOf(s);
  for (const sound of [...(timelineSounds.get(h) ?? [])]) {
    if (within(sound.owner, display)) {
      stopTimelineSound(h, sound);
    }
  }
}

/** What plays the timelines' sounds of every library a host loads. */
export function timelineSoundsOf(h: SoundHost): TimelineSounds {
  return {
    frame(clip, frame) {
      if (!h.audio) {
        return;
      }

      const timeline = clip.timeline;
      for (const start of timeline.sounds.get(frame) ?? []) {
        const character = startSoundCharacter(clip.library, start);
        if (character) {
          startEventSound(h, clip, character, start.info);
        }
      }

      if (timeline.stream) {
        startStream(h, clip, timeline.stream, frame);
      }
    },
    stopStream(clip) {
      clip.stream = null;
      for (const sound of [...(timelineSounds.get(h) ?? [])]) {
        if (sound.clip === clip) {
          stopTimelineSound(h, sound);
        }
      }
    },
    start(owner, library, id, info) {
      const character = library.characters.get(id);
      if (h.audio && character?.type === "sound") {
        startEventSound(h, owner, character, info);
      }
    },
    removed(display) {
      if (!h.audio) {
        return;
      }

      unloaded.set(display, h.frames);
      for (const sound of [...(timelineSounds.get(h) ?? [])]) {
        if (sound.clip && within(sound.clip, display)) {
          stopTimelineSound(h, sound);
        }
      }
    },
  };
}

/**
 * The timeline's sounds that have played their time are over, with the
 * frame: a NoMultiple may start one again, its clip's stream at the next
 * block, and AVM1 Sound's hears it.
 */
export function finishTimelineSounds(h: SoundHost): void {
  const ended: TimelineSound[] = [];
  for (const sound of [...(timelineSounds.get(h) ?? [])]) {
    if (sound.endedAt === null && h.now - sound.started >= sound.duration) {
      sound.endedAt = h.now;
      if (sound.clip?.stream === sound) {
        sound.clip.stream = null;
      }

      if (sound.onEnd) {
        ended.push(sound);
      }
    } else if (sound.endedAt !== null && !onDevice(sound)) {
      stopTimelineSound(h, sound);
    } else if (
      sound.endedAt !== null &&
      sound.playing?.ended === undefined &&
      h.now - sound.endedAt >= TAIL
    ) {
      stopTimelineSound(h, sound);
    }
  }

  for (const sound of ended) {
    sound.onEnd?.();
  }
}

/** Sound completions run with the next SWF frame, even if the device ended between frames. */
export function finishSounds(s: Scripting): void {
  finishTimelineSounds(soundHostOf(s));
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
    if (s.timers.now - state.started < duration) {
      continue;
    }

    stopChannel(s, state);
    active.delete(channel);
    dispatchEvent(s, channel, s.event("soundComplete"));
  }
}
