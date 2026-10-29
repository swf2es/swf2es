// layerStrokes (opaque lines, JS) against the native line builder, packing
// and copying out included, on representative layers: ns per layer and per
// flattened point, the median of several runs after warm-up. The native
// time is split into packing (JS into wasm memory), the call, and copying
// the geometry out.
import { LineBuilder } from "../../../packages/native/dist/strokes/index.js";
import type { ShapeLayer } from "../../../packages/player/dist/display/shapes.js";
import { trace } from "../../../packages/player/dist/scene/fills.js";
import { layerStrokes } from "../../../packages/player/dist/scene/strokes.js";
import { layerStrokesNative } from "../../../packages/player/dist/scene/strokes-native.js";
import { curved, layerOf, polygon, random } from "./layers.ts";

const RUNS = Number(process.argv[2] ?? 7);
const POOL = 64;
/** How long each run lasts, roughly. */
const RUN_MS = 60;

const builder = new LineBuilder();
const tessellator = (() => null) as unknown as Parameters<typeof layerStrokes>[6];
// Packing alone: the real input view, no call.
const packer = { input: (n: number) => builder.input(n), build: () => null } as unknown as LineBuilder;
let lastLength = 0;
const measurer = {
  input: (n: number) => builder.input(n),
  build: (length: number) => {
    lastLength = length;
    return null;
  },
} as unknown as LineBuilder;

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
const header =
  "| layer | width | join | pts | verts | JS ns | Zig ns | Zig/JS | pack | call | copy | JS ns/pt | Zig ns/pt |";
rows.push(header, header.replace(/[^|]+/g, "---"));
let jsTotal = 0;
let zigTotal = 0;
for (const [shapeName, make] of shapes) {
  for (const [widthName, width] of widths) {
    for (const [joinName, join] of joins) {
      const r = random(7);
      const pool: ShapeLayer[] = [];
      for (let i = 0; i < POOL; i++) {
        pool.push(layerOf(r, { width, join, cap: 0 }, 1, make));
      }

      // Hairlines and 2px lines at whole scale; 10px too.
      const js = (layer: ShapeLayer) => layerStrokes(layer, 1, 0, 0, 1, 1, tessellator, null, true);
      const zig = (layer: ShapeLayer) => layerStrokesNative(layer, 1, 0, 0, 1, 1, builder);
      const pts = pool.reduce((sum, layer) => sum + points(layer), 0) / POOL;
      const verts =
        pool.reduce((sum, layer) => sum + (js(layer)?.positions.length ?? 0) / 2, 0) / POOL;
      const tJs = time(pool, js);
      const tZig = time(pool, zig);
      const tPack = time(pool, (layer) => layerStrokesNative(layer, 1, 0, 0, 1, 1, packer));
      // The call alone, on each layer packed once beforehand into a buffer of its own.
      const packed = pool.map((layer) => {
        layerStrokesNative(layer, 1, 0, 0, 1, 1, measurer);
        return builder.input(lastLength).slice(0, lastLength);
      });
      let next = 0;
      const tCall = time(pool, () => {
        const input = packed[next++ % packed.length];
        builder.input(input.length).set(input);
        return builder.run(input.length) === 0;
      });
      // The copy-in of the call's own timing is packing's, counted there.
      const tCopyIn = time(pool, () => {
        const input = packed[next++ % packed.length];
        builder.input(input.length).set(input);
        return true;
      });
      const call = tCall - tCopyIn;
      const copy = tZig - tPack - call;
      jsTotal += tJs;
      zigTotal += tZig;
      rows.push(
        `| ${shapeName} | ${widthName} | ${joinName} | ${pts.toFixed(0)} | ${verts.toFixed(0)} | ` +
          `${tJs.toFixed(0)} | ${tZig.toFixed(0)} | ${(tZig / tJs).toFixed(2)} | ` +
          `${tPack.toFixed(0)} | ${call.toFixed(0)} | ${copy.toFixed(0)} | ` +
          `${(tJs / pts).toFixed(1)} | ${(tZig / pts).toFixed(1)} |`,
      );
      console.error(rows[rows.length - 1]);
    }
  }
}

console.log(rows.join("\n"));
console.log(`\nsum over rows: JS ${jsTotal.toFixed(0)} ns, Zig ${zigTotal.toFixed(0)} ns`);
