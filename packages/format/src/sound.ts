// DefineSound's header and encoded samples. Decoding belongs to the player,
// where a host can supply an audio device.
import { SwfReader, type Tag } from "./swf.js";

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

export function readSound(bytes: Uint8Array, tag: Tag): Sound {
  const r = new SwfReader(bytes, tag.offset, tag.offset + tag.length);
  const id = r.u16();
  const flags = r.u8();
  const format = flags >> 4;
  const sampleRate = [5512.5, 11025, 22050, 44100][(flags >> 2) & 3];
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
