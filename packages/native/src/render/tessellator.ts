import { LineBuilder } from "./lines.js";
import { renderInstance, renderModule } from "./module.js";

/**
 * Buffers are owned by the caller; subsequent calls and disposal cannot change them, but for a
 * layer asked for `borrowed` (FillTessellate.layer).
 */
export interface FillGeometry {
  vertices: Float64Array;
  indices: Uint16Array | Uint32Array;
  /**
   * The vertex the indices count from: a layer's fills share its indices,
   * each counted from the layer's first vertex (Tessellator.tessellate.layer).
   */
  indexOffset?: number;
}

/** A fill tessellated alone, and with the rest of its layer. */
export interface FillTessellate {
  (contours: readonly (readonly number[])[], nonZero: boolean): FillGeometry | null;
  /**
   * Every fill of a layer in one native call, its contours as path
   * commands (PATH_MOVE, PATH_LINE, PATH_CURVE, PATH_CUBIC) that the module
   * flattens itself: each fill's geometry, or null for one it refused, all
   * fills' positions and indices in one buffer each. Its output needs no checking: the module has checked
   * every coordinate finite and every index in range.
   *
   * Where `borrowed`, the geometries may be views of the module's memory,
   * which the tessellator's next call of any kind overwrites: for a caller
   * that reads them at once, as the player does for a drawing made again
   * every frame, which the two buffers a layer otherwise takes cost more
   * than the copy does.
   */
  layer(
    fills: readonly (readonly (readonly number[])[])[],
    nonZero: readonly boolean[],
    borrowed?: boolean,
  ): (FillGeometry | null)[] | null;
  /** A layer's lines in one call, their outlines filled by the same libtess2 (LineBuilder). */
  lines: LineBuilder;
}

/**
 * The commands of a contour layer() takes, each followed by its
 * coordinates: MOVE x y and LINE x y; CURVE cx cy x y, a quadratic from
 * the pen; CUBIC c1x c1y c2x c2y x y. The pen starts each contour at 0, 0.
 * Curves are flattened to within 0.02 of the curve, in at most 256 chords;
 * repeated points are dropped, and contours of fewer than three points left out.
 */
export const PATH_MOVE = 1;
export const PATH_LINE = 2;
export const PATH_CURVE = 3;
export const PATH_CUBIC = 4;

interface NativeExports {
  memory: WebAssembly.Memory;
  reset(): void;
  alloc(n: number): number;
  run(coords: number, count: number, ends: number, contours: number, nonzero: number): number;
  layer(
    commands: number,
    length: number,
    ends: number,
    contours: number,
    fills: number,
    rules: number,
    count: number,
  ): number;
  vertices(): number;
  indices(): number;
  vertexCount(): number;
  triangleCount(): number;
  highWater(): number;
  setLimit(n: number): void;
  bandsOnly(on: number): void;
}

export interface TessellatorOptions {
  /** Maximum arena address, including the C stack; at most 128 MiB. */
  memoryLimit?: number;
  /** Drop instances larger than this after each call. Defaults to 8 MiB. */
  retainMemory?: number;
  /**
   * Fill by the module's bands alone (bands.zig), as it does after libtess2
   * has trapped, never by libtess2, the lines' outlines too: for tests of
   * the bands.
   */
  bands?: boolean;
}

/** What root.zig takes of one fill; it rejects more too. */
const MOST_CONTOURS = 100000;
const MOST_POINTS = 1000000;
/** A rule root.zig rejects, for a fill whose arrays already show it would reject them. */
const REJECTED = 2;
/** The Int32s of root.zig's Layer, and of each fill's Range after it. */
const LAYER = 5;
const RANGE = 5;

/**
 * Synchronous double-precision tessellator. It compiles the render module
 * as it is made, and throws where the host refuses it. A fill it refuses
 * (not finite, malformed, too large, or out of memory) is null.
 */
export class Tessellator {
  private instance: NativeExports | null = null;
  /**
   * The instance's whole memory as each kind a layer reads and writes, made again once growth
   * detaches them (their length 0) or the instance is another: a view made for each array of each
   * call cost a drawing made again every frame as much as the copies.
   */
  private f64 = new Float64Array(0);
  private i32 = new Int32Array(0);
  private u32 = new Uint32Array(0);
  private u16 = new Uint16Array(0);
  private u8 = new Uint8Array(0);
  private viewed: NativeExports | null = null;
  private readonly limit: number;
  private readonly keep: number;
  private readonly bands: boolean;
  private readonly lines: LineBuilder;

  constructor(options: TessellatorOptions = {}) {
    this.limit = options.memoryLimit ?? 128 << 20;
    this.keep = options.retainMemory ?? 8 << 20;
    this.bands = options.bands ?? false;
    if (
      !Number.isInteger(this.limit) ||
      this.limit < 0 ||
      this.limit > 128 << 20 ||
      !Number.isInteger(this.keep) ||
      this.keep < 0 ||
      this.keep > 128 << 20
    ) {
      throw new RangeError("invalid tessellator memory limit");
    }

    renderModule();
    this.lines = new LineBuilder({
      memoryLimit: this.limit,
      retainMemory: this.keep,
      bands: this.bands,
    });
    this.tessellate = Object.assign(this.fill, { layer: this.layer, lines: this.lines });
  }

  /**
   * Current retained Wasm capacity, the line builder's included. Arena reset
   * alone does not shrink this memory.
   */
  get capacity(): number {
    return (this.instance?.memory.buffer.byteLength ?? 0) + this.lines.capacity;
  }

  dispose(): void {
    this.release();
    this.lines.dispose();
  }

  /** The instance, made on first use, its arena reset; filling by the bands alone where `bands`. */
  private arena(bands: boolean): NativeExports {
    this.instance ??= renderInstance(() => {
      throw new Error("tessellation allocation failed");
    }) as unknown as NativeExports;
    const x = this.instance;
    x.reset();
    x.setLimit(this.limit);
    x.bandsOnly(Number(bands));
    return x;
  }

  /** `x`'s memory viewed as it is now (f64 and the rest). */
  private view(x: NativeExports): void {
    if (this.viewed !== x || this.u8.length === 0) {
      const buffer = x.memory.buffer;
      this.f64 = new Float64Array(buffer, 0, buffer.byteLength >> 3);
      this.i32 = new Int32Array(buffer);
      this.u32 = new Uint32Array(buffer);
      this.u16 = new Uint16Array(buffer);
      this.u8 = new Uint8Array(buffer);
      this.viewed = x;
    }
  }

  /** A call that threw: a trapped instance is never used again. */
  private failed(): void {
    // In particular, longjmp unwinds through a throwing import: never resume that C instance. The
    // line builder's instance is its own.
    this.release();
  }

  /** The instance let go of, and the views that would keep its memory. */
  private release(): void {
    this.instance = null;
    this.viewed = null;
    this.f64 = new Float64Array(0);
    this.i32 = new Int32Array(0);
    this.u32 = new Uint32Array(0);
    this.u16 = new Uint16Array(0);
    this.u8 = new Uint8Array(0);
  }

  /** An instance grown past what is kept, let go. */
  private trim(): void {
    if ((this.instance?.memory.buffer.byteLength ?? 0) > this.keep) {
      this.release();
    }
  }

  /** One fill. The module checks the coordinates; only the arrays' lengths are looked at here. */
  private readonly fill = (
    contours: readonly (readonly number[])[],
    nonZero: boolean,
  ): FillGeometry | null => this.fillBy(contours, nonZero, this.bands);

  /** One fill, by the bands alone where `bands`; again so in a new instance where libtess2 trapped. */
  private fillBy(
    contours: readonly (readonly number[])[],
    nonZero: boolean,
    bands: boolean,
  ): FillGeometry | null {
    if (contours.length > MOST_CONTOURS) {
      return null;
    }

    let count = 0;
    for (const points of contours) {
      if (points.length % 2 !== 0) {
        return null;
      }

      count += points.length / 2;
    }

    if (count > MOST_POINTS) {
      return null;
    }

    if (count === 0) {
      return { vertices: new Float64Array(), indices: new Uint16Array() };
    }

    try {
      const x = this.arena(bands);
      // One allocation: coordinates, then contours' ends.
      const coordAt = x.alloc(count * 16 + contours.length * 4);
      if (!coordAt) {
        throw new Error("tessellation input allocation failed");
      }

      const endsAt = coordAt + count * 16;

      const coords = new Float64Array(x.memory.buffer, coordAt, count * 2);
      const ends = new Uint32Array(x.memory.buffer, endsAt, contours.length);
      let at = 0;
      for (let i = 0; i < contours.length; i++) {
        coords.set(contours[i], at);
        at += contours[i].length;
        ends[i] = at / 2;
      }

      if (x.run(coordAt, count, endsAt, contours.length, Number(nonZero)) !== 0) {
        return null;
      }

      // Growth can detach the input views. Cached geometry owns fresh copies of the final views.
      const vertices = new Float64Array(x.memory.buffer, x.vertices(), x.vertexCount() * 2).slice();
      const source = new Uint32Array(x.memory.buffer, x.indices(), x.triangleCount() * 3);
      const indices = vertices.length / 2 <= 0x10000 ? new Uint16Array(source) : source.slice();

      return { vertices, indices };
    } catch {
      this.failed();
      return bands ? null : this.fillBy(contours, nonZero, true);
    } finally {
      this.trim();
    }
  }

  /** Each fill flattened and tessellated, as `fill` would make its polygons, in one call and one copy out. */
  private readonly layer = (
    fills: readonly (readonly (readonly number[])[])[],
    nonZero: readonly boolean[],
    borrowed = false,
  ): (FillGeometry | null)[] | null => this.layerBy(fills, nonZero, this.bands, borrowed);

  /** The layer, by the bands alone where `bands`; again so in a new instance where libtess2 trapped. */
  private layerBy(
    fills: readonly (readonly (readonly number[])[])[],
    nonZero: readonly boolean[],
    bands: boolean,
    borrowed = false,
  ): (FillGeometry | null)[] | null {
    let length = 0;
    let contours = 0;
    for (let i = 0; i < fills.length; i++) {
      const fill = fills[i];
      if (fill.length <= MOST_CONTOURS) {
        for (let j = 0; j < fill.length; j++) {
          length += fill[j].length;
        }

        contours += fill.length;
      }
    }

    let ranges: Int32Array;
    let vertices: Float64Array;
    let indices: Uint16Array | Uint32Array;
    try {
      // One allocation: commands, contours' ends, each fill's last contour, then rules.
      const x = this.arena(bands);
      const commandAt = x.alloc(length * 8 + contours * 4 + fills.length * 5);
      if (!commandAt) {
        throw new Error("tessellation input allocation failed");
      }

      const endsAt = commandAt + length * 8;
      const fillsAt = endsAt + contours * 4;
      const rulesAt = fillsAt + fills.length * 4;

      this.view(x);
      const commands = this.f64;
      const ends = this.u32;
      const rules = this.u8;
      const command = commandAt >> 3;
      let at = 0;
      let contour = 0;
      for (let i = 0; i < fills.length; i++) {
        const fill = fills[i];
        if (fill.length <= MOST_CONTOURS) {
          for (let j = 0; j < fill.length; j++) {
            commands.set(fill[j], command + at);
            at += fill[j].length;
            ends[(endsAt >> 2) + contour++] = at;
          }

          rules[rulesAt + i] = Number(nonZero[i]);
        } else {
          rules[rulesAt + i] = REJECTED;
        }

        ends[(fillsAt >> 2) + i] = contour;
      }

      const head = x.layer(commandAt, length, endsAt, contours, fillsAt, rulesAt, fills.length);
      if (head === 0) {
        // The layer's own output did not fit: a call a fill.
        return fills.length === 1
          ? [null]
          : fills.map((fill, i) => this.alone(fill, nonZero[i], bands));
      }

      // The one copy out, its ranges read before a retry resets the arena.
      this.view(x);
      const count = LAYER + fills.length * RANGE;
      ranges = this.i32.subarray(head >> 2, (head >> 2) + count);
      // A fill that ran out is tried alone, which resets the arena under what is borrowed.
      let lent = borrowed;
      for (let i = 0; lent && i < fills.length; i++) {
        lent = ranges[LAYER + i * RANGE] !== -1;
      }

      const vertexAt = ranges[0] >> 3;
      const indexAt = ranges[1];
      if (lent) {
        vertices = this.f64.subarray(vertexAt, vertexAt + ranges[2] * 2);
        indices =
          ranges[4] === 2
            ? this.u16.subarray(indexAt >> 1, (indexAt >> 1) + ranges[3])
            : this.u32.subarray(indexAt >> 2, (indexAt >> 2) + ranges[3]);
      } else {
        ranges = ranges.slice();
        vertices = this.f64.slice(vertexAt, vertexAt + ranges[2] * 2);
        indices =
          ranges[4] === 2
            ? this.u16.slice(indexAt >> 1, (indexAt >> 1) + ranges[3])
            : this.u32.slice(indexAt >> 2, (indexAt >> 2) + ranges[3]);
      }
    } catch {
      this.failed();
      if (bands) {
        return null;
      }

      // libtess2 trapped: each fill in a fresh instance, and one that traps alone again by the
      // bands, which never trap.
      return fills.length === 1
        ? this.layerBy(fills, nonZero, true, borrowed)
        : fills.map((fill, i) => this.alone(fill, nonZero[i], false));
    } finally {
      this.trim();
    }

    const out: (FillGeometry | null)[] = new Array(fills.length);
    for (let i = 0; i < fills.length; i++) {
      const range = LAYER + i * RANGE;
      const status = ranges[range];
      if (status === 0) {
        const vertexStart = ranges[range + 1];
        const indexStart = ranges[range + 3];
        out[i] = {
          vertices: vertices.subarray(vertexStart * 2, (vertexStart + ranges[range + 2]) * 2),
          indices: indices.subarray(indexStart, indexStart + ranges[range + 4]),
          indexOffset: vertexStart,
        };
      } else {
        // Running out may be the layer's memory, where the fill alone fits.
        out[i] = status === -1 && fills.length > 1 ? this.alone(fills[i], nonZero[i], bands) : null;
      }
    }

    return out;
  }

  /** One fill's commands as a layer of its own, in a fresh arena. */
  private alone(
    contours: readonly (readonly number[])[],
    nonZero: boolean,
    bands: boolean,
  ): FillGeometry | null {
    const geometry = this.layerBy([contours], [nonZero], bands)?.[0] ?? null;
    return geometry && { vertices: geometry.vertices, indices: geometry.indices };
  }

  /**
   * Use as RenderView's fillTessellator. A fill alone takes its contours
   * flattened already; a layer takes them as path commands; and a layer's
   * lines take the layer as the player packs it (`lines`).
   */
  readonly tessellate: FillTessellate;
}
