import type { ProgramType } from "./agal.js";
import type { DxtEncoder } from "./dxt.js";

/**
 * The widest and tallest back buffer configure() takes: Flash Player 32's and AIR 51's
 * maxBackBufferWidth and maxBackBufferHeight on a desktop GPU, in every profile. A GPU that
 * allows less still takes it, and draws it smaller (WebGLContext3D).
 */
export const MOST_BACK_BUFFER = 16384;

export const COMPARE_MODES = [
  "always",
  "never",
  "less",
  "lessEqual",
  "equal",
  "notEqual",
  "greaterEqual",
  "greater",
] as const;
export type CompareMode = (typeof COMPARE_MODES)[number];
export const CULL_FACES = ["none", "back", "front", "frontAndBack"] as const;
export type CullFace = (typeof CULL_FACES)[number];
export const STENCIL_ACTIONS = [
  "keep",
  "zero",
  "set",
  "incrementSaturate",
  "decrementSaturate",
  "invert",
  "incrementWrap",
  "decrementWrap",
] as const;
export type StencilAction = (typeof STENCIL_ACTIONS)[number];
export const BLEND_FACTORS = [
  "zero",
  "one",
  "sourceColor",
  "oneMinusSourceColor",
  "sourceAlpha",
  "oneMinusSourceAlpha",
  "destinationColor",
  "oneMinusDestinationColor",
  "destinationAlpha",
  "oneMinusDestinationAlpha",
] as const;
export type BlendFactor = (typeof BLEND_FACTORS)[number];

export const SAMPLER_WRAPS = ["clamp", "repeat_u_clamp_v", "clamp_u_repeat_v", "repeat"] as const;
export type SamplerWrap = (typeof SAMPLER_WRAPS)[number];
export const SAMPLER_FILTERS = [
  "nearest",
  "linear",
  "anisotropic2x",
  "anisotropic4x",
  "anisotropic8x",
  "anisotropic16x",
] as const;
export type SamplerFilter = (typeof SAMPLER_FILTERS)[number];
export const SAMPLER_MIPS = ["mipnone", "mipnearest", "miplinear"] as const;
export type SamplerMip = (typeof SAMPLER_MIPS)[number];

/** The texture formats a backend stores: BGRA, and S3TC's DXT1 and DXT5 as Flash calls them. */
export const TEXTURE_FORMATS = ["bgra", "compressed", "compressedAlpha"] as const;
export type TextureFormat = (typeof TEXTURE_FORMATS)[number];

/** Stage3D's profiles, from what the least GPU does to the most. */
export const PROFILES = [
  "baselineConstrained",
  "baseline",
  "baselineExtended",
  "standardConstrained",
  "standard",
  "standardExtended",
] as const;
export type Profile = (typeof PROFILES)[number];

/** What a profile allows, as AIR 51 grants it on a desktop GPU (docs/architecture/rendering.md). */
export interface ProfileLimits {
  /** The newest AGAL version its programs may be. */
  readonly agal: number;
  /** The widest and tallest Texture. */
  readonly textureSize: number;
  /** The widest and tallest RectangleTexture, 0 where the profile has none. */
  readonly rectangleSize: number;
  /** Whether it creates rgbaHalfFloat textures. */
  readonly halfFloat: boolean;
  /** How many textures a draw renders into at once. */
  readonly colorOutputs: number;
}

const LIMITS: Record<Profile, ProfileLimits> = {
  baselineConstrained: {
    agal: 1,
    textureSize: 2048,
    rectangleSize: 0,
    halfFloat: false,
    colorOutputs: 1,
  },
  baseline: { agal: 1, textureSize: 2048, rectangleSize: 2048, halfFloat: false, colorOutputs: 1 },
  baselineExtended: {
    agal: 1,
    textureSize: 4096,
    rectangleSize: 4096,
    halfFloat: false,
    colorOutputs: 1,
  },
  standardConstrained: {
    agal: 2,
    textureSize: 4096,
    rectangleSize: 4096,
    halfFloat: true,
    colorOutputs: 1,
  },
  standard: { agal: 2, textureSize: 4096, rectangleSize: 4096, halfFloat: true, colorOutputs: 4 },
  standardExtended: {
    agal: 3,
    textureSize: 4096,
    rectangleSize: 4096,
    halfFloat: true,
    colorOutputs: 4,
  },
};

export function profileLimits(profile: Profile): ProfileLimits {
  return LIMITS[profile];
}

/** Cube faces are at most this wide in every profile. */
export const MOST_CUBE = 1024;

/** Sampler, vertex attribute and constant registers a context holds in every profile. */
export const SAMPLER_SLOTS = 16;
export const VERTEX_SLOTS = 16;
export const VERTEX_CONSTANTS = 250;
export const FRAGMENT_CONSTANTS = 200;

export const VERTEX_FORMATS = ["float1", "float2", "float3", "float4", "bytes4"] as const;
export type VertexFormat = (typeof VERTEX_FORMATS)[number];

export class VertexOffsetError extends Error {}

export class ScissorBoundsError extends Error {}

export class SamplerBiasError extends Error {}

export class TextureBindingError extends Error {
  readonly reason:
    | "unused"
    | "conflicting"
    | "missing"
    | "unuploaded"
    | "mipmaps"
    | "dimension"
    | "wrap"
    | "rectangleMip"
    | "feedback"
    | "format";

  /** The sampler it names, where it names one. */
  readonly sampler: number;

  constructor(reason: TextureBindingError["reason"], sampler = -1) {
    super(`Invalid texture binding: ${reason}`);
    this.reason = reason;
    this.sampler = sampler;
  }
}

// No AS objects, renderer objects or browser globals cross this boundary.
export interface Buffer3D {
  readonly count: number;
  readonly stride: number;
  upload(values: ArrayLike<number>, start: number, count: number): void;
  /** Raw little-endian bytes, copied before returning; offset is relative to data. */
  uploadBytes(data: Uint8Array, offset: number, start: number, count: number): void;
  dispose(): void;
}

export interface Program3D {
  /** The vertex attributes it reads, a bit each; 0 before an upload. */
  readonly attributes: number;
  upload(vertex: Uint8Array, fragment: Uint8Array): void;
  dispose(): void;
}

export interface Texture3D {
  readonly width: number;
  readonly height: number;
  readonly levels: number;
  readonly cube: boolean;
  readonly rectangle: boolean;
  /** What samplers must read it as; a compressed texture also takes pixels, as AIR's do. */
  readonly format: TextureFormat;
  /** Top-down premultiplied ARGB pixels, copied before returning.
   * All texture kinds clip/pad source dimensions against the selected face/mip. */
  upload(
    pixels: Uint32Array,
    level?: number,
    face?: number,
    sourceWidth?: number,
    sourceHeight?: number,
  ): void;
  /** Top-down BGRA bytes, copied verbatim without alpha conversion. */
  uploadBytes(data: Uint8Array, offset: number, level?: number, face?: number): void;
  /**
   * A compressed texture's level as S3TC blocks, DXT1's for "compressed" and
   * DXT5's for "compressedAlpha": rows of 4x4 blocks from the top, at least
   * one however small the level, copied before returning.
   */
  uploadCompressed(blocks: Uint8Array, level?: number, face?: number): void;
  dispose(): void;
}

export interface Context3DLifecycle {
  lost(): void;
  restored(): void;
}

/** Loss callbacks are asynchronous. Keep the lost surface until remove(), including
 * its restoration listener; remove() must detach both listeners before releasing it. */
export interface Stage3DHost {
  create(slot: number, lifecycle: Context3DLifecycle): Context3D;
  place(slot: number, x: number, y: number, visible: boolean): void;
  remove(slot: number): void;
}

export interface Context3D {
  readonly width: number;
  readonly height: number;
  readonly disposed: boolean;
  /**
   * Whether a draw refuses a sampler that reads its texture as another
   * format (TextureBindingError "format"): AIR checks from SWF 17 on.
   */
  samplerFormats: boolean;
  /** The profile it was made for: what its programs, textures and targets may be. */
  profile: Profile;
  /** Optional acceleration for pixels uploaded to compressed textures. */
  setDxtEncoder?(encoder: DxtEncoder): void;
  /** Width and height from 32 to MOST_BACK_BUFFER. */
  configure(width: number, height: number, depth?: boolean, antiAlias?: number): void;
  /** No back buffer, width and height 0, as a size configureBackBuffer refuses leaves AIR's. */
  unconfigure(): void;
  clear(
    red: number,
    green: number,
    blue: number,
    alpha: number,
    depth?: number,
    mask?: number,
    stencil?: number,
  ): void;
  setStencilActions(
    face: CullFace,
    compare: CompareMode,
    pass: StencilAction,
    depthFail: StencilAction,
    stencilFail: StencilAction,
  ): void;
  setStencilReference(reference: number, readMask: number, writeMask: number): void;
  setDepth(write: boolean, compare: CompareMode): void;
  setCulling(face: CullFace): void;
  setBlend(source: BlendFactor, destination: BlendFactor): void;
  setColorMask(red: boolean, green: boolean, blue: boolean, alpha: boolean): void;
  /** Null disables clipping; coordinates are in top-down target pixels. */
  setScissor(x: number | null, y?: number, width?: number, height?: number): void;
  createBuffer(count: number, stride: number): Buffer3D;
  createProgram(): Program3D;
  createTexture(width: number, height: number, cube?: boolean, format?: TextureFormat): Texture3D;
  createRectangleTexture(width: number, height: number): Texture3D;
  /** Level-zero target; face selects a cube surface. Null resumes the back buffer. */
  setRenderTarget(
    texture: Texture3D | null,
    depth?: boolean,
    face?: number,
    antiAlias?: number,
  ): void;
  setSampler(index: number, wrap: SamplerWrap, filter: SamplerFilter, mip: SamplerMip): void;
  setTexture(index: number, texture: Texture3D | null): void;
  setProgram(program: Program3D): void;
  /** Offset counts 32-bit words; bytes4 consumes one word, normalized on the GPU. */
  setVertex(index: number, buffer: Buffer3D | null, offset: number, format: VertexFormat): void;
  setConstants(stage: ProgramType, first: number, values: ArrayLike<number>, count: number): void;
  draw(indices: Buffer3D, first: number, triangles: number): void;
  /**
   * Top-down raw RGBA channels of the back buffer's top-left width by height
   * (the whole of it by default), rows width * 4 bytes apart, without alpha
   * conversion; valid until the next read. Each size is at most the back
   * buffer's: a larger one is clamped to it, a negative one to 0.
   */
  read(width?: number, height?: number): Uint8Array;
  present(): void;
  dispose(): void;
}
