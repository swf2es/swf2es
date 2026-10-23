import type { Texture3D } from "../backend.js";
import { Context3DError } from "../errors.js";
import type { TextureState } from "./textures.js";

export interface MultisampleTarget {
  framebuffer: WebGLFramebuffer;
  color: WebGLRenderbuffer;
  depth: WebGLRenderbuffer | null;
  samples: number;
  resolve: WebGLFramebuffer | null;
  texture: WebGLTexture | null;
  valid: boolean;
  dirty: boolean;
  face: number;
  depthAttached: boolean;
}

export function selectSamples(gl: WebGL2RenderingContext, quality: number, depth: boolean): number {
  if (!Number.isInteger(quality)) {
    throw new Context3DError("operation", "Context3D experiment: invalid antialiasing quality");
  }
  if (quality < 2) {
    return 0;
  }

  const color: Int32Array = gl.getInternalformatParameter(gl.RENDERBUFFER, gl.RGBA8, gl.SAMPLES);
  const stencil: Int32Array | null = depth
    ? gl.getInternalformatParameter(gl.RENDERBUFFER, gl.DEPTH24_STENCIL8, gl.SAMPLES)
    : null;
  let samples = 0;
  // Quality is a hardware-dependent request; bound this experiment to 4x.
  for (let i = 0; i < color.length; i++) {
    const count = color[i];
    if (count > samples && count <= Math.min(quality, 4) && (!stencil || stencil.includes(count))) {
      samples = count;
    }
  }

  return samples;
}

export function targetFramebuffer(state: TextureState): WebGLFramebuffer | null {
  return state.samples ? (state.multisample?.framebuffer ?? null) : state.framebuffer;
}

export function resolveTarget(
  gl: WebGL2RenderingContext,
  texture: Texture3D,
  state: TextureState,
  face: number,
  scissor: boolean,
): void {
  const target = state.multisample;
  if (!state.samples || !target?.dirty) {
    return;
  }

  gl.bindFramebuffer(gl.READ_FRAMEBUFFER, target.framebuffer);
  gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, target.resolve ?? state.framebuffer);
  if (scissor) {
    gl.disable(gl.SCISSOR_TEST);
  }
  gl.blitFramebuffer(
    0,
    0,
    texture.width,
    texture.height,
    0,
    0,
    texture.width,
    texture.height,
    gl.COLOR_BUFFER_BIT,
    gl.NEAREST,
  );
  if (target.resolve) {
    // SwiftShader corrupts direct multisample blits into cube faces.
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, target.resolve);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_CUBE_MAP, state.handle);
    gl.copyTexSubImage2D(
      gl.TEXTURE_CUBE_MAP_POSITIVE_X + face,
      0,
      0,
      0,
      0,
      0,
      texture.width,
      texture.height,
    );
  }
  target.dirty = false;
}

export function deleteMultisample(gl: WebGL2RenderingContext, target: MultisampleTarget): void {
  gl.deleteFramebuffer(target.framebuffer);
  gl.deleteRenderbuffer(target.color);
  gl.deleteRenderbuffer(target.depth);
  gl.deleteFramebuffer(target.resolve);
  gl.deleteTexture(target.texture);
}

export function allocateMultisample(
  gl: WebGL2RenderingContext,
  texture: Texture3D,
  old: MultisampleTarget | null,
  samples: number,
  depth: boolean,
  depthWrite: boolean,
  stencilWrite: number,
): MultisampleTarget {
  const same = old?.samples === samples;
  const newDepth = depth && (!same || !old.depth);
  const framebuffer = same ? old.framebuffer : gl.createFramebuffer();
  const color = same ? old.color : gl.createRenderbuffer();
  const depthBuffer = newDepth ? gl.createRenderbuffer() : same ? old.depth : null;
  const resolve = same ? old.resolve : texture.cube ? gl.createFramebuffer() : null;
  const resolved = same ? old.texture : texture.cube ? gl.createTexture() : null;
  try {
    if (texture.cube && (!resolve || !resolved)) {
      throw new Context3DError(
        "operation",
        "Context3D experiment: cannot allocate cube resolve target",
      );
    }
    if (texture.cube && !same) {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, resolved);
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, texture.width, texture.height);
      gl.bindFramebuffer(gl.FRAMEBUFFER, resolve);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, resolved, 0);
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
        throw new Context3DError(
          "operation",
          "Context3D experiment: incomplete cube resolve target",
        );
      }
    }
    if (!framebuffer || !color || (newDepth && !depthBuffer)) {
      throw new Context3DError(
        "operation",
        "Context3D experiment: cannot allocate multisample target",
      );
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    if (!same) {
      gl.bindRenderbuffer(gl.RENDERBUFFER, color);
      gl.renderbufferStorageMultisample(
        gl.RENDERBUFFER,
        samples,
        gl.RGBA8,
        texture.width,
        texture.height,
      );
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, color);
    }
    if (newDepth) {
      gl.bindRenderbuffer(gl.RENDERBUFFER, depthBuffer);
      gl.renderbufferStorageMultisample(
        gl.RENDERBUFFER,
        samples,
        gl.DEPTH24_STENCIL8,
        texture.width,
        texture.height,
      );
    }
    gl.framebufferRenderbuffer(
      gl.FRAMEBUFFER,
      gl.DEPTH_STENCIL_ATTACHMENT,
      gl.RENDERBUFFER,
      depth ? depthBuffer : null,
    );
    if (
      (!same || newDepth) &&
      gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE
    ) {
      throw new Context3DError("operation", "Context3D experiment: incomplete multisample target");
    }
  } catch (error) {
    if (!same) {
      gl.deleteFramebuffer(framebuffer);
      gl.deleteRenderbuffer(color);
      gl.deleteFramebuffer(resolve);
      gl.deleteTexture(resolved);
    } else {
      gl.bindFramebuffer(gl.FRAMEBUFFER, old.framebuffer);
      gl.framebufferRenderbuffer(
        gl.FRAMEBUFFER,
        gl.DEPTH_STENCIL_ATTACHMENT,
        gl.RENDERBUFFER,
        old.depthAttached ? old.depth : null,
      );
    }
    if (newDepth) {
      gl.deleteRenderbuffer(depthBuffer);
    }
    throw error;
  }

  if (newDepth) {
    gl.disable(gl.SCISSOR_TEST);
    gl.depthMask(true);
    gl.stencilMask(255);
    gl.clearDepth(1);
    gl.clearStencil(0);
    gl.clear(gl.DEPTH_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);
    gl.depthMask(depthWrite);
    gl.stencilMask(stencilWrite);
  }

  if (same) {
    old.depth = depthBuffer;
    old.depthAttached = depth;
    return old;
  }

  return {
    framebuffer,
    color,
    depth: depthBuffer,
    samples,
    resolve,
    texture: resolved,
    valid: false,
    dirty: false,
    face: 0,
    depthAttached: depth,
  };
}
