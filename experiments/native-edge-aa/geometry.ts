import { Tessellator } from "@swf2es/native/render";
import type { GeometryData } from "@swf2es/render";

interface Kernel {
  memory: WebAssembly.Memory;
  inputAddress(): number;
  outputAddress(): number;
  build(n: number, pixel: number, color: number): number;
}

export class GeometryBuilder {
  private readonly base = new Tessellator();
  private readonly kernel: Kernel | null;
  private readonly input: Float64Array | null;
  refused = 0;
  bytes = 0;

  constructor(instance?: WebAssembly.Instance) {
    this.kernel = instance ? (instance.exports as unknown as Kernel) : null;
    this.input = this.kernel
      ? new Float64Array(this.kernel.memory.buffer, this.kernel.inputAddress(), 1024)
      : null;
  }

  coverage(points: number[], pixel = 1, color = 0xff202020): GeometryData | null {
    if (this.kernel && this.input && points.length <= 1024 && points.length % 2 === 0) {
      this.input.set(points);
      const n = points.length / 2;
      const count = this.kernel.build(n, pixel, color);
      if (count >= 0) {
        const vertices = n * 2;
        const at = this.kernel.outputAddress();
        const copy = this.kernel.memory.buffer.slice(at, at + (vertices * 5 + count) * 4);
        this.bytes += copy.byteLength;
        return {
          positions: new Float32Array(copy, 0, vertices * 2),
          texels: new Float32Array(copy, vertices * 8, vertices * 2),
          colors: new Uint32Array(copy, vertices * 16, vertices),
          indices: new Uint32Array(copy, vertices * 20, count),
        };
      }
      this.refused++;
    }

    return null;
  }

  make(points: number[], aa: boolean, pixel = 1, color = 0xff202020): GeometryData {
    if (aa) {
      const result = this.coverage(points, pixel, color);
      if (result) {
        return result;
      }
    }

    const base = this.base.tessellate([points], true);
    if (!base) {
      throw new Error("Baseline tessellation failed");
    }
    const data = {
      positions: Float32Array.from(base.vertices),
      colors: new Uint32Array(base.vertices.length / 2).fill(color),
      indices: Uint32Array.from(base.indices, (n) => n - (base.indexOffset ?? 0)),
    };
    this.bytes += data.positions.byteLength + data.colors.byteLength + data.indices.byteLength;
    return data;
  }

  get retainedWasmBytes(): number {
    return (this.kernel?.memory.buffer.byteLength ?? 0) + this.base.capacity;
  }

  dispose(): void {
    this.base.dispose();
  }
}
