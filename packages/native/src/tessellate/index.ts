import { binary } from "./binary.js";

/** Buffers are owned by the caller; subsequent calls and disposal cannot change them. */
export interface FillGeometry {
  vertices: Float64Array;
  indices: Uint16Array | Uint32Array;
}

interface NativeExports {
  memory: WebAssembly.Memory;
  reset(): void;
  alloc(n: number): number;
  run(coords: number, count: number, ends: number, contours: number, nonzero: number): number;
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

  /** Use as PixiView's fillTessellator. Contours must already have their curves flattened. */
  readonly tessellate = (
    contours: readonly (readonly number[])[],
    nonZero: boolean,
  ): FillGeometry | null => {
    if (this.unavailable) {
      return null;
    }

    let count = 0;
    if (contours.length > 100000) {
      return null;
    }

    for (const points of contours) {
      if (points.length < 6 || points.length % 2 !== 0) {
        return null;
      }

      count += points.length / 2;
      if (count > 1000000) {
        return null;
      }

      for (const value of points) {
        if (!Number.isFinite(value) || Math.abs(value) > 2 ** 23) {
          return null;
        }
      }
    }

    if (count === 0) {
      return { vertices: new Float64Array(), indices: new Uint16Array() };
    }

    try {
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
        throw new Error("tessellation rejected");
      }

      // Growth can detach the input views. Cached geometry owns fresh copies of the final views.
      const vertices = new Float64Array(x.memory.buffer, x.vertices(), x.vertexCount() * 2).slice();
      const source = new Uint32Array(x.memory.buffer, x.indices(), x.triangleCount() * 3);
      const indices = vertices.length / 2 <= 0x10000 ? new Uint16Array(source) : source.slice();

      return { vertices, indices };
    } catch {
      // Compilation can be blocked by CSP or unavailable on the host: try only once per owner.
      this.unavailable = module === null;
      // In particular, longjmp unwinds through a throwing import: never resume that C instance.
      this.dispose();
      return null;
    } finally {
      if (this.capacity > this.keep) {
        this.dispose();
      }
    }
  };
}
