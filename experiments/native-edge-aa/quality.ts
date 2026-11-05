import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { decodePng, encodePng } from "../../tests/player/image.ts";
import { out } from "./paths.ts";
import { fixture } from "./shapes.ts";

const width = 512;
const height = 320;
const diagonal = process.argv[2] === "diagonal";
const prefix = diagonal ? "diagonal-" : "";
type Point = [number, number];

// Independent box integration: clip each convex polygon against a pixel
// square and measure the area. No tessellation or fringe code is reused.
function clip(points: Point[], axis: number, value: number, sign: number): Point[] {
  const result: Point[] = [];
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const q = points[(i + 1) % points.length];
    const a = (p[axis] - value) * sign;
    const b = (q[axis] - value) * sign;
    if (a >= 0) {
      result.push(p);
    }
    if (a < 0 !== b < 0) {
      const t = a / (a - b);
      result.push([p[0] + t * (q[0] - p[0]), p[1] + t * (q[1] - p[1])]);
    }
  }
  return result;
}

function area(points: Point[]): number {
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    sum += a[0] * b[1] - a[1] * b[0];
  }
  return Math.abs(sum) / 2;
}

const coverage = new Float64Array(width * height);
let exactArea = 0;
for (const p of fixture(diagonal)) {
  const points: Point[] = [];
  for (let i = 0; i < p.length; i += 2) {
    points.push([p[i], p[i + 1]]);
  }
  exactArea += area(points);
  const minX = Math.floor(Math.min(...points.map((v) => v[0])));
  const maxX = Math.ceil(Math.max(...points.map((v) => v[0])));
  const minY = Math.floor(Math.min(...points.map((v) => v[1])));
  const maxY = Math.ceil(Math.max(...points.map((v) => v[1])));
  for (let y = minY; y < maxY; y++) {
    for (let x = minX; x < maxX; x++) {
      let part = clip(points, 0, x, 1);
      part = clip(part, 0, x + 1, -1);
      part = clip(part, 1, y, 1);
      part = clip(part, 1, y + 1, -1);
      coverage[y * width + x] += area(part);
    }
  }
}
assert.ok(Math.abs(coverage.reduce((a, b) => a + b, 0) - exactArea) < 1e-7);
const image = { width, height, data: new Uint8Array(width * height * 4) };
for (let i = 0; i < coverage.length; i++) {
  image.data.fill(Math.round(255 * (1 - coverage[i])), i * 4, i * 4 + 3);
  image.data[i * 4 + 3] = 255;
}
writeFileSync(`${out}${prefix}box-reference.png`, encodePng(image));
const names = [
  "main-8",
  "main-4",
  "shader-only-8",
  "coverage-4",
  "coverage-1",
  "flash-high",
  "flash-best",
];
const pictures = Object.fromEntries(
  names.map((name) => [name, decodePng(readFileSync(`${out}${prefix}${name}.png`))]),
);
assert.deepEqual(pictures["main-8"], pictures["shader-only-8"]);
const rows = names.map((name) => {
  const actual = pictures[name];
  assert.equal(actual.width, width);
  assert.equal(actual.height, height);
  let ink = 0;
  let edgeError = 0;
  let edgeCount = 0;
  let flashError = 0;
  let flashEdges = 0;
  let squareError = 0;
  for (let i = 0; i < coverage.length; i++) {
    const inkPixel = 1 - actual.data[i * 4] / 255;
    ink += inkPixel;
    const difference = Math.abs(coverage[i] - inkPixel);
    squareError += difference ** 2;
    if (coverage[i] > 1e-7 && coverage[i] < 1 - 1e-7) {
      edgeError += difference;
      edgeCount++;
    }
    const flash = pictures["flash-best"].data[i * 4];
    if ((flash > 0 && flash < 255) || (coverage[i] > 1e-7 && coverage[i] < 1 - 1e-7)) {
      flashError += Math.abs(actual.data[i * 4] - flash);
      flashEdges++;
    }
  }
  return {
    name,
    inkArea: ink,
    areaErrorPercent: (ink / exactArea - 1) * 100,
    exactBoxEdgeMAE: (edgeError / edgeCount) * 255,
    exactBoxRMSE: Math.sqrt(squareError / coverage.length) * 255,
    flashBestEdgeMAE: flashError / flashEdges,
    edgePixels: edgeCount,
  };
});
writeFileSync(`${out}${prefix}quality.json`, JSON.stringify({ exactArea, rows }, null, 2));
console.table(rows);
