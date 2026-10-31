import type { Texture3D } from "../backend.js";
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
}

/** The staging array, made base-sized at its first use: a texture given only blocks on S3TC has none. */
function staging(texture: Texture3D, state: TextureState): Uint8Array {
  if (state.bytes.length === 0) {
    state.bytes = new Uint8Array(texture.width * texture.height * 4);
  }

  return state.bytes;
}

/** The staged level uploaded: as it is, or a compressed texture's encoded to its blocks, as AIR compresses pixels. */
function uploadLevel(
  gl: WebGL2RenderingContext,
  texture: Texture3D,
  state: TextureState,
  level: number,
  face: number,
  w: number,
  h: number,
  encoder: DxtEncoder | null,
): void {
  if (texture.format !== "bgra") {
    const rgba = state.bytes.subarray(0, w * h * 4);
    const dxt5 = texture.format === "compressedAlpha";
    const blocks = encoder?.(rgba, dxt5, w, h) ?? encodeDxt(rgba, dxt5, w, h);
    uploadCompressedLevel(gl, texture, state, blocks, level, face);
    return;
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
    gl.RGBA,
    gl.UNSIGNED_BYTE,
    state.bytes,
  );
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
  const length = w * h * 4;
  range(offset, length, data.length);
  staging(texture, state);

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
