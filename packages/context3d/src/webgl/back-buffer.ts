// The back buffer: its storage, as large as the GPU gives, its multisample resolve and its
// presentation to the canvas.

import { MOST_BACK_BUFFER } from "../backend.js";
import { Context3DError } from "../errors.js";

import type { WebGLContext3D } from "./context.js";
import { range } from "./state.js";
import { selectSamples } from "./targets.js";

export function configureBackBuffer(
  ctx: WebGLContext3D,
  width: number,
  height: number,
  depth: boolean,
  antiAlias: number,
  scale: number,
): void {
  ctx.alive();
  range(32, width - 32, MOST_BACK_BUFFER);
  range(32, height - 32, MOST_BACK_BUFFER);
  if (ctx.renderTexture) {
    throw new Context3DError(
      "operation",
      "Context3D experiment: resize while rendering to texture",
    );
  }

  // AIR preserves color, depth and bindings when the request is unchanged.
  // Shadow passes can issue this every frame when returning to the back buffer.
  if (
    ctx.framebuffer &&
    width === ctx.width &&
    height === ctx.height &&
    depth === (ctx.depthBuffer !== null) &&
    antiAlias === ctx.antiAlias
  ) {
    if (scale !== ctx.scale) {
      ctx.scale = scale;
      showAt(ctx);
      ctx.applyScissor();
    }

    return;
  }

  const samples = selectSamples(ctx.gl, antiAlias, depth);
  const gl = ctx.gl;
  const most = storageLimit(ctx);
  const drawnWidth = Math.min(width, most[0]);
  const drawnHeight = Math.min(height, most[1]);
  const texture = gl.createTexture();
  const framebuffer = gl.createFramebuffer();
  const depthBuffer = depth ? gl.createRenderbuffer() : null;
  const resolveFramebuffer = samples ? gl.createFramebuffer() : null;
  const colorBuffer = samples ? gl.createRenderbuffer() : null;
  try {
    if (
      !texture ||
      !framebuffer ||
      (depth && !depthBuffer) ||
      (samples && (!resolveFramebuffer || !colorBuffer))
    ) {
      throw new Context3DError("operation", "Context3D experiment: cannot allocate back buffer");
    }

    ctx.texturesApplied[0] = 0;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA8,
      drawnWidth,
      drawnHeight,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      null,
    );
    ctx.bindFramebuffer(gl.FRAMEBUFFER, resolveFramebuffer ?? framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    if (resolveFramebuffer) {
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
        throw new Context3DError("operation", "Context3D experiment: incomplete resolve buffer");
      }

      ctx.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
      gl.bindRenderbuffer(gl.RENDERBUFFER, colorBuffer);
      gl.renderbufferStorageMultisample(
        gl.RENDERBUFFER,
        samples,
        gl.RGBA8,
        drawnWidth,
        drawnHeight,
      );
      gl.framebufferRenderbuffer(
        gl.FRAMEBUFFER,
        gl.COLOR_ATTACHMENT0,
        gl.RENDERBUFFER,
        colorBuffer,
      );
    }
    if (depthBuffer) {
      gl.bindRenderbuffer(gl.RENDERBUFFER, depthBuffer);
      if (samples) {
        gl.renderbufferStorageMultisample(
          gl.RENDERBUFFER,
          samples,
          gl.DEPTH24_STENCIL8,
          drawnWidth,
          drawnHeight,
        );
      } else {
        gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH24_STENCIL8, drawnWidth, drawnHeight);
      }
      gl.framebufferRenderbuffer(
        gl.FRAMEBUFFER,
        gl.DEPTH_STENCIL_ATTACHMENT,
        gl.RENDERBUFFER,
        depthBuffer,
      );
    }
    gl.bindRenderbuffer(gl.RENDERBUFFER, null);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
      throw new Context3DError("operation", "Context3D experiment: incomplete back buffer");
    }
  } catch (error) {
    gl.deleteTexture(texture);
    gl.deleteFramebuffer(framebuffer);
    gl.deleteFramebuffer(resolveFramebuffer);
    gl.deleteRenderbuffer(depthBuffer);
    gl.deleteRenderbuffer(colorBuffer);
    gl.bindRenderbuffer(gl.RENDERBUFFER, null);
    ctx.bindFramebuffer(gl.FRAMEBUFFER, ctx.framebuffer);
    throw error;
  }

  gl.deleteTexture(ctx.texture);
  gl.deleteFramebuffer(ctx.framebuffer);
  gl.deleteFramebuffer(ctx.resolveFramebuffer);
  gl.deleteRenderbuffer(ctx.depthBuffer);
  gl.deleteRenderbuffer(ctx.colorBuffer);
  ctx.texture = texture;
  ctx.framebuffer = framebuffer;
  ctx.resolveFramebuffer = resolveFramebuffer;
  ctx.colorBuffer = colorBuffer;
  ctx.depthBuffer = depthBuffer;
  ctx.antiAlias = antiAlias;
  ctx.width = width;
  ctx.height = height;
  ctx.drawnWidth = drawnWidth;
  ctx.drawnHeight = drawnHeight;
  ctx.scale = scale;
  gl.canvas.width = drawnWidth;
  gl.canvas.height = drawnHeight;
  showAt(ctx);
  // Readback's storage waits for a read: a back buffer as large as a 4K screen is 33 MB each.
  ctx.pixels = new Uint8Array(0);
  ctx.topDown = new Uint8Array(0);
  ctx.applyScissor();
  ctx.clear(0, 0, 0, 1);
}

/**
 * Shown at the size asked for, in CSS pixels, as an unstyled canvas of that size would be,
 * divided by its scale: a best-resolution back buffer shows its pixels at the screen's.
 */
function showAt(ctx: WebGLContext3D): void {
  const style = (ctx.gl.canvas as Partial<HTMLCanvasElement>).style;
  if (!style) {
    return;
  }

  const plain = ctx.scale === 1;
  style.width = plain && ctx.drawnWidth === ctx.width ? "" : `${ctx.width / ctx.scale}px`;
  style.height = plain && ctx.drawnHeight === ctx.height ? "" : `${ctx.height / ctx.scale}px`;
}

/** The largest back buffer storage the GPU gives: a texture, a renderbuffer and a viewport. */
function storageLimit(ctx: WebGLContext3D): Int32Array {
  if (!ctx.gpuMost) {
    const gl = ctx.gl;
    const viewport = gl.getParameter(gl.MAX_VIEWPORT_DIMS) as Int32Array;
    const side = Math.min(
      gl.getParameter(gl.MAX_TEXTURE_SIZE) as number,
      gl.getParameter(gl.MAX_RENDERBUFFER_SIZE) as number,
    );
    ctx.gpuMost = Int32Array.of(Math.min(side, viewport[0]), Math.min(side, viewport[1]));
  }

  return ctx.gpuMost;
}

export function unconfigureBackBuffer(ctx: WebGLContext3D): void {
  ctx.alive();
  if (ctx.renderTexture) {
    throw new Context3DError(
      "operation",
      "Context3D experiment: resize while rendering to texture",
    );
  }

  const gl = ctx.gl;
  gl.deleteTexture(ctx.texture);
  gl.deleteFramebuffer(ctx.framebuffer);
  gl.deleteFramebuffer(ctx.resolveFramebuffer);
  gl.deleteRenderbuffer(ctx.depthBuffer);
  gl.deleteRenderbuffer(ctx.colorBuffer);
  ctx.drawState.forget();
  ctx.texture = null;
  ctx.framebuffer = null;
  ctx.resolveFramebuffer = null;
  ctx.colorBuffer = null;
  ctx.depthBuffer = null;
  ctx.resolveDirty = false;
  ctx.antiAlias = 0;
  ctx.scale = 1;
  ctx.width = 0;
  ctx.height = 0;
  ctx.drawnWidth = 0;
  ctx.drawnHeight = 0;
  ctx.pixels = new Uint8Array(0);
  ctx.topDown = new Uint8Array(0);
}

export function resolveBackBuffer(ctx: WebGLContext3D): void {
  if (!ctx.resolveFramebuffer) {
    return;
  }

  const gl = ctx.gl;
  if (ctx.resolveDirty) {
    ctx.bindFramebuffer(gl.READ_FRAMEBUFFER, ctx.framebuffer);
    ctx.bindFramebuffer(gl.DRAW_FRAMEBUFFER, ctx.resolveFramebuffer);
    if (ctx.scissor) {
      gl.disable(gl.SCISSOR_TEST);
    }
    gl.blitFramebuffer(
      0,
      0,
      ctx.drawnWidth,
      ctx.drawnHeight,
      0,
      0,
      ctx.drawnWidth,
      ctx.drawnHeight,
      gl.COLOR_BUFFER_BIT,
      gl.NEAREST,
    );
    if (ctx.scissor) {
      gl.enable(gl.SCISSOR_TEST);
    }
    ctx.resolveDirty = false;
  }
  ctx.bindFramebuffer(gl.READ_FRAMEBUFFER, ctx.resolveFramebuffer);
}

export function presentBackBuffer(ctx: WebGLContext3D): void {
  ctx.setRenderTarget(null);
  ctx.target();
  resolveBackBuffer(ctx);
  const gl = ctx.gl;
  ctx.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
  if (ctx.scissor) {
    gl.disable(gl.SCISSOR_TEST);
  }
  // To the drawing buffer the browser gave, which it may have made smaller than the canvas.
  gl.blitFramebuffer(
    0,
    0,
    ctx.drawnWidth,
    ctx.drawnHeight,
    0,
    0,
    gl.drawingBufferWidth,
    gl.drawingBufferHeight,
    gl.COLOR_BUFFER_BIT,
    gl.NEAREST,
  );
  if (ctx.scissor) {
    gl.enable(gl.SCISSOR_TEST);
  }
  gl.flush();
}
