// The display list's tags (SWF specification, chapter 3), and the ones that
// tie a SWF's classes to its symbols: PlaceObject 1 to 3, RemoveObject 1
// and 2, FrameLabel, DefineSprite, SymbolClass and DoABC. Filters and clip
// actions are kept as their bytes for now.
import { type ColorTransform, type Matrix, readColorTransform, readMatrix } from "./shape.js";
import { readTags, SwfReader, type Tag } from "./swf.js";
import { DoABC, PlaceObject, PlaceObject3, RemoveObject, RemoveObject2 } from "./tags.js";

/**
 * A place: a new character at a depth, or a move of the one there, with
 * what it sets. Fields it does not set are null or undefined.
 */
export interface Place {
  depth: number;
  /** Whether it changes the character already at the depth, rather than placing one. */
  move: boolean;
  character: number | null;
  matrix: Matrix | null;
  colorTransform: ColorTransform | null;
  ratio: number | null;
  name: string | null;
  clipDepth: number | null;
  /** PlaceObject3's class name, for a character made by a class. */
  className: string | null;
  blendMode: number | null;
  cacheAsBitmap: boolean | null;
  visible: boolean | null;
  opaqueBackground: number | null;
  /** The filter list's bytes, undecoded; null without one. */
  filters: Uint8Array | null;
  /** AVM1 clip actions' bytes, undecoded; null without them. */
  clipActions: Uint8Array | null;
}

function readString(r: SwfReader): string {
  const start = r.pos;
  while (r.pos < r.end && r.bytes[r.pos] !== 0) {
    r.pos++;
  }

  const s = utf8(r.bytes.subarray(start, r.pos));
  r.pos++;
  return s;
}

/**
 * UTF-8 as SWF 6 and later write strings, read as avmplus' Utf8ToUtf16 does
 * (fromUtf8 in the runtime): a malformed or overlong sequence is no
 * sequence, and its first byte stands for itself.
 */
function utf8(bytes: Uint8Array): string {
  let s = "";
  const length = bytes.length;

  for (let i = 0; i < length; ) {
    const b = bytes[i++];
    // ASCII, and a continuation byte on its own, stand for themselves.
    if (b < 0xc0) {
      s += String.fromCharCode(b);
      continue;
    }

    const n = b < 0xe0 ? 1 : b < 0xf0 ? 2 : 3;
    const minimum = n === 1 ? 0x80 : n === 2 ? 0x800 : 0x10000;
    let c = b & (n === 1 ? 0x1f : n === 2 ? 0x0f : 0x07);
    let ok = i + n <= length;
    for (let k = 0; ok && k < n; k++) {
      const next = bytes[i + k];
      ok = (next & 0xc0) === 0x80;
      c = (c << 6) | (next & 0x3f);
    }

    if (!ok || c < minimum) {
      s += String.fromCharCode(b);
      continue;
    }

    i += n;
    if (n === 3) {
      // A surrogate pair however large the value, as avmplus makes one;
      // fromCodePoint would refuse one past U+10FFFF.
      const u = c - 0x10000;
      s += String.fromCharCode(0xd800 + ((u >> 10) & 0x3ff), 0xdc00 + (u & 0x3ff));
    } else {
      s += String.fromCharCode(c);
    }
  }

  return s;
}

/** A PlaceObject, PlaceObject2 or PlaceObject3 tag's body. */
export function readPlace(bytes: Uint8Array, tag: Tag): Place {
  const r = new SwfReader(bytes, tag.offset, tag.offset + tag.length);
  const place: Place = {
    depth: 0,
    move: false,
    character: null,
    matrix: null,
    colorTransform: null,
    ratio: null,
    name: null,
    clipDepth: null,
    className: null,
    blendMode: null,
    cacheAsBitmap: null,
    visible: null,
    opaqueBackground: null,
    filters: null,
    clipActions: null,
  };

  if (tag.code === PlaceObject) {
    place.character = r.u16();
    place.depth = r.u16();
    place.matrix = readMatrix(r);
    if (r.pos < r.end) {
      place.colorTransform = readColorTransform(r, false);
    }

    return place;
  }

  const flags = r.u8();
  const flags2 = tag.code === PlaceObject3 ? r.u8() : 0;
  place.depth = r.u16();
  place.move = (flags & 0x01) !== 0;

  // SWF19 has a class name follow HasImage with a character; Flash reads
  // one with HasImage only without a character, as Ruffle's reader notes.
  const hasImage = (flags2 & 0x10) !== 0;
  if (flags2 & 0x08 || (hasImage && !(flags & 0x02))) {
    place.className = readString(r);
  }

  if (flags & 0x02) {
    place.character = r.u16();
  }

  if (flags & 0x04) {
    place.matrix = readMatrix(r);
  }

  if (flags & 0x08) {
    place.colorTransform = readColorTransform(r, true);
  }

  if (flags & 0x10) {
    place.ratio = r.u16();
  }

  if (flags & 0x20) {
    place.name = readString(r);
  }

  if (flags & 0x40) {
    place.clipDepth = r.u16();
  }

  if (flags2 & 0x01) {
    place.filters = readFilterBytes(r);
  }

  if (flags2 & 0x02) {
    place.blendMode = r.u8();
  }

  if (flags2 & 0x04) {
    place.cacheAsBitmap = r.u8() !== 0;
  }

  if (flags2 & 0x20) {
    place.visible = r.u8() !== 0;
  }

  // The background follows its own flag, not HasVisible as SWF19 lays it out.
  if (flags2 & 0x40) {
    const a = r.u8();
    const rgb = (r.u8() << 16) | (r.u8() << 8) | r.u8();
    place.opaqueBackground = ((a << 24) | rgb) >>> 0;
  }

  if (flags & 0x80 && r.pos < r.end) {
    place.clipActions = bytes.subarray(r.pos, r.end);
  }

  return place;
}

/** Filter sizes by id, as FILTER's variants lay them out (6 and 7 have variable length). */
function readFilterBytes(r: SwfReader): Uint8Array {
  const start = r.pos;
  const count = r.u8();

  for (let i = 0; i < count && !r.overrun; i++) {
    const id = r.u8();
    if (id === 0) {
      r.pos += 23; // DropShadow
    } else if (id === 1) {
      r.pos += 9; // Blur
    } else if (id === 2) {
      r.pos += 15; // Glow
    } else if (id === 3) {
      r.pos += 27; // Bevel
    } else if (id === 4 || id === 7) {
      const stops = r.u8(); // GradientGlow, GradientBevel
      r.pos += stops * 5 + 19;
    } else if (id === 5) {
      const x = r.u8(); // Convolution
      const y = r.u8();
      r.pos += 8 + x * y * 4 + 5;
    } else if (id === 6) {
      r.pos += 80; // ColorMatrix
    }
  }

  return r.bytes.subarray(start, Math.min(r.pos, r.end));
}

/** A RemoveObject's or RemoveObject2's depth. */
export function readRemove(bytes: Uint8Array, tag: Tag): number {
  const r = new SwfReader(bytes, tag.offset, tag.offset + tag.length);
  if (tag.code === RemoveObject) {
    r.u16();
  } else if (tag.code !== RemoveObject2) {
    throw new Error(`tag ${tag.code} is not a remove`);
  }

  return r.u16();
}

export function readFrameLabel(bytes: Uint8Array, tag: Tag): string {
  return readString(new SwfReader(bytes, tag.offset, tag.offset + tag.length));
}

/** A DefineSprite's id, frame count and its own tags. */
export function readSprite(
  bytes: Uint8Array,
  tag: Tag,
): { id: number; frameCount: number; tags: Tag[] } {
  const r = new SwfReader(bytes, tag.offset, tag.offset + tag.length);
  const id = r.u16();
  const frameCount = r.u16();
  return { id, frameCount, tags: readTags(bytes, r.pos, tag.offset + tag.length).tags };
}

/** SymbolClass's links from character ids to class names; id 0 is the main timeline's class. */
export function readSymbolClass(bytes: Uint8Array, tag: Tag): Map<number, string> {
  const r = new SwfReader(bytes, tag.offset, tag.offset + tag.length);
  const count = r.u16();
  const symbols = new Map<number, string>();

  for (let i = 0; i < count && !r.overrun; i++) {
    const id = r.u16();
    symbols.set(id, readString(r));
  }

  return symbols;
}

/** A DoABC's or DoABC2's ABC bytes, its name, and whether it is to be run lazily (kDoAbcLazyInitializeFlag). */
export function readDoAbc(
  bytes: Uint8Array,
  tag: Tag,
): { name: string; lazy: boolean; abc: Uint8Array } {
  const r = new SwfReader(bytes, tag.offset, tag.offset + tag.length);
  if (tag.code === DoABC) {
    return { name: "", lazy: false, abc: bytes.subarray(tag.offset, tag.offset + tag.length) };
  }

  const flags = r.u32();
  const name = readString(r);
  return { name, lazy: (flags & 1) !== 0, abc: bytes.subarray(r.pos, tag.offset + tag.length) };
}
