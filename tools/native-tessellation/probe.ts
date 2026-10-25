import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { crossingFill } from "../../packages/player/dist/render/fill-polygons.js";
import { NativeTess } from "./native.ts";
import { synthetic } from "./synthetic.ts";

interface Fill {
  contours: number[][];
  nonzero: boolean;
}

/** Convert the JS crossing kernel's convex bands into owned indexed geometry. */
function baseline(fill: Fill) {
  const began = performance.now();
  const polygons = crossingFill(fill.contours, fill.nonzero);
  if (!polygons) {
    throw new Error("the standalone comparison requires a crossing fill");
  }

  const kernel = performance.now();
  let coordinates = 0;
  let count = 0;
  for (const polygon of polygons) {
    coordinates += polygon.length;
    count += (polygon.length / 2 - 2) * 3;
  }

  const vertices = new Float64Array(coordinates);
  const indices = new Uint32Array(count);
  let at = 0;
  let index = 0;
  for (const polygon of polygons) {
    vertices.set(polygon, at);
    for (let i = 1; i < polygon.length / 2 - 1; i++) {
      indices[index++] = at / 2;
      indices[index++] = at / 2 + i;
      indices[index++] = at / 2 + i + 1;
    }

    at += polygon.length;
  }

  const done = performance.now();
  return {
    vertices,
    indices,
    kernelMs: kernel - began,
    packMs: 0,
    copyMs: done - kernel,
    totalMs: done - began,
    wasmCapacity: 0,
    scratch: 0,
  };
}

const [directory, input] = process.argv.slice(2);
if (!directory) {
  throw new Error(
    "usage: node --expose-gc tools/native-tessellation/probe.ts <artifact-directory> [fills.json]",
  );
}

const fills: Fill[] = input
  ? JSON.parse(readFileSync(input, "utf8"))
  : synthetic.flatMap(({ contours }) => [false, true].map((nonzero) => ({ contours, nonzero })));
// The other fills use JS containment and earcut, outside this kernel comparison.
const crossing = fills.filter((fill) => crossingFill(fill.contours, fill.nonzero) !== null);
const native = new NativeTess("f64", readFileSync(resolve(directory, "f64.wasm")));
const report = [];
for (let run = 0; run < 3; run++) {
  for (const variant of run % 2 ? ["f64", "js"] : ["js", "f64"]) {
    globalThis.gc?.();
    const initial = process.memoryUsage();
    const held = [];
    let totalMs = 0;
    let kernelMs = 0;
    let packMs = 0;
    let copyMs = 0;
    let worstFillMs = 0;
    let capacity = 0;
    let scratch = 0;
    let outputBytes = 0;
    for (const fill of crossing) {
      const result =
        variant === "js" ? baseline(fill) : native.tessellate(fill.contours, fill.nonzero);
      held.push({ vertices: result.vertices, indices: result.indices });
      totalMs += result.totalMs;
      kernelMs += result.kernelMs;
      packMs += result.packMs;
      copyMs += result.copyMs;
      worstFillMs = Math.max(worstFillMs, result.totalMs);
      capacity = Math.max(capacity, result.wasmCapacity);
      scratch = Math.max(scratch, result.scratch);
      outputBytes += result.vertices.byteLength + result.indices.byteLength;
    }

    globalThis.gc?.();
    const retained = process.memoryUsage();
    held.length = 0;
    globalThis.gc?.();
    report.push({
      run,
      variant,
      cases: crossing.length,
      totalMs,
      kernelMs,
      packMs,
      copyMs,
      worstFillMs,
      capacity,
      scratch,
      outputBytes,
      initial,
      retained,
      cleared: process.memoryUsage(),
    });
  }
}

console.log(JSON.stringify(report, null, 2));
