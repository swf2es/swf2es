import { binary } from "./binary.js";

/**
 * A layer's opaque lines as triangles (root.zig): the caller writes the
 * layer into input()'s view and calls build() with its length.
 */
export interface LineGeometry {
  positions: Float32Array;
  colors: Uint32Array;
  indices: Uint32Array;
}

interface NativeExports {
  memory: WebAssembly.Memory;
  input(n: number): number;
  build(length: number): number;
  pack(): number;
  headerAt(): number;
  positionsAt(): number;
  colorsAt(): number;
  indicesAt(): number;
  vertexCount(): number;
  indexCount(): number;
}

/** The commands of a path root.zig takes, as the player's shapes have them. */
export const PATH_MOVE = 1;
export const PATH_LINE = 2;
export const PATH_CURVE = 3;
export const PATH_CUBIC = 4;

let module: WebAssembly.Module | null = null;

export class LineBuilder {
  private readonly x: NativeExports;
  private view = new Float64Array(0);
  private capacity = 0;
  private header = new Uint32Array(0);

  constructor() {
    module ??= new WebAssembly.Module(Uint8Array.from(atob(binary), (c) => c.charCodeAt(0)));
    this.x = new WebAssembly.Instance(module, {}).exports as unknown as NativeExports;
  }

  /** A view of at least `n` f64s of input, valid until the next call. */
  input(n: number): Float64Array {
    if (n > this.capacity || this.view.buffer !== this.x.memory.buffer) {
      const size = Math.max(n, this.capacity * 2, 1024);
      const at = this.x.input(size);
      if (!at) {
        throw new Error("line input allocation failed");
      }

      this.view = new Float64Array(this.x.memory.buffer, at, size);
      this.capacity = size;
    }

    return this.view;
  }

  /** The native call alone, its output left in the module: for timing what copying costs. */
  run(length: number): number {
    return this.x.build(length);
  }

  /** The layer in the input's first `length` f64s, copied out; null for none, or a failure. */
  build(length: number): LineGeometry | null {
    const x = this.x;
    if (x.build(length) !== 0 || x.indexCount() === 0) {
      return null;
    }

    const buffer = x.memory.buffer;
    const vertices = x.vertexCount();
    return {
      positions: new Float32Array(buffer, x.positionsAt(), vertices * 2).slice(),
      colors: new Uint32Array(buffer, x.colorsAt(), vertices).slice(),
      indices: new Uint32Array(buffer, x.indicesAt(), x.indexCount()).slice(),
    };
  }

  /** As build(), the geometry laid out in one block in the module and copied out at once. */
  buildBlock(length: number): LineGeometry | null {
    const x = this.x;
    if (x.build(length) !== 0 || x.pack() !== 0) {
      return null;
    }

    const buffer = x.memory.buffer;
    if (this.header.buffer !== buffer) {
      this.header = new Uint32Array(buffer, x.headerAt(), 3);
    }

    const [at, vertices, count] = this.header;
    if (count === 0) {
      return null;
    }

    const copy = buffer.slice(at, at + (vertices * 3 + count) * 4);
    return {
      positions: new Float32Array(copy, 0, vertices * 2),
      colors: new Uint32Array(copy, vertices * 8, vertices),
      indices: new Uint32Array(copy, vertices * 12, count),
    };
  }
}
