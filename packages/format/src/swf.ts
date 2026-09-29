// A SWF's movie header and its tags, as the SWF file format specification
// (version 19) lays them out: after the 8-byte file header and the body's
// decompression, the frame size as a RECT, the frame rate as 8.8 fixed
// point, the frame count, then tags to an End tag or the body's end.
import { decompressSwf } from "./compression.js";
import { End, SetBackgroundColor } from "./tags.js";

export type SwfCompression = "none" | "zlib" | "lzma";

export interface SwfHeader {
  compression: SwfCompression;
  /** SWF version byte (e.g. 10 for Flash Player 10). */
  version: number;
  /** Uncompressed length of the whole file, header included. */
  fileLength: number;
}

const SIGNATURES: Record<string, SwfCompression> = { FWS: "none", CWS: "zlib", ZWS: "lzma" };

/** Read the 8-byte header every SWF starts with. */
export function readSwfHeader(bytes: Uint8Array): SwfHeader {
  if (bytes.length < 8) {
    throw new RangeError(`SWF header needs 8 bytes, got ${bytes.length}`);
  }
  const signature = String.fromCharCode(bytes[0], bytes[1], bytes[2]);
  const compression = SIGNATURES[signature];
  if (!compression) {
    throw new TypeError(`Not a SWF file (signature ${JSON.stringify(signature)})`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { compression, version: bytes[3], fileLength: view.getUint32(4, true) };
}

/** A rectangle in twips (1/20 pixel), as a RECT holds one. */
export interface Rect {
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
}

/** A tag: its code, and where its body is in the decompressed file. */
export interface Tag {
  code: number;
  /** Offset of the body in the decompressed file, after the tag's header. */
  offset: number;
  length: number;
}

export interface Swf {
  header: SwfHeader;
  /** The whole file, decompressed, header included; tags' offsets are into it. */
  bytes: Uint8Array;
  frameSize: Rect;
  /** Frames per second: the 8.8 fixed-point value as a number. */
  frameRate: number;
  frameCount: number;
  tags: Tag[];
  /** Whether the tags ran past the end of the file, and were cut there. */
  truncated: boolean;
}

/** Reads bits and bytes of a SWF body, bits most significant first, as the format packs them. */
export class SwfReader {
  private bit = 0;
  private byte = 0;

  constructor(
    readonly bytes: Uint8Array,
    public pos = 0,
    readonly end = bytes.length,
  ) {}

  /** Past the end: every read after it gives 0. */
  get overrun(): boolean {
    return this.pos > this.end;
  }

  align(): void {
    this.bit = 0;
  }

  ub(n: number): number {
    let v = 0;
    for (let i = 0; i < n; i++) {
      if (this.bit === 0) {
        this.byte = this.pos < this.end ? this.bytes[this.pos] : 0;
        this.pos++;
        this.bit = 8;
      }

      this.bit--;
      v = v * 2 + ((this.byte >> this.bit) & 1);
    }

    return v;
  }

  sb(n: number): number {
    if (n === 0) {
      return 0;
    }

    const v = this.ub(n);
    return v >= 2 ** (n - 1) ? v - 2 ** n : v;
  }

  u8(): number {
    this.align();
    const v = this.pos < this.end ? this.bytes[this.pos] : 0;
    this.pos++;
    return v;
  }

  u16(): number {
    return this.u8() | (this.u8() << 8);
  }

  u32(): number {
    return (this.u16() | (this.u16() << 16)) >>> 0;
  }

  rect(): Rect {
    this.align();
    const n = this.ub(5);
    const rect = { xMin: this.sb(n), xMax: this.sb(n), yMin: this.sb(n), yMax: this.sb(n) };
    this.align();
    return rect;
  }
}

/** A SWF's header and tags, its body decompressed. */
export function readSwf(file: Uint8Array): Swf {
  const header = readSwfHeader(file);
  const bytes = decompressSwf(file);
  const r = new SwfReader(bytes, 8);
  const frameSize = r.rect();
  const frameRate = r.u16() / 256;
  const frameCount = r.u16();
  const { tags, truncated } = readTags(bytes, r.pos, bytes.length);
  return { header, bytes, frameSize, frameRate, frameCount, tags, truncated };
}

/** The tags from `start` to an End tag or `end`, as a sprite's or the file's. */
export function readTags(
  bytes: Uint8Array,
  start: number,
  end: number,
): { tags: Tag[]; truncated: boolean } {
  const tags: Tag[] = [];
  const r = new SwfReader(bytes, start, end);
  while (r.pos + 2 <= end) {
    const codeAndLength = r.u16();
    const code = codeAndLength >> 6;
    let length = codeAndLength & 0x3f;
    if (length === 0x3f) {
      length = r.u32();
    }

    if (r.pos + length > end) {
      tags.push({ code, offset: r.pos, length: Math.max(0, end - r.pos) });
      return { tags, truncated: true };
    }

    tags.push({ code, offset: r.pos, length });
    r.pos += length;
    if (code === End) {
      break;
    }
  }

  return { tags, truncated: false };
}

/** The background colour SetBackgroundColor sets, 0xRRGGBB, or white without one. */
export function backgroundColor(swf: Swf): number {
  const tag = swf.tags.find((t) => t.code === SetBackgroundColor);
  if (!tag || tag.length < 3) {
    return 0xffffff;
  }

  const b = swf.bytes;
  return (b[tag.offset] << 16) | (b[tag.offset + 1] << 8) | b[tag.offset + 2];
}
