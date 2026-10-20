import type { ProgramType } from "./agal.ts";

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

/** The host owns placement and lifetime of the surfaces beneath the display list. */
export interface Stage3DHost {
  create(slot: number): Context3D;
  place(slot: number, x: number, y: number, visible: boolean): void;
  remove(slot: number): void;
}

export interface Context3D {
  readonly width: number;
  readonly height: number;
  readonly disposed: boolean;
  configure(width: number, height: number): void;
  clear(red: number, green: number, blue: number, alpha: number): void;
  createBuffer(count: number, stride: number): Buffer3D;
  createProgram(): Program3D;
  setProgram(program: Program3D): void;
  setVertex(index: number, buffer: Buffer3D | null, offset: number, size: number): void;
  setConstants(stage: ProgramType, first: number, values: ArrayLike<number>, count: number): void;
  draw(indices: Buffer3D, first: number, triangles: number): void;
  /** Top-down, straight RGBA bytes; read only until the next read. */
  read(): Uint8Array;
  present(): void;
  dispose(): void;
}
