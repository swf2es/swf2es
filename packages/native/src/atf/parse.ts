// ATF, Adobe's texture container: its header and the blocks of each face
// and level, read as AIR reads them. The layout is Adobe's "ATF file
// format" (version 3, 2015), and the old header, which has no version,
// as Adobe's dds2atf writes it:
//
//   old:  "ATF", length U24, cube UB[1] format UB[7], log2 width U8,
//         log2 height U8, count U8; each block's length U24
//   new:  "ATF", reserved U8[3], 0xff, version U8, length U32, then as
//         the old; each block's length U32 (U24 at version 0)
//
// The length counts what follows its own field. Each face, then each level
// of it, holds the blocks of every GPU's encoding in a fixed order; from
// version 3 those include ETC2's.

/**
 * Why AIR refuses an ATF: `size` is Error #3669 (Bad input size), `decode`
 * #3677 (Texture decoding failed) and `format` #3675 (Texture format
 * mismatch).
 */
export type AtfFailure = "size" | "decode" | "format";

export class AtfError extends Error {
  readonly reason: AtfFailure;

  constructor(reason: AtfFailure, message: string) {
    super(message);
    this.reason = reason;
  }
}

/** The Context3DTextureFormat whose textures take an ATF format. */
export type AtfKind = "bgra" | "compressed" | "compressedAlpha";

export const ATF_RGB888 = 0;
export const ATF_RGBA8888 = 1;
export const ATF_COMPRESSED = 2;
export const ATF_RAW_COMPRESSED = 3;
export const ATF_COMPRESSED_ALPHA = 4;
export const ATF_RAW_COMPRESSED_ALPHA = 5;
export const ATF_COMPRESSED_LOSSY = 0x0c;
export const ATF_COMPRESSED_LOSSY_ALPHA = 0x0d;

/** The largest texture ATF describes, 4096 pixels a side. */
const MAX_LOG2 = 12;

export interface AtfHeader {
  /** Whether it is the old header, which AIR reads alone for content before SWF 17. */
  old: boolean;
  /** 0 for the old header. */
  version: number;
  format: number;
  cube: boolean;
  log2Width: number;
  log2Height: number;
  width: number;
  height: number;
  /** Levels each face holds, the first the full size. */
  count: number;
  /** Where the first face's first block starts, in the data. */
  start: number;
  /** Where the length field says the texture ends: AIR refuses less data (#3669), and reads on past it. */
  end: number;
}

/** A level's blocks, in the order its format lists them: views of the data. */
export type AtfBlocks = Uint8Array[];

/**
 * The texture format that takes ATF's `format`: null for the formats 6 to
 * 11, which AIR calls a mismatch whatever the texture (#3675), and
 * undefined for any later one, which it calls corrupt (#3677).
 */
export function atfKind(format: number): AtfKind | null | undefined {
  switch (format) {
    case ATF_RGB888:
    case ATF_RGBA8888:
      return "bgra";
    case ATF_COMPRESSED:
    case ATF_RAW_COMPRESSED:
    case ATF_COMPRESSED_LOSSY:
      return "compressed";
    case ATF_COMPRESSED_ALPHA:
    case ATF_RAW_COMPRESSED_ALPHA:
    case ATF_COMPRESSED_LOSSY_ALPHA:
      return "compressedAlpha";
    default:
      return format <= 11 ? null : undefined;
  }
}

/**
 * The ATF at `offset` of `data`, checked as AIR checks it before it looks
 * further, even for an asynchronous upload: its signature (#3677), and that
 * the data holds the header and what its length says (#3669).
 */
export function readAtfHeader(data: Uint8Array, offset: number): AtfHeader {
  // An offset past the data, or not one at all, is as short as none.
  const available =
    Number.isInteger(offset) && offset >= 0 && offset <= data.length ? data.length - offset : -1;
  if (available < 3) {
    throw new AtfError("size", "no ATF signature");
  }

  if (data[offset] !== 0x41 || data[offset + 1] !== 0x54 || data[offset + 2] !== 0x46) {
    throw new AtfError("decode", "not an ATF");
  }

  // The new header marks itself where the old one has its format.
  const old = available < 7 || data[offset + 6] !== 0xff;
  if (available < (old ? 10 : 16)) {
    throw new AtfError("size", "ATF header truncated");
  }

  const at = offset + (old ? 6 : 12);
  const length = old
    ? (data[offset + 3] << 16) | (data[offset + 4] << 8) | data[offset + 5]
    : ((data[offset + 8] << 24) |
        (data[offset + 9] << 16) |
        (data[offset + 10] << 8) |
        data[offset + 11]) >>>
      0;
  // Past this, AIR reads as far as the data goes, the length aside.
  const end = at + length;
  if (end > data.length) {
    throw new AtfError("size", "ATF longer than its data");
  }

  const log2Width = data[at + 1];
  const log2Height = data[at + 2];

  return {
    old,
    version: old ? 0 : data[offset + 7],
    format: data[at] & 0x7f,
    cube: (data[at] & 0x80) !== 0,
    log2Width,
    log2Height,
    width: 2 ** Math.min(log2Width, 31),
    height: 2 ** Math.min(log2Height, 31),
    count: data[at + 3],
    start: at + 4,
    end,
  };
}

/** The lossy formats, which came with version 3 and AIR reads in no other. */
function lossy(format: number): boolean {
  return format === ATF_COMPRESSED_LOSSY || format === ATF_COMPRESSED_LOSSY_ALPHA;
}

/** Blocks a level holds, every GPU's encoding: ETC2's from version 3. */
function blocksPerLevel(format: number, version: number): number {
  const etc2 = version >= 3;
  switch (format) {
    case ATF_RGB888:
    case ATF_RGBA8888:
      return 1;
    case ATF_COMPRESSED:
      // DXT1 2, PVRTC 3, ETC1 3, ETC2 3.
      return etc2 ? 11 : 8;
    case ATF_RAW_COMPRESSED:
    case ATF_RAW_COMPRESSED_ALPHA:
      // DXT, PVRTC, ETC1 and ETC2 one each.
      return etc2 ? 4 : 3;
    case ATF_COMPRESSED_ALPHA:
      // DXT5 4, PVRTC 3, ETC1 3, ETC2 6.
      return etc2 ? 16 : 10;
    case ATF_COMPRESSED_LOSSY:
      // As compressed, with a block of ETC2's modes; version 3 alone.
      return 12;
    default:
      // As compressed with alpha, with a block of ETC2's modes; version 3 alone.
      return 17;
  }
}

/** How many of a level's blocks the desktop reads: its BGRA image, or its DXT's. */
function desktopBlocks(format: number): number {
  switch (format) {
    case ATF_COMPRESSED:
    case ATF_COMPRESSED_LOSSY:
      return 2;
    case ATF_COMPRESSED_ALPHA:
    case ATF_COMPRESSED_LOSSY_ALPHA:
      return 4;
    default:
      return 1;
  }
}

/**
 * Each face's levels, each its blocks, as views of `data`; a format AIR
 * knows, a size up to 4096 and a level count from 1 to the size's own, or
 * #3677, and a format no texture takes, #3675. AIR reads the blocks as far
 * as the data goes, whatever the length says, and streams what it finds: a
 * level that starts where too little is left for a block's length is
 * absent, as are those after it; one whose blocks for the desktop are whole
 * stands though a later block of its is cut short, and the levels after it
 * are absent; but a block the desktop reads that is cut short is corrupt
 * (#3677).
 */
export function readAtfBlocks(data: Uint8Array, header: AtfHeader): (AtfBlocks | null)[][] {
  const kind = atfKind(header.format);
  if (kind === null) {
    throw new AtfError("format", `ATF format ${header.format} is no texture's`);
  }

  const levels = 1 + Math.max(header.log2Width, header.log2Height);
  if (
    kind === undefined ||
    header.log2Width > MAX_LOG2 ||
    header.log2Height > MAX_LOG2 ||
    header.count === 0 ||
    header.count > levels ||
    (lossy(header.format) && header.version < 3)
  ) {
    throw new AtfError("decode", "ATF format, size or level count out of range");
  }

  const blocks = blocksPerLevel(header.format, header.version);
  const needed = desktopBlocks(header.format);
  const field = header.version === 0 ? 3 : 4;
  const faces: (AtfBlocks | null)[][] = [];
  let at = header.start;
  let streamed = false;

  for (let face = 0; face < (header.cube ? 6 : 1); face++) {
    const found: (AtfBlocks | null)[] = [];
    for (let level = 0; level < header.count; level++) {
      const read: AtfBlocks = [];
      for (let block = 0; block < blocks && !streamed; block++) {
        if (field > data.length - at) {
          streamed = true;
          break;
        }

        let length = (data[at] << 16) | (data[at + 1] << 8) | data[at + 2];
        if (field === 4) {
          length = length * 256 + data[at + 3];
        }

        at += field;
        if (length > data.length - at) {
          if (block < needed) {
            throw new AtfError("decode", "ATF block past the data");
          }

          streamed = true;
          break;
        }

        read.push(data.subarray(at, at + length));
        at += length;
      }

      found.push(read.length >= needed ? read : null);
    }

    faces.push(found);
  }

  return faces;
}
