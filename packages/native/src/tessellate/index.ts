import { binary } from "./binary.js";

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
   * Every fill of a layer in one native call: each fill's geometry, or null
   * for JS to fill it, all fills' positions and indices in one buffer each;
   * null where the module is unavailable. Its output needs no checking: the
   * module has checked every coordinate finite and every index in range.
   */
  layer(
    fills: readonly (readonly (readonly number[])[])[],
    nonZero: readonly boolean[],
  ): (FillGeometry | null)[] | null;
}

interface NativeExports {
  memory: WebAssembly.Memory;
  reset(): void;
  alloc(n: number): number;
  run(coords: number, count: number, ends: number, contours: number, nonzero: number): number;
  layer(
    coords: number,
    points: number,
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
}

export interface TessellatorOptions {
  /** Maximum arena address, including the C stack; at most 128 MiB. */
  memoryLimit?: number;
  /** Drop instances larger than this after each call. Defaults to 8 MiB. */
  retainMemory?: number;
}

/** What root.zig takes of one fill; it rejects more too. */
const MOST_CONTOURS = 100000;
const MOST_POINTS = 1000000;
/** A rule root.zig rejects, for a fill whose arrays already show it would reject them. */
const REJECTED = 2;
/** The Int32s of root.zig's Layer, and of each fill's Range after it. */
const LAYER = 5;
const RANGE = 5;

let module: WebAssembly.Module | null = null;

/** Optional synchronous double-precision tessellator. Rejection returns null for the caller's fallback. */
export class Tessellator {
  private instance: NativeExports | null = null;
  private unavailable = false;
  private readonly limit: number;
  private readonly keep: number;

  constructor(options: TessellatorOptions = {}) {
    this.limit = options.memoryLimit ?? 128 << 20;
    this.keep = options.retainMemory ?? 8 << 20;
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
  }

  /** Current retained Wasm capacity. Arena reset alone does not shrink this memory. */
  get capacity(): number {
    return this.instance?.memory.buffer.byteLength ?? 0;
  }

  dispose(): void {
    this.instance = null;
  }

  /** The instance, made on first use, its arena reset. */
  private arena(): NativeExports {
    module ??= new WebAssembly.Module(Uint8Array.from(atob(binary), (c) => c.charCodeAt(0)));
    this.instance ??= new WebAssembly.Instance(module, {
      env: {
        failure: () => {
          throw new Error("tessellation allocation failed");
        },
      },
    }).exports as unknown as NativeExports;
    const x = this.instance;
    x.reset();
    x.setLimit(this.limit);
    return x;
  }

  /** A call that threw: the module is tried once per owner, and a trapped instance never again. */
  private failed(): void {
    // Compilation can be blocked by CSP or unavailable on the host.
    this.unavailable = module === null;
    // In particular, longjmp unwinds through a throwing import: never resume that C instance.
    this.dispose();
  }

  /** An instance grown past what is kept, let go. */
  private trim(): void {
    if (this.capacity > this.keep) {
      this.dispose();
    }
  }

  /** One fill. The module checks the coordinates; only the arrays' lengths are looked at here. */
  private readonly fill = (
    contours: readonly (readonly number[])[],
    nonZero: boolean,
  ): FillGeometry | null => {
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
      const x = this.arena();
      const coordAt = x.alloc(count * 16);
      const endsAt = x.alloc(contours.length * 4);
      if (!coordAt || !endsAt) {
        throw new Error("tessellation input allocation failed");
      }

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
      return null;
    } finally {
      this.trim();
    }
  };

  /** Each fill as `fill` would make it, but in one call and one copy out. */
  private readonly layer = (
    fills: readonly (readonly (readonly number[])[])[],
    nonZero: readonly boolean[],
  ): (FillGeometry | null)[] | null => {
    if (this.unavailable) {
      return null;
    }

    let points = 0;
    let contours = 0;
    const rules = new Uint8Array(fills.length);
    for (let i = 0; i < fills.length; i++) {
      const fill = fills[i];
      let count = 0;
      let even = true;
      for (let j = 0; j < fill.length; j++) {
        count += fill[j].length / 2;
        even &&= fill[j].length % 2 === 0;
      }

      if (!even || fill.length > MOST_CONTOURS || count > MOST_POINTS) {
        rules[i] = REJECTED;
        continue;
      }

      rules[i] = Number(nonZero[i]);
      points += count;
      contours += fill.length;
    }

    let ranges: Int32Array;
    let vertices: Float64Array;
    let indices: Uint16Array | Uint32Array;
    try {
      // One allocation: coordinates, contours' ends, each fill's last contour, then rules.
      const x = this.arena();
      const coordAt = x.alloc(points * 16 + contours * 4 + fills.length * 5);
      if (!coordAt) {
        throw new Error("tessellation input allocation failed");
      }

      const endsAt = coordAt + points * 16;
      const fillsAt = endsAt + contours * 4;
      const rulesAt = fillsAt + fills.length * 4;

      const coords = new Float64Array(x.memory.buffer, coordAt, points * 2);
      const ends = new Uint32Array(x.memory.buffer, endsAt, contours);
      const lasts = new Uint32Array(x.memory.buffer, fillsAt, fills.length);
      new Uint8Array(x.memory.buffer, rulesAt, fills.length).set(rules);
      let at = 0;
      let contour = 0;
      for (let i = 0; i < fills.length; i++) {
        if (rules[i] !== REJECTED) {
          const start = at;
          const fill = fills[i];
          for (let j = 0; j < fill.length; j++) {
            coords.set(fill[j], at);
            at += fill[j].length;
            ends[contour++] = (at - start) / 2;
          }
        }

        lasts[i] = contour;
      }

      const head = x.layer(coordAt, points, endsAt, contours, fillsAt, rulesAt, fills.length);
      if (head === 0) {
        // The layer's own output did not fit: a call a fill, as before there was a layer call.
        return fills.map((fill, i) => this.fill(fill, nonZero[i]));
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
      // A trapped layer leaves each fill to a fresh instance, as before there was a layer call.
      return this.unavailable ? null : fills.map((fill, i) => this.fill(fill, nonZero[i]));
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
        // libtess2 failing may be the layer's memory, where the fill alone fits as it did before.
        out[i] = status === -1 ? this.fill(fills[i], nonZero[i]) : null;
      }
    }

    return out;
  };

  /** Use as PixiView's fillTessellator. Contours must already have their curves flattened. */
  readonly tessellate: FillTessellate = Object.assign(this.fill, { layer: this.layer });
}
