import { renderCompiled, renderInstance } from "./module.js";

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
}

/** An instance grown past this is let go after its call: what Tessellator keeps by default. */
const KEEP = 8 << 20;

/**
 * A shape layer's lines built in one call by the render module's
 * strokes.zig, as the player's scene/strokes.ts builds them, its outlines
 * filled by the module's libtess2: the caller writes the layer into
 * input() as strokes.zig reads it and calls build() with its length. Its
 * instance is its own, apart from any Tessellator's.
 */
export class LineBuilder {
  private instance: NativeExports | null = null;
  private unavailable = false;
  private view = new Float64Array(0);
  private layout = new Uint32Array(0);

  /** A view of at least `n` f64s of input, valid until build(); null where the module is unavailable. */
  input(n: number): Float64Array | null {
    if (this.unavailable) {
      return null;
    }

    try {
      this.instance ??= renderInstance(() => {
        throw new Error("line tessellation allocation failed");
      }) as unknown as NativeExports;
    } catch {
      // Compilation can be blocked by CSP or unavailable on the host.
      this.unavailable = !renderCompiled();
      this.dispose();
      return null;
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
   * block: null for none, undefined where the module refused it (a fill
   * libtess2 refused, which JS fills its own way, or a position not a
   * number) or failed, for the caller to build in JS.
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

      const buffer = x.memory.buffer;
      if (this.layout.buffer !== buffer) {
        this.layout = new Uint32Array(buffer, x.lineHeader(), 3);
      }

      const [at, vertices, count] = this.layout;
      if (count === 0) {
        return null;
      }

      const copy = buffer.slice(at, at + (vertices * 3 + count) * 4);
      return {
        positions: new Float32Array(copy, 0, vertices * 2),
        colors: new Uint32Array(copy, vertices * 8, vertices),
        indices: new Uint32Array(copy, vertices * 12, count),
      };
    } catch {
      // libtess2 unwound through the failure import: never resume that instance.
      this.dispose();
      return undefined;
    } finally {
      if (this.instance && this.instance.memory.buffer.byteLength > KEEP) {
        this.dispose();
      }
    }
  }

  /** The instance let go, its memory with it; the next input() makes another. */
  dispose(): void {
    this.instance = null;
    this.view = new Float64Array(0);
    this.layout = new Uint32Array(0);
  }
}
