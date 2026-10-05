// DefineSound's header and encoded samples, and the tags that play sounds
// from a timeline: StartSound and StartSound2, the stream of
// SoundStreamHead and SoundStreamBlock, and DefineButtonSound. Decoding
// belongs to the player, where a host can supply an audio device.
import { readString } from "./display.js";
import { SwfReader, type Tag } from "./swf.js";
import { StartSound2 } from "./tags.js";

export interface Sound {
  id: number;
  format: number;
  sampleRate: number;
  sampleSize: 8 | 16;
  channels: 1 | 2;
  sampleCount: number;
  /** For MP3, the signed sample offset at the front of SoundData. */
  seekSamples: number;
  data: Uint8Array;
}

const RATES = [5512.5, 11025, 22050, 44100];

export function readSound(bytes: Uint8Array, tag: Tag): Sound {
  const r = new SwfReader(bytes, tag.offset, tag.offset + tag.length);
  const id = r.u16();
  const flags = r.u8();
  const format = flags >> 4;
  const sampleRate = RATES[(flags >> 2) & 3];
  const sampleSize = (flags & 2) === 0 ? 8 : 16;
  const channels = (flags & 1) === 0 ? 1 : 2;
  const sampleCount = r.u32();
  const seekSamples = format === 2 ? r.s16() : 0;
  return {
    id,
    format,
    sampleRate,
    sampleSize,
    channels,
    sampleCount,
    seekSamples,
    data: bytes.subarray(r.pos, tag.offset + tag.length),
  };
}

/** A point of SOUNDINFO's envelope: its sample at 44.1 kHz from the start, and each channel's level, 0 to 1. */
export interface SoundEnvelopePoint {
  sample: number;
  left: number;
  right: number;
}

/** SOUNDINFO: how StartSound, StartSound2 and DefineButtonSound play a sound. */
export interface SoundInfo {
  /** SyncStop: stop the sound wherever it plays, and start none. */
  stop: boolean;
  /** SyncNoMultiple: start none while the sound plays. */
  noMultiple: boolean;
  /** Where each loop starts and ends, in samples at 44.1 kHz; null for the sound's own. */
  inPoint: number | null;
  outPoint: number | null;
  /** 1 without HasLoops. */
  loops: number;
  envelope: SoundEnvelopePoint[] | null;
}

export function readSoundInfo(r: SwfReader): SoundInfo {
  const flags = r.u8();
  const inPoint = flags & 0x01 ? r.u32() : null;
  const outPoint = flags & 0x02 ? r.u32() : null;
  const loops = flags & 0x04 ? r.u16() : 1;
  let envelope: SoundEnvelopePoint[] | null = null;
  if (flags & 0x08) {
    envelope = [];
    for (let n = r.u8(); n > 0 && !r.overrun; n--) {
      envelope.push({ sample: r.u32(), left: r.u16() / 32768, right: r.u16() / 32768 });
    }
  }

  return {
    stop: (flags & 0x20) !== 0,
    noMultiple: (flags & 0x10) !== 0,
    inPoint,
    outPoint,
    loops,
    envelope,
  };
}

/** StartSound names its sound by id, StartSound2 by the class bound to it. */
export interface StartSound {
  id: number | null;
  className: string | null;
  info: SoundInfo;
}

export function readStartSound(bytes: Uint8Array, tag: Tag): StartSound {
  const r = new SwfReader(bytes, tag.offset, tag.offset + tag.length);
  if (tag.code === StartSound2) {
    const className = readString(r);
    return { id: null, className, info: readSoundInfo(r) };
  }

  const id = r.u16();
  return { id, className: null, info: readSoundInfo(r) };
}

/** SoundStreamHead or SoundStreamHead2: the format of a timeline's SoundStreamBlocks. */
export interface SoundStreamHead {
  format: number;
  sampleRate: number;
  sampleSize: 8 | 16;
  channels: 1 | 2;
  /** The samples each frame's block holds, on average. */
  samplesPerBlock: number;
}

export function readSoundStreamHead(bytes: Uint8Array, tag: Tag): SoundStreamHead {
  const r = new SwfReader(bytes, tag.offset, tag.offset + tag.length);
  // The playback format is only a hint; the stream's own follows it.
  r.u8();
  const flags = r.u8();
  return {
    format: flags >> 4,
    sampleRate: RATES[(flags >> 2) & 3],
    sampleSize: (flags & 2) === 0 ? 8 : 16,
    channels: (flags & 1) === 0 ? 1 : 2,
    samplesPerBlock: r.u16(),
  };
}

/** A SoundStreamBlock's samples: for MP3, the frames after its sample count and seek. */
export interface SoundStreamBlock {
  /** MP3's own count; null for the other formats, whose bytes tell it. */
  sampleCount: number | null;
  data: Uint8Array;
}

export function readSoundStreamBlock(
  bytes: Uint8Array,
  tag: Tag,
  format: number,
): SoundStreamBlock {
  const end = tag.offset + tag.length;
  if (format !== 2) {
    return { sampleCount: null, data: bytes.subarray(tag.offset, end) };
  }

  const r = new SwfReader(bytes, tag.offset, end);
  const sampleCount = r.u16();
  return { sampleCount, data: bytes.subarray(Math.min(end, tag.offset + 4), end) };
}

/**
 * DefineButtonSound: the sounds a button plays as its state changes, in
 * the tag's order: over to up, up to over, over to down, down to over.
 * Some tools write fewer than four, as Ruffle notes; the missing are none.
 */
export interface ButtonSounds {
  id: number;
  sounds: ({ id: number; info: SoundInfo } | null)[];
}

export function readButtonSound(bytes: Uint8Array, tag: Tag): ButtonSounds {
  const r = new SwfReader(bytes, tag.offset, tag.offset + tag.length);
  const id = r.u16();
  const sounds: ButtonSounds["sounds"] = [];
  for (let i = 0; i < 4; i++) {
    const sound = r.pos + 2 <= r.end ? r.u16() : 0;
    sounds.push(sound === 0 ? null : { id: sound, info: readSoundInfo(r) });
  }

  return { id, sounds };
}
