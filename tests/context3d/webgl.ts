import { type ProgramType, type SamplerSource, type ShaderSource, translate } from "./agal.ts";
import {
  type BlendFactor,
  type Buffer3D,
  type CompareMode,
  type Context3D,
  type Context3DLifecycle,
  type CullFace,
  type Program3D,
  ScissorBoundsError,
  type Texture3D,
  TextureBindingError,
} from "./backend.ts";

const DEPTH_FUNCTIONS = {
  always: "ALWAYS",
  never: "NEVER",
  less: "LESS",
  lessEqual: "LEQUAL",
  equal: "EQUAL",
  notEqual: "NOTEQUAL",
  greaterEqual: "GEQUAL",
  greater: "GREATER",
} as const;

const BLEND_FUNCTIONS = {
  zero: "ZERO",
  one: "ONE",
  sourceColor: "SRC_COLOR",
  oneMinusSourceColor: "ONE_MINUS_SRC_COLOR",
  sourceAlpha: "SRC_ALPHA",
  oneMinusSourceAlpha: "ONE_MINUS_SRC_ALPHA",
  destinationColor: "DST_COLOR",
  oneMinusDestinationColor: "ONE_MINUS_DST_COLOR",
  destinationAlpha: "DST_ALPHA",
  oneMinusDestinationAlpha: "ONE_MINUS_DST_ALPHA",
} as const;

function range(start: number, count: number, length: number): void {
  if (
    !Number.isInteger(start) ||
    !Number.isInteger(count) ||
    start < 0 ||
    count < 0 ||
    start > length - count
  ) {
    throw new Error("Context3D experiment: range outside resource");
  }
}

interface BufferState {
  handle: WebGLBuffer;
  indices: Uint16Array | null;
  uploaded: Uint8Array;
}

interface ProgramState {
  handle: WebGLProgram | null;
  targetY: WebGLUniformLocation | null;
  attributes: number[];
  vertex: (WebGLUniformLocation | null)[];
  fragment: (WebGLUniformLocation | null)[];
  samplers: { source: SamplerSource; location: WebGLUniformLocation | null }[];
  samplerMask: number;
}

interface TextureState {
  handle: WebGLTexture;
  bytes: Uint8Array;
  uploaded: Uint16Array;
  framebuffer: WebGLFramebuffer | null;
  depthBuffer: WebGLRenderbuffer | null;
  dirty: boolean;
}

/** An owned WebGL2 context, deliberately independent of the 2D renderer. */
export class WebGLContext3D implements Context3D {
  readonly gl: WebGL2RenderingContext;
  width = 0;
  height = 0;
  disposed = false;
  private readonly buffers = new Map<Buffer3D, BufferState>();
  private bufferBytes = 0;
  private readonly programs = new Map<Program3D, ProgramState>();
  private readonly textures = new Map<Texture3D, TextureState>();
  private readonly textureOwners = new WeakSet<Texture3D>();
  private textureBytes = 0;
  private targetDepthBytes = 0;
  private renderTexture: Texture3D | null = null;
  private renderDepth = false;
  private readonly textureSlots: (Texture3D | null)[] = new Array(8).fill(null);
  private textureMask = 0;
  private readonly samplers: (WebGLSampler | null)[] = new Array(12).fill(null);
  private readonly vertices: ({ buffer: Buffer3D; offset: number; size: number } | null)[] =
    new Array(8).fill(null);
  private selected: Program3D | null = null;
  private framebuffer: WebGLFramebuffer | null = null;
  private texture: WebGLTexture | null = null;
  private resolveFramebuffer: WebGLFramebuffer | null = null;
  private colorBuffer: WebGLRenderbuffer | null = null;
  private resolveDirty = false;
  private depthBuffer: WebGLRenderbuffer | null = null;
  private antiAlias = 0;
  private depthWrite = true;
  private colorWrite = 15;
  private scissor = false;
  private scissorLeft = 0;
  private scissorTop = 0;
  private scissorRight = 0;
  private scissorBottom = 0;
  private scissorOutside = false;
  private readonly vertexConstants = new Float32Array(128 * 4);
  private readonly fragmentConstants = new Float32Array(28 * 4);
  private pixels = new Uint8Array(0);
  private topDown = new Uint8Array(0);
  private readonly vao: WebGLVertexArrayObject;

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    const vao = gl.createVertexArray();
    if (!vao) {
      throw new Error("Context3D experiment: cannot create vertex array");
    }

    this.vao = vao;
    gl.bindVertexArray(vao);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LESS);
    gl.depthMask(true);
    gl.colorMask(true, true, true, true);
    gl.disable(gl.STENCIL_TEST);
    gl.disable(gl.BLEND);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.SCISSOR_TEST);
    // Stage3D front faces are clockwise in clip-space XY.
    gl.frontFace(gl.CW);
    gl.disable(gl.DITHER);
  }

  private alive(): void {
    if (this.disposed || this.gl.isContextLost()) {
      throw new Error("Context3D experiment: context disposed or lost");
    }
  }

  private target(back = false): void {
    this.alive();
    if (!this.framebuffer) {
      throw new Error("Context3D experiment: configure the back buffer first");
    }

    const texture = back ? null : this.renderTexture;
    this.gl.bindFramebuffer(
      this.gl.FRAMEBUFFER,
      texture ? this.textureState(texture).framebuffer : this.framebuffer,
    );
    this.gl.viewport(0, 0, texture?.width ?? this.width, texture?.height ?? this.height);
  }

  private samples(quality: number, depth: boolean): number {
    if (!Number.isInteger(quality)) {
      throw new Error("Context3D experiment: invalid antialiasing quality");
    }
    if (quality < 2) {
      return 0;
    }

    const gl = this.gl;
    const color: Int32Array = gl.getInternalformatParameter(gl.RENDERBUFFER, gl.RGBA8, gl.SAMPLES);
    const stencil: Int32Array | null = depth
      ? gl.getInternalformatParameter(gl.RENDERBUFFER, gl.DEPTH24_STENCIL8, gl.SAMPLES)
      : null;
    let samples = 0;
    // Quality is a hardware-dependent request; bound this experiment to 4x.
    for (let i = 0; i < color.length; i++) {
      const count = color[i];
      if (
        count > samples &&
        count <= Math.min(quality, 4) &&
        (!stencil || stencil.includes(count))
      ) {
        samples = count;
      }
    }

    return samples;
  }

  configure(width: number, height: number, depth = false, antiAlias = 0): void {
    this.alive();
    range(32, width - 32, 2048);
    range(32, height - 32, 2048);
    if (this.renderTexture) {
      throw new Error("Context3D experiment: resize while rendering to texture");
    }

    // AIR preserves color, depth and bindings when the request is unchanged.
    // Shadow passes can issue this every frame when returning to the back buffer.
    if (
      this.framebuffer &&
      width === this.width &&
      height === this.height &&
      depth === (this.depthBuffer !== null) &&
      antiAlias === this.antiAlias
    ) {
      return;
    }

    const samples = this.samples(antiAlias, depth);
    const gl = this.gl;
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
        throw new Error("Context3D experiment: cannot allocate back buffer");
      }

      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.bindFramebuffer(gl.FRAMEBUFFER, resolveFramebuffer ?? framebuffer);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
      if (resolveFramebuffer) {
        if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
          throw new Error("Context3D experiment: incomplete resolve buffer");
        }

        gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
        gl.bindRenderbuffer(gl.RENDERBUFFER, colorBuffer);
        gl.renderbufferStorageMultisample(gl.RENDERBUFFER, samples, gl.RGBA8, width, height);
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
            width,
            height,
          );
        } else {
          gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH24_STENCIL8, width, height);
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
        throw new Error("Context3D experiment: incomplete back buffer");
      }
    } catch (error) {
      gl.deleteTexture(texture);
      gl.deleteFramebuffer(framebuffer);
      gl.deleteFramebuffer(resolveFramebuffer);
      gl.deleteRenderbuffer(depthBuffer);
      gl.deleteRenderbuffer(colorBuffer);
      gl.bindRenderbuffer(gl.RENDERBUFFER, null);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
      throw error;
    }

    gl.deleteTexture(this.texture);
    gl.deleteFramebuffer(this.framebuffer);
    gl.deleteFramebuffer(this.resolveFramebuffer);
    gl.deleteRenderbuffer(this.depthBuffer);
    gl.deleteRenderbuffer(this.colorBuffer);
    this.texture = texture;
    this.framebuffer = framebuffer;
    this.resolveFramebuffer = resolveFramebuffer;
    this.colorBuffer = colorBuffer;
    this.depthBuffer = depthBuffer;
    this.antiAlias = antiAlias;
    this.width = width;
    this.height = height;
    gl.canvas.width = width;
    gl.canvas.height = height;
    this.pixels = new Uint8Array(width * height * 4);
    this.topDown = new Uint8Array(this.pixels.length);
    this.applyScissor();
    this.clear(0, 0, 0, 1);
  }

  clear(
    red: number,
    green: number,
    blue: number,
    alpha: number,
    depth = 1,
    mask = 0xffffffff,
  ): void {
    this.target();
    const gl = this.gl;
    let bits = 0;
    if (mask & 1) {
      gl.clearColor(red, green, blue, alpha);
      bits |= gl.COLOR_BUFFER_BIT;
      this.changedTarget();
    }
    if (mask & 2) {
      gl.clearDepth(depth);
      bits |= gl.DEPTH_BUFFER_BIT;
    }
    if (mask & 4) {
      gl.clearStencil(0);
      bits |= gl.STENCIL_BUFFER_BIT;
    }

    // Flash clear writes depth even while draw-time depth writes are masked.
    const hasDepth = this.renderTexture ? this.renderDepth : this.depthBuffer !== null;
    const overrideDepth = hasDepth && (mask & 2) !== 0 && !this.depthWrite;
    if (overrideDepth) {
      gl.depthMask(true);
    }

    // AIR clears every color channel regardless of the draw-time mask.
    const overrideColor = (mask & 1) !== 0 && this.colorWrite !== 15;
    if (overrideColor) {
      gl.colorMask(true, true, true, true);
    }

    if (this.scissor) {
      gl.disable(gl.SCISSOR_TEST);
    }
    gl.clear(bits);
    if (this.scissor) {
      gl.enable(gl.SCISSOR_TEST);
    }
    if (overrideDepth) {
      gl.depthMask(false);
    }
    if (overrideColor) {
      this.applyColorMask();
    }
  }

  setColorMask(red: boolean, green: boolean, blue: boolean, alpha: boolean): void {
    this.alive();
    const mask = (red ? 1 : 0) | (green ? 2 : 0) | (blue ? 4 : 0) | (alpha ? 8 : 0);
    if (mask === this.colorWrite) {
      return;
    }

    this.colorWrite = mask;
    this.applyColorMask();
  }

  private applyColorMask(): void {
    const mask = this.colorWrite;
    this.gl.colorMask((mask & 1) !== 0, (mask & 2) !== 0, (mask & 4) !== 0, (mask & 8) !== 0);
  }

  setDepth(write: boolean, compare: CompareMode): void {
    this.alive();
    this.depthWrite = write;
    this.gl.depthMask(write);
    this.gl.depthFunc(this.gl[DEPTH_FUNCTIONS[compare]]);
  }

  setScissor(x: number | null, y = 0, width = 0, height = 0): void {
    this.alive();
    if (
      x !== null &&
      (!Number.isFinite(x) ||
        !Number.isFinite(y) ||
        !Number.isFinite(width) ||
        !Number.isFinite(height))
    ) {
      throw new Error("Context3D experiment: non-finite scissor rectangle");
    }

    this.scissor = x !== null;
    if (x !== null) {
      // AIR rounds the edges, not the width/height, and copies the rectangle.
      this.scissorLeft = Math.floor(x + 0.5);
      this.scissorTop = Math.floor(y + 0.5);
      this.scissorRight = Math.floor(x + width + 0.5);
      this.scissorBottom = Math.floor(y + height + 0.5);
      this.scissor = this.scissorRight > this.scissorLeft && this.scissorBottom > this.scissorTop;
    }

    this.applyScissor();
  }

  private applyScissor(): void {
    const gl = this.gl;
    if (!this.scissor) {
      this.scissorOutside = false;
      gl.disable(gl.SCISSOR_TEST);
      return;
    }

    const width = this.renderTexture?.width ?? this.width;
    const height = this.renderTexture?.height ?? this.height;
    const left = Math.max(0, Math.min(width, this.scissorLeft));
    const top = Math.max(0, Math.min(height, this.scissorTop));
    const right = Math.max(0, Math.min(width, this.scissorRight));
    const bottom = Math.max(0, Math.min(height, this.scissorBottom));
    this.scissorOutside = right <= left || bottom <= top;
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(
      left,
      this.renderTexture ? top : height - bottom,
      Math.max(0, right - left),
      Math.max(0, bottom - top),
    );
  }

  setBlend(source: BlendFactor, destination: BlendFactor): void {
    this.alive();
    const gl = this.gl;
    if (source === "one" && destination === "zero") {
      gl.disable(gl.BLEND);
    } else {
      gl.blendFunc(gl[BLEND_FUNCTIONS[source]], gl[BLEND_FUNCTIONS[destination]]);
      gl.enable(gl.BLEND);
    }
  }

  setCulling(face: CullFace): void {
    this.alive();
    const gl = this.gl;
    if (face === "none") {
      gl.disable(gl.CULL_FACE);
      return;
    }

    gl.enable(gl.CULL_FACE);
    switch (face) {
      case "back":
        gl.cullFace(gl.BACK);
        break;
      case "front":
        gl.cullFace(gl.FRONT);
        break;
      case "frontAndBack":
        gl.cullFace(gl.FRONT_AND_BACK);
        break;
    }
  }

  createBuffer(count: number, stride: number): Buffer3D {
    this.alive();
    range(1, count - 1, stride === 0 ? 524287 : 65535);
    range(0, stride, 64);
    if (this.buffers.size >= 128) {
      throw new Error("Context3D experiment: buffer limit");
    }

    const gl = this.gl;
    const handle = gl.createBuffer();
    if (!handle) {
      throw new Error("Context3D experiment: cannot allocate buffer");
    }

    const target = stride === 0 ? gl.ELEMENT_ARRAY_BUFFER : gl.ARRAY_BUFFER;
    const bytes = count * (stride === 0 ? 2 : stride * 4);
    if (this.bufferBytes + bytes > 64 * 1024 * 1024) {
      gl.deleteBuffer(handle);
      throw new Error("Context3D experiment: buffer memory limit");
    }

    gl.bindVertexArray(this.vao);
    gl.bindBuffer(target, handle);
    gl.bufferData(target, bytes, gl.STATIC_DRAW);
    const state: BufferState = {
      handle,
      indices: stride === 0 ? new Uint16Array(count) : null,
      uploaded: new Uint8Array(count),
    };
    const buffer: Buffer3D = {
      count,
      stride,
      upload: (values, start, amount) => {
        this.alive();
        this.buffer(buffer);
        range(start, amount, count);
        const size = stride || 1;
        range(0, amount * size, values.length);
        const data = stride === 0 ? new Uint16Array(amount) : new Float32Array(amount * stride);
        for (let i = 0; i < data.length; i++) {
          data[i] = values[i];
        }

        state.indices?.set(data, start);
        state.uploaded.fill(1, start, start + amount);
        gl.bindVertexArray(this.vao);
        gl.bindBuffer(target, handle);
        gl.bufferSubData(target, start * size * (stride === 0 ? 2 : 4), data);
      },
      dispose: () => {
        if (!this.buffers.delete(buffer)) {
          return;
        }

        gl.deleteBuffer(handle);
        this.bufferBytes -= bytes;
        state.indices = null;
        state.uploaded = new Uint8Array(0);
        for (let i = 0; i < this.vertices.length; i++) {
          if (this.vertices[i]?.buffer === buffer) {
            this.vertices[i] = null;
          }
        }
      },
    };
    this.buffers.set(buffer, state);
    this.bufferBytes += bytes;
    return buffer;
  }

  private buffer(buffer: Buffer3D): BufferState {
    const state = this.buffers.get(buffer);
    if (!state) {
      throw new Error("Context3D experiment: buffer disposed or from another context");
    }

    return state;
  }

  createProgram(): Program3D {
    this.alive();
    if (this.programs.size >= 128) {
      throw new Error("Context3D experiment: program limit");
    }

    const state: ProgramState = {
      handle: null,
      targetY: null,
      attributes: [],
      vertex: [],
      fragment: [],
      samplers: [],
      samplerMask: 0,
    };
    const program: Program3D = {
      upload: (vertex, fragment) => {
        this.alive();
        this.program(program);
        // Translate both before allocating anything on the GPU.
        const vs = translate(vertex, "vertex");
        const fs = translate(fragment, "fragment");
        const handle = this.link(vs, fs);
        const gl = this.gl;
        if (state.handle && gl.getParameter(gl.CURRENT_PROGRAM) === state.handle) {
          gl.useProgram(null);
        }

        gl.deleteProgram(state.handle);
        state.handle = handle;
        state.targetY = gl.getUniformLocation(handle, "targetY");
        state.attributes = vs.attributes;
        state.vertex = [];
        state.fragment = [];
        state.samplers = [];
        state.samplerMask = 0;
        for (let i = 0; i < vs.constants.length; i++) {
          const index = vs.constants[i];
          state.vertex[index] = gl.getUniformLocation(handle, `vc${index}`);
        }

        for (let i = 0; i < fs.constants.length; i++) {
          const index = fs.constants[i];
          state.fragment[index] = gl.getUniformLocation(handle, `fc${index}`);
        }

        for (let i = 0; i < fs.samplers.length; i++) {
          const source = fs.samplers[i];
          state.samplerMask |= 1 << source.index;
          state.samplers.push({
            source,
            location: gl.getUniformLocation(handle, `fs${source.index}`),
          });
        }
      },
      dispose: () => {
        if (!this.programs.delete(program)) {
          return;
        }

        // WebGL keeps a deleted program alive while it is still current.
        if (this.gl.getParameter(this.gl.CURRENT_PROGRAM) === state.handle) {
          this.gl.useProgram(null);
        }

        this.gl.deleteProgram(state.handle);
        state.handle = null;
        state.targetY = null;
        state.attributes.length = 0;
        state.vertex.length = 0;
        state.fragment.length = 0;
        state.samplers.length = 0;
        state.samplerMask = 0;
        if (this.selected === program) {
          this.selected = null;
        }
      },
    };
    this.programs.set(program, state);
    return program;
  }

  private program(program: Program3D): ProgramState {
    const state = this.programs.get(program);
    if (!state) {
      throw new Error("Context3D experiment: program disposed or from another context");
    }

    return state;
  }

  createTexture(width: number, height: number, cube = false): Texture3D {
    this.alive();
    range(1, width - 1, 2048);
    range(1, height - 1, 2048);
    if (cube && (width !== height || width > 1024)) {
      throw new Error("Context3D experiment: cube faces must be square and at most 1024");
    }

    const faces = cube ? 6 : 1;
    const levels = 1 + Math.floor(Math.log2(Math.max(width, height)));
    let size = 0;
    for (let level = 0; level < levels; level++) {
      size += Math.max(1, width >> level) * Math.max(1, height >> level) * 4 * faces;
    }
    if (
      width & (width - 1) ||
      height & (height - 1) ||
      this.textures.size >= 128 ||
      this.textureBytes + size > 64 * 1024 * 1024
    ) {
      throw new Error("Context3D experiment: texture size or memory limit");
    }

    const bytes = new Uint8Array(width * height * 4);
    const gl = this.gl;
    const handle = gl.createTexture();
    if (!handle) {
      throw new Error("Context3D experiment: cannot create texture");
    }

    gl.activeTexture(gl.TEXTURE0);
    const target = cube ? gl.TEXTURE_CUBE_MAP : gl.TEXTURE_2D;
    gl.bindTexture(target, handle);
    gl.texStorage2D(target, levels, gl.RGBA8, width, height);
    const state: TextureState = {
      handle,
      bytes,
      uploaded: new Uint16Array(faces),
      framebuffer: null,
      depthBuffer: null,
      dirty: false,
    };
    const texture: Texture3D = {
      width,
      height,
      levels,
      cube,
      upload: (pixels, level = 0, face = 0) => {
        this.alive();
        this.textureState(texture);
        range(level, 1, levels);
        range(face, 1, faces);
        const w = Math.max(1, width >> level);
        const h = Math.max(1, height >> level);
        if (pixels.length !== w * h) {
          throw new Error("Context3D experiment: texture upload size mismatch");
        }

        for (let i = 0; i < pixels.length; i++) {
          const pixel = pixels[i];
          const at = i * 4;
          state.bytes[at] = pixel >>> 16;
          state.bytes[at + 1] = pixel >>> 8;
          state.bytes[at + 2] = pixel;
          state.bytes[at + 3] = pixel >>> 24;
        }

        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(target, handle);
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
      },
      dispose: () => {
        if (!this.textures.delete(texture)) {
          return;
        }

        if (this.renderTexture === texture) {
          this.renderTexture = null;
          this.renderDepth = false;
          gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
          gl.frontFace(gl.CW);
          this.applyScissor();
        }
        gl.deleteFramebuffer(state.framebuffer);
        gl.deleteRenderbuffer(state.depthBuffer);
        if (state.depthBuffer) {
          this.targetDepthBytes -= width * height * 4;
        }
        state.framebuffer = null;
        state.depthBuffer = null;

        for (let i = 0; i < this.textureSlots.length; i++) {
          if (this.textureSlots[i] === texture) {
            this.textureSlots[i] = null;
            this.textureMask &= ~(1 << i);
            gl.activeTexture(gl.TEXTURE0 + i);
            gl.bindTexture(target, null);
            gl.bindSampler(i, null);
          }
        }

        gl.deleteTexture(handle);
        state.bytes = new Uint8Array(0);
        this.textureBytes -= size;
      },
    };
    this.textures.set(texture, state);
    this.textureOwners.add(texture);
    this.textureBytes += size;

    return texture;
  }

  private textureState(texture: Texture3D): TextureState {
    const state = this.textures.get(texture);
    if (!state) {
      throw new Error("Context3D experiment: texture disposed or from another context");
    }

    return state;
  }

  setRenderTarget(texture: Texture3D | null, depth = false): void {
    this.alive();
    if (texture === this.renderTexture && (!texture || depth === this.renderDepth)) {
      return;
    }

    const gl = this.gl;
    if (texture) {
      const state = this.textureState(texture);
      if (texture.cube) {
        throw new Error("Context3D experiment: cube render targets are not supported");
      }
      if (texture.width < 8 || texture.height < 8) {
        throw new Error("Context3D experiment: render targets must be at least 8 by 8");
      }

      let framebuffer = state.framebuffer;
      let depthBuffer = state.depthBuffer;
      try {
        framebuffer ??= gl.createFramebuffer();
        if (!framebuffer) {
          throw new Error("Context3D experiment: cannot create texture framebuffer");
        }
        gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
        gl.framebufferTexture2D(
          gl.FRAMEBUFFER,
          gl.COLOR_ATTACHMENT0,
          gl.TEXTURE_2D,
          state.handle,
          0,
        );
        if (depth && !depthBuffer) {
          if (this.targetDepthBytes + texture.width * texture.height * 4 > 64 * 1024 * 1024) {
            throw new Error("Context3D experiment: target depth memory limit");
          }
          depthBuffer = gl.createRenderbuffer();
          if (!depthBuffer) {
            throw new Error("Context3D experiment: cannot create texture depth buffer");
          }
          gl.bindRenderbuffer(gl.RENDERBUFFER, depthBuffer);
          gl.renderbufferStorage(
            gl.RENDERBUFFER,
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
          (!state.framebuffer || (depth && !state.depthBuffer)) &&
          gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE
        ) {
          throw new Error("Context3D experiment: incomplete texture framebuffer");
        }
      } catch (error) {
        if (framebuffer !== state.framebuffer) {
          gl.deleteFramebuffer(framebuffer);
        } else if (framebuffer) {
          // Restore the attachment if this was the currently selected target.
          gl.framebufferRenderbuffer(
            gl.FRAMEBUFFER,
            gl.DEPTH_STENCIL_ATTACHMENT,
            gl.RENDERBUFFER,
            this.renderTexture === texture && this.renderDepth ? state.depthBuffer : null,
          );
        }
        if (depthBuffer !== state.depthBuffer) {
          gl.deleteRenderbuffer(depthBuffer);
        }
        gl.bindRenderbuffer(gl.RENDERBUFFER, null);
        gl.bindFramebuffer(
          gl.FRAMEBUFFER,
          this.renderTexture ? this.textureState(this.renderTexture).framebuffer : this.framebuffer,
        );
        throw error;
      }

      if (depthBuffer && !state.depthBuffer) {
        this.targetDepthBytes += texture.width * texture.height * 4;
        gl.disable(gl.SCISSOR_TEST);
        gl.depthMask(true);
        gl.clearDepth(1);
        gl.clearStencil(0);
        gl.clear(gl.DEPTH_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);
        gl.depthMask(this.depthWrite);
      }
      state.framebuffer = framebuffer;
      state.depthBuffer = depthBuffer;
      gl.bindRenderbuffer(gl.RENDERBUFFER, null);
    }

    this.finishTarget();
    this.renderTexture = texture;
    this.renderDepth = texture !== null && depth;
    gl.frontFace(texture ? gl.CCW : gl.CW);
    this.applyScissor();
  }

  private changedTarget(): void {
    if (this.renderTexture) {
      this.textureState(this.renderTexture).dirty = true;
    } else {
      this.resolveDirty = true;
    }
  }

  private finishTarget(): void {
    if (!this.renderTexture) {
      return;
    }
    const texture = this.renderTexture;
    const state = this.textureState(texture);
    if (state.dirty) {
      const gl = this.gl;
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, state.handle);
      gl.generateMipmap(gl.TEXTURE_2D);
      state.uploaded[0] = (1 << texture.levels) - 1;
      state.dirty = false;
    }
  }

  setTexture(index: number, texture: Texture3D | null): void {
    this.alive();
    range(index, 1, 8);
    if (texture && !this.textureOwners.has(texture)) {
      throw new Error("Context3D experiment: texture from another context");
    }

    // AIR accepts a disposed texture binding and reports 3663 when drawing.
    this.textureSlots[index] = texture;
    this.textureMask = (this.textureMask & ~(1 << index)) | (texture ? 1 << index : 0);
    if (!texture) {
      this.gl.activeTexture(this.gl.TEXTURE0 + index);
      this.gl.bindTexture(this.gl.TEXTURE_2D, null);
      this.gl.bindTexture(this.gl.TEXTURE_CUBE_MAP, null);
      this.gl.bindSampler(index, null);
    }
  }

  private sampler(source: SamplerSource): WebGLSampler {
    const index = source.mip * 4 + Number(source.linear) * 2 + Number(source.repeat);
    let sampler = this.samplers[index];
    if (!sampler) {
      const gl = this.gl;
      sampler = gl.createSampler();
      if (!sampler) {
        throw new Error("Context3D experiment: cannot create sampler");
      }

      const filter = source.linear ? gl.LINEAR : gl.NEAREST;
      let minFilter: number = filter;
      switch (source.mip) {
        case 1:
          minFilter = source.linear ? gl.LINEAR_MIPMAP_NEAREST : gl.NEAREST_MIPMAP_NEAREST;
          break;
        case 2:
          minFilter = source.linear ? gl.LINEAR_MIPMAP_LINEAR : gl.NEAREST_MIPMAP_LINEAR;
          break;
      }
      const wrap = source.repeat ? gl.REPEAT : gl.CLAMP_TO_EDGE;
      gl.samplerParameteri(sampler, gl.TEXTURE_MIN_FILTER, minFilter);
      gl.samplerParameteri(sampler, gl.TEXTURE_MAG_FILTER, filter);
      gl.samplerParameteri(sampler, gl.TEXTURE_WRAP_S, wrap);
      gl.samplerParameteri(sampler, gl.TEXTURE_WRAP_T, wrap);
      gl.samplerParameteri(sampler, gl.TEXTURE_WRAP_R, wrap);
      this.samplers[index] = sampler;
    }

    return sampler;
  }

  private link(vertex: ShaderSource, fragment: ShaderSource): WebGLProgram {
    const gl = this.gl;
    const v = gl.createShader(gl.VERTEX_SHADER);
    const f = gl.createShader(gl.FRAGMENT_SHADER);
    const p = gl.createProgram();
    let linked = false;
    let attached = false;
    try {
      if (!v || !f || !p) {
        throw new Error("Context3D experiment: cannot allocate shader");
      }

      gl.shaderSource(v, vertex.source);
      gl.shaderSource(f, fragment.source);
      gl.compileShader(v);
      gl.compileShader(f);
      if (
        !gl.getShaderParameter(v, gl.COMPILE_STATUS) ||
        !gl.getShaderParameter(f, gl.COMPILE_STATUS)
      ) {
        throw new Error(`Context3D shader: ${gl.getShaderInfoLog(v)} ${gl.getShaderInfoLog(f)}`);
      }

      gl.attachShader(p, v);
      gl.attachShader(p, f);
      attached = true;
      gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
        throw new Error(`Context3D link: ${gl.getProgramInfoLog(p)}`);
      }

      linked = true;
      return p;
    } finally {
      if (attached && p && v) {
        gl.detachShader(p, v);
      }
      if (attached && p && f) {
        gl.detachShader(p, f);
      }
      gl.deleteShader(v);
      gl.deleteShader(f);
      if (!linked) {
        gl.deleteProgram(p);
      }
    }
  }

  setProgram(program: Program3D): void {
    this.alive();
    if (!this.program(program).handle) {
      throw new Error("Context3D experiment: program not uploaded");
    }

    this.selected = program;
  }

  setVertex(index: number, buffer: Buffer3D | null, offset: number, size: number): void {
    this.alive();
    range(index, 1, 8);
    if (buffer === null) {
      this.vertices[index] = null;
      return;
    }

    this.buffer(buffer);
    range(1, size - 1, 4);
    range(offset, size, buffer.stride);
    this.vertices[index] = { buffer, offset, size };
  }

  setConstants(stage: ProgramType, first: number, values: ArrayLike<number>, count: number): void {
    this.alive();
    const dest = stage === "vertex" ? this.vertexConstants : this.fragmentConstants;
    range(first, count, dest.length / 4);
    range(0, count * 4, values.length);
    for (let i = 0; i < count * 4; i++) {
      dest[first * 4 + i] = values[i];
    }
  }

  draw(indices: Buffer3D, first: number, triangles: number): void {
    this.target();
    if (this.scissorOutside) {
      throw new ScissorBoundsError("Scissor rectangle does not intersect the target");
    }

    const index = this.buffer(indices);
    if (!index.indices || !this.selected) {
      throw new Error("Context3D experiment: draw needs indices and a program");
    }

    const state = this.program(this.selected);
    if (this.textureMask & ~state.samplerMask) {
      throw new TextureBindingError("unused");
    }

    for (let i = 0; i < state.samplers.length; i++) {
      const source = state.samplers[i].source;
      const texture = this.textureSlots[source.index];
      for (let j = i + 1; texture && j < state.samplers.length; j++) {
        const other = state.samplers[j].source;
        if (
          this.textureSlots[other.index] === texture &&
          (source.linear !== other.linear ||
            source.repeat !== other.repeat ||
            source.mip !== other.mip)
        ) {
          throw new TextureBindingError("conflicting");
        }
      }
    }

    const count = triangles === -1 ? indices.count - first : triangles * 3;
    range(first, count, indices.count);
    if (count % 3 !== 0) {
      throw new Error("Context3D experiment: incomplete triangle");
    }

    for (let i = first; i < first + count; i++) {
      if (!index.uploaded[i]) {
        throw new Error("Context3D experiment: index not uploaded");
      }
    }

    const gl = this.gl;
    gl.bindVertexArray(this.vao);
    for (let i = 0; i < 8; i++) {
      gl.disableVertexAttribArray(i);
    }

    for (let i = 0; i < state.attributes.length; i++) {
      const slot = state.attributes[i];
      const binding = this.vertices[slot];
      if (!binding) {
        throw new Error("Context3D experiment: missing vertex binding");
      }

      const buffer = this.buffer(binding.buffer);
      for (let j = first; j < first + count; j++) {
        if (!buffer.uploaded[index.indices[j]]) {
          throw new Error("Context3D experiment: vertex not uploaded or out of range");
        }
      }

      gl.bindBuffer(gl.ARRAY_BUFFER, buffer.handle);
      gl.enableVertexAttribArray(slot);
      gl.vertexAttribPointer(
        slot,
        binding.size,
        gl.FLOAT,
        false,
        binding.buffer.stride * 4,
        binding.offset * 4,
      );
    }

    gl.useProgram(state.handle);
    gl.uniform1f(state.targetY, this.renderTexture ? -1 : 1);
    for (let i = 0; i < state.samplers.length; i++) {
      const binding = state.samplers[i];
      const slot = binding.source.index;
      const texture = this.textureSlots[slot];
      if (texture && texture === this.renderTexture) {
        throw new TextureBindingError("feedback");
      }
      const resource = texture && this.textures.get(texture);
      if (!resource || !texture) {
        throw new TextureBindingError("missing");
      }
      if (texture.cube !== binding.source.cube) {
        throw new TextureBindingError("dimension");
      }
      if (texture.cube) {
        let uploaded = 0;
        for (let face = 0; face < 6; face++) {
          uploaded |= resource.uploaded[face];
        }
        if (!uploaded) {
          throw new TextureBindingError("unuploaded");
        }
      }
      for (let face = 0; face < resource.uploaded.length; face++) {
        if (!texture.cube && !(resource.uploaded[face] & 1)) {
          throw new TextureBindingError("unuploaded");
        }
        // AIR requires every cube face and mip even with mip filtering disabled.
        if (
          (texture.cube || binding.source.mip !== 0) &&
          resource.uploaded[face] !== (1 << texture.levels) - 1
        ) {
          throw new TextureBindingError("mipmaps");
        }
      }

      gl.activeTexture(gl.TEXTURE0 + slot);
      gl.bindTexture(texture.cube ? gl.TEXTURE_CUBE_MAP : gl.TEXTURE_2D, resource.handle);
      gl.bindSampler(slot, this.sampler(binding.source));
      gl.uniform1i(binding.location, slot);
    }

    this.uniforms(state.vertex, this.vertexConstants);
    this.uniforms(state.fragment, this.fragmentConstants);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, index.handle);
    gl.drawElements(gl.TRIANGLES, count, gl.UNSIGNED_SHORT, first * 2);
    this.changedTarget();
  }

  private uniforms(locations: (WebGLUniformLocation | null)[], data: Float32Array): void {
    for (let i = 0; i < locations.length; i++) {
      if (locations[i]) {
        this.gl.uniform4fv(locations[i], data, i * 4, 4);
      }
    }
  }

  private resolve(): void {
    if (!this.resolveFramebuffer) {
      return;
    }

    const gl = this.gl;
    if (this.resolveDirty) {
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.framebuffer);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.resolveFramebuffer);
      if (this.scissor) {
        gl.disable(gl.SCISSOR_TEST);
      }
      gl.blitFramebuffer(
        0,
        0,
        this.width,
        this.height,
        0,
        0,
        this.width,
        this.height,
        gl.COLOR_BUFFER_BIT,
        gl.NEAREST,
      );
      if (this.scissor) {
        gl.enable(gl.SCISSOR_TEST);
      }
      this.resolveDirty = false;
    }
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.resolveFramebuffer);
  }

  read(): Uint8Array {
    this.target(true);
    this.resolve();
    const gl = this.gl;
    gl.readPixels(0, 0, this.width, this.height, gl.RGBA, gl.UNSIGNED_BYTE, this.pixels);
    const row = this.width * 4;
    for (let y = 0; y < this.height; y++) {
      const from = (this.height - y - 1) * row;
      const to = y * row;
      for (let x = 0; x < row; x++) {
        this.topDown[to + x] = this.pixels[from + x];
      }
    }

    return this.topDown;
  }

  present(): void {
    this.setRenderTarget(null);
    this.target();
    this.resolve();
    const gl = this.gl;
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
    if (this.scissor) {
      gl.disable(gl.SCISSOR_TEST);
    }
    gl.blitFramebuffer(
      0,
      0,
      this.width,
      this.height,
      0,
      0,
      this.width,
      this.height,
      gl.COLOR_BUFFER_BIT,
      gl.NEAREST,
    );
    if (this.scissor) {
      gl.enable(gl.SCISSOR_TEST);
    }
    gl.flush();
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }

    this.disposed = true;
    for (const buffer of this.buffers.keys()) {
      buffer.dispose();
    }
    for (const program of this.programs.keys()) {
      program.dispose();
    }
    for (const texture of this.textures.keys()) {
      texture.dispose();
    }
    this.textureSlots.fill(null);
    this.textureMask = 0;
    for (let i = 0; i < this.samplers.length; i++) {
      this.gl.deleteSampler(this.samplers[i]);
      this.samplers[i] = null;
    }
    this.gl.bindVertexArray(null);
    this.gl.useProgram(null);
    this.gl.bindBuffer(this.gl.ARRAY_BUFFER, null);
    this.gl.bindBuffer(this.gl.ELEMENT_ARRAY_BUFFER, null);
    this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, null);
    this.gl.bindTexture(this.gl.TEXTURE_2D, null);
    this.gl.deleteVertexArray(this.vao);
    this.gl.deleteFramebuffer(this.framebuffer);
    this.gl.deleteFramebuffer(this.resolveFramebuffer);
    this.gl.deleteRenderbuffer(this.colorBuffer);
    this.gl.deleteTexture(this.texture);
    this.gl.deleteRenderbuffer(this.depthBuffer);
    this.framebuffer = null;
    this.resolveFramebuffer = null;
    this.colorBuffer = null;
    this.texture = null;
    this.depthBuffer = null;
    this.pixels = new Uint8Array(0);
    this.topDown = new Uint8Array(0);
  }
}

/** The surface outlives its lost resources so the browser can signal recovery. */
export function observeLoss(canvas: HTMLCanvasElement, lifecycle: Context3DLifecycle): () => void {
  const lost = (event: Event): void => {
    event.preventDefault();
    lifecycle.lost();
  };
  const restored = (): void => lifecycle.restored();
  canvas.addEventListener("webglcontextlost", lost);
  canvas.addEventListener("webglcontextrestored", restored);

  return () => {
    canvas.removeEventListener("webglcontextlost", lost);
    canvas.removeEventListener("webglcontextrestored", restored);
  };
}
