// Independent ray crossings check both fill rules, including self-intersecting contours.
// Run with: node tests/fuzz/tessellate.ts [cases, 2000] [seed, 1]
import assert from "node:assert/strict";
import { Tessellator } from "../../packages/tessellate/dist/index.js";

const cases = Number(process.argv[2] ?? 2000);
const seed = Number(process.argv[3] ?? 1);
let state = seed;
function random(): number {
  state = (Math.imul(state, 1664525) + 1013904223) >>> 0;

  return state / 2 ** 32;
}

function winding(contours: number[][], x: number, y: number): number {
  let n = 0;
  for (const points of contours) {
    for (let i = 0, j = points.length - 2; i < points.length; j = i, i += 2) {
      const ax = points[j];
      const ay = points[j + 1];
      const bx = points[i];
      const by = points[i + 1];
      const cross = (bx - ax) * (y - ay) - (by - ay) * (x - ax);
      if (ay <= y && by > y && cross > 0) {
        n++;
      }
      if (ay > y && by <= y && cross < 0) {
        n--;
      }
    }
  }

  return n;
}

function boundary(contours: number[][], x: number, y: number): boolean {
  for (const points of contours) {
    for (let i = 0, j = points.length - 2; i < points.length; j = i, i += 2) {
      const ax = points[j];
      const ay = points[j + 1];
      const bx = points[i];
      const by = points[i + 1];
      if (
        x >= Math.min(ax, bx) - 1e-6 &&
        x <= Math.max(ax, bx) + 1e-6 &&
        y >= Math.min(ay, by) - 1e-6 &&
        y <= Math.max(ay, by) + 1e-6 &&
        Math.abs((bx - ax) * (y - ay) - (by - ay) * (x - ax)) < 1e-5
      ) {
        return true;
      }
    }
  }

  return false;
}

const tessellator = new Tessellator();
let checked = 0;
for (let i = 0; i < cases; i++) {
  const contours: number[][] = [];
  for (let j = 0; j < 1 + Math.floor(random() * 3); j++) {
    const points: number[] = [];
    for (let k = 0; k < 3 + Math.floor(random() * 20); k++) {
      points.push(Math.floor(random() * 100), Math.floor(random() * 100));
    }

    contours.push(points);
  }

  const nonZero = i % 2 === 1;
  const context = JSON.stringify({ seed, case: i, nonZero, contours });
  const result = tessellator.tessellate(contours, nonZero);
  assert.ok(result, `rejected ${context}`);
  const { vertices, indices } = result;
  for (let j = 0; j < vertices.length; j++) {
    assert.ok(Number.isFinite(vertices[j]), `nonfinite vertex: ${context}`);
  }
  for (let j = 0; j < indices.length; j++) {
    assert.ok(indices[j] < vertices.length / 2, `invalid index: ${context}`);
  }

  for (let sample = 0; sample < 12; sample++) {
    const x = random() * 100;
    const y = random() * 100;
    if (boundary(contours, x, y)) {
      continue;
    }

    const count = winding(contours, x, y);
    const expected = nonZero ? count !== 0 : Math.abs(count) % 2 === 1;
    let covered = false;
    for (let j = 0; j < indices.length; j += 3) {
      const a = indices[j] * 2;
      const b = indices[j + 1] * 2;
      const c = indices[j + 2] * 2;
      const area =
        (vertices[b] - vertices[a]) * (vertices[c + 1] - vertices[a + 1]) -
        (vertices[b + 1] - vertices[a + 1]) * (vertices[c] - vertices[a]);
      if (area === 0) {
        continue;
      }

      const p =
        (vertices[b] - vertices[a]) * (y - vertices[a + 1]) -
        (vertices[b + 1] - vertices[a + 1]) * (x - vertices[a]);
      const q =
        (vertices[c] - vertices[b]) * (y - vertices[b + 1]) -
        (vertices[c + 1] - vertices[b + 1]) * (x - vertices[b]);
      const r =
        (vertices[a] - vertices[c]) * (y - vertices[c + 1]) -
        (vertices[a + 1] - vertices[c + 1]) * (x - vertices[c]);
      if ((p >= 0 && q >= 0 && r >= 0) || (p <= 0 && q <= 0 && r <= 0)) {
        covered = true;
        break;
      }
    }

    assert.equal(covered, expected, `coverage at ${x},${y}: ${context}`);
    checked++;
  }
}

console.log(
  `fuzz tessellate: ${cases} fills, ${checked} winding samples from seed ${seed}, all well`,
);
