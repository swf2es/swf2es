// The sounds the player plays: the timeline's own, which no script sees
// (StartSound, a clip's stream, a button's), and the channels a script's
// Sound opens, all held to Flash's 32 at once, mixed under the mixer's
// transform, and finished with the frame. playerglobal's Sound and
// SoundMixer are their AS3 side.
import type { SoundInfo, StartSound } from "@swf2es/format";
import type { avm2 } from "@swf2es/runtime";
import type { DisplayObject, MovieClip } from "../display/display.js";
import type { Library, SoundCharacter, SoundStream, TimelineSounds } from "../display/timeline.js";
import { dispatchEvent } from "../scripting/events.js";
import type { Scripting } from "../scripting.js";
import {
  type DecodedSound,
  type PlayingSound,
  type PlayShape,
  type SoundMix,
  streamSound,
} from "./audio.js";
import type { Mp3Frames } from "./mp3.js";

type AsObject = avm2.AsObject;

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
}

const timelineSounds = new WeakMap<Scripting, Set<TimelineSound>>();

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
  let n = 0;
  for (const channel of channels.get(s) ?? []) {
    if ((channel.$channel as ChannelState).sound.length > 0) {
      n++;
    }
  }

  for (const sound of timelineSounds.get(s) ?? []) {
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
  const task = s.symbols.soundClip(character);
  if (!task || liveSounds(s) >= MAX_SOUNDS) {
    return null;
  }

  const sound: TimelineSound = {
    owner,
    character,
    clip,
    started: s.timers.now,
    duration,
    playing: null,
    stopped: false,
    decoding: true,
    endedAt: null,
  };
  let active = timelineSounds.get(s);
  if (!active) {
    active = new Set();
    timelineSounds.set(s, active);
  }

  active.add(sound);
  void task.then(
    (decoded) => {
      sound.decoding = false;
      // A stream whose decode took frames starts as far in as the clock has
      // run, to keep with its timeline; an event sound plays whole, late.
      const late = Math.max(0, s.timers.now - sound.started);
      if (!sound.stopped && (!clip || late < sound.duration)) {
        sound.playing = decoded.play(
          start,
          loops,
          timelineMix(s, owner),
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

  // The last moments of its stream before, over by the clock, give way to this one.
  for (const sound of [...(timelineSounds.get(s) ?? [])]) {
    if (sound.clip === clip) {
      stopTimelineSound(s, sound);
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
      clip.stream = null;
      for (const sound of [...(timelineSounds.get(s) ?? [])]) {
        if (sound.clip === clip) {
          stopTimelineSound(s, sound);
        }
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

/** Sound completions run with the next SWF frame, even if the device ended between frames. */
export function finishSounds(s: Scripting): void {
  // A timeline sound that has played its time is over: a NoMultiple may start
  // it again, and its clip's stream at the next block.
  for (const sound of [...(timelineSounds.get(s) ?? [])]) {
    if (sound.endedAt === null && s.timers.now - sound.started >= sound.duration) {
      sound.endedAt = s.timers.now;
      if (sound.clip?.stream === sound) {
        sound.clip.stream = null;
      }
    } else if (sound.endedAt !== null && !onDevice(sound)) {
      stopTimelineSound(s, sound);
    } else if (
      sound.endedAt !== null &&
      sound.playing?.ended === undefined &&
      s.timers.now - sound.endedAt >= TAIL
    ) {
      stopTimelineSound(s, sound);
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
    if (s.timers.now - state.started < duration) {
      continue;
    }

    stopChannel(s, state);
    active.delete(channel);
    dispatchEvent(s, channel, s.event("soundComplete"));
  }
}
