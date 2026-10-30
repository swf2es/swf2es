// ATF textures for Stage3D: the header and blocks (parse.ts), and each
// level decoded into what a desktop GPU takes, as Flash Player picks it on
// the desktop: RGB888 and RGBA8888's JPEG XR images as BGRA, and the block
// compressed formats as S3TC, DXT1 or DXT5, rebuilt from their LZMA'd
// indices and JPEG XR endpoint images, or copied where they are raw.
import { DONE, lzmaDecode } from "../compress/index.js";
import { decodeJxr, JXR_BGR, JXR_BGRA, JXR_GRAY, JXR_RGB565, type JxrImage } from "./jxr.js";
import {
  ATF_COMPRESSED,
  ATF_COMPRESSED_ALPHA,
  ATF_COMPRESSED_LOSSY,
  ATF_COMPRESSED_LOSSY_ALPHA,
  ATF_RAW_COMPRESSED,
  ATF_RAW_COMPRESSED_ALPHA,
  ATF_RGB888,
  type AtfBlocks,
  AtfError,
  type AtfHeader,
  readAtfBlocks,
} from "./parse.js";

export { jxrMemoryInUse, jxrTraps } from "./jxr.js";
export * from "./parse.js";

/** What a level decodes to: BGRA pixels, or S3TC blocks. */
export type AtfEncoding = "bgra" | "dxt1" | "dxt5";

export interface AtfImage {
  face: number;
  level: number;
  width: number;
  height: number;
  /**
   * BGRA's top-down rows of 4 bytes a pixel, alpha straight; DXT1's 8 bytes
   * a 4x4 block, DXT5's 16, the blocks in rows from the top, each at least
   * one block however small the level.
   */
  bytes: Uint8Array;
}

/** The encoding an ATF of `format` decodes to. */
export function atfEncoding(format: number): AtfEncoding {
  switch (format) {
    case ATF_COMPRESSED:
    case ATF_RAW_COMPRESSED:
    case ATF_COMPRESSED_LOSSY:
      return "dxt1";
    case ATF_COMPRESSED_ALPHA:
    case ATF_RAW_COMPRESSED_ALPHA:
    case ATF_COMPRESSED_LOSSY_ALPHA:
      return "dxt5";
    default:
      return "bgra";
  }
}

/**
 * Every level the ATF holds, of every face, decoded: a level that is absent,
 * or whose blocks for the desktop are empty, is left out. Throws AtfError
 * (`decode`, #3677) for a block that does not decode or is not the size its
 * level needs.
 */
export function decodeAtf(data: Uint8Array, header: AtfHeader): AtfImage[] {
  const faces = readAtfBlocks(data, header);
  const images: AtfImage[] = [];

  for (let face = 0; face < faces.length; face++) {
    const levels = faces[face];
    for (let level = 0; level < levels.length; level++) {
      const blocks = levels[level];
      const width = Math.max(1, header.width >> level);
      const height = Math.max(1, header.height >> level);
      const bytes = blocks && decodeLevel(header.format, blocks, width, height);
      if (bytes) {
        images.push({ face, level, width, height, bytes });
      }
    }
  }

  return images;
}

function corrupt(what: string): never {
  throw new AtfError("decode", `ATF ${what} does not decode`);
}

/** A level's image for the desktop; null where its blocks for it are all empty. */
function decodeLevel(
  format: number,
  blocks: AtfBlocks,
  width: number,
  height: number,
): Uint8Array | null {
  const across = Math.max(1, width >> 2);
  const down = Math.max(1, height >> 2);
  switch (format) {
    case ATF_RGB888:
      return blocks[0].length === 0 ? null : bgra(blocks[0], width, height, false);
    case ATF_COMPRESSED:
    case ATF_COMPRESSED_LOSSY:
      return empty(blocks, 2) ? null : dxt1(blocks, across, down);
    case ATF_COMPRESSED_ALPHA:
    case ATF_COMPRESSED_LOSSY_ALPHA:
      return empty(blocks, 4) ? null : dxt5(blocks, across, down);
    case ATF_RAW_COMPRESSED:
    case ATF_RAW_COMPRESSED_ALPHA:
      if (blocks[0].length === 0) {
        return null;
      }

      // Raw blocks are the GPU's, as they are.
      if (blocks[0].length !== across * down * (format === ATF_RAW_COMPRESSED ? 8 : 16)) {
        corrupt("raw blocks");
      }

      return blocks[0].slice();
    default:
      return blocks[0].length === 0 ? null : bgra(blocks[0], width, height, true);
  }
}

/** Whether the first `n` blocks, the desktop's, are all empty. */
function empty(blocks: AtfBlocks, n: number): boolean {
  for (let i = 0; i < n; i++) {
    if (blocks[i].length !== 0) {
      return false;
    }
  }

  return true;
}

/** An image of `format` exactly `width` by `height`. */
function image(block: Uint8Array, format: number, width: number, height: number): JxrImage {
  // jxrlib refuses an image larger than the level's before it allocates for it.
  const decoded = block.length === 0 ? null : decodeJxr(block, format, Math.max(width, height));
  if (!decoded || decoded.width !== width || decoded.height !== height) {
    corrupt("JPEG XR image");
  }

  return decoded;
}

/** RGB888's or RGBA8888's image as BGRA. */
function bgra(block: Uint8Array, width: number, height: number, alpha: boolean): Uint8Array {
  return image(block, alpha ? JXR_BGRA : JXR_BGR, width, height).pixels;
}

/** An LZMA block, its 5 property bytes first, decoded to exactly `size` bytes. */
function lzma(block: Uint8Array, size: number): Uint8Array {
  const decoded = lzmaDecode(block, 0, 5, size);
  if (decoded.status !== DONE || decoded.bytes.length !== size) {
    corrupt("LZMA block");
  }

  return decoded.bytes;
}

/**
 * DXT1 from Compressed's first two blocks: each 4x4 block's 2-bit indices,
 * 4 bytes a block, LZMA'd, and its two RGB565 endpoints as an image a pixel
 * a block, the first endpoints above the second (Adobe's dds2atf).
 */
function dxt1(blocks: AtfBlocks, across: number, down: number): Uint8Array {
  const count = across * down;
  const indices = lzma(blocks[0], count * 4);
  const colors = image(blocks[1], JXR_RGB565, across, down * 2).pixels;
  const out = new Uint8Array(count * 8);

  for (let i = 0; i < count; i++) {
    const o = i * 8;
    const c = i * 2;
    const d = (count + i) * 2;
    out[o] = colors[c];
    out[o + 1] = colors[c + 1];
    out[o + 2] = colors[d];
    out[o + 3] = colors[d + 1];
    out.set(indices.subarray(i * 4, i * 4 + 4), o + 4);
  }

  return out;
}

/**
 * DXT5 from CompressedAlpha's first four blocks: the alpha indices, 6 bytes
 * a block, LZMA'd; the alpha endpoints as an 8-bit grey image, the first
 * above the second; then the colour indices and endpoints as DXT1's.
 */
function dxt5(blocks: AtfBlocks, across: number, down: number): Uint8Array {
  const count = across * down;
  const alphaIndices = lzma(blocks[0], count * 6);
  const alphas = image(blocks[1], JXR_GRAY, across, down * 2).pixels;
  const indices = lzma(blocks[2], count * 4);
  const colors = image(blocks[3], JXR_RGB565, across, down * 2).pixels;
  const out = new Uint8Array(count * 16);

  for (let i = 0; i < count; i++) {
    const o = i * 16;
    const c = i * 2;
    const d = (count + i) * 2;
    out[o] = alphas[i];
    out[o + 1] = alphas[count + i];
    out.set(alphaIndices.subarray(i * 6, i * 6 + 6), o + 2);
    out[o + 8] = colors[c];
    out[o + 9] = colors[c + 1];
    out[o + 10] = colors[d];
    out[o + 11] = colors[d + 1];
    out.set(indices.subarray(i * 4, i * 4 + 4), o + 12);
  }

  return out;
}
