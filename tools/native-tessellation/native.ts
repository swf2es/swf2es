export type Variant = "f32" | "f64";
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
  allocated(): number;
  setLimit(n: number): void;
}
const wasm = WebAssembly as unknown as {
  Module: new (bytes: ArrayBufferView | ArrayBuffer) => WebAssembly.Module;
  Instance: new (module: WebAssembly.Module, imports: object) => { exports: unknown };
};
export class NativeTess {
  private instance: NativeExports | null = null;
  readonly module: WebAssembly.Module;
  drops = 0;
  readonly variant: Variant;
  readonly keep: number;
  readonly limit: number;

  constructor(
    variant: Variant,
    bytes: ArrayBufferView | ArrayBuffer,
    keep = 8 << 20,
    limit = 128 << 20,
  ) {
    this.variant = variant;
    this.keep = keep;
    this.limit = limit;
    this.module = new wasm.Module(bytes);
  }

  tessellate(contours: number[][], nonzero = false) {
    const began = performance.now();
    let count = 0;
    if (contours.length > 100000) {
      throw new RangeError("too many contours");
    }
    for (const p of contours) {
      if (p.length < 6 || p.length % 2) {
        throw new RangeError("bad contour length");
      }
      count += p.length / 2;
      if (count > 1000000) {
        throw new RangeError("too many vertices");
      }

      for (const value of p) {
        if (!Number.isFinite(value) || Math.abs(value) > 2 ** 23) {
          throw new RangeError("coordinate range");
        }
      }
    }
    this.instance ??= new wasm.Instance(this.module, {
      env: {
        failure: () => {
          throw new Error("native allocation failure");
        },
      },
    }).exports as unknown as NativeExports;
    const x = this.instance;

    try {
      x.reset();
      x.setLimit(this.limit);
      const coordAt = x.alloc(count * 2 * (this.variant === "f64" ? 8 : 4));
      const endsAt = x.alloc(contours.length * 4);
      if (!coordAt || !endsAt) {
        throw new Error("input allocation failure");
      }
      const Type = this.variant === "f64" ? Float64Array : Float32Array;
      const coords = new Type(x.memory.buffer, coordAt, count * 2);
      const ends = new Uint32Array(x.memory.buffer, endsAt, contours.length);
      let at = 0;
      contours.forEach((p, i) => {
        coords.set(p, at);
        at += p.length;
        ends[i] = at / 2;
      });

      const packed = performance.now();
      if (x.run(coordAt, count, endsAt, contours.length, Number(nonzero)) !== 0) {
        throw new Error("native tessellation rejected");
      }

      const kernel = performance.now();
      // Read fresh views after tessellation: memory growth detaches the input views.
      const vertices = new Type(x.memory.buffer, x.vertices(), x.vertexCount() * 2).slice();
      const indices = new Uint32Array(x.memory.buffer, x.indices(), x.triangleCount() * 3).slice();
      const done = performance.now();

      return {
        vertices,
        indices,
        packMs: packed - began,
        kernelMs: kernel - packed,
        copyMs: done - kernel,
        totalMs: done - began,
        wasmCapacity: x.memory.buffer.byteLength,
        scratch: x.highWater(),
        nativeAllocated: x.allocated(),
        outputBytes: vertices.byteLength + indices.byteLength,
      };
    } catch (e) {
      this.instance = null;
      this.drops++;
      throw e;
    } finally {
      if (x.memory.buffer.byteLength > this.keep && this.instance) {
        this.instance = null;
        this.drops++;
      }
    }
  }

  capacity() {
    return this.instance?.memory.buffer.byteLength ?? 0;
  }
}
