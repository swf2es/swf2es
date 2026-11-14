import { GeometryBuilder } from "./geometry.ts";
import { rectangle } from "./shapes.ts";

function check(ok: boolean, message: string): void {
  if (!ok) {
    throw new Error(message);
  }
}

export function validateKernel(instance: WebAssembly.Instance) {
  const builder = new GeometryBuilder(instance);
  const first = builder.make(rectangle(30, 4), true);
  const saved = first.positions.slice();
  let seed = 17;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const memory = instance.exports.memory as WebAssembly.Memory;
  const initialBytes = memory.buffer.byteLength;
  let tests = 0;
  for (let i = 0; i < 2000; i++) {
    const pixel = 0.5 + random();
    const points = rectangle(5 + random() * 200, 3 + random() * 10);
    const angle = random() * 2 * Math.PI;
    const x = random() * 1000;
    const y = random() * 1000;
    for (let k = 0; k < points.length; k += 2) {
      const px = points[k];
      const py = points[k + 1];
      points[k] = px * Math.cos(angle) - py * Math.sin(angle) + x;
      points[k + 1] = px * Math.sin(angle) + py * Math.cos(angle) + y;
    }
    if (i % 2) {
      points.push(...points.splice(0, 2));
      // Reverse the winding while preserving coordinate pairs.
      for (let j = 0; j < 2; j++) {
        const at = j * 2;
        const other = 6 - at;
        [points[at], points[other]] = [points[other], points[at]];
        [points[at + 1], points[other + 1]] = [points[other + 1], points[at + 1]];
      }
    }
    const data = builder.make(points, true, pixel);
    check(data.positions.length === 16 && data.indices.length === 30, "rectangle refused");
    check(data.positions.every(Number.isFinite), "nonfinite positions");
    check(
      data.indices.every((n) => n < 8),
      "out-of-range index",
    );
    let winding = 0;
    for (let k = 0; k < data.indices.length; k += 3) {
      const a = data.indices[k] * 2;
      const b = data.indices[k + 1] * 2;
      const c = data.indices[k + 2] * 2;
      const p = data.positions;
      const cross = (p[b] - p[a]) * (p[c + 1] - p[a + 1]) - (p[b + 1] - p[a + 1]) * (p[c] - p[a]);
      const sign = Math.sign(cross);
      check(sign !== 0 && (winding === 0 || winding === sign), "triangle folds");
      winding = sign;
    }
    tests++;
  }
  check(
    first.positions.every((v, i) => v === saved[i]),
    "scratch overwrote owned geometry",
  );
  check(memory.buffer.byteLength === initialBytes, "kernel memory grew");
  const kernel = instance.exports as unknown as {
    build(n: number, pixel: number, color: number): number;
    inputAddress(): number;
  };
  const input = new Float64Array(memory.buffer, kernel.inputAddress(), 1024);
  input.set(rectangle(10, 0.5));
  check(kernel.build(4, 1, 0xffffffff) === -1, "thin shape accepted");
  check(kernel.build(4, 1, 0x80ffffff) === -1, "translucent shape accepted");
  check(kernel.build(4, Number.NaN, 0xffffffff) === -1, "NaN width accepted");
  check(kernel.build(513, 1, 0xffffffff) === -1, "oversized contour accepted");
  input[0] = Number.NaN;
  check(kernel.build(4, 1, 0xffffffff) === -1, "NaN coordinate accepted");
  const result = {
    randomRectangles: tests,
    refused: builder.refused,
    kernelBytes: initialBytes,
    ownershipPreserved: true,
  };
  builder.dispose();
  return result;
}
