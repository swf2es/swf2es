// Independent ray crossings check both fill rules, including self-intersecting contours, and
// every eight fills tessellated as a layer must give each what it gave alone: by libtess2, and
// by the bands the module fills by where libtess2 fails (bands.zig). Then curved fills:
// the layer call's flattening must match a JS one, as the player's was, the same points where
// the two take a curve in as many chords, and within the flatness where a bend at a whole
// number of chords rounds the other way; the same fills drawn and the same refused.
// Run with: node tests/fuzz/tessellate.ts [cases, 2000] [seed, 1]
import assert from "node:assert/strict";
import {
  type FillGeometry,
  PATH_CUBIC,
  PATH_CURVE,
  PATH_LINE,
  PATH_MOVE,
  Tessellator,
} from "../../packages/native/dist/render/index.js";

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
const banded = new Tessellator({ bands: true });
let checked = 0;
let layered = 0;
const pending: { contours: number[][]; nonZero: boolean; alone: FillGeometry }[] = [];

/** A polygon as path commands: a move to its first point, then lines. */
function path(points: readonly number[]): number[] {
  const commands = [PATH_MOVE, points[0], points[1]];
  for (let i = 2; i < points.length; i += 2) {
    commands.push(PATH_LINE, points[i], points[i + 1]);
  }

  return commands;
}

/** The pending fills as a layer, each as it was alone, bit for bit. */
function checkLayer(by: Tessellator): void {
  const layer = by.tessellate.layer(
    pending.map(({ contours }) => contours.map(path)),
    pending.map(({ nonZero }) => nonZero),
  );
  assert.ok(layer, "layer unavailable");
  for (let i = 0; i < pending.length; i++) {
    const { contours, nonZero, alone } = pending[i];
    const together: FillGeometry | null = layer[i];
    const context = JSON.stringify({ seed, nonZero, contours });
    assert.ok(together, `layer rejected ${context}`);
    const offset: number = together.indexOffset ?? 0;
    assert.deepEqual(together.vertices, alone.vertices, `layer positions: ${context}`);
    assert.deepEqual(
      Array.from(together.indices, (index: number): number => index - offset),
      Array.from(alone.indices),
      `layer indices: ${context}`,
    );
    layered++;
  }

  pending.length = 0;
}

for (const by of [tessellator, banded]) {
  state = seed;
  for (let i = 0; i < cases; i++) {
    const contours: number[][] = [];
    for (let j = 0; j < 1 + Math.floor(random() * 3); j++) {
      const points: number[] = [];
      for (let k = 0; k < 3 + Math.floor(random() * 20); k++) {
        const x = Math.floor(random() * 100);
        const y = Math.floor(random() * 100);
        // A repeated point, or a closing one, the layer's flattening drops, as the player's does.
        if (
          (points.length > 0 && points.at(-2) === x && points.at(-1) === y) ||
          (k > 1 && points[0] === x && points[1] === y)
        ) {
          continue;
        }

        points.push(x, y);
      }

      if (points.length < 6) {
        points.push(200, 200);
      }

      contours.push(points);
    }

    const nonZero = i % 2 === 1;
    const context = JSON.stringify({ seed, case: i, nonZero, contours });
    const result = by.tessellate(contours, nonZero);
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

    pending.push({ contours, nonZero, alone: result });
    if (pending.length === 8) {
      checkLayer(by);
    }
  }

  checkLayer(by);
}

console.log(
  `fuzz tessellate: ${cases} fills by libtess2 and as many by the bands, ${checked} winding samples, ${layered} in layers from seed ${seed}, all well`,
);

/** A contour flattened as the player's JS did, with its length function. */
function flatten(commands: readonly number[], length: (x: number, y: number) => number): number[] {
  const points: number[] = [];
  const append = (x: number, y: number) => {
    if (points.length === 0 || points.at(-2) !== x || points.at(-1) !== y) {
      points.push(x, y);
    }
  };
  let x = 0;
  let y = 0;
  for (let i = 0; i < commands.length; ) {
    const command = commands[i];
    if (command === PATH_MOVE || command === PATH_LINE) {
      x = commands[i + 1];
      y = commands[i + 2];
      append(x, y);
      i += 3;
      continue;
    }

    if (command === PATH_CUBIC) {
      const [c1x, c1y, c2x, c2y, ax, ay] = commands.slice(i + 1, i + 7);
      const bend = Math.max(
        length(x - 2 * c1x + c2x, y - 2 * c1y + c2y),
        length(c1x - 2 * c2x + ax, c1y - 2 * c2y + ay),
      );
      const n = Math.min(256, Math.max(1, Math.ceil(Math.sqrt((3 * bend) / (4 * 0.02)))));
      for (let k = 1; k < n; k++) {
        const t = k / n;
        const u = 1 - t;
        append(
          u * u * u * x + 3 * u * u * t * c1x + 3 * u * t * t * c2x + t * t * t * ax,
          u * u * u * y + 3 * u * u * t * c1y + 3 * u * t * t * c2y + t * t * t * ay,
        );
      }

      append(ax, ay);
      x = ax;
      y = ay;
      i += 7;
      continue;
    }

    const [cx, cy, ax, ay] = commands.slice(i + 1, i + 5);
    const bend = length(x - 2 * cx + ax, y - 2 * cy + ay);
    const n = Math.min(256, Math.max(1, Math.ceil(Math.sqrt(bend / (4 * 0.02)))));
    for (let k = 1; k < n; k++) {
      const t = k / n;
      const u = 1 - t;
      append(u * u * x + 2 * u * t * cx + t * t * ax, u * u * y + 2 * u * t * cy + t * t * ay);
    }

    append(ax, ay);
    x = ax;
    y = ay;
    i += 5;
  }

  if (points.length > 2 && points[0] === points.at(-2) && points[1] === points.at(-1)) {
    points.length -= 2;
  }

  return points;
}

function area(geometry: FillGeometry): number {
  const { vertices: v, indices: p, indexOffset = 0 } = geometry;
  let sum = 0;
  for (let i = 0; i < p.length; i += 3) {
    const a = (p[i] - indexOffset) * 2;
    const b = (p[i + 1] - indexOffset) * 2;
    const c = (p[i + 2] - indexOffset) * 2;
    sum += Math.abs((v[b] - v[a]) * (v[c + 1] - v[a + 1]) - (v[b + 1] - v[a + 1]) * (v[c] - v[a]));
  }

  return sum / 2;
}

function sameGeometry(a: FillGeometry, b: FillGeometry): boolean {
  const ao = a.indexOffset ?? 0;
  const bo = b.indexOffset ?? 0;
  if (a.vertices.length !== b.vertices.length || a.indices.length !== b.indices.length) {
    return false;
  }

  for (let i = 0; i < a.vertices.length; i++) {
    if (!Object.is(a.vertices[i], b.vertices[i])) {
      return false;
    }
  }

  for (let i = 0; i < a.indices.length; i++) {
    if (a.indices[i] - ao !== b.indices[i] - bo) {
      return false;
    }
  }

  return true;
}

/** A coordinate: mostly twips, sometimes fractional, sometimes a bend just at a whole number of chords. */
function coordinate(): number {
  const r = random();
  return r < 0.6
    ? Math.round(random() * 4000) / 20
    : r < 0.9
      ? random() * 200
      : random() * 2e4 - 1e4;
}

let curved = 0;
let differing = 0;
let rejected = 0;
const plain = (x: number, y: number) => Math.sqrt(x * x + y * y);
for (let i = 0; i < cases / 8; i++) {
  const fills: number[][][] = [];
  const rules: boolean[] = [];
  for (let f = 0; f < 8; f++) {
    const contours: number[][] = [];
    for (let j = 0; j < 1 + Math.floor(random() * 3); j++) {
      const commands = [PATH_MOVE, coordinate(), coordinate()];
      for (let k = 0; k < 1 + Math.floor(random() * 8); k++) {
        const r = random();
        if (r < 0.2) {
          commands.push(PATH_LINE, coordinate(), coordinate());
        } else if (r < 0.7) {
          commands.push(PATH_CURVE, coordinate(), coordinate(), coordinate(), coordinate());
        } else if (r < 0.75) {
          // A curve of no length.
          const x = commands.at(-2) as number;
          const y = commands.at(-1) as number;
          commands.push(PATH_CURVE, x, y, x, y);
        } else {
          commands.push(PATH_CUBIC, coordinate(), coordinate(), coordinate(), coordinate());
          commands.push(coordinate(), coordinate());
        }
      }

      if (random() < 0.02) {
        commands[commands.length - 1 - Math.floor(random() * 2)] = Number.NaN;
      }

      contours.push(commands);
    }

    fills.push(contours);
    rules.push(random() < 0.5);
  }

  const layer = tessellator.tessellate.layer(fills, rules);
  assert.ok(layer, "layer unavailable");
  for (let f = 0; f < fills.length; f++) {
    const context = JSON.stringify({ seed, nonZero: rules[f], contours: fills[f] });
    const js = fills[f].map((c) => flatten(c, Math.hypot)).filter((p) => p.length >= 6);
    const model = fills[f].map((c) => flatten(c, plain)).filter((p) => p.length >= 6);
    const expected = tessellator.tessellate(js, rules[f]);
    const exact = tessellator.tessellate(model, rules[f]);
    const together: FillGeometry | null = layer[f];
    assert.equal(together === null, expected === null, `accepted differently: ${context}`);
    if (!together || !expected || !exact) {
      rejected++;
      continue;
    }

    curved++;
    // Square roots as the module takes them: the same points, bit for bit.
    assert.ok(sameGeometry(together, exact), `not the flattening of plain lengths: ${context}`);
    if (sameGeometry(together, expected)) {
      continue;
    }

    // A chord more or fewer on a curve whose bend sits at a whole number of chords: each chord
    // within the flatness, so the areas within it along the outline.
    differing++;
    let outline = 0;
    for (const points of js) {
      for (let k = 0, j = points.length - 2; k < points.length; j = k, k += 2) {
        outline += Math.hypot(points[k] - points[j], points[k + 1] - points[j + 1]);
      }
    }

    const gap = Math.abs(area(together) - area(expected));
    assert.ok(gap <= 2 * 0.02 * outline, `area ${gap} off over ${outline}: ${context}`);
  }
}

console.log(
  `fuzz tessellate: ${curved} curved fills flattened in layers as JS does (${differing} a chord apart at a boundary, ${rejected} refused by both)`,
);
