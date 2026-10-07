// What Flash reads of MP3 bytes before it decodes them: its frames, by
// their headers, after any ID3v2 tag. Flash counts a frame the bytes cut
// short in a sound's length but decodes only whole frames, and decodes a
// Xing, Info or VBRI frame as a frame of silence like any other (adl, the
// sound-extract case), where a browser's decoder reads it to trim the
// encoder's delay and padding.

/** Kilobits a second by bitrate index: MPEG-1 Layer III, then MPEG-2 and 2.5. */
const BITRATES = [
  [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
];

/** Rates by index for MPEG-2.5, (reserved), MPEG-2 and MPEG-1, as the version bits number them. */
const RATES = [[11025, 12000, 8000], [], [22050, 24000, 16000], [44100, 48000, 32000]];

export interface Mp3Frames {
  rate: number;
  channels: 1 | 2;
  samplesPerFrame: number;
  /** Frames whole and cut short, as Sound.length counts them. */
  frames: number;
  /** Where the first frame starts, and where the last whole one ends. */
  start: number;
  end: number;
  /** The first frame's bytes when it is a Xing, Info or VBRI header, which a browser would trim by. */
  header: [number, number] | null;
}

interface Header {
  rate: number;
  channels: 1 | 2;
  samples: number;
  length: number;
  mpeg1: boolean;
}

function header(bytes: Uint8Array, at: number): Header | null {
  if (at + 4 > bytes.length || bytes[at] !== 0xff || (bytes[at + 1] & 0xe0) !== 0xe0) {
    return null;
  }

  const version = (bytes[at + 1] >> 3) & 3;
  const layer = (bytes[at + 1] >> 1) & 3;
  const bitrate = bytes[at + 2] >> 4;
  const rateIndex = (bytes[at + 2] >> 2) & 3;
  if (version === 1 || layer !== 1 || bitrate === 0 || bitrate === 15 || rateIndex === 3) {
    return null;
  }

  const mpeg1 = version === 3;
  const rate = RATES[version][rateIndex];
  const padding = (bytes[at + 2] >> 1) & 1;
  const kbps = BITRATES[mpeg1 ? 0 : 1][bitrate];
  return {
    rate,
    channels: bytes[at + 3] >> 6 === 3 ? 1 : 2,
    samples: mpeg1 ? 1152 : 576,
    length: Math.floor(((mpeg1 ? 144 : 72) * kbps * 1000) / rate) + padding,
    mpeg1,
  };
}

/** Whether the frame at `at` is a Xing, Info or VBRI header rather than sound. */
function isHeaderFrame(bytes: Uint8Array, at: number, h: Header): boolean {
  const tag = (offset: number) =>
    String.fromCharCode(...bytes.subarray(at + offset, at + offset + 4));
  const side = h.mpeg1 ? (h.channels === 1 ? 17 : 32) : h.channels === 1 ? 9 : 17;
  const xing = tag(4 + side);
  return xing === "Xing" || xing === "Info" || tag(36) === "VBRI";
}

/** The frames of MP3 bytes, or null for bytes with none. */
export function mp3Frames(bytes: Uint8Array): Mp3Frames | null {
  let at = 0;
  if (bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33 && bytes.length >= 10) {
    // ID3v2: a ten-byte header, its size in seven-bit bytes, and a footer if flagged.
    const size = (bytes[6] << 21) | (bytes[7] << 14) | (bytes[8] << 7) | bytes[9];
    at = 10 + size + (bytes[5] & 0x10 ? 10 : 0);
  }

  let first = header(bytes, at);
  while (!first && at + 4 < bytes.length) {
    at++;
    first = header(bytes, at);
  }

  if (!first) {
    return null;
  }

  const start = at;
  let frames = 0;
  let end = start;
  for (let h: Header | null = first; h; h = header(bytes, at)) {
    frames++;
    at += h.length;
    if (at > bytes.length) {
      break;
    }

    end = at;
  }

  return {
    rate: first.rate,
    channels: first.channels,
    samplesPerFrame: first.samples,
    frames,
    start,
    end,
    header: isHeaderFrame(bytes, start, first) ? [start, start + first.length] : null,
  };
}
