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

export class ScissorBoundsError extends Error {}

export class TextureBindingError extends Error {
  readonly reason: "unused" | "conflicting" | "missing" | "unuploaded" | "mipmaps";

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
  /** Top-down premultiplied ARGB pixels, copied before returning. */
  upload(pixels: Uint32Array, level?: number): void;
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
  configure(width: number, height: number, depth?: boolean): void;
  clear(
    red: number,
    green: number,
    blue: number,
    alpha: number,
    depth?: number,
    mask?: number,
  ): void;
  setDepth(write: boolean, compare: CompareMode): void;
  setCulling(face: CullFace): void;
  setBlend(source: BlendFactor, destination: BlendFactor): void;
  /** Null disables clipping; coordinates are in top-down target pixels. */
  setScissor(x: number | null, y?: number, width?: number, height?: number): void;
  createBuffer(count: number, stride: number): Buffer3D;
  createProgram(): Program3D;
  createTexture(width: number, height: number): Texture3D;
  setTexture(index: number, texture: Texture3D | null): void;
  setProgram(program: Program3D): void;
  setVertex(index: number, buffer: Buffer3D | null, offset: number, size: number): void;
  setConstants(stage: ProgramType, first: number, values: ArrayLike<number>, count: number): void;
  draw(indices: Buffer3D, first: number, triangles: number): void;
  /** Top-down raw RGBA channels, without alpha conversion; valid until the next read. */
  read(): Uint8Array;
  present(): void;
  dispose(): void;
}
