import { compressedFormat, TEXEL_BYTES, type Texture3D, type TextureFormat } from "../backend.js";
import { blockBytes, type DxtEncoder, decodeDxt, encodeDxt } from "../dxt.js";
import { Context3DError } from "../errors.js";
import { range } from "./state.js";
import type { MultisampleTarget } from "./targets.js";

export interface TextureState {
  handle: WebGLTexture;
  /** The internal format its storage has: RGBA8, or S3TC's for a compressed texture. */
  storage: number;
  /** RGBA staging for a level, made at the first upload that needs it: base-sized. */
  bytes: Uint8Array;
  uploaded: Uint16Array;
  framebuffer: WebGLFramebuffer | null;
  depthBuffer: WebGLRenderbuffer | null;
  dirty: boolean;
  face: number;
  mipFramebuffer: WebGLFramebuffer | null;
  depthAttached: boolean;
  multisample: MultisampleTarget | null;
  samples: number;
  antiAlias: number;
  /** The extra colour outputs its framebuffer has attached, a bit each from output 1. */
  outputs: number;
}

/**
 * GL's internal format for an uncompressed texture's storage. The packed formats are kept
 * at 8 bits a channel, as AIR draws into them, their texels widened on upload as Direct3D
 * samples them; 5:6:5 has no alpha to read but 1.
 */
export function storageFormat(gl: WebGL2RenderingContext, format: TextureFormat): number {
  switch (format) {
    case "bgrPacked565":
      return gl.RGB8;
    case "rgbaHalfFloat":
      return gl.RGBA16F;
    default:
      return gl.RGBA8;
  }
}

/** 8-bit channel values as half floats, for bitmaps uploaded to rgbaHalfFloat. */
let halves: Uint16Array | null = null;

function halfOf(byte: number): number {
  if (!halves) {
    halves = new Uint16Array(256);
    const float = new Float32Array(1);
    const bits = new Uint32Array(float.buffer);
    for (let i = 1; i < 256; i++) {
      float[0] = i / 255;
      const word = bits[0];
      const exponent = ((word >>> 23) & 255) - 127 + 15;
      // Every value here is a normal half: round its 23-bit mantissa to 10 bits, to nearest even.
      const mantissa = word & 0x7fffff;
      let half = (exponent << 10) | (mantissa >>> 13);
      const rest = mantissa & 0x1fff;
      if (rest > 0x1000 || (rest === 0x1000 && half & 1)) {
        half++;
      }
      halves[i] = half;
    }
  }

  return halves[byte];
}

/** A channel cut to its high `bits` and widened back to 8 by repeating them, as Direct3D reads it. */
function widen(value: number, bits: number): number {
  const kept = value >> (8 - bits);
  return (kept << (8 - bits)) | (kept >> (2 * bits - 8));
}

/**
 * The staging array, made base-sized at its first use: a texture given only blocks on S3TC
 * has none. It holds a level as RGBA bytes, or a byte upload's texels as they came, with
 * room for half floats' eight bytes a texel.
 */
function staging(texture: Texture3D, state: TextureState): Uint8Array {
  if (state.bytes.length === 0) {
    state.bytes = new Uint8Array(
      texture.width * texture.height * Math.max(4, TEXEL_BYTES[texture.format] ?? 4),
    );
  }

  return state.bytes;
}

/**
 * The staged level turned, in place, into what the texture's storage takes: from RGBA
 * bytes, or from its format's texels where `raw`, little-endian words. 5:6:5 and 4:4:4:4
 * keep each channel's high bits, as AIR packs a bitmap; half floats take each byte over 255.
 */
function convertStaged(
  format: TextureFormat,
  bytes: Uint8Array,
  count: number,
  raw: boolean,
): void {
  const words = new Uint16Array(bytes.buffer, bytes.byteOffset, bytes.length >> 1);
  switch (format) {
    case "bgrPacked565":
      if (raw) {
        // Backwards: texel i's three bytes land at 3i, ahead of its word at 2i.
        for (let i = count - 1; i >= 0; i--) {
          const word = words[i];
          const at = i * 3;
          bytes[at] = ((word >> 11) << 3) | (word >> 13);
          bytes[at + 1] = (((word >> 5) & 63) << 2) | ((word >> 9) & 3);
          bytes[at + 2] = ((word & 31) << 3) | ((word >> 2) & 7);
        }
      } else {
        // Forwards: texel i's three bytes land at 3i, behind its own four at 4i.
        for (let i = 0; i < count; i++) {
          const at = i * 4;
          const to = i * 3;
          const r = widen(bytes[at], 5);
          const g = widen(bytes[at + 1], 6);
          const b = widen(bytes[at + 2], 5);
          bytes[to] = r;
          bytes[to + 1] = g;
          bytes[to + 2] = b;
        }
      }
      break;
    case "bgraPacked4444":
      if (raw) {
        // A word is alpha, red, green and blue from its high nibble down.
        for (let i = count - 1; i >= 0; i--) {
          const word = words[i];
          const at = i * 4;
          bytes[at] = ((word >> 8) & 15) * 17;
          bytes[at + 1] = ((word >> 4) & 15) * 17;
          bytes[at + 2] = (word & 15) * 17;
          bytes[at + 3] = (word >> 12) * 17;
        }
      } else {
        for (let i = 0; i < count * 4; i++) {
          bytes[i] = (bytes[i] >> 4) * 17;
        }
      }
      break;
    case "rgbaHalfFloat":
      if (!raw) {
        // Backwards: texel i's four words land at 8i, ahead of its own bytes at 4i.
        for (let i = count - 1; i >= 0; i--) {
          const at = i * 4;
          const r = halfOf(bytes[at]);
          const g = halfOf(bytes[at + 1]);
          const b = halfOf(bytes[at + 2]);
          const a = halfOf(bytes[at + 3]);
          words[i * 4] = r;
          words[i * 4 + 1] = g;
          words[i * 4 + 2] = b;
          words[i * 4 + 3] = a;
        }
      }
      break;
  }
}

/** The staged level's texels, as WebGL takes them for the texture's storage. */
function stagedPixels(
  gl: WebGL2RenderingContext,
  format: TextureFormat,
  bytes: Uint8Array,
  count: number,
): [number, number, ArrayBufferView] {
  switch (format) {
    case "bgrPacked565":
      return [gl.RGB, gl.UNSIGNED_BYTE, bytes];
    case "rgbaHalfFloat":
      return [gl.RGBA, gl.HALF_FLOAT, new Uint16Array(bytes.buffer, bytes.byteOffset, count * 4)];
    default:
      return [gl.RGBA, gl.UNSIGNED_BYTE, bytes];
  }
}

/**
 * The staged level uploaded: as it is, or a compressed texture's encoded to its blocks, as
 * AIR compresses pixels; `raw` where it is staged in the texture's own format, not as RGBA.
 */
function uploadLevel(
  gl: WebGL2RenderingContext,
  texture: Texture3D,
  state: TextureState,
  level: number,
  face: number,
  w: number,
  h: number,
  encoder: DxtEncoder | null,
  raw = false,
): void {
  if (compressedFormat(texture.format)) {
    const rgba = state.bytes.subarray(0, w * h * 4);
    const dxt5 = texture.format === "compressedAlpha";
    const blocks = encoder?.(rgba, dxt5, w, h) ?? encodeDxt(rgba, dxt5, w, h);
    uploadCompressedLevel(gl, texture, state, blocks, level, face);
    return;
  }

  convertStaged(texture.format, state.bytes, w * h, raw);
  const [layout, type, pixels] = stagedPixels(gl, texture.format, state.bytes, w * h);
  // 5:6:5's rows of three bytes need not be 4-byte aligned.
  if (texture.format === "bgrPacked565") {
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  }
  const cube = texture.cube;
  const target = cube ? gl.TEXTURE_CUBE_MAP : gl.TEXTURE_2D;
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(target, state.handle);
  gl.texSubImage2D(
    cube ? gl.TEXTURE_CUBE_MAP_POSITIVE_X + face : target,
    level,
    0,
    0,
    w,
    h,
    layout,
    type,
    pixels,
  );
  if (texture.format === "bgrPacked565") {
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
  }
  state.uploaded[face] |= 1 << level;
}

export function uploadTexture(
  gl: WebGL2RenderingContext,
  texture: Texture3D,
  state: TextureState,
  pixels: Uint32Array,
  level: number,
  face: number,
  sourceWidth?: number,
  sourceHeight?: number,
  encoder: DxtEncoder | null = null,
): void {
  const { width, height, levels, cube } = texture;
  const faces = cube ? 6 : 1;
  range(level, 1, levels);
  range(face, 1, faces);
  const w = Math.max(1, width >> level);
  const h = Math.max(1, height >> level);
  const sw = sourceWidth ?? w;
  const sh = sourceHeight ?? h;
  if (
    !Number.isSafeInteger(sw) ||
    sw <= 0 ||
    !Number.isSafeInteger(sh) ||
    sh <= 0 ||
    pixels.length !== sw * sh
  ) {
    throw new Context3DError("textureUpload", "Context3D experiment: texture upload size mismatch");
  }

  // Made once the call is known good: a refused one allocates nothing.
  staging(texture, state);

  if (sw === w && sh === h) {
    for (let i = 0; i < pixels.length; i++) {
      const pixel = pixels[i];
      const at = i * 4;
      state.bytes[at] = pixel >>> 16;
      state.bytes[at + 1] = pixel >>> 8;
      state.bytes[at + 2] = pixel;
      state.bytes[at + 3] = pixel >>> 24;
    }
  } else {
    // AIR clips at the top-left and clears uncovered pixels, without scaling.
    if (sw < w || sh < h) {
      state.bytes.fill(0, 0, w * h * 4);
    }
    const columns = Math.min(w, sw);
    const rows = Math.min(h, sh);
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < columns; x++) {
        const pixel = pixels[y * sw + x];
        const at = (y * w + x) * 4;
        state.bytes[at] = pixel >>> 16;
        state.bytes[at + 1] = pixel >>> 8;
        state.bytes[at + 2] = pixel;
        state.bytes[at + 3] = pixel >>> 24;
      }
    }
  }

  uploadLevel(gl, texture, state, level, face, w, h, encoder);
}

export function uploadTextureBytes(
  gl: WebGL2RenderingContext,
  texture: Texture3D,
  state: TextureState,
  data: Uint8Array,
  offset: number,
  level: number,
  face: number,
  encoder: DxtEncoder | null = null,
): void {
  const { width, height, levels, cube } = texture;
  const faces = cube ? 6 : 1;
  range(level, 1, levels);
  range(face, 1, faces);
  const w = Math.max(1, width >> level);
  const h = Math.max(1, height >> level);
  const texel = TEXEL_BYTES[texture.format] ?? 4;
  const length = w * h * texel;
  range(offset, length, data.length);
  staging(texture, state);

  // BGRA, and the compressed formats' pixels, which are BGRA too, go up as RGBA; the
  // others' texels as they are, little-endian words.
  if (texel !== 4) {
    state.bytes.set(data.subarray(offset, offset + length));
    uploadLevel(gl, texture, state, level, face, w, h, encoder, true);
    return;
  }

  for (let i = 0; i < length; i += 4) {
    state.bytes[i] = data[offset + i + 2];
    state.bytes[i + 1] = data[offset + i + 1];
    state.bytes[i + 2] = data[offset + i];
    state.bytes[i + 3] = data[offset + i + 3];
  }

  uploadLevel(gl, texture, state, level, face, w, h, encoder);
}

/**
 * A compressed texture's level from S3TC blocks: as they are where its
 * storage is S3TC's, or decoded to RGBA where the context takes no S3TC.
 */
export function uploadCompressedLevel(
  gl: WebGL2RenderingContext,
  texture: Texture3D,
  state: TextureState,
  blocks: Uint8Array,
  level: number,
  face: number,
): void {
  const { width, height, levels, cube } = texture;
  range(level, 1, levels);
  range(face, 1, cube ? 6 : 1);
  const w = Math.max(1, width >> level);
  const h = Math.max(1, height >> level);
  const dxt5 = texture.format === "compressedAlpha";
  if (blocks.length !== blockBytes(w, h, dxt5)) {
    throw new Context3DError(
      "textureUpload",
      "Context3D experiment: compressed level size mismatch",
    );
  }

  const target = cube ? gl.TEXTURE_CUBE_MAP_POSITIVE_X + face : gl.TEXTURE_2D;
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(cube ? gl.TEXTURE_CUBE_MAP : gl.TEXTURE_2D, state.handle);
  if (state.storage === gl.RGBA8) {
    decodeDxt(blocks, dxt5, w, h, staging(texture, state));
    gl.texSubImage2D(target, level, 0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, state.bytes);
  } else {
    gl.compressedTexSubImage2D(target, level, 0, 0, w, h, state.storage, blocks);
  }

  state.uploaded[face] |= 1 << level;
}
