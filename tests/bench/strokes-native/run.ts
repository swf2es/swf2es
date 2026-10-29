// layerStrokes (JS, its outlines filled by the native tessellator) against
// the native line builder, packing and copying out included, on
// representative layers, opaque and translucent: ns per layer, the median of
// several runs after warm-up.
import { Tessellator } from "../../../packages/native/dist/render/index.js";
import type { ShapeLayer } from "../../../packages/player/dist/display/shapes.js";
import { trace } from "../../../packages/player/dist/scene/fills.js";
import { layerStrokes } from "../../../packages/player/dist/scene/strokes.js";
import { layerStrokesNative } from "../../../packages/player/dist/scene/strokes-native.js";
import { curved, layerOf, polygon, random } from "../../unit/player/scene/line-layers.ts";

const RUNS = Number(process.argv[2] ?? 7);
const POOL = 64;
/** How long each run lasts, roughly. */
const RUN_MS = 60;

const tessellate = new Tessellator().tessellate;

const shapes: [string, (r: () => number) => number[]][] = [
  ["polygon 3-10", (r) => polygon(r, 3 + Math.floor(r() * 8), true)],
  ["curve ~20 pts", (r) => curved(r, 4, true, 10)],
  ["curve ~60 pts", (r) => curved(r, 8, true, 40)],
  ["curve ~200 pts", (r) => curved(r, 16, true, 200)],
];
const widths: [string, number][] = [
  ["hairline", 0],
  ["2px", 40],
  ["10px", 200],
];
const joins: [string, number][] = [
  ["round", 0],
  ["miter", 2],
  ["bevel", 1],
];

function points(layer: ShapeLayer): number {
  let n = 0;
  for (const stroke of layer.strokes) {
    for (const path of stroke.paths) {
      trace({ moveTo: () => n++, lineTo: () => n++ }, path, 0.1);
    }
  }

  return n;
}

/** The median ns per call of `f` over the pool, after a warm-up. */
function time(pool: ShapeLayer[], f: (layer: ShapeLayer) => unknown): number {
  let sink = 0;
  const pass = () => {
    for (const layer of pool) {
      sink += f(layer) ? 1 : 0;
    }
  };
  // Warm-up, and how many passes fill a run.
  const start = performance.now();
  let passes = 0;
  while (performance.now() - start < RUN_MS * 2) {
    pass();
    passes++;
  }

  const each = Math.max(1, Math.round(passes / 2));
  const samples: number[] = [];
  for (let k = 0; k < RUNS; k++) {
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < each; i++) {
      pass();
    }

    samples.push(Number(process.hrtime.bigint() - t0) / (each * pool.length));
  }

  samples.sort((x, y) => x - y);
  if (sink < 0) {
    console.log(sink);
  }

  return samples[samples.length >> 1];
}

const rows: string[] = [];
const header = "| lines | layer | width | join | pts | verts | JS ns | native ns | native/JS |";
rows.push(header, header.replace(/[^|]+/g, "---"));
for (const [kind, alpha] of [
  ["opaque", 255],
  ["translucent", 128],
] as const) {
  let jsTotal = 0;
  let nativeTotal = 0;
  for (const [shapeName, make] of shapes) {
    for (const [widthName, width] of widths) {
      for (const [joinName, join] of joins) {
        const r = random(7);
        const pool: ShapeLayer[] = [];
        for (let i = 0; i < POOL; i++) {
          pool.push(layerOf(r, { width, join, cap: 0, alpha }, 1, make));
        }

        // Drawn opaque, where a line of whole alpha takes lineTriangles.
        const js = (layer: ShapeLayer) =>
          layerStrokes(layer, 1, 0, 0, 1, 1, tessellate, null, true);
        const native = (layer: ShapeLayer) =>
          layerStrokesNative(layer, 1, 0, 0, 1, 1, tessellate.lines, null, true);
        const pts = pool.reduce((sum, layer) => sum + points(layer), 0) / POOL;
        const verts =
          pool.reduce((sum, layer) => sum + (js(layer)?.positions.length ?? 0) / 2, 0) / POOL;
        const tJs = time(pool, js);
        const tNative = time(pool, native);
        jsTotal += tJs;
        nativeTotal += tNative;
        rows.push(
          `| ${kind} | ${shapeName} | ${widthName} | ${joinName} | ${pts.toFixed(0)} | ` +
            `${verts.toFixed(0)} | ${tJs.toFixed(0)} | ${tNative.toFixed(0)} | ` +
            `${(tNative / tJs).toFixed(2)} |`,
        );
        console.error(rows[rows.length - 1]);
      }
    }
  }

  rows.push(
    `| ${kind} | sum over rows | | | | | ${jsTotal.toFixed(0)} | ${nativeTotal.toFixed(0)} | ` +
      `${(nativeTotal / jsTotal).toFixed(2)} |`,
  );
}

console.log(rows.join("\n"));
