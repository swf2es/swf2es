// What Flash reads of MP3 bytes before it decodes them: its frames, by
// their headers, past ID3v2 tags and other bytes between them. Flash
// counts a frame the bytes cut short in a sound's length but decodes only
// whole frames, and decodes a Xing, Info or VBRI frame as a frame of
// silence like any other (adl, the sound-extract case), where a browser's
// decoder reads it to trim the encoder's delay and padding. A header is
// trusted as the start of a run only with the next two frames' headers
// where it says they are, as decoders find their way into a stream, so
// that bytes that happen to look like one, in a tag or another format,
// are passed over.

/** Kilobits a second by bitrate index: MPEG-1 Layer III, then MPEG-2 and 2.5. */
const BITRATES = [
  [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
];

/** Rates by index for MPEG-2.5, (reserved), MPEG-2 and MPEG-1, as the version bits number them. */
const RATES = [[11025, 12000, 8000], [], [22050, 24000, 16000], [44100, 48000, 32000]];

/** How many headers in a row, the first included, make a run. */
const RUN = 3;

export interface Mp3Frames {
  rate: number;
  channels: 1 | 2;
  samplesPerFrame: number;
  /** Frames whole and cut short, as Sound.length counts them. */
  frames: number;
  /** Where each whole frame starts and ends, in pairs. */
  whole: number[];
  /** Where reading goes on from with more bytes: after the last whole frame. */
  end: number;
  /** The first frame's bytes when it is a Xing, Info or VBRI header, which a browser would trim by. */
  header: [number, number] | null;
}

interface Header {
  version: number;
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
    version,
    rate,
    channels: bytes[at + 3] >> 6 === 3 ? 1 : 2,
    samples: mpeg1 ? 1152 : 576,
    length: Math.floor(((mpeg1 ? 144 : 72) * kbps * 1000) / rate) + padding,
    mpeg1,
  };
}

/** A header of the stream's kind at `at`: its version, rate and channels those of `like`. */
function frameAt(bytes: Uint8Array, at: number, like: Header | null): Header | null {
  const h = header(bytes, at);
  if (
    !h ||
    (like && (h.version !== like.version || h.rate !== like.rate || h.channels !== like.channels))
  ) {
    return null;
  }

  return h;
}

/** A header at `at` the next frames' headers follow, as many as the bytes hold up to a run. */
function runAt(bytes: Uint8Array, at: number, like: Header | null): Header | null {
  const first = frameAt(bytes, at, like);
  let next = first ? at + first.length : 0;
  for (let k = 1; first && k < RUN && next + 4 <= bytes.length; k++) {
    const h = frameAt(bytes, next, first);
    if (!h) {
      return null;
    }

    next += h.length;
  }

  return first;
}

/** The length of an ID3v2 tag at `at`, header, body and footer, or 0 for none. */
function id3Length(bytes: Uint8Array, at: number): number {
  if (
    at + 10 > bytes.length ||
    bytes[at] !== 0x49 ||
    bytes[at + 1] !== 0x44 ||
    bytes[at + 2] !== 0x33 ||
    (bytes[at + 6] | bytes[at + 7] | bytes[at + 8] | bytes[at + 9]) & 0x80
  ) {
    return 0;
  }

  // Its size in seven-bit bytes.
  const size = (bytes[at + 6] << 21) | (bytes[at + 7] << 14) | (bytes[at + 8] << 7) | bytes[at + 9];
  return 10 + size + (bytes[at + 5] & 0x10 ? 10 : 0);
}

/** The next run of frames from `at`, past tags and anything else, and where it starts; null for none. */
function nextRun(bytes: Uint8Array, at: number, like: Header | null): [number, Header] | null {
  for (let p = at; p + 4 <= bytes.length; ) {
    const tag = id3Length(bytes, p);
    if (tag) {
      p += tag;
      continue;
    }

    const h = runAt(bytes, p, like);
    if (h) {
      return [p, h];
    }

    p++;
  }

  return null;
}

/**
 * The frames of MP3 bytes, or null for bytes with none. Given what it read
 * of the bytes before more came after them, it reads on from there.
 */
export function mp3Frames(bytes: Uint8Array, before: Mp3Frames | null = null): Mp3Frames | null {
  const like = before?.whole.length ? header(bytes, before.whole[0]) : null;
  if (!like) {
    const run = nextRun(bytes, 0, null);
    return run ? readFrames(bytes, run[0], run[1], [], null) : null;
  }

  return readFrames(bytes, before?.end ?? 0, like, before?.whole ?? [], before?.header ?? null);
}

function readFrames(
  bytes: Uint8Array,
  from: number,
  like: Header,
  before: number[],
  headerFrame: [number, number] | null,
): Mp3Frames {
  const whole = before.slice();
  let frames = whole.length / 2;
  let at = from;
  let end = from;
  while (at + 4 <= bytes.length) {
    let h = frameAt(bytes, at, like);
    if (!h) {
      const run = nextRun(bytes, at, like);
      if (!run) {
        break;
      }

      [at, h] = run;
    }

    frames++;
    if (at + h.length > bytes.length) {
      break;
    }

    whole.push(at, at + h.length);
    at += h.length;
    end = at;
  }

  const first = before.length ? null : whole[0];
  return {
    rate: like.rate,
    channels: like.channels,
    samplesPerFrame: like.samples,
    frames,
    whole,
    end,
    header:
      first === undefined || first === null
        ? headerFrame
        : isHeaderFrame(bytes, first, like)
          ? [first, whole[1]]
          : null,
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

/** The whole frames of MP3 bytes back to back, all else left out, a Xing, Info or VBRI header too. */
export function mp3Bytes(bytes: Uint8Array, mp3: Mp3Frames): Uint8Array<ArrayBuffer> {
  const from = mp3.header ? 2 : 0;
  let size = 0;
  for (let i = from; i < mp3.whole.length; i += 2) {
    size += mp3.whole[i + 1] - mp3.whole[i];
  }

  const out = new Uint8Array(size);
  let at = 0;
  for (let i = from; i < mp3.whole.length; i += 2) {
    out.set(bytes.subarray(mp3.whole[i], mp3.whole[i + 1]), at);
    at += mp3.whole[i + 1] - mp3.whole[i];
  }

  return out;
}
