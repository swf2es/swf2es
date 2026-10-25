import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const out = process.argv[2];
if (!out) {
  throw new Error("usage: node tools/native-tessellation/check.ts <artifact-directory>");
}

import { NativeTess } from "./native.ts";
import { synthetic } from "./synthetic.ts";

let seed = 1;
function random() {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed / 2 ** 32;
}
function winding(polys: number[][], x: number, y: number) {
  let n = 0;
  for (const p of polys) {
    for (let i = 0, j = p.length - 2; i < p.length; j = i, i += 2) {
      const x0 = p[j],
        y0 = p[j + 1],
        x1 = p[i],
        y1 = p[i + 1];
      const cross = (x1 - x0) * (y - y0) - (x - x0) * (y1 - y0);
      if (y0 <= y && y1 > y && cross > 0) {
        n++;
      }
      if (y0 > y && y1 <= y && cross < 0) {
        n--;
      }
    }
  }
  return n;
}
function boundary(polys: number[][], x: number, y: number) {
  for (const p of polys) {
    for (let i = 0, j = p.length - 2; i < p.length; j = i, i += 2) {
      const ax = p[j],
        ay = p[j + 1],
        bx = p[i],
        by = p[i + 1];
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
const results = [];
for (const variant of ["f32", "f64"] as const) {
  seed = 1;
  const bytes = readFileSync(resolve(out, `${variant}.wasm`));
  const n = new NativeTess(variant, bytes);
  let checked = 0,
    wrong = 0,
    rejected = 0;
  const saved = n.tessellate(synthetic[0].contours);
  const original = createHash("sha256")
    .update(new Uint8Array(saved.vertices.buffer))
    .update(new Uint8Array(saved.indices.buffer))
    .digest("hex");
  for (let i = 0; i < 2000; i++) {
    const polys: number[][] = [];
    for (let j = 0; j < 1 + Math.floor(random() * 3); j++) {
      const p = [];
      for (let k = 0; k < 3 + Math.floor(random() * 20); k++) {
        p.push(Math.floor(random() * 100), Math.floor(random() * 100));
      }
      polys.push(p);
    }
    const nonzero = i % 2 === 1;
    try {
      const r = n.tessellate(polys, nonzero);
      for (const ix of r.indices) {
        assert.ok(ix < r.vertices.length / 2);
      }
      for (const x of r.vertices) {
        assert.ok(Number.isFinite(x));
      }
      for (let sample = 0; sample < 12; sample++) {
        const x = random() * 100,
          y = random() * 100;
        if (boundary(polys, x, y)) {
          continue;
        }
        const w = winding(polys, x, y),
          expected = nonzero ? w !== 0 : Math.abs(w) % 2 === 1;
        let got = false;
        const v = r.vertices;
        for (let at = 0; at < r.indices.length; at += 3) {
          const a = r.indices[at] * 2,
            b = r.indices[at + 1] * 2,
            c = r.indices[at + 2] * 2;
          const p = (v[b] - v[a]) * (y - v[a + 1]) - (v[b + 1] - v[a + 1]) * (x - v[a]);
          const q = (v[c] - v[b]) * (y - v[b + 1]) - (v[c + 1] - v[b + 1]) * (x - v[b]);
          const s = (v[a] - v[c]) * (y - v[c + 1]) - (v[a + 1] - v[c + 1]) * (x - v[c]);
          if ((p > 0 && q > 0 && s > 0) || (p < 0 && q < 0 && s < 0)) {
            got = true;
            break;
          }
        }
        checked++;
        if (got !== expected) {
          wrong++;
        }
      }
    } catch {
      rejected++;
    }
  }
  for (const contours of [
    [[NaN, 0, 1, 0, 0, 1]],
    [[Infinity, 0, 1, 0, 0, 1]],
    [[8388609, 0, 1, 0, 0, 1]],
    [[0, 0, 1]],
    [[0, 0, 1, 1]],
  ]) {
    assert.throws(() => n.tessellate(contours), RangeError);
  }
  assert.equal(
    createHash("sha256")
      .update(new Uint8Array(saved.vertices.buffer))
      .update(new Uint8Array(saved.indices.buffer))
      .digest("hex"),
    original,
  );
  const limited = new NativeTess(variant, bytes, 8 << 20, 600000);
  const ring: number[] = [];
  for (let i = 0; i < 10000; i++) {
    ring.push(Math.cos(i) * 100, Math.sin(i) * 100);
  }
  assert.throws(() => limited.tessellate([ring]));
  const recovered = limited.tessellate(synthetic[0].contours);
  assert.equal(recovered.indices.length, 6);
  assert.equal(wrong, 0);
  assert.equal(rejected, 0);
  const row = {
    variant,
    seed: 1,
    attempts: 2000,
    checked,
    wrong,
    rejected,
    allocationFailures: limited.drops,
    recovered: true,
    retainedWasm: n.capacity(),
  };
  results.push(row);
  console.log(row);
}
writeFileSync(resolve(out, "checks.json"), JSON.stringify(results, null, 2));

function triangleArea(vertices: Float32Array | Float64Array, indices: Uint32Array): number {
  let area = 0;
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i] * 2;
    const b = indices[i + 1] * 2;
    const c = indices[i + 2] * 2;
    area +=
      Math.abs(
        (vertices[b] - vertices[a]) * (vertices[c + 1] - vertices[a + 1]) -
          (vertices[c] - vertices[a]) * (vertices[b + 1] - vertices[a + 1]),
      ) / 2;
  }

  return area;
}

// This loss is intentional evidence against adopting the upstream float ABI.
const thin = synthetic.find((c) => c.name === "large-origin-detail");
assert.ok(thin);
const double = new NativeTess("f64", readFileSync(resolve(out, "f64.wasm")));
const precise = double.tessellate(thin.contours);
assert.equal(triangleArea(precise.vertices, precise.indices), 12.5);
const float = new NativeTess("f32", readFileSync(resolve(out, "f32.wasm")));
const reduced = float.tessellate(thin.contours);
assert.equal(triangleArea(reduced.vertices, reduced.indices), 0);
console.log("precision: double preserves the thin fill; float collapses it");
