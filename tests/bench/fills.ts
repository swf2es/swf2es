// Compare fill construction with two render modules from a git ref, using
// the current player's other dependencies. Build first, then:
// node --expose-gc tests/bench/fills.ts [ref, HEAD] [iterations, 5000] [samples, 10] [--allocs]
// Add --staggered for a large fill with unrelated band levels; use fewer iterations.
import { execFileSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { Session } from "node:inspector";
import { stripTypeScriptTypes } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ShapeLayer } from "../../packages/player/dist/display/shapes.js";
import * as current from "../../packages/player/dist/render/tessellate.js";

const args = process.argv.slice(2).filter((arg) => arg !== "--allocs" && arg !== "--staggered");
const ref = args[0] ?? "HEAD";
const iterations = Number(args[1] ?? 5000);
const samples = Number(args[2] ?? 10);
if (
  !Number.isSafeInteger(iterations) ||
  iterations < 1 ||
  !Number.isSafeInteger(samples) ||
  samples < 2
) {
  throw new Error("iterations must be positive and samples at least 2");
}

const root = fileURLToPath(new URL("../../", import.meta.url));
const render = `${root}packages/player/dist/render/`;
const name = `fills-bench-${process.pid}`;
const paths = [`${render}${name}-edges.js`, `${render}${name}.js`];
const rect = (x: number, y: number, w: number, h: number) => [
  1,
  x,
  y,
  2,
  x + w,
  y,
  2,
  x + w,
  y + h,
  2,
  x,
  y + h,
  2,
  x,
  y,
];
const cases: Record<string, number[][]> = process.argv.includes("--staggered")
  ? {
      staggered: [
        [1, 0, 0, 2, 10, 10, 2, 0, 10, 2, 10, 0, 2, 0, 0],
        ...Array.from({ length: 300 }, (_, i) => rect(20 + i * 4, i + 0.25, 2, 699.75 - i * 2)),
      ],
    }
  : {
      square: [rect(0, 0, 100, 100)],
      curves: [
        [1, 0, 0, 3, 100, -100, 100, 0, 3, 200, 100, 100, 100, 3, 0, 200, 0, 100, 3, -100, 0, 0, 0],
      ],
      holes: [rect(0, 0, 100, 100), rect(10, 10, 20, 20), rect(50, 50, 40, 40)],
      disjoint: Array.from({ length: 10 }, (_, i) => rect(i * 20, 0, 10, 10)),
      crossing: [
        rect(0, 0, 256, 192),
        [1, 60, -40, 2, 20, 175, 2, 90, 175, 2, 60, -40],
        [1, 190, -40, 2, 165, 175, 2, 235, 175, 2, 190, -40],
      ],
    };
const painter = () => ({ color: 0, alpha: 1 });
type Module = typeof current;
const median = (values: number[]) => {
  values.sort((a, b) => a - b);
  const middle = Math.floor(values.length / 2);
  return values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2;
};

function run(module: Module, layer: ShapeLayer, count: number): number {
  const start = performance.now();
  for (let i = 0; i < count; i++) {
    module.destroyContext(module.fillContext(layer, painter));
  }

  return ((performance.now() - start) * 1000) / count;
}

interface SampledNode {
  selfSize: number;
  children: SampledNode[];
}

async function allocated(module: Module, layer: ShapeLayer): Promise<number> {
  globalThis.gc?.();
  const session = new Session();
  session.connect();
  const send = (method: string, params: object = {}) =>
    new Promise<unknown>((resolve, reject) => {
      session.post(method, params, (error, result) => (error ? reject(error) : resolve(result)));
    });
  try {
    await send("HeapProfiler.startSampling", {
      samplingInterval: 4096,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
    run(module, layer, iterations);
    const { profile } = (await send("HeapProfiler.stopSampling")) as {
      profile: { head: SampledNode };
    };
    let bytes = 0;
    const walk = (node: SampledNode) => {
      bytes += node.selfSize;
      for (let i = 0; i < node.children.length; i++) {
        walk(node.children[i]);
      }
    };
    walk(profile.head);
    return bytes / iterations;
  } finally {
    session.disconnect();
  }
}

try {
  for (const [i, source] of ["fill-polygons", "tessellate"].entries()) {
    const text = execFileSync("git", ["show", `${ref}:packages/player/src/render/${source}.ts`], {
      cwd: root,
      encoding: "utf8",
    });
    writeFileSync(
      paths[i],
      stripTypeScriptTypes(text).replace("./fill-polygons.js", `./${name}-edges.js`),
    );
  }

  const reference = (await import(pathToFileURL(paths[1]).href)) as Module;
  const result: Record<string, unknown> = {};
  for (const [name, contours] of Object.entries(cases)) {
    const layer: ShapeLayer = {
      fills: [{ fill: { type: "solid", color: 0xff000000 }, contours, winding: "evenOdd" }],
      strokes: [],
    };
    run(reference, layer, Math.min(2000, iterations));
    run(current, layer, Math.min(2000, iterations));
    const before: number[] = [];
    const after: number[] = [];
    for (let i = 0; i < samples; i++) {
      for (const which of i % 2 ? [current, reference] : [reference, current]) {
        globalThis.gc?.();
        (which === reference ? before : after).push(run(which, layer, iterations));
      }
    }

    result[name] = {
      microseconds: { reference: median(before), current: median(after) },
      ...(process.argv.includes("--allocs")
        ? {
            sampledBytes: {
              reference: await allocated(reference, layer),
              current: await allocated(current, layer),
            },
          }
        : {}),
    };
  }

  console.log(JSON.stringify({ ref, iterations, samples, result }, null, 2));
} finally {
  for (const path of paths) {
    rmSync(path, { force: true });
  }
}
