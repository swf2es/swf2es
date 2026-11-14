import { INDIRECT_BANK, type ProgramType } from "../agal.js";
import {
  type BlendFactor,
  type Buffer3D,
  type CompareMode,
  type Context3D,
  type CullFace,
  compressedFormat,
  FRAGMENT_CONSTANTS,
  MOST_CUBE,
  type Profile,
  type Program3D,
  profileLimits,
  SAMPLER_FILTERS,
  SAMPLER_MIPS,
  SAMPLER_SLOTS,
  SAMPLER_WRAPS,
  type SamplerFilter,
  type SamplerMip,
  type SamplerWrap,
  ScissorBoundsError,
  type StencilAction,
  screenPixels,
  TEXEL_BYTES,
  type Texture3D,
  TextureBindingError,
  type TextureFormat,
  VERTEX_CONSTANTS,
  VERTEX_FORMATS,
  VERTEX_SLOTS,
  type VertexFormat,
  VertexOffsetError,
} from "../backend.js";
import { GlState } from "../device/state.js";
import { blockBytes, type DxtEncoder } from "../dxt.js";
import { Context3DError } from "../errors.js";

import { configureBackBuffer, presentBackBuffer, unconfigureBackBuffer } from "./back-buffer.js";
import { allocateBuffer, type BufferState, type VertexBinding } from "./buffers.js";
import { resourceLimits, type WebGLContext3DLimits } from "./limits.js";
import {
  type CopyProgram,
  createCopyProgram,
  type ProgramState,
  uploadProgram,
} from "./programs.js";
import { readBackBuffer } from "./readback.js";
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
import {
  storageFormat,
  type TextureState,
  uploadCompressedLevel,
  uploadTexture,
  uploadTextureBytes,
} from "./textures.js";
import { validateIndices, validateVertices } from "./validation.js";

/** What AGAL's sampler must name to read each texture format: RGBA, DXT1 or DXT5. */
const SAMPLER_FORMATS: Record<TextureFormat, number> = {
  bgra: 0,
  compressed: 1,
  compressedAlpha: 2,
  bgrPacked565: 0,
  bgraPacked4444: 0,
  rgbaHalfFloat: 0,
};

/**
 * A clear colour's channel as Direct3D's 8-bit clear colour holds it, which AIR fills by
 * truncation (0.5 clears to 127): within 0 to 1 and cut to its byte, NaN kept.
 */
function clearChannel(value: number): number {
  if (!(value > 0)) {
    return value < 0 ? 0 : value;
  }

  return value >= 1 ? 1 : Math.floor(value * 255 + 1e-3) / 255;
}

/** AGAL's wraps (clamp, repeat, clamp_u_repeat_v, repeat_u_clamp_v) as SAMPLER_WRAPS indices. */
const WRAPS = [0, 3, 2, 1];

interface Constants {
  data: Float32Array;
  bits: Uint32Array;
  versions: Float64Array;
  version: number;
  writing: number;
}

function constants(registers: number): Constants {
  const data = new Float32Array(registers * 4);

  return {
    data,
    bits: new Uint32Array(data.buffer),
    versions: new Float64Array(registers),
    version: 0,
    writing: 0,
  };
}

/**
 * An owned WebGL2 context, deliberately independent of the 2D renderer. Its members that are
 * neither private nor Context3D's are for back-buffer.ts, buffers.ts and readback.ts, which
 * hold parts of it as functions over it.
 */
export class WebGLContext3D implements Context3D {
  readonly gl: WebGL2RenderingContext;
  readonly drawState: GlState;
  width = 0;
  height = 0;
  /**
   * The back buffer's storage: its size, or less where the GPU allows less. The SWF still
   * sees the size it asked for, drawn at this one and stretched to it when presented.
   */
  drawnWidth = 0;
  drawnHeight = 0;
  gpuMost: Int32Array | null = null;
  disposed = false;
  samplerFormats = true;
  profile: Profile = "baseline";
  readonly buffers = new Map<Buffer3D, BufferState>();
  vertexBuffers = 0;
  bufferBytes = 0;
  vertexBufferBytes = 0;
  private readonly programs = new Map<Program3D, ProgramState>();
  private readonly textures = new Map<Texture3D, TextureState>();
  private readonly textureCounts = new Float64Array(3);
  private readonly textureQuotaBytes = new Float64Array(3);
  private readonly textureOwners = new WeakSet<Texture3D>();
  private textureBytes = 0;
  private targetDepthBytes = 0;
  private targetColorBytes = 0;
  private copy2D: CopyProgram | null = null;
  private copyCube: CopyProgram | null = null;
  private readonly targetSamples = new Int8Array(10).fill(-1);
  renderTexture: Texture3D | null = null;
  private renderDepth = false;
  private renderFace = 0;
  /** Colour outputs 1 to 3, drawn into with renderTexture, and their cube faces. */
  private readonly outputs: (Texture3D | null)[] = [null, null, null];
  private readonly outputFaces = new Uint8Array(3);
  private outputsChanged = false;
  /** Whether any of outputs is bound, so that a draw alone into its target looks at none. */
  private outputsBound = false;
  private floatTargets: boolean | undefined;
  private readonly textureSlots: (Texture3D | null)[] = new Array(SAMPLER_SLOTS).fill(null);
  private textureMask = 0;
  private readonly samplers: (WebGLSampler | null)[] = new Array(96).fill(null);
  // Two wrap bits, three filter bits and two mip bits fit each slot in one byte.
  private readonly samplerStates = new Uint8Array(16);
  private anisotropy: EXT_texture_filter_anisotropic | null | undefined;
  private s3tc: WEBGL_compressed_texture_s3tc | null | undefined;
  private maxAnisotropy = 1;
  readonly vertices: (VertexBinding | null)[] = new Array(VERTEX_SLOTS).fill(null);
  private enabledAttributes = 0;
  indexBuffer: WebGLBuffer | null = null;
  readonly texturesApplied = new Uint8Array(SAMPLER_SLOTS);
  private selected: Program3D | null = null;
  framebuffer: WebGLFramebuffer | null = null;
  texture: WebGLTexture | null = null;
  resolveFramebuffer: WebGLFramebuffer | null = null;
  colorBuffer: WebGLRenderbuffer | null = null;
  resolveDirty = false;
  depthBuffer: WebGLRenderbuffer | null = null;
  antiAlias = 0;
  /** The back buffer's pixels to a CSS pixel and to a scissor rectangle's unit. */
  scale = 1;
  private depthWrite = true;
  private depthCompare: CompareMode = "less";
  private blendEnabled = false;
  private blendSource: BlendFactor = "one";
  private blendDestination: BlendFactor = "zero";
  private cullFace: CullFace = "none";
  private colorWrite = 15;
  private readonly stencilFront = new StencilState();
  private readonly stencilBack = new StencilState();
  private stencilEnabled = false;
  private stencilReference = 0;
  private stencilRead = 255;
  private stencilWrite = 255;
  scissor = false;
  private scissorLeft = 0;
  private scissorTop = 0;
  private scissorRight = 0;
  private scissorBottom = 0;
  private scissorOutside = false;
  private readonly vertexConstants = constants(VERTEX_CONSTANTS);
  private readonly fragmentConstants = constants(FRAGMENT_CONSTANTS);
  pixels = new Uint8Array(0);
  topDown = new Uint8Array(0);
  readonly vao: WebGLVertexArrayObject;
  readonly limits: Readonly<WebGLContext3DLimits>;
  private dxtEncoder: DxtEncoder | null = null;

  /** The host's whole-level encoder; a refusal retains the TypeScript path. */
  setDxtEncoder(encoder: DxtEncoder): void {
    this.dxtEncoder = encoder;
  }

  constructor(gl: WebGL2RenderingContext, limits: Partial<WebGLContext3DLimits> = {}) {
    this.limits = resourceLimits(limits);
    this.gl = gl;
    if (gl.getContextAttributes()?.antialias) {
      throw new Context3DError(
        "unsupported",
        "Context3D requires a WebGL2 context with antialias: false",
      );
    }

    this.drawState = new GlState(gl);
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

  alive(): void {
    if (this.disposed || this.gl.isContextLost()) {
      throw new Context3DError("disposed", "Context3D experiment: context disposed or lost");
    }
  }

  target(back = false, discardColor = false): void {
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
    this.drawState.bindFramebuffer(state ? targetFramebuffer(state) : this.framebuffer);
    if (this.outputsChanged || state?.outputs) {
      this.attachOutputs(state);
    }
    this.drawState.viewport(
      0,
      0,
      texture?.width ?? this.drawnWidth,
      texture?.height ?? this.drawnHeight,
    );
  }

  /** Temporary attachments and separate READ/DRAW bindings bypass the hot target cache. */
  bindFramebuffer(target: number, framebuffer: WebGLFramebuffer | null): void {
    this.drawState.forget();
    this.gl.bindFramebuffer(target, framebuffer);
  }

  configure(width: number, height: number, depth = false, antiAlias = 0, scale = 1): void {
    configureBackBuffer(this, width, height, depth, antiAlias, scale);
  }

  unconfigure(): void {
    unconfigureBackBuffer(this);
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
      // A float target too: AIR clears through Direct3D's 8-bit colour.
      gl.clearColor(
        clearChannel(red),
        clearChannel(green),
        clearChannel(blue),
        clearChannel(alpha),
      );
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
    if (this.depthWrite !== write) {
      this.depthWrite = write;
      this.gl.depthMask(write);
    }

    if (this.depthCompare !== compare) {
      this.depthCompare = compare;
      this.gl.depthFunc(this.gl[DEPTH_FUNCTIONS[compare]]);
    }
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

  applyScissor(): void {
    const gl = this.gl;
    if (!this.scissor) {
      this.scissorOutside = false;
      gl.disable(gl.SCISSOR_TEST);
      return;
    }

    const width = this.renderTexture?.width ?? this.width;
    const height = this.renderTexture?.height ?? this.height;
    let left = Math.max(0, Math.min(width, this.scissorLeft));
    let top = Math.max(0, Math.min(height, this.scissorTop));
    let right = Math.max(0, Math.min(width, this.scissorRight));
    let bottom = Math.max(0, Math.min(height, this.scissorBottom));
    // AIR tells a rectangle outside from its own unit, then scales it to a back buffer
    // configured for best resolution, whose pixels are the screen's.
    this.scissorOutside = right <= left || bottom <= top;
    if (!this.renderTexture && this.scale !== 1) {
      const scale = this.scale;
      left = Math.max(0, Math.min(width, screenPixels(this.scissorLeft, scale)));
      top = Math.max(0, Math.min(height, screenPixels(this.scissorTop, scale)));
      right = Math.max(0, Math.min(width, screenPixels(this.scissorRight, scale)));
      bottom = Math.max(0, Math.min(height, screenPixels(this.scissorBottom, scale)));
    }
    let drawnHeight = height;
    if (!this.renderTexture && (this.drawnWidth !== width || this.drawnHeight !== height)) {
      // The back buffer's storage is smaller than its size: the rectangle shrinks with it.
      const x = this.drawnWidth / width;
      const y = this.drawnHeight / height;
      left = Math.round(left * x);
      right = Math.round(right * x);
      top = Math.round(top * y);
      bottom = Math.round(bottom * y);
      drawnHeight = this.drawnHeight;
    }

    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(
      left,
      this.renderTexture ? top : drawnHeight - bottom,
      Math.max(0, right - left),
      Math.max(0, bottom - top),
    );
  }

  setBlend(source: BlendFactor, destination: BlendFactor): void {
    this.alive();
    if (this.blendSource === source && this.blendDestination === destination) {
      return;
    }

    const gl = this.gl;
    const enabled = this.blendEnabled;
    this.blendSource = source;
    this.blendDestination = destination;
    this.blendEnabled = source !== "one" || destination !== "zero";
    if (!this.blendEnabled) {
      gl.disable(gl.BLEND);
    } else {
      gl.blendFunc(gl[BLEND_FUNCTIONS[source]], gl[BLEND_FUNCTIONS[destination]]);
      if (!enabled) {
        gl.enable(gl.BLEND);
      }
    }
  }

  setCulling(face: CullFace): void {
    this.alive();
    const previous = this.cullFace;
    if (previous === face) {
      return;
    }

    const gl = this.gl;
    this.cullFace = face;
    if (face === "none") {
      gl.disable(gl.CULL_FACE);
      return;
    }

    if (previous === "none") {
      gl.enable(gl.CULL_FACE);
    }
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

  createBuffer(count: number, stride: number, dynamic = false): Buffer3D {
    return allocateBuffer(this, count, stride, dynamic);
  }

  buffer(buffer: Buffer3D): BufferState {
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
      targetYValue: Number.NaN,
      attributes: [],
      attributeMask: 0,
      vertex: [],
      vertexBank: null,
      outputs: 1,
      fragment: [],
      samplers: [],
      samplerMask: 0,
      samplersSet: false,
      vertexVersions: new Float64Array(0),
      fragmentVersions: new Float64Array(0),
      vertexValues: new Uint32Array(0),
      fragmentValues: new Uint32Array(0),
      vertexVersion: -1,
    };
    const program: Program3D = {
      get outputs() {
        return state.outputs;
      },
      get attributes() {
        return state.attributeMask;
      },
      upload: (vertex, fragment) => {
        this.alive();
        this.program(program);
        this.drawState.forget();
        uploadProgram(this.gl, state, vertex, fragment, this.profile);

        if (this.selected === program) {
          this.setProgram(program);
        }
      },
      dispose: () => {
        if (!this.programs.delete(program)) {
          return;
        }

        // WebGL keeps a deleted program alive while it is still current.
        this.drawState.forget();
        if (this.gl.getParameter(this.gl.CURRENT_PROGRAM) === state.handle) {
          this.gl.useProgram(null);
        }

        this.gl.deleteProgram(state.handle);
        state.handle = null;
        state.targetY = null;
        state.attributes.length = 0;
        state.attributeMask = 0;
        state.vertex.length = 0;
        state.vertexBank = null;
        state.fragment.length = 0;
        state.samplers.length = 0;
        state.samplerMask = 0;
        state.vertexVersions = new Float64Array(0);
        state.fragmentVersions = new Float64Array(0);
        state.vertexValues = new Uint32Array(0);
        state.fragmentValues = new Uint32Array(0);
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

  createTexture(
    width: number,
    height: number,
    cube = false,
    format: TextureFormat = "bgra",
    streaming = 0,
  ): Texture3D {
    return this.allocateTexture(width, height, cube, false, format, streaming);
  }

  createRectangleTexture(width: number, height: number, format: TextureFormat = "bgra"): Texture3D {
    return this.allocateTexture(width, height, false, true, format);
  }

  /** GL's internal format for a compressed texture's S3TC, or 0 where the context takes none. */
  private s3tcFormat(format: TextureFormat): number {
    if (this.s3tc === undefined) {
      this.s3tc = this.gl.getExtension("WEBGL_compressed_texture_s3tc");
    }
    if (!this.s3tc || !compressedFormat(format)) {
      return 0;
    }

    // AIR's DXT1 has DXT1's one bit of alpha: a block of three colours has transparent black.
    return format === "compressed"
      ? this.s3tc.COMPRESSED_RGBA_S3TC_DXT1_EXT
      : this.s3tc.COMPRESSED_RGBA_S3TC_DXT5_EXT;
  }

  /**
   * Bytes a mip chain of `format` takes, its faces' every level: S3TC's
   * blocks for a compressed texture whatever its storage, as AIR counts
   * them, so that a GPU without S3TC allocates no less than one with it.
   */
  private chainBytes(
    width: number,
    height: number,
    levels: number,
    faces: number,
    format: TextureFormat,
  ): number {
    let size = 0;
    for (let level = 0; level < levels; level++) {
      const w = Math.max(1, width >> level);
      const h = Math.max(1, height >> level);
      size += compressedFormat(format)
        ? blockBytes(w, h, format === "compressedAlpha")
        : w * h * (TEXEL_BYTES[format] ?? 4);
    }

    return size * faces;
  }

  private allocateTexture(
    width: number,
    height: number,
    cube: boolean,
    rectangle: boolean,
    format: TextureFormat,
    streaming = 0,
  ): Texture3D {
    this.alive();
    const limits = profileLimits(this.profile);
    const most = rectangle ? limits.rectangleSize : limits.textureSize;
    range(1, width - 1, most);
    range(1, height - 1, most);
    if (cube && width !== height) {
      throw new Context3DError("textureShape", "Context3D cube faces must be square");
    }
    if (cube && width > MOST_CUBE) {
      throw new Context3DError("textureSize", "Context3D cube faces must be at most 1024");
    }

    const faces = cube ? 6 : 1;
    const levels = rectangle ? 1 : 1 + Math.floor(Math.log2(Math.max(width, height)));
    range(streaming, 1, levels);
    if (!rectangle && ((width & (width - 1)) !== 0 || (height & (height - 1)) !== 0)) {
      throw new Context3DError(
        "texturePowerOfTwo",
        "Context3D texture size must be a power of two",
      );
    }
    if (compressedFormat(format) && rectangle) {
      throw new Context3DError("unsupported", "Context3D rectangle textures are not compressed");
    }
    if (compressedFormat(format) && (width < 4 || height < 4)) {
      throw new Context3DError("compressedSize", "Context3D compressed textures are at least 4x4");
    }

    const gl = this.gl;
    const storage = this.s3tcFormat(format) || storageFormat(gl, format);
    const size = this.chainBytes(width, height, levels, faces, format);
    const kind = cube ? 2 : rectangle ? 1 : 0;
    const countLimit = cube
      ? this.limits.maxCubeTextures
      : rectangle
        ? this.limits.maxRectangleTextures
        : this.limits.max2DTextures;
    const byteLimit = cube
      ? this.limits.maxCubeTextureBytes
      : rectangle
        ? this.limits.maxRectangleTextureBytes
        : this.limits.max2DTextureBytes;
    // AIR reserves half the base size for mips, independently of the exact
    // chain storage, and charges DXT1 an eighth of BGRA and DXT5 a quarter.
    const quotaBytes =
      (width * height * faces * (rectangle ? 4 : 6) * (TEXEL_BYTES[format] ?? 4)) /
      4 /
      (format === "compressed" ? 8 : format === "compressedAlpha" ? 4 : 1);
    if (
      this.textures.size >= this.limits.maxTextures ||
      this.textureCounts[kind] >= countLimit ||
      this.textureQuotaBytes[kind] + quotaBytes > byteLimit ||
      this.textureBytes + size > this.limits.maxTextureBytes
    ) {
      throw new Context3DError("limit", "Context3D experiment: texture count or memory limit");
    }

    const handle = gl.createTexture();
    if (!handle) {
      throw new Context3DError("textureAllocation", "Context3D experiment: cannot create texture");
    }

    this.texturesApplied[0] = 0;
    gl.activeTexture(gl.TEXTURE0);
    const target = cube ? gl.TEXTURE_CUBE_MAP : gl.TEXTURE_2D;
    gl.bindTexture(target, handle);
    gl.texStorage2D(target, levels, storage, width, height);
    const state: TextureState = {
      handle,
      storage,
      bytes: new Uint8Array(0),
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
      outputs: 0,
      base: 0,
    };
    const texture: Texture3D = {
      width,
      height,
      levels,
      cube,
      rectangle,
      format,
      streaming,
      upload: (pixels, level = 0, face = 0, sourceWidth, sourceHeight) => {
        this.alive();
        this.textureState(texture);
        try {
          uploadTexture(
            gl,
            texture,
            state,
            pixels,
            level,
            face,
            sourceWidth,
            sourceHeight,
            this.dxtEncoder,
          );
        } finally {
          // An encoder can draw before the upload replaces unit zero's binding.
          this.texturesApplied[0] = 0;
        }
      },
      uploadBytes: (data, offset, level = 0, face = 0) => {
        this.alive();
        this.textureState(texture);
        try {
          uploadTextureBytes(gl, texture, state, data, offset, level, face, this.dxtEncoder);
        } finally {
          this.texturesApplied[0] = 0;
        }
      },
      uploadCompressed: (blocks, level = 0, face = 0) => {
        this.alive();
        this.textureState(texture);
        if (!compressedFormat(format)) {
          throw new Context3DError(
            "textureUpload",
            "Context3D experiment: uncompressed texture given blocks",
          );
        }

        try {
          uploadCompressedLevel(gl, texture, state, blocks, level, face);
        } finally {
          this.texturesApplied[0] = 0;
        }
      },
      dispose: () => {
        if (!this.textures.delete(texture)) {
          return;
        }

        this.textureCounts[kind]--;
        this.drawState.forget();
        this.textureQuotaBytes[kind] -= quotaBytes;

        if (this.renderTexture === texture) {
          this.renderTexture = null;
          this.renderDepth = false;
          this.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
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

        for (let i = 0; i < this.outputs.length; i++) {
          if (this.outputs[i] === texture) {
            this.outputs[i] = null;
            this.outputsChanged = true;
            this.outputsBound = this.outputMask() !== 0;
          }
        }
        for (let i = 0; i < this.textureSlots.length; i++) {
          if (this.textureSlots[i] === texture) {
            this.texturesApplied[i] = 0;
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
    this.textureCounts[kind]++;
    this.textureQuotaBytes[kind] += quotaBytes;
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
    this.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
    gl.viewport(0, 0, texture.width, texture.height);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.STENCIL_TEST);
    gl.disable(gl.BLEND);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.SCISSOR_TEST);
    gl.colorMask(true, true, true, true);
    this.texturesApplied[0] = 0;
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
    if (this.cullFace !== "none") {
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
    this.drawState.forget();
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
    this.drawState.forget();
    this.texturesApplied[0] = 0;
    const target = allocateMultisample(
      this.gl,
      texture,
      old,
      samples,
      depth,
      this.depthWrite,
      this.stencilWrite,
      state.storage,
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
      if (compressedFormat(texture.format)) {
        throw new Context3DError(
          "operation",
          "Context3D experiment: compressed textures are no render targets",
        );
      }
      this.renderFormat(texture.format);
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
        this.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
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
          this.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
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
        this.bindFramebuffer(
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
    for (let i = 0; this.outputsBound && i < this.outputs.length; i++) {
      const output = this.outputs[i];
      if (output) {
        this.textureState(output).dirty = true;
      }
    }
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
    if (this.renderTexture) {
      this.finishTexture(this.renderTexture, this.renderFace);
    }
    for (let i = 0; i < this.outputs.length; i++) {
      const output = this.outputs[i];
      if (output) {
        this.finishTexture(output, this.outputFaces[i]);
      }
    }
  }

  /** A texture drawn into made whole again: resolved, and its mips regenerated. */
  private finishTexture(texture: Texture3D, renderFace: number): void {
    const state = this.textureState(texture);
    if (state.dirty) {
      const gl = this.gl;
      this.drawState.forget();
      this.texturesApplied[0] = 0;
      resolveTarget(this.gl, texture, state, renderFace, this.scissor);
      gl.activeTexture(gl.TEXTURE0);
      if (texture.cube) {
        // An extra colour output may never have been a target of its own.
        state.framebuffer ??= gl.createFramebuffer();
        state.mipFramebuffer ??= gl.createFramebuffer();
        // generateMipmap(CUBE_MAP) would overwrite manually uploaded mips on
        // untouched faces. AIR regenerates only the face just rendered.
        gl.disable(gl.SCISSOR_TEST);
        const face = gl.TEXTURE_CUBE_MAP_POSITIVE_X + renderFace;
        // The base-size depth attachment cannot accompany smaller mip images.
        this.bindFramebuffer(gl.FRAMEBUFFER, state.framebuffer);
        if (state.depthAttached) {
          gl.framebufferRenderbuffer(
            gl.FRAMEBUFFER,
            gl.DEPTH_STENCIL_ATTACHMENT,
            gl.RENDERBUFFER,
            null,
          );
        }
        for (let level = 1; level < texture.levels; level++) {
          this.bindFramebuffer(gl.READ_FRAMEBUFFER, state.framebuffer);
          gl.framebufferTexture2D(
            gl.READ_FRAMEBUFFER,
            gl.COLOR_ATTACHMENT0,
            face,
            state.handle,
            level - 1,
          );
          this.bindFramebuffer(gl.DRAW_FRAMEBUFFER, state.mipFramebuffer);
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
        this.bindFramebuffer(gl.FRAMEBUFFER, state.framebuffer);
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
      state.uploaded[renderFace] = (1 << texture.levels) - 1;
      state.dirty = false;
    }
  }

  /** Half floats are drawn into where the GPU's WebGL renders float colour, as every desktop one does. */
  private renderFormat(format: TextureFormat): void {
    if (format !== "rgbaHalfFloat") {
      return;
    }

    this.floatTargets ??= this.gl.getExtension("EXT_color_buffer_float") !== null;
    if (!this.floatTargets) {
      throw new Context3DError("unsupported", "Context3D: this GPU draws into no half floats");
    }
  }

  setColorOutput(index: number, texture: Texture3D | null, face = 0): void {
    this.alive();
    range(index - 1, 1, this.outputs.length);
    if (texture) {
      this.textureState(texture);
      range(face, 1, texture.cube ? 6 : 1);
      if (compressedFormat(texture.format)) {
        throw new Context3DError(
          "operation",
          "Context3D experiment: compressed textures are no render targets",
        );
      }
      this.renderFormat(texture.format);
    }
    if (this.outputs[index - 1] === texture && this.outputFaces[index - 1] === face) {
      return;
    }

    const previous = this.outputs[index - 1];
    if (previous) {
      this.finishTexture(previous, this.outputFaces[index - 1]);
    }
    this.outputs[index - 1] = texture;
    this.outputFaces[index - 1] = texture ? face : 0;
    this.outputsChanged = true;
    this.outputsBound = this.outputMask() !== 0;
  }

  /**
   * The current target's framebuffer with the extra colour outputs attached, or without
   * them: its draws write every output bound, and a program's unwritten ones are refused
   * before they draw.
   */
  private attachOutputs(state: TextureState | null): void {
    const want = state ? this.outputMask() : 0;
    if (!state || (!this.outputsChanged && state.outputs === want)) {
      return;
    }
    if (want && state.samples) {
      throw new Context3DError("unsupported", "Context3D: antialiased colour outputs");
    }

    const gl = this.gl;
    const buffers: number[] = [gl.COLOR_ATTACHMENT0];
    for (let i = 0; i < this.outputs.length; i++) {
      const output = this.outputs[i];
      const handle = output ? this.textureState(output).handle : null;
      gl.framebufferTexture2D(
        gl.FRAMEBUFFER,
        gl.COLOR_ATTACHMENT1 + i,
        output?.cube ? gl.TEXTURE_CUBE_MAP_POSITIVE_X + this.outputFaces[i] : gl.TEXTURE_2D,
        handle,
        0,
      );
      buffers.push(output ? gl.COLOR_ATTACHMENT1 + i : gl.NONE);
    }
    gl.drawBuffers(buffers);
    state.outputs = want;
    this.outputsChanged = false;
  }

  /** The extra colour outputs bound, a bit each from output 1. */
  private outputMask(): number {
    let mask = 0;
    for (let i = 0; i < this.outputs.length; i++) {
      if (this.outputs[i]) {
        mask |= 1 << i;
      }
    }

    return mask;
  }

  setTexture(index: number, texture: Texture3D | null): void {
    this.alive();
    range(index, 1, SAMPLER_SLOTS);
    if (texture && !this.textureOwners.has(texture)) {
      throw new Context3DError("disposed", "Context3D experiment: texture from another context");
    }

    // AIR accepts a disposed texture binding and reports 3663 when drawing.
    if (this.textureSlots[index] !== texture) {
      this.texturesApplied[index] = 0;
    }
    this.textureSlots[index] = texture;
    this.textureMask = (this.textureMask & ~(1 << index)) | (texture ? 1 << index : 0);
    if (!texture) {
      this.texturesApplied[index] = 0;
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

    this.setSamplerState(index, w | (f << 2) | (m << 5));
  }

  private setSamplerState(index: number, state: number): void {
    if (this.samplerStates[index] !== state) {
      this.samplerStates[index] = state;
      this.texturesApplied[index] = 0;
    }
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
        this.setSamplerState(
          source.index,
          WRAPS[source.wrap] | (source.filter << 2) | (source.mip << 5),
        );
      }
    }
  }

  setVertex(index: number, buffer: Buffer3D | null, offset: number, format: VertexFormat): void {
    this.alive();
    range(index, 1, VERTEX_SLOTS);
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
      if (
        previous.buffer !== buffer ||
        previous.offset !== offset ||
        previous.size !== size ||
        previous.packed !== packed
      ) {
        previous.applied = false;
      }

      if (previous.buffer !== buffer) {
        previous.checkedIndex = null;
      }
      previous.buffer = buffer;
      previous.offset = offset;
      previous.size = size;
      previous.packed = packed;
      previous.valid = valid;
    } else {
      this.vertices[index] = {
        buffer,
        offset,
        size,
        packed,
        valid,
        applied: false,
        checkedIndex: null,
        checkedIndexVersion: -1,
        checkedVertexVersion: -1,
        checkedFirst: 0,
        checkedCount: 0,
      };
    }
  }

  setConstants(stage: ProgramType, first: number, values: ArrayLike<number>, count: number): void {
    this.alive();
    const dest = stage === "vertex" ? this.vertexConstants : this.fragmentConstants;
    range(first, count, dest.data.length / 4);
    range(0, count * 4, values.length);

    dest.writing++;
    try {
      for (let i = 0; i < count * 4; i++) {
        dest.data[first * 4 + i] = values[i];
      }
    } finally {
      // Source getters can draw, nest setters or throw after partially writing the bank.
      dest.writing--;
      if (count) {
        dest.versions.fill(++dest.version, first, first + count);
      }
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

    const maximum = validateIndices(index, first, count);

    const gl = this.gl;
    this.drawState.bindVertexArray(this.vao);
    // The streams enabled that the program does not read, highest first.
    let stale = this.enabledAttributes & ~state.attributeMask;
    while (stale) {
      const i = 31 - Math.clz32(stale);
      gl.disableVertexAttribArray(i);
      stale &= ~(1 << i);
    }
    this.enabledAttributes &= state.attributeMask;

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

      validateVertices(buffer, index, binding, first, count, maximum);

      if (!binding.applied) {
        gl.bindBuffer(gl.ARRAY_BUFFER, buffer.handle);
        gl.vertexAttribPointer(
          slot,
          binding.size,
          binding.packed ? gl.UNSIGNED_BYTE : gl.FLOAT,
          binding.packed,
          binding.buffer.stride * 4,
          binding.offset * 4,
        );
        binding.applied = true;
      }

      const bit = 1 << slot;
      if (!(this.enabledAttributes & bit)) {
        gl.enableVertexAttribArray(slot);
        this.enabledAttributes |= bit;
      }
    }

    this.drawState.useProgram(state.handle);
    const targetY = this.renderTexture ? -1 : 1;
    if (state.targetYValue !== targetY) {
      gl.uniform1f(state.targetY, targetY);
      state.targetYValue = targetY;
    }
    for (let i = 0; i < state.samplers.length; i++) {
      const binding = state.samplers[i];
      const slot = binding.source.index;
      const texture = this.textureSlots[slot];
      if (
        texture &&
        (texture === this.renderTexture ||
          (this.outputsBound &&
            (texture === this.outputs[0] ||
              texture === this.outputs[1] ||
              texture === this.outputs[2])))
      ) {
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
      const base = texture.streaming
        ? this.streamingBase(texture, resource, this.samplerStates[slot] >>> 5 !== 0)
        : 0;
      for (let face = 0; !texture.streaming && face < resource.uploaded.length; face++) {
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
      // AGAL must say a compressed texture is one, and which: AIR reads nothing otherwise.
      if (this.samplerFormats && binding.source.format !== SAMPLER_FORMATS[texture.format]) {
        throw new TextureBindingError("format", slot);
      }

      if (!this.texturesApplied[slot]) {
        gl.activeTexture(gl.TEXTURE0 + slot);
        gl.bindTexture(texture.cube ? gl.TEXTURE_CUBE_MAP : gl.TEXTURE_2D, resource.handle);
        gl.bindSampler(slot, this.sampler(this.samplerStates[slot]));
        this.texturesApplied[slot] = 1;
      }
      if (resource.base !== base) {
        const target = texture.cube ? gl.TEXTURE_CUBE_MAP : gl.TEXTURE_2D;
        gl.activeTexture(gl.TEXTURE0 + slot);
        gl.bindTexture(target, resource.handle);
        gl.texParameteri(target, gl.TEXTURE_BASE_LEVEL, base);
        resource.base = base;
      }
      if (!state.samplersSet) {
        gl.uniform1i(binding.location, slot);
      }
    }

    state.samplersSet = true;

    if (state.vertexBank) {
      if (this.vertexConstants.writing || state.vertexVersion !== this.vertexConstants.version) {
        gl.uniform4fv(state.vertexBank, this.vertexConstants.data, 0, INDIRECT_BANK * 4);
        state.vertexVersion = this.vertexConstants.version;
      }
    }
    // An indirect program's own uniforms are only the registers past its bank.
    if (state.vertex.length) {
      this.uniforms(state.vertex, this.vertexConstants, state.vertexVersions, state.vertexValues);
    }
    this.uniforms(
      state.fragment,
      this.fragmentConstants,
      state.fragmentVersions,
      state.fragmentValues,
    );
    if (this.indexBuffer !== index.handle) {
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, index.handle);
      this.indexBuffer = index.handle;
    }
    gl.drawElements(gl.TRIANGLES, count, gl.UNSIGNED_SHORT, first * 2);
    this.changedTarget();
  }

  /**
   * The level a streaming texture is drawn from, as AIR 51 draws one: with mip filtering, the
   * finest whose levels down to the smallest are uploaded on every face, which must reach its
   * streaming level (#3700 before); without, its level 0 alone (#3713), as a texture that
   * does not stream.
   */
  private streamingBase(texture: Texture3D, resource: TextureState, mip: boolean): number {
    const faces = resource.uploaded.length;
    let uploaded = 0;
    for (let face = 0; face < faces; face++) {
      uploaded |= resource.uploaded[face];
    }
    if (!uploaded) {
      throw new TextureBindingError("unuploaded");
    }
    if (!mip) {
      for (let face = 0; face < faces; face++) {
        if (!(resource.uploaded[face] & 1)) {
          throw new TextureBindingError("streaming");
        }
      }

      return 0;
    }

    let base = texture.levels;
    while (base > 0) {
      let whole = true;
      for (let face = 0; face < faces; face++) {
        whole &&= (resource.uploaded[face] & (1 << (base - 1))) !== 0;
      }
      if (!whole) {
        break;
      }

      base--;
    }
    if (base > texture.streaming) {
      throw new TextureBindingError("mipmaps");
    }

    return base;
  }

  private uniforms(
    locations: (WebGLUniformLocation | null)[],
    bank: Constants,
    previous: Float64Array,
    values: Uint32Array,
  ): void {
    for (let i = 0; i < locations.length; i++) {
      if (locations[i] && (bank.writing || previous[i] !== bank.versions[i])) {
        const offset = i * 4;
        const a = bank.bits[offset];
        const b = bank.bits[offset + 1];
        const c = bank.bits[offset + 2];
        const d = bank.bits[offset + 3];
        // Compare float32 bits so signed zero and NaN payloads keep reaching GL unchanged.
        if (
          previous[i] < 0 ||
          values[offset] !== a ||
          values[offset + 1] !== b ||
          values[offset + 2] !== c ||
          values[offset + 3] !== d
        ) {
          this.gl.uniform4fv(locations[i], bank.data, offset, 4);
          values[offset] = a;
          values[offset + 1] = b;
          values[offset + 2] = c;
          values[offset + 3] = d;
        }
        previous[i] = bank.versions[i];
      }
    }
  }

  read(width = this.width, height = this.height): Uint8Array {
    return readBackBuffer(this, width, height);
  }

  present(): void {
    presentBackBuffer(this);
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
    this.bindFramebuffer(this.gl.FRAMEBUFFER, null);
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
    this.texturesApplied.fill(0);
    this.indexBuffer = null;
    this.drawState.forget();
  }
}
