import { LineBuilder } from "../render/lines.js";
import { renderCompiled, renderInstance } from "../render/module.js";

export { LineBuilder, type LineBuilderOptions, type LineGeometry } from "../render/lines.js";

/** Buffers are owned by the caller; subsequent calls and disposal cannot change them. */
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
   * flattens itself: each fill's geometry, or null for JS to fill it, all
   * fills' positions and indices in one buffer each; null where the module
   * is unavailable. Its output needs no checking: the module has checked
   * every coordinate finite and every index in range.
   */
  layer(
    fills: readonly (readonly (readonly number[])[])[],
    nonZero: readonly boolean[],
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
   * has trapped, never by libtess2: for tests of the bands.
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

/** Optional synchronous double-precision tessellator. Rejection returns null for the caller's fallback. */
export class Tessellator {
  private instance: NativeExports | null = null;
  private unavailable = false;
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

    this.lines = new LineBuilder({ memoryLimit: this.limit, retainMemory: this.keep });
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
    this.instance = null;
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

  /** A call that threw: the module is tried once per owner, and a trapped instance never again. */
  private failed(): void {
    // Compilation can be blocked by CSP or unavailable on the host.
    this.unavailable = !renderCompiled();
    // In particular, longjmp unwinds through a throwing import: never resume that C instance. The
    // line builder's instance is its own.
    this.instance = null;
  }

  /** An instance grown past what is kept, let go. */
  private trim(): void {
    if ((this.instance?.memory.buffer.byteLength ?? 0) > this.keep) {
      this.instance = null;
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
    if (this.unavailable || contours.length > MOST_CONTOURS) {
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
      return this.unavailable || bands ? null : this.fillBy(contours, nonZero, true);
    } finally {
      this.trim();
    }
  }

  /** Each fill flattened and tessellated, as `fill` would make its polygons, in one call and one copy out. */
  private readonly layer = (
    fills: readonly (readonly (readonly number[])[])[],
    nonZero: readonly boolean[],
  ): (FillGeometry | null)[] | null => this.layerBy(fills, nonZero, this.bands);

  /** The layer, by the bands alone where `bands`; again so in a new instance where libtess2 trapped. */
  private layerBy(
    fills: readonly (readonly (readonly number[])[])[],
    nonZero: readonly boolean[],
    bands: boolean,
  ): (FillGeometry | null)[] | null {
    if (this.unavailable) {
      return null;
    }

    let length = 0;
    let contours = 0;
    const rules = new Uint8Array(fills.length);
    for (let i = 0; i < fills.length; i++) {
      const fill = fills[i];
      if (fill.length > MOST_CONTOURS) {
        rules[i] = REJECTED;
        continue;
      }

      for (let j = 0; j < fill.length; j++) {
        length += fill[j].length;
      }

      rules[i] = Number(nonZero[i]);
      contours += fill.length;
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

      const commands = new Float64Array(x.memory.buffer, commandAt, length);
      const ends = new Uint32Array(x.memory.buffer, endsAt, contours);
      const lasts = new Uint32Array(x.memory.buffer, fillsAt, fills.length);
      new Uint8Array(x.memory.buffer, rulesAt, fills.length).set(rules);
      let at = 0;
      let contour = 0;
      for (let i = 0; i < fills.length; i++) {
        if (rules[i] !== REJECTED) {
          const fill = fills[i];
          for (let j = 0; j < fill.length; j++) {
            commands.set(fill[j], at);
            at += fill[j].length;
            ends[contour++] = at;
          }
        }

        lasts[i] = contour;
      }

      const head = x.layer(commandAt, length, endsAt, contours, fillsAt, rulesAt, fills.length);
      if (head === 0) {
        // The layer's own output did not fit: a call a fill.
        return fills.length === 1
          ? [null]
          : fills.map((fill, i) => this.alone(fill, nonZero[i], bands));
      }

      // The one copy out, its ranges read before a retry resets the arena.
      const buffer = x.memory.buffer;
      ranges = new Int32Array(buffer, head, LAYER + fills.length * RANGE).slice();
      vertices = new Float64Array(buffer, ranges[0], ranges[2] * 2).slice();
      indices =
        ranges[4] === 2
          ? new Uint16Array(buffer, ranges[1], ranges[3]).slice()
          : new Uint32Array(buffer, ranges[1], ranges[3]).slice();
    } catch {
      this.failed();
      if (this.unavailable || bands) {
        return null;
      }

      // libtess2 trapped: each fill in a fresh instance, and one that traps alone again by the
      // bands, which never trap.
      return fills.length === 1
        ? this.layerBy(fills, nonZero, true)
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
