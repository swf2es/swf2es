import type { ProgramType } from "../agal.js";
import {
  type BlendFactor,
  type Buffer3D,
  type CompareMode,
  type Context3D,
  type CullFace,
  type Program3D,
  SAMPLER_FILTERS,
  SAMPLER_MIPS,
  SAMPLER_WRAPS,
  type SamplerFilter,
  type SamplerMip,
  type SamplerWrap,
  ScissorBoundsError,
  type StencilAction,
  type Texture3D,
  TextureBindingError,
  VERTEX_FORMATS,
  type VertexFormat,
  VertexOffsetError,
} from "../backend.js";
import { Context3DError } from "../errors.js";

import {
  type BufferState,
  uploadBuffer,
  uploadBufferBytes,
  type VertexBinding,
} from "./buffers.js";
import { resourceLimits, type WebGLContext3DLimits } from "./limits.js";
import {
  type CopyProgram,
  createCopyProgram,
  type ProgramState,
  uploadProgram,
} from "./programs.js";
import {
  BLEND_FUNCTIONS,
  DEPTH_FUNCTIONS,
  range,
  STENCIL_FUNCTIONS,
  StencilState,
} from "./state.js";
import {
  allocateMultisample,
  deleteMultisample,
  type MultisampleTarget,
  resolveTarget,
  selectSamples,
  targetFramebuffer,
} from "./targets.js";
import { type TextureState, uploadTexture, uploadTextureBytes } from "./textures.js";

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
  private targetColorBytes = 0;
  private copy2D: CopyProgram | null = null;
  private copyCube: CopyProgram | null = null;
  private readonly targetSamples = new Int8Array(10).fill(-1);
  private renderTexture: Texture3D | null = null;
  private renderDepth = false;
  private renderFace = 0;
  private readonly textureSlots: (Texture3D | null)[] = new Array(8).fill(null);
  private textureMask = 0;
  private readonly samplers: (WebGLSampler | null)[] = new Array(96).fill(null);
  // Two wrap bits, three filter bits and two mip bits fit each slot in one byte.
  private readonly samplerStates = new Uint8Array(16);
  private anisotropy: EXT_texture_filter_anisotropic | null | undefined;
  private maxAnisotropy = 1;
  private readonly vertices: (VertexBinding | null)[] = new Array(8).fill(null);
  private selected: Program3D | null = null;
  private framebuffer: WebGLFramebuffer | null = null;
  private texture: WebGLTexture | null = null;
  private resolveFramebuffer: WebGLFramebuffer | null = null;
  private colorBuffer: WebGLRenderbuffer | null = null;
  private resolveDirty = false;
  private depthBuffer: WebGLRenderbuffer | null = null;
  private antiAlias = 0;
  private depthWrite = true;
  private blendEnabled = false;
  private cullEnabled = false;
  private colorWrite = 15;
  private readonly stencilFront = new StencilState();
  private readonly stencilBack = new StencilState();
  private stencilEnabled = false;
  private stencilReference = 0;
  private stencilRead = 255;
  private stencilWrite = 255;
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
  private readonly limits: Readonly<WebGLContext3DLimits>;

  constructor(gl: WebGL2RenderingContext, limits: Partial<WebGLContext3DLimits> = {}) {
    this.limits = resourceLimits(limits);
    this.gl = gl;
    const vao = gl.createVertexArray();
    if (!vao) {
      throw new Context3DError("operation", "Context3D experiment: cannot create vertex array");
    }

    this.vao = vao;
    gl.bindVertexArray(vao);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LESS);
    gl.depthMask(true);
    gl.colorMask(true, true, true, true);
    gl.disable(gl.STENCIL_TEST);
    gl.stencilFunc(gl.ALWAYS, 0, 255);
    gl.stencilOp(gl.KEEP, gl.KEEP, gl.KEEP);
    gl.stencilMask(255);
    gl.disable(gl.BLEND);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.SCISSOR_TEST);
    // Stage3D front faces are clockwise in clip-space XY.
    gl.frontFace(gl.CW);
    gl.disable(gl.DITHER);
  }

  private alive(): void {
    if (this.disposed || this.gl.isContextLost()) {
      throw new Context3DError("disposed", "Context3D experiment: context disposed or lost");
    }
  }

  private target(back = false, discardColor = false): void {
    this.alive();
    if (!this.framebuffer) {
      throw new Context3DError(
        "backBuffer",
        "Context3D experiment: configure the back buffer first",
      );
    }

    const texture = back ? null : this.renderTexture;
    const state = texture && this.textureState(texture);
    if (texture && state?.samples && state.multisample && !state.multisample.valid) {
      if (discardColor) {
        state.multisample.valid = true;
      } else {
        this.seedTarget(texture, state);
      }
    }
    this.gl.bindFramebuffer(
      this.gl.FRAMEBUFFER,
      state ? targetFramebuffer(state) : this.framebuffer,
    );
    this.gl.viewport(0, 0, texture?.width ?? this.width, texture?.height ?? this.height);
  }

  configure(width: number, height: number, depth = false, antiAlias = 0): void {
    this.alive();
    range(32, width - 32, 2048);
    range(32, height - 32, 2048);
    if (this.renderTexture) {
      throw new Context3DError(
        "operation",
        "Context3D experiment: resize while rendering to texture",
      );
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

    const samples = selectSamples(this.gl, antiAlias, depth);
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
        throw new Context3DError("operation", "Context3D experiment: cannot allocate back buffer");
      }

      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.bindFramebuffer(gl.FRAMEBUFFER, resolveFramebuffer ?? framebuffer);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
      if (resolveFramebuffer) {
        if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
          throw new Context3DError("operation", "Context3D experiment: incomplete resolve buffer");
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
        throw new Context3DError("operation", "Context3D experiment: incomplete back buffer");
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
    stencil = 0,
  ): void {
    this.target(false, (mask & 1) !== 0);
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
      gl.clearStencil(Math.min(stencil >>> 0, 255));
      bits |= gl.STENCIL_BUFFER_BIT;
    }

    // Flash clear writes depth even while draw-time depth writes are masked.
    const hasDepth = this.renderTexture ? this.renderDepth : this.depthBuffer !== null;
    const overrideDepth = hasDepth && (mask & 2) !== 0 && !this.depthWrite;
    if (overrideDepth) {
      gl.depthMask(true);
    }

    const overrideStencil = hasDepth && (mask & 4) !== 0 && this.stencilWrite !== 255;
    if (overrideStencil) {
      gl.stencilMask(255);
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
    if (overrideStencil) {
      gl.stencilMask(this.stencilWrite);
    }
  }

  setStencilActions(
    face: CullFace,
    compare: CompareMode,
    pass: StencilAction,
    depthFail: StencilAction,
    stencilFail: StencilAction,
  ): void {
    this.alive();
    const gl = this.gl;
    if (face === "front" || face === "frontAndBack") {
      this.stencilFace(gl.FRONT, this.stencilFront, compare, pass, depthFail, stencilFail);
    }
    if (face === "back" || face === "frontAndBack") {
      this.stencilFace(gl.BACK, this.stencilBack, compare, pass, depthFail, stencilFail);
    }

    const enabled = this.stencilFront.active || this.stencilBack.active;
    if (enabled !== this.stencilEnabled) {
      this.stencilEnabled = enabled;
      if (enabled) {
        gl.enable(gl.STENCIL_TEST);
      } else {
        gl.disable(gl.STENCIL_TEST);
      }
    }
  }

  private stencilFace(
    face: number,
    state: StencilState,
    compare: CompareMode,
    pass: StencilAction,
    depthFail: StencilAction,
    stencilFail: StencilAction,
  ): void {
    const gl = this.gl;
    if (state.compare !== compare) {
      state.compare = compare;
      gl.stencilFuncSeparate(
        face,
        gl[DEPTH_FUNCTIONS[compare]],
        this.stencilReference,
        this.stencilRead,
      );
    }
    if (state.pass !== pass || state.depthFail !== depthFail || state.stencilFail !== stencilFail) {
      state.pass = pass;
      state.depthFail = depthFail;
      state.stencilFail = stencilFail;
      gl.stencilOpSeparate(
        face,
        gl[STENCIL_FUNCTIONS[stencilFail]],
        gl[STENCIL_FUNCTIONS[depthFail]],
        gl[STENCIL_FUNCTIONS[pass]],
      );
    }
  }

  setStencilReference(reference: number, readMask: number, writeMask: number): void {
    this.alive();
    reference &= 255;
    readMask &= 255;
    writeMask &= 255;
    const gl = this.gl;
    if (reference !== this.stencilReference || readMask !== this.stencilRead) {
      this.stencilReference = reference;
      this.stencilRead = readMask;
      gl.stencilFuncSeparate(
        gl.FRONT,
        gl[DEPTH_FUNCTIONS[this.stencilFront.compare]],
        reference,
        readMask,
      );
      gl.stencilFuncSeparate(
        gl.BACK,
        gl[DEPTH_FUNCTIONS[this.stencilBack.compare]],
        reference,
        readMask,
      );
    }
    if (writeMask !== this.stencilWrite) {
      this.stencilWrite = writeMask;
      gl.stencilMask(writeMask);
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
      throw new Context3DError("operation", "Context3D experiment: non-finite scissor rectangle");
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
    this.blendEnabled = source !== "one" || destination !== "zero";
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
    this.cullEnabled = face !== "none";
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
    if (this.buffers.size >= this.limits.maxBuffers) {
      throw new Context3DError("limit", "Context3D experiment: buffer limit");
    }

    const bytes = count * (stride === 0 ? 2 : stride * 4);
    if (this.bufferBytes + bytes > this.limits.maxBufferBytes) {
      throw new Context3DError("limit", "Context3D experiment: buffer memory limit");
    }

    const gl = this.gl;
    const handle = gl.createBuffer();
    if (!handle) {
      throw new Context3DError("bufferAllocation", "Context3D experiment: cannot allocate buffer");
    }

    const target = stride === 0 ? gl.ELEMENT_ARRAY_BUFFER : gl.ARRAY_BUFFER;
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
        uploadBuffer(gl, this.vao, buffer, state, values, start, amount);
      },
      uploadBytes: (data, offset, start, amount) => {
        this.alive();
        this.buffer(buffer);
        uploadBufferBytes(gl, this.vao, buffer, state, data, offset, start, amount);
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
      throw new Context3DError(
        "disposed",
        "Context3D experiment: buffer disposed or from another context",
      );
    }

    return state;
  }

  createProgram(): Program3D {
    this.alive();
    if (this.programs.size >= this.limits.maxPrograms) {
      throw new Context3DError("limit", "Context3D experiment: program limit");
    }

    const state: ProgramState = {
      handle: null,
      targetY: null,
      attributes: [],
      vertex: [],
      vertexBank: null,
      fragment: [],
      samplers: [],
      samplerMask: 0,
    };
    const program: Program3D = {
      upload: (vertex, fragment) => {
        this.alive();
        this.program(program);
        uploadProgram(this.gl, state, vertex, fragment);

        if (this.selected === program) {
          this.setProgram(program);
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
        state.vertexBank = null;
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
      throw new Context3DError(
        "disposed",
        "Context3D experiment: program disposed or from another context",
      );
    }

    return state;
  }

  createTexture(width: number, height: number, cube = false): Texture3D {
    return this.allocateTexture(width, height, cube, false);
  }

  createRectangleTexture(width: number, height: number): Texture3D {
    return this.allocateTexture(width, height, false, true);
  }

  private allocateTexture(
    width: number,
    height: number,
    cube: boolean,
    rectangle: boolean,
  ): Texture3D {
    this.alive();
    range(1, width - 1, 2048);
    range(1, height - 1, 2048);
    if (cube && width !== height) {
      throw new Context3DError("textureShape", "Context3D cube faces must be square");
    }
    if (cube && width > 1024) {
      throw new Context3DError("textureSize", "Context3D cube faces must be at most 1024");
    }

    const faces = cube ? 6 : 1;
    const levels = rectangle ? 1 : 1 + Math.floor(Math.log2(Math.max(width, height)));
    let size = 0;
    for (let level = 0; level < levels; level++) {
      size += Math.max(1, width >> level) * Math.max(1, height >> level) * 4 * faces;
    }
    if (!rectangle && ((width & (width - 1)) !== 0 || (height & (height - 1)) !== 0)) {
      throw new Context3DError(
        "texturePowerOfTwo",
        "Context3D texture size must be a power of two",
      );
    }

    if (
      this.textures.size >= this.limits.maxTextures ||
      this.textureBytes + size > this.limits.maxTextureBytes
    ) {
      throw new Context3DError("limit", "Context3D experiment: texture count or memory limit");
    }

    const bytes = new Uint8Array(width * height * 4);
    const gl = this.gl;
    const handle = gl.createTexture();
    if (!handle) {
      throw new Context3DError("textureAllocation", "Context3D experiment: cannot create texture");
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
      face: 0,
      mipFramebuffer: null,
      depthAttached: false,
      multisample: null,
      samples: 0,
      antiAlias: 0,
    };
    const texture: Texture3D = {
      width,
      height,
      levels,
      cube,
      rectangle,
      upload: (pixels, level = 0, face = 0, sourceWidth, sourceHeight) => {
        this.alive();
        this.textureState(texture);
        uploadTexture(gl, texture, state, pixels, level, face, sourceWidth, sourceHeight);
      },
      uploadBytes: (data, offset, level = 0, face = 0) => {
        this.alive();
        this.textureState(texture);
        uploadTextureBytes(gl, texture, state, data, offset, level, face);
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
        gl.deleteFramebuffer(state.mipFramebuffer);
        gl.deleteRenderbuffer(state.depthBuffer);
        if (state.multisample) {
          this.deleteMultisample(texture, state.multisample);
          state.multisample = null;
        }
        if (state.depthBuffer) {
          this.targetDepthBytes -= width * height * 4;
        }
        state.framebuffer = null;
        state.mipFramebuffer = null;
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
      throw new Context3DError(
        "disposed",
        "Context3D experiment: texture disposed or from another context",
      );
    }

    return state;
  }

  private copyProgram(cube: boolean): CopyProgram {
    const cached = cube ? this.copyCube : this.copy2D;
    if (cached) {
      return cached;
    }

    const program = createCopyProgram(this.gl, cube);
    if (cube) {
      this.copyCube = program;
    } else {
      this.copy2D = program;
    }

    return program;
  }

  private seedTarget(texture: Texture3D, state: TextureState): void {
    const target = state.multisample;
    if (!target) {
      return;
    }

    const gl = this.gl;
    const program = this.copyProgram(texture.cube);
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
    gl.viewport(0, 0, texture.width, texture.height);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.STENCIL_TEST);
    gl.disable(gl.BLEND);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.SCISSOR_TEST);
    gl.colorMask(true, true, true, true);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(texture.cube ? gl.TEXTURE_CUBE_MAP : gl.TEXTURE_2D, state.handle);
    gl.bindSampler(0, this.sampler(0));
    gl.bindVertexArray(this.vao);
    gl.useProgram(program.handle);
    if (texture.cube) {
      gl.uniform2f(program.size, texture.width, texture.height);
      gl.uniform1i(program.face, this.renderFace);
    }
    // WebGL cannot blit single-sample color into a multisample framebuffer.
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.enable(gl.DEPTH_TEST);
    if (this.stencilEnabled) {
      gl.enable(gl.STENCIL_TEST);
    }
    if (this.blendEnabled) {
      gl.enable(gl.BLEND);
    }
    if (this.cullEnabled) {
      gl.enable(gl.CULL_FACE);
    }
    if (this.scissor) {
      gl.enable(gl.SCISSOR_TEST);
    }
    this.applyColorMask();
    target.valid = true;
  }

  private multisamples(quality: number, depth: boolean): number {
    if (!Number.isInteger(quality)) {
      throw new Context3DError("operation", "Context3D experiment: invalid antialiasing quality");
    }

    const key = Math.max(0, Math.min(quality, 4)) * 2 + Number(depth);
    if (this.targetSamples[key] < 0) {
      this.targetSamples[key] = selectSamples(this.gl, quality, depth);
    }

    return this.targetSamples[key];
  }

  private deleteMultisample(texture: Texture3D, target: MultisampleTarget): void {
    deleteMultisample(this.gl, target);

    const bytes = texture.width * texture.height * 4 * target.samples;
    this.targetColorBytes -= bytes + (target.texture ? texture.width * texture.height * 4 : 0);
    if (target.depth) {
      this.targetDepthBytes -= bytes;
    }
  }

  private prepareMultisample(
    texture: Texture3D,
    state: TextureState,
    samples: number,
    depth: boolean,
  ): void {
    const old = state.multisample;
    const same = old?.samples === samples;
    const bytes = texture.width * texture.height * 4 * samples;
    const previous = old ? texture.width * texture.height * 4 * old.samples : 0;
    const resolveBytes = texture.cube ? texture.width * texture.height * 4 : 0;
    const newDepth = depth && (!same || !old.depth);
    if (
      this.targetColorBytes + (same ? 0 : bytes - previous + (old ? 0 : resolveBytes)) >
        this.limits.maxTargetColorBytes ||
      this.targetDepthBytes + (newDepth ? bytes : 0) - (!same && old?.depth ? previous : 0) >
        this.limits.maxTargetDepthBytes
    ) {
      throw new Context3DError("limit", "Context3D experiment: multisample target memory limit");
    }

    this.copyProgram(texture.cube);
    this.sampler(0);
    const target = allocateMultisample(
      this.gl,
      texture,
      old,
      samples,
      depth,
      this.depthWrite,
      this.stencilWrite,
    );
    if (same) {
      if (newDepth) {
        this.targetDepthBytes += bytes;
      }
    } else {
      if (old) {
        this.deleteMultisample(texture, old);
      }
      state.multisample = target;
      this.targetColorBytes += bytes + resolveBytes;
      if (target.depth) {
        this.targetDepthBytes += bytes;
      }
    }
  }

  setRenderTarget(texture: Texture3D | null, depth = false, face = 0, antiAlias = 0): void {
    this.alive();
    if (texture) {
      range(face, 1, texture.cube ? 6 : 1);
    }
    if (
      texture === this.renderTexture &&
      (!texture ||
        (depth === this.renderDepth &&
          face === this.renderFace &&
          antiAlias === this.textureState(texture).antiAlias))
    ) {
      return;
    }

    const gl = this.gl;
    if (texture) {
      this.textureState(texture);
      if (texture.width < 8 || texture.height < 8) {
        throw new Context3DError(
          "operation",
          "Context3D experiment: render targets must be at least 8 by 8",
        );
      }
    }
    const samples = texture ? this.multisamples(antiAlias, depth) : 0;
    this.finishTarget();
    if (texture) {
      const state = this.textureState(texture);
      const singleDepth = depth && samples === 0;

      let framebuffer = state.framebuffer;
      let mipFramebuffer = state.mipFramebuffer;
      let depthBuffer = state.depthBuffer;
      try {
        framebuffer ??= gl.createFramebuffer();
        if (!framebuffer) {
          throw new Context3DError(
            "operation",
            "Context3D experiment: cannot create texture framebuffer",
          );
        }
        if (texture.cube && !mipFramebuffer) {
          mipFramebuffer = gl.createFramebuffer();
          if (!mipFramebuffer) {
            throw new Context3DError(
              "operation",
              "Context3D experiment: cannot create cube mip framebuffer",
            );
          }
        }
        gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
        gl.framebufferTexture2D(
          gl.FRAMEBUFFER,
          gl.COLOR_ATTACHMENT0,
          texture.cube ? gl.TEXTURE_CUBE_MAP_POSITIVE_X + face : gl.TEXTURE_2D,
          state.handle,
          0,
        );
        if (singleDepth && !depthBuffer) {
          if (
            this.targetDepthBytes + texture.width * texture.height * 4 >
            this.limits.maxTargetDepthBytes
          ) {
            throw new Context3DError("limit", "Context3D experiment: target depth memory limit");
          }
          depthBuffer = gl.createRenderbuffer();
          if (!depthBuffer) {
            throw new Context3DError(
              "operation",
              "Context3D experiment: cannot create texture depth buffer",
            );
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
          singleDepth ? depthBuffer : null,
        );
        if (
          (!state.framebuffer || (singleDepth && !state.depthBuffer)) &&
          gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE
        ) {
          throw new Context3DError(
            "operation",
            "Context3D experiment: incomplete texture framebuffer",
          );
        }
        if (samples) {
          this.prepareMultisample(texture, state, samples, depth);
        }
      } catch (error) {
        if (framebuffer !== state.framebuffer) {
          gl.deleteFramebuffer(framebuffer);
        } else if (framebuffer) {
          gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
          gl.framebufferTexture2D(
            gl.FRAMEBUFFER,
            gl.COLOR_ATTACHMENT0,
            texture.cube ? gl.TEXTURE_CUBE_MAP_POSITIVE_X + state.face : gl.TEXTURE_2D,
            state.handle,
            0,
          );
          // Restore the attachment if this was the currently selected target.
          gl.framebufferRenderbuffer(
            gl.FRAMEBUFFER,
            gl.DEPTH_STENCIL_ATTACHMENT,
            gl.RENDERBUFFER,
            state.depthAttached ? state.depthBuffer : null,
          );
        }
        if (mipFramebuffer !== state.mipFramebuffer) {
          gl.deleteFramebuffer(mipFramebuffer);
        }
        if (depthBuffer !== state.depthBuffer) {
          gl.deleteRenderbuffer(depthBuffer);
        }
        gl.bindRenderbuffer(gl.RENDERBUFFER, null);
        gl.bindFramebuffer(
          gl.FRAMEBUFFER,
          this.renderTexture
            ? targetFramebuffer(this.textureState(this.renderTexture))
            : this.framebuffer,
        );
        this.applyScissor();
        throw error;
      }

      if (depthBuffer && !state.depthBuffer) {
        this.targetDepthBytes += texture.width * texture.height * 4;
        gl.disable(gl.SCISSOR_TEST);
        gl.depthMask(true);
        gl.clearDepth(1);
        gl.clearStencil(0);
        gl.stencilMask(255);
        gl.clear(gl.DEPTH_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);
        gl.depthMask(this.depthWrite);
        gl.stencilMask(this.stencilWrite);
      }
      state.framebuffer = framebuffer;
      state.mipFramebuffer = mipFramebuffer;
      state.face = face;
      state.depthAttached = singleDepth;
      state.depthBuffer = depthBuffer;
      state.samples = samples;
      state.antiAlias = antiAlias;
      if (samples && state.multisample && state.multisample.face !== face) {
        state.multisample.face = face;
        state.multisample.valid = false;
      }
      gl.bindRenderbuffer(gl.RENDERBUFFER, null);
    }

    this.renderTexture = texture;
    this.renderFace = texture ? face : 0;
    this.renderDepth = texture !== null && depth;
    gl.frontFace(texture ? gl.CCW : gl.CW);
    this.applyScissor();
  }

  private changedTarget(): void {
    if (this.renderTexture) {
      const state = this.textureState(this.renderTexture);
      state.dirty = true;
      if (state.multisample) {
        if (state.samples) {
          state.multisample.dirty = true;
        } else {
          state.multisample.valid = false;
        }
      }
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
      resolveTarget(this.gl, texture, state, this.renderFace, this.scissor);
      gl.activeTexture(gl.TEXTURE0);
      if (texture.cube) {
        // generateMipmap(CUBE_MAP) would overwrite manually uploaded mips on
        // untouched faces. AIR regenerates only the face just rendered.
        gl.disable(gl.SCISSOR_TEST);
        const face = gl.TEXTURE_CUBE_MAP_POSITIVE_X + this.renderFace;
        // The base-size depth attachment cannot accompany smaller mip images.
        gl.bindFramebuffer(gl.FRAMEBUFFER, state.framebuffer);
        if (state.depthAttached) {
          gl.framebufferRenderbuffer(
            gl.FRAMEBUFFER,
            gl.DEPTH_STENCIL_ATTACHMENT,
            gl.RENDERBUFFER,
            null,
          );
        }
        for (let level = 1; level < texture.levels; level++) {
          gl.bindFramebuffer(gl.READ_FRAMEBUFFER, state.framebuffer);
          gl.framebufferTexture2D(
            gl.READ_FRAMEBUFFER,
            gl.COLOR_ATTACHMENT0,
            face,
            state.handle,
            level - 1,
          );
          gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, state.mipFramebuffer);
          gl.framebufferTexture2D(
            gl.DRAW_FRAMEBUFFER,
            gl.COLOR_ATTACHMENT0,
            face,
            state.handle,
            level,
          );
          const size = texture.width >> level;
          gl.blitFramebuffer(
            0,
            0,
            size * 2,
            size * 2,
            0,
            0,
            size,
            size,
            gl.COLOR_BUFFER_BIT,
            gl.LINEAR,
          );
        }
        gl.bindFramebuffer(gl.FRAMEBUFFER, state.framebuffer);
        gl.framebufferTexture2D(
          gl.FRAMEBUFFER,
          gl.COLOR_ATTACHMENT0,
          gl.TEXTURE_CUBE_MAP_POSITIVE_X + state.face,
          state.handle,
          0,
        );
        if (state.depthAttached) {
          gl.framebufferRenderbuffer(
            gl.FRAMEBUFFER,
            gl.DEPTH_STENCIL_ATTACHMENT,
            gl.RENDERBUFFER,
            state.depthBuffer,
          );
        }
      } else if (!texture.rectangle) {
        gl.bindTexture(gl.TEXTURE_2D, state.handle);
        gl.generateMipmap(gl.TEXTURE_2D);
      }
      state.uploaded[this.renderFace] = (1 << texture.levels) - 1;
      state.dirty = false;
    }
  }

  setTexture(index: number, texture: Texture3D | null): void {
    this.alive();
    range(index, 1, 8);
    if (texture && !this.textureOwners.has(texture)) {
      throw new Context3DError("disposed", "Context3D experiment: texture from another context");
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

  setSampler(index: number, wrap: SamplerWrap, filter: SamplerFilter, mip: SamplerMip): void {
    this.alive();
    range(index, 1, this.samplerStates.length);
    const w = SAMPLER_WRAPS.indexOf(wrap);
    const f = SAMPLER_FILTERS.indexOf(filter);
    const m = SAMPLER_MIPS.indexOf(mip);
    if (w < 0 || f < 0 || m < 0) {
      throw new Context3DError("operation", "Context3D experiment: invalid sampler state");
    }

    this.samplerStates[index] = w | (f << 2) | (m << 5);
  }

  private sampler(index: number): WebGLSampler {
    let sampler = this.samplers[index];
    if (!sampler) {
      const gl = this.gl;
      sampler = gl.createSampler();
      if (!sampler) {
        throw new Context3DError("operation", "Context3D experiment: cannot create sampler");
      }

      const mode = (index >>> 2) & 7;
      const linear = mode !== 0;
      const filter = linear ? gl.LINEAR : gl.NEAREST;
      let minFilter: number = filter;
      switch (index >>> 5) {
        case 1:
          minFilter = linear ? gl.LINEAR_MIPMAP_NEAREST : gl.NEAREST_MIPMAP_NEAREST;
          break;
        case 2:
          minFilter = linear ? gl.LINEAR_MIPMAP_LINEAR : gl.NEAREST_MIPMAP_LINEAR;
          break;
      }
      gl.samplerParameteri(sampler, gl.TEXTURE_MIN_FILTER, minFilter);
      gl.samplerParameteri(sampler, gl.TEXTURE_MAG_FILTER, filter);
      if (mode > 1) {
        if (this.anisotropy === undefined) {
          this.anisotropy = gl.getExtension("EXT_texture_filter_anisotropic");
          if (this.anisotropy) {
            this.maxAnisotropy = gl.getParameter(this.anisotropy.MAX_TEXTURE_MAX_ANISOTROPY_EXT);
          }
        }

        if (this.anisotropy) {
          gl.samplerParameterf(
            sampler,
            this.anisotropy.TEXTURE_MAX_ANISOTROPY_EXT,
            Math.min(1 << (mode - 1), this.maxAnisotropy),
          );
        }
      }
      gl.samplerParameteri(sampler, gl.TEXTURE_WRAP_S, index & 1 ? gl.REPEAT : gl.CLAMP_TO_EDGE);
      gl.samplerParameteri(sampler, gl.TEXTURE_WRAP_T, index & 2 ? gl.REPEAT : gl.CLAMP_TO_EDGE);
      gl.samplerParameteri(
        sampler,
        gl.TEXTURE_WRAP_R,
        (index & 3) === 3 ? gl.REPEAT : gl.CLAMP_TO_EDGE,
      );
      this.samplers[index] = sampler;
    }

    return sampler;
  }

  setProgram(program: Program3D): void {
    this.alive();
    const state = this.program(program);
    if (!state.handle) {
      throw new Context3DError("program", "Context3D experiment: program not uploaded");
    }

    this.selected = program;
    for (let i = 0; i < state.samplers.length; i++) {
      const source = state.samplers[i].source;
      if (!source.ignore) {
        this.samplerStates[source.index] =
          (source.repeat ? 3 : 0) | (source.filter << 2) | (source.mip << 5);
      }
    }
  }

  setVertex(index: number, buffer: Buffer3D | null, offset: number, format: VertexFormat): void {
    this.alive();
    range(index, 1, 8);
    if (buffer === null) {
      this.vertices[index] = null;
      return;
    }

    this.buffer(buffer);
    const packed = format === "bytes4";
    const size = packed ? 4 : VERTEX_FORMATS.indexOf(format) + 1;
    range(1, size - 1, 4);
    if (!Number.isInteger(offset)) {
      throw new Context3DError(
        "operation",
        "Context3D experiment: vertex offset must be an integer",
      );
    }

    // AIR reports stride overruns at draw time, including on an existing binding.
    const valid = offset >= 0 && offset <= buffer.stride - (packed ? 1 : size);
    const previous = this.vertices[index];
    if (previous) {
      previous.buffer = buffer;
      previous.offset = offset;
      previous.size = size;
      previous.packed = packed;
      previous.valid = valid;
    } else {
      this.vertices[index] = { buffer, offset, size, packed, valid };
    }
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
    if (!index.indices) {
      throw new Context3DError("indexBuffer", "Context3D draw needs an index buffer");
    }
    if (!this.selected) {
      throw new Context3DError("program", "Context3D draw needs a program");
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
          this.samplerStates[source.index] !== this.samplerStates[other.index]
        ) {
          throw new TextureBindingError("conflicting");
        }
      }
    }

    const count = triangles === -1 ? Math.floor((indices.count - first) / 3) * 3 : triangles * 3;
    if (!Number.isInteger(first) || !Number.isInteger(count) || first < 0 || count < 0) {
      throw new Context3DError("triangleCount", "Context3D draw has invalid triangle parameters");
    }
    if (first > indices.count - count) {
      throw new Context3DError("drawRange", "Context3D draw exceeds its index buffer");
    }
    if (count % 3 !== 0) {
      throw new Context3DError("triangleCount", "Context3D experiment: incomplete triangle");
    }

    for (let i = first; i < first + count; i++) {
      if (!index.uploaded[i]) {
        throw new Context3DError("indexData", "Context3D index not uploaded");
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
        throw new Context3DError("vertexBinding", "Context3D experiment: missing vertex binding");
      }

      const buffer = this.buffer(binding.buffer);
      if (!binding.valid) {
        throw new VertexOffsetError("Vertex attribute exceeds its stride");
      }

      for (let j = first; j < first + count; j++) {
        if (index.indices[j] >= buffer.uploaded.length) {
          throw new Context3DError("vertexData", "Context3D vertex outside its buffer");
        }
        if (!buffer.uploaded[index.indices[j]]) {
          throw new Context3DError("vertexStream", "Context3D vertex not uploaded");
        }
      }

      gl.bindBuffer(gl.ARRAY_BUFFER, buffer.handle);
      gl.enableVertexAttribArray(slot);
      gl.vertexAttribPointer(
        slot,
        binding.size,
        binding.packed ? gl.UNSIGNED_BYTE : gl.FLOAT,
        binding.packed,
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
      if ((texture.cube || texture.rectangle) && (this.samplerStates[slot] & 3) !== 0) {
        throw new TextureBindingError("wrap");
      }
      if (texture.rectangle && this.samplerStates[slot] >> 5 !== 0) {
        throw new TextureBindingError("rectangleMip");
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
          (texture.cube || this.samplerStates[slot] >>> 5 !== 0) &&
          resource.uploaded[face] !== (1 << texture.levels) - 1
        ) {
          throw new TextureBindingError("mipmaps");
        }
      }

      gl.activeTexture(gl.TEXTURE0 + slot);
      gl.bindTexture(texture.cube ? gl.TEXTURE_CUBE_MAP : gl.TEXTURE_2D, resource.handle);
      gl.bindSampler(slot, this.sampler(this.samplerStates[slot]));
      gl.uniform1i(binding.location, slot);
    }

    if (state.vertexBank) {
      gl.uniform4fv(state.vertexBank, this.vertexConstants);
    } else {
      this.uniforms(state.vertex, this.vertexConstants);
    }
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
    this.gl.deleteProgram(this.copy2D?.handle ?? null);
    this.gl.deleteProgram(this.copyCube?.handle ?? null);
    this.copy2D = null;
    this.copyCube = null;
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
