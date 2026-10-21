import type { ProgramType } from "./agal.ts";

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

export const VERTEX_FORMATS = ["float1", "float2", "float3", "float4", "bytes4"] as const;
export type VertexFormat = (typeof VERTEX_FORMATS)[number];

export class VertexOffsetError extends Error {}

export class ScissorBoundsError extends Error {}

export class TextureBindingError extends Error {
  readonly reason:
    | "unused"
    | "conflicting"
    | "missing"
    | "unuploaded"
    | "mipmaps"
    | "dimension"
    | "feedback";

  constructor(reason: TextureBindingError["reason"]) {
    super(`Invalid texture binding: ${reason}`);
    this.reason = reason;
  }
}

// No AS objects, Pixi objects or browser globals cross this boundary.
export interface Buffer3D {
  readonly count: number;
  readonly stride: number;
  upload(values: ArrayLike<number>, start: number, count: number): void;
  /** Raw little-endian bytes, copied before returning; offset is relative to data. */
  uploadBytes(data: Uint8Array, offset: number, start: number, count: number): void;
  dispose(): void;
}

export interface Program3D {
  upload(vertex: Uint8Array, fragment: Uint8Array): void;
  dispose(): void;
}

export interface Texture3D {
  readonly width: number;
  readonly height: number;
  readonly levels: number;
  readonly cube: boolean;
  /** Top-down premultiplied ARGB pixels, copied before returning. */
  upload(pixels: Uint32Array, level?: number, face?: number): void;
  /** Top-down BGRA bytes, copied verbatim without alpha conversion. */
  uploadBytes(data: Uint8Array, offset: number, level?: number, face?: number): void;
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
  configure(width: number, height: number, depth?: boolean, antiAlias?: number): void;
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
  createTexture(width: number, height: number, cube?: boolean): Texture3D;
  /** Level-zero target; face selects a cube surface. Null resumes the back buffer. */
  setRenderTarget(texture: Texture3D | null, depth?: boolean, face?: number): void;
  setTexture(index: number, texture: Texture3D | null): void;
  setProgram(program: Program3D): void;
  /** Offset counts 32-bit words; bytes4 consumes one word, normalized on the GPU. */
  setVertex(index: number, buffer: Buffer3D | null, offset: number, format: VertexFormat): void;
  setConstants(stage: ProgramType, first: number, values: ArrayLike<number>, count: number): void;
  draw(indices: Buffer3D, first: number, triangles: number): void;
  /** Top-down raw RGBA channels, without alpha conversion; valid until the next read. */
  read(): Uint8Array;
  present(): void;
  dispose(): void;
}
