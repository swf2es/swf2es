// The back buffer read back for drawToBitmapData: its rows top-down, at the size asked for.

import { resolveBackBuffer } from "./back-buffer.js";
import type { WebGLContext3D } from "./context.js";

export function readBackBuffer(ctx: WebGLContext3D, width: number, height: number): Uint8Array {
  width = Math.max(0, Math.min(ctx.width, Math.floor(width) || 0));
  height = Math.max(0, Math.min(ctx.height, Math.floor(height) || 0));
  ctx.target(true);
  resolveBackBuffer(ctx);
  const gl = ctx.gl;
  const scaleX = ctx.drawnWidth / ctx.width;
  const scaleY = ctx.drawnHeight / ctx.height;
  const drawnWidth = Math.min(ctx.drawnWidth, Math.ceil(width * scaleX));
  const drawnHeight = Math.min(ctx.drawnHeight, Math.ceil(height * scaleY));
  if (ctx.pixels.length < drawnWidth * drawnHeight * 4) {
    ctx.pixels = new Uint8Array(drawnWidth * drawnHeight * 4);
  }
  if (ctx.topDown.length < width * height * 4) {
    ctx.topDown = new Uint8Array(width * height * 4);
  }

  // GL's rows run bottom-up, so the top-left region starts height rows below the top.
  gl.readPixels(
    0,
    ctx.drawnHeight - drawnHeight,
    drawnWidth,
    drawnHeight,
    gl.RGBA,
    gl.UNSIGNED_BYTE,
    ctx.pixels,
  );
  const row = width * 4;
  if (drawnWidth === width && drawnHeight === height) {
    for (let y = 0; y < height; y++) {
      const from = (height - y - 1) * row;
      ctx.topDown.set(ctx.pixels.subarray(from, from + row), y * row);
    }

    return ctx.topDown;
  }

  // Storage smaller than the back buffer: each pixel is the stored one it falls on.
  const source = new Uint32Array(ctx.pixels.buffer, 0, drawnWidth * drawnHeight);
  const target = new Uint32Array(ctx.topDown.buffer, 0, width * height);
  for (let y = 0; y < height; y++) {
    const from = (drawnHeight - 1 - Math.min(drawnHeight - 1, Math.floor(y * scaleY))) * drawnWidth;
    for (let x = 0; x < width; x++) {
      target[y * width + x] = source[from + Math.min(drawnWidth - 1, Math.floor(x * scaleX))];
    }
  }

  return ctx.topDown;
}
