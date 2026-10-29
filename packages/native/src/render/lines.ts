import { renderInstance } from "./module.js";

/** A layer's lines as triangles: two floats a vertex, its colour, and three indices a triangle. */
export interface LineGeometry {
  positions: Float32Array;
  colors: Uint32Array;
  indices: Uint32Array;
}

interface NativeExports {
  memory: WebAssembly.Memory;
  lineInput(n: number): number;
  lineHeader(): number;
  lineBuild(length: number): number;
  setLimit(n: number): void;
  bandsOnly(on: number): void;
}

export interface LineBuilderOptions {
  /** Maximum arena address, including the C stack; at most 128 MiB. */
  memoryLimit?: number;
  /** Drop instances larger than this after each call. Defaults to 8 MiB. */
  retainMemory?: number;
}

/**
 * A shape layer's lines built in one call by the render module's
 * strokes.zig, as the player's scene/strokes.ts builds them, its outlines
 * filled by the module's libtess2: the caller writes the layer into
 * input() as strokes.zig reads it and calls build() with its length. Its
 * instance is its own, apart from any Tessellator's, and held to the same
 * limits as a Tessellator's (TessellatorOptions), which pass them on: where
 * a fill would have run out of memory, so do the lines, and JS builds them.
 */
export class LineBuilder {
  private instance: NativeExports | null = null;
  private unavailable = false;
  private view = new Float64Array(0);
  private layout = new Uint32Array(0);
  /** libtess2 trapped the last instance: the next fills its outlines by the bands alone. */
  private trapped = false;
  private readonly limit: number;
  private readonly keep: number;

  constructor(options: LineBuilderOptions = {}) {
    this.limit = options.memoryLimit ?? 128 << 20;
    this.keep = options.retainMemory ?? 8 << 20;
  }

  /** Current retained Wasm capacity. */
  get capacity(): number {
    return this.instance?.memory.buffer.byteLength ?? 0;
  }

  /** A view of at least `n` f64s of input, valid until build(); null where the module is unavailable. */
  input(n: number): Float64Array | null {
    if (this.unavailable) {
      return null;
    }

    if (!this.instance) {
      try {
        this.instance = renderInstance(() => {
          throw new Error("line tessellation allocation failed");
        }) as unknown as NativeExports;
      } catch {
        // A missing Wasm engine or SIMD, or a CSP refusal, is tried only once per owner.
        this.unavailable = true;
        return null;
      }

      this.instance.setLimit(this.limit);
      this.instance.bandsOnly(Number(this.trapped));
    }

    const x = this.instance;
    if (n > this.view.length || this.view.buffer !== x.memory.buffer) {
      const size = Math.max(n, this.view.length * 2, 1024);
      const at = x.lineInput(size);
      if (!at) {
        this.dispose();
        return null;
      }

      this.view = new Float64Array(x.memory.buffer, at, size);
    }

    return this.view;
  }

  /**
   * The layer in the input's first `length` f64s, copied out in one
   * block: null for none, undefined where the module refused it (a
   * position not a number) or failed, for the caller to build in JS. Where
   * libtess2 trapped, the next instance fills the layer's outlines by the
   * bands alone, for the caller's next input() and build().
   */
  build(length: number): LineGeometry | null | undefined {
    const x = this.instance;
    if (!x) {
      return undefined;
    }

    try {
      if (x.lineBuild(length) !== 0) {
        return undefined;
      }

      if (this.trapped) {
        this.trapped = false;
        x.bandsOnly(0);
      }

      const [at, vertices, count] = this.header(x);
      if (count === 0) {
        return null;
      }

      const copy = x.memory.buffer.slice(at, at + (vertices * 3 + count) * 4);
      return {
        positions: new Float32Array(copy, 0, vertices * 2),
        colors: new Uint32Array(copy, vertices * 8, vertices),
        indices: new Uint32Array(copy, vertices * 12, count),
      };
    } catch {
      // libtess2 unwound through the failure import: never resume that instance.
      this.dispose();
      this.trapped = true;
      return undefined;
    } finally {
      if (this.capacity > this.keep) {
        this.dispose();
      }
    }
  }

  /** strokes.zig's layout, read again where memory grew. */
  private header(x: NativeExports): Uint32Array {
    if (this.layout.buffer !== x.memory.buffer) {
      this.layout = new Uint32Array(x.memory.buffer, x.lineHeader(), 3);
    }

    return this.layout;
  }

  /** The instance let go, its memory with it; the next input() makes another. */
  dispose(): void {
    this.instance = null;
    this.view = new Float64Array(0);
    this.layout = new Uint32Array(0);
  }
}
