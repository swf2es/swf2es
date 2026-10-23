import type { Texture3D } from "../backend.js";
import { range } from "./state.js";
import type { MultisampleTarget } from "./targets.js";

export interface TextureState {
  handle: WebGLTexture;
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

function uploadLevel(
  gl: WebGL2RenderingContext,
  texture: Texture3D,
  state: TextureState,
  level: number,
  face: number,
  w: number,
  h: number,
): void {
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
): void {
  const { width, height, levels, cube, rectangle } = texture;
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
    pixels.length !== sw * sh ||
    (!rectangle && (sw !== w || sh !== h))
  ) {
    throw new Error("Context3D experiment: texture upload size mismatch");
  }

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
      state.bytes.fill(0);
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

  uploadLevel(gl, texture, state, level, face, w, h);
}

export function uploadTextureBytes(
  gl: WebGL2RenderingContext,
  texture: Texture3D,
  state: TextureState,
  data: Uint8Array,
  offset: number,
  level: number,
  face: number,
): void {
  const { width, height, levels, cube } = texture;
  const faces = cube ? 6 : 1;
  range(level, 1, levels);
  range(face, 1, faces);
  const w = Math.max(1, width >> level);
  const h = Math.max(1, height >> level);
  const length = w * h * 4;
  range(offset, length, data.length);

  for (let i = 0; i < length; i += 4) {
    state.bytes[i] = data[offset + i + 2];
    state.bytes[i + 1] = data[offset + i + 1];
    state.bytes[i + 2] = data[offset + i];
    state.bytes[i + 3] = data[offset + i + 3];
  }

  uploadLevel(gl, texture, state, level, face, w, h);
}
