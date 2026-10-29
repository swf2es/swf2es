// The player's lines as @swf2es/native's line builder makes them (strokes.zig), through
// scene/strokes.ts: what a translucent line covers is its outline, tessellated into triangles that
// do not overlap, so their area is the area it covers; an opaque one's triangles may overlap.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Tessellator } from "@swf2es/native/render";
import { Drawing } from "../../../../packages/player/dist/display/drawing.js";
import { layerStrokes, strokeWidth } from "../../../../packages/player/dist/scene/strokes.js";
import { curved, layerOf, random, randomLayer } from "./line-layers.ts";

const builder = new Tessellator().tessellate.lines;

const line = (width: number, noHScale = false, noVScale = false) =>
  ({ width, noHScale, noVScale }) as Parameters<typeof strokeWidth>[0];

test("a line is as wide as its scale mode lets the transform make it, never under a screen pixel", () => {
  assert.equal(strokeWidth(line(40), 3, 0, 0, 3, 0.5), 6);
  assert.equal(strokeWidth(line(40, true, true), 3, 0, 0, 3, 0.5), 2);
  assert.equal(strokeWidth(line(40, false, true), 3, 0, 0, 1, 0.5), 6);
  assert.equal(strokeWidth(line(0), 1, 0, 0, 1, 0.5), 0.5);
});

/** Caps and joins as a SWF codes them. */
const ROUND = 0;
const NONE = 1;
const SQUARE = 2;
const BEVEL = 1;
const MITER = 2;

/**
 * The polyline `p` stroked `h` either side, with `caps` and `join`, closed
 * back to its start where `closed`: half clear, outlined, unless `opaque`
 * asks for a line of whole alpha drawn as triangles.
 */
function stroke(
  p: readonly number[],
  closed: boolean,
  h: number,
  caps: number,
  join: number,
  limit: number,
  opaque = false,
) {
  const drawing = new Drawing();
  drawing.lineStyle({
    width: h * 40,
    color: opaque ? 0xff000000 : 0x80000000,
    startCap: caps,
    endCap: caps,
    join,
    miterLimit: limit,
    noHScale: false,
    noVScale: false,
    pixelHinting: false,
    noClose: false,
  } as never);
  drawing.moveTo(p[0], p[1]);
  for (let i = 2; i < p.length; i += 2) {
    drawing.lineTo(p[i], p[i + 1]);
  }

  if (p.length === 2) {
    drawing.lineTo(p[0], p[1]);
  }

  if (closed) {
    drawing.lineTo(p[0], p[1]);
  }

  return layerStrokes(drawing.layers[0], 1, 0, 0, 1, 0.25, builder, null, opaque);
}

/** The area a geometry's triangles cover, each counted once. */
function area(g: ReturnType<typeof stroke>): number {
  if (!g) {
    return 0;
  }

  let sum = 0;
  const { positions: v, indices: t } = g;
  for (let k = 0; k < t.length; k += 3) {
    const [a, b, c] = [t[k] * 2, t[k + 1] * 2, t[k + 2] * 2];
    sum +=
      Math.abs((v[b] - v[a]) * (v[c + 1] - v[a + 1]) - (v[c] - v[a]) * (v[b + 1] - v[a + 1])) / 2;
  }

  return sum;
}

test("an open line with no caps is the rectangle along it", () => {
  assert.ok(Math.abs(area(stroke([0, 0, 10, 0], false, 1, NONE, MITER, 3)) - 20) < 1e-4);
});

test("square caps reach half the width past each end", () => {
  assert.ok(Math.abs(area(stroke([0, 0, 10, 0], false, 1, SQUARE, MITER, 3)) - 24) < 1e-4);
});

test("round caps add a half disc at each end", () => {
  // Chords near the arc: a little less than the half discs.
  const covered = area(stroke([0, 0, 10, 0], false, 1, ROUND, MITER, 3));
  assert.ok(covered < 20 + Math.PI && covered > 20 + Math.PI - 0.15);
});

test("a closed path's ring lies between its outer loop and its hole", () => {
  // Mitred corners: the outer loop 12 a side. The inner one goes through the path's own corners,
  // into the ring, which only makes the hole smaller there: no more than 8 a side.
  const covered = area(stroke([0, 0, 10, 0, 10, 10, 0, 10], true, 1, ROUND, MITER, 3));
  assert.ok(covered >= 144 - 64 - 1e-4 && covered < 144 - 56);
});

test("a miter past its limit is cut, a bevel cuts it at the corner", () => {
  const corner = [0, 10, 0, 0, 10, 0];
  const mitred = area(stroke(corner, false, 1, NONE, MITER, 3));
  const cut = area(stroke(corner, false, 1, NONE, MITER, 1));
  const bevelled = area(stroke(corner, false, 1, NONE, BEVEL, 3));
  assert.ok(mitred > cut && cut >= bevelled);
});

test("a single point with round caps is a dot, with others nothing", () => {
  assert.ok(Math.abs(area(stroke([5, 5], false, 2, ROUND, ROUND, 3)) - 4 * Math.PI) < 0.25);
  assert.equal(area(stroke([5, 5], false, 2, NONE, ROUND, 3)), 0);
});

test("a way turned right back is joined around its tip", () => {
  // Out to 10 and back to 5, round joins: the outline reaches past 10 by the half width.
  const g = stroke([0, 0, 10, 0, 5, 0], false, 1, NONE, ROUND, 3);
  assert.ok(g);
  const xs = Array.from(g.positions).filter((_, i) => i % 2 === 0);
  assert.ok(Math.abs(Math.max(...xs) - 11) < 1e-4);
});

test("a closed path there and back is its one side, joined at both ends", () => {
  // A capsule: the rectangle and a disc's worth of round ends.
  const covered = area(stroke([0, 0, 10, 0], true, 1, NONE, ROUND, 3));
  assert.ok(Math.abs(covered - (20 + Math.PI)) < 0.15);
});

/** How many of a geometry's triangles cover (x, y). */
const coverings = (
  g: { positions: ArrayLike<number>; indices: ArrayLike<number> },
  x: number,
  y: number,
) => {
  let n = 0;
  for (let k = 0; k < g.indices.length; k += 3) {
    const p = [0, 1, 2].map((j) => [
      g.positions[g.indices[k + j] * 2],
      g.positions[g.indices[k + j] * 2 + 1],
    ]);
    const side = (a: number[], b: number[]) =>
      (b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0]);
    const d = [side(p[0], p[1]), side(p[1], p[2]), side(p[2], p[0])];
    if (d.every((v) => v > 0) || d.every((v) => v < 0)) {
      n++;
    }
  }

  return n;
};

test("a line wider than its curve leaves no hole inside, whatever its joins and caps", () => {
  // Wandering curves of short chords, as flattened curves are, often wider than they turn: the
  // inner sides cut at gentle turns once wound back there and left holes the fill skipped.
  let seed = 7;
  const random = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  for (let k = 0; k < 400; k++) {
    const n = 4 + Math.floor(random() * 12);
    const p = [0, 0];
    let angle = random() * Math.PI * 2;
    for (let i = 0; i < n; i++) {
      angle += (random() - 0.5) * 1.6;
      const step = 0.3 + random() * 4;
      p.push(p[p.length - 2] + Math.cos(angle) * step, p[p.length - 1] + Math.sin(angle) * step);
    }

    const h = 0.2 + random() * 7;
    const caps = Math.floor(random() * 3);
    const join = Math.floor(random() * 3);
    const g = stroke(p, false, h, caps, join, 4);
    assert.ok(g);
    // Places well within a segment, out from it less than the half width, are in the line.
    for (let s = 0; s < 500; s++) {
      const i = Math.floor(random() * n) * 2;
      const [dx, dy] = [p[i + 2] - p[i], p[i + 3] - p[i + 1]];
      const l = Math.hypot(dx, dy);
      const t = 0.05 + random() * 0.9;
      const off = (random() * 2 - 1) * (h - 0.05);
      const x = p[i] + dx * t - (dy / l) * off;
      const y = p[i + 1] + dy * t + (dx / l) * off;
      assert.equal(coverings(g, x, y), 1, `path ${k}: (${x}, ${y}) not covered once`);
    }
  }
});

/** A line `width` pixels wide, round, half clear. */
const halfClear = (width: number) =>
  ({
    width: width * 20,
    color: 0x80000000,
    startCap: 0,
    endCap: 0,
    join: 0,
    miterLimit: 3,
    noHScale: false,
    noVScale: false,
    pixelHinting: false,
    noClose: false,
  }) as never;

test("drawTriangles' outlines are filled once, their full width where triangles meet", () => {
  // A quad as two triangles sharing a diagonal and two corners: libtess2 once dropped part of a
  // ring here, where each triangle's inner side passed through the shared corners.
  const drawing = new Drawing();
  drawing.lineStyle(halfClear(2));
  drawing.drawTriangles([0, 10, 50, 0, 50, 50, 0, 40], [0, 1, 2, 0, 2, 3], null, 0);
  const g = layerStrokes(drawing.layers[0], 1, 0, 0, 1, 0.25, builder);
  assert.ok(g);
  // Across the top edge at x = 25, which lies at y = 5: covered within a pixel of it, once.
  assert.deepEqual(
    [3.8, 4.5, 5, 5.5, 5.9, 6.2].map((y) => coverings(g, 25, y)),
    [0, 1, 1, 1, 1, 0],
  );
  // On the shared diagonal, and at a shared corner: once, as adl fills them (line-overlaps).
  assert.equal(coverings(g, 25, 30), 1);
  assert.equal(coverings(g, 0.5, 10.2), 1);
});

test("a line's paths are each filled once, and blended over each other where they overlap", () => {
  const drawing = new Drawing();
  drawing.lineStyle(halfClear(6));
  drawing.moveTo(0, 0);
  drawing.lineTo(60, 60);
  drawing.moveTo(0, 60);
  drawing.lineTo(60, 0);
  const g = layerStrokes(drawing.layers[0], 1, 0, 0, 1, 0.25, builder);
  assert.ok(g);
  assert.equal(coverings(g, 30.3, 30.1), 2);
  assert.equal(coverings(g, 10.3, 10.1), 1);
});

test("an opaque line's triangles cover what its outline does, whatever its joins and caps", () => {
  let seed = 11;
  const random = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  for (let k = 0; k < 300; k++) {
    const n = 2 + Math.floor(random() * 10);
    const p = [0, 0];
    let angle = random() * Math.PI * 2;
    for (let i = 1; i < n; i++) {
      angle += (random() - 0.5) * (k % 3 === 0 ? 5 : 1.6);
      const step = 0.3 + random() * 6;
      p.push(p[p.length - 2] + Math.cos(angle) * step, p[p.length - 1] + Math.sin(angle) * step);
    }

    const closed = k % 4 === 1;
    const h = 0.2 + random() * 4;
    const caps = Math.floor(random() * 3);
    const join = Math.floor(random() * 3);
    const outlined = stroke(p, closed, h, caps, join, 3);
    const triangles = stroke(p, closed, h, caps, join, 3, true);
    assert.ok(outlined && triangles);
    const xs = p.filter((_, i) => i % 2 === 0);
    const ys = p.filter((_, i) => i % 2 === 1);

    for (let s = 0; s < 400; s++) {
      const x = Math.min(...xs) - 4 * h + random() * (Math.max(...xs) - Math.min(...xs) + 8 * h);
      const y = Math.min(...ys) - 4 * h + random() * (Math.max(...ys) - Math.min(...ys) + 8 * h);
      assert.equal(
        coverings(triangles, x, y) > 0,
        coverings(outlined, x, y) > 0,
        `path ${k} (${closed ? "closed" : "open"}, caps ${caps}, join ${join}): (${x}, ${y})`,
      );
    }
  }
});

test("a line of whole alpha drawn opaque is triangles that overlap, any other is filled once", () => {
  const p = [0, 0, 60, 60, 0, 60];
  const triangles = stroke(p, false, 2, ROUND, ROUND, 3, true);
  assert.ok(triangles);
  // The turn's inner corner, where the segments' quads overlap.
  assert.equal(coverings(triangles, 57, 59), 2);
  assert.equal(coverings(triangles, 30, 29.5), 1);
  const outlined = stroke(p, false, 2, ROUND, ROUND, 3);
  assert.ok(outlined);
  assert.equal(coverings(outlined, 57, 59), 1);
});

/**
 * The corners of a geometry that lie within one of its triangles' outer
 * edges, those with no triangle of their own across them, and belong to a
 * triangle across the edge, which meets it there: a T-junction, where
 * rounding may open a crack between the two.
 */
const tJunctions = (positions: number[], indices: number[]) => {
  const at = (v: number) => [positions[v * 2], positions[v * 2 + 1]];
  const side = (a: number, b: number, v: number) => {
    const [ax, ay] = at(a);
    const [bx, by] = at(b);
    const [vx, vy] = at(v);
    return (bx - ax) * (vy - ay) - (by - ay) * (vx - ax);
  };
  const found: string[] = [];
  for (let t = 0; t < indices.length; t += 3) {
    for (let e = 0; e < 3; e++) {
      const a = indices[t + e];
      const b = indices[t + ((e + 1) % 3)];
      const across = Math.sign(side(a, b, indices[t + ((e + 2) % 3)]));
      // An edge with a triangle of its own across it is inside what they cover: nothing to crack.
      let shared = false;
      for (let u = 0; u < indices.length && !shared; u += 3) {
        const tri = [indices[u], indices[u + 1], indices[u + 2]];
        const third = tri.find((w) => w !== a && w !== b);
        shared =
          tri.includes(a) &&
          tri.includes(b) &&
          third !== undefined &&
          Math.sign(side(a, b, third)) === -across;
      }

      if (shared) {
        continue;
      }

      const [ax, ay] = at(a);
      const [bx, by] = at(b);
      const length = Math.hypot(bx - ax, by - ay);
      for (let u = 0; u < indices.length; u += 3) {
        const tri = [indices[u], indices[u + 1], indices[u + 2]];
        for (const v of tri) {
          const [vx, vy] = at(v);
          const along = ((vx - ax) * (bx - ax) + (vy - ay) * (by - ay)) / length;
          const off = Math.abs(side(a, b, v)) / length;
          if (off > 1e-9 || along < 1e-9 || along > length - 1e-9) {
            continue;
          }

          const ends = tri.filter((w) => w === a || w === b);
          const third = tri.find((w) => w !== v && w !== a && w !== b);
          if (
            ends.length === 1 &&
            third !== undefined &&
            Math.sign(side(a, b, third)) === -across
          ) {
            found.push(`corner ${v} on edge ${a}-${b}`);
          }
        }
      }
    }
  }

  return found;
};

test("an opaque line's triangles meet corner to corner, no corner within another's edge", () => {
  const zigzag = [0, 0, 10, 20, 20, 0, 30, 20, 40, 0];
  const square = [0, 0, 30, 0, 30, 30, 0, 30];
  const curve = [0, 0, 10, 1, 20, 3, 30, 6, 40, 10];
  for (const [name, p, closed] of [
    ["zigzag", zigzag, false],
    ["square", square, true],
    ["curve", curve, false],
  ] as const) {
    for (let join = 0; join < 3; join++) {
      for (let caps = 0; caps < 3; caps++) {
        const g = stroke(p, closed, 3, caps, join, 3, true);
        assert.ok(g);
        const found = tJunctions(Array.from(g.positions), Array.from(g.indices));
        assert.deepEqual(found, [], `${name}, join ${join}, caps ${caps}`);
      }
    }
  }
});

test("random layers build, through any transform, their positions finite and indices in range", () => {
  const r = random(1);
  let built = 0;
  for (let k = 0; k < 3000; k++) {
    const layer = randomLayer(r);
    const angle = r() * 2 * Math.PI;
    const scale = [0.05, 0.5, 1, 1, 2, 6][Math.floor(r() * 6)];
    const skew = r() < 0.2 ? r() : 0;
    const a = scale * Math.cos(angle);
    const b = scale * Math.sin(angle);
    const c = -scale * Math.sin(angle) + skew;
    const d = scale * Math.cos(angle);
    const least = [1, 0.5, 2][Math.floor(r() * 3)];
    const by = r() < 0.1 ? [1, 0, 0, 1] : null;
    const g = layerStrokes(layer, a, b, c, d, least, builder, by, r() < 0.5);
    if (!g) {
      continue;
    }

    built++;
    assert.ok(g.positions.every(Number.isFinite), `layer ${k}: a position not finite`);
    const vertices = g.positions.length / 2;
    assert.equal(g.colors.length, vertices);
    assert.ok(
      g.indices.every((i) => i < vertices),
      `layer ${k}: an index past its vertices`,
    );
  }

  // A layer of lines builds, whatever the transform; only one of no extent builds none.
  assert.ok(built > 2900, `${built} of 3000 built`);
});

test("a NaN position draws no lines", () => {
  const layer = randomLayer(random(3));
  layer.strokes[0].paths[0][1] = Number.NaN;
  assert.equal(layerStrokes(layer, 1, 0, 0, 1, 1, builder, null, true), null);
});

test("the line builder keeps to its tessellator's memory limit and what it retains", () => {
  const layer = layerOf(random(4), { width: 200, join: 0, cap: 0, alpha: 128 }, 20, (r) =>
    curved(r, 16, true, 200),
  );
  const build = (tessellator: Tessellator) =>
    layerStrokes(layer, 1, 0, 0, 1, 1, tessellator.tessellate.lines, null, false);
  // Short of memory, the layer has no lines, as a fill short of memory is left out.
  assert.equal(build(new Tessellator({ memoryLimit: 1 << 20 })), null);
  const roomy = new Tessellator();
  assert.ok(build(roomy));
  assert.ok(roomy.capacity > 0, "the line builder's memory counts in the tessellator's");
  const keepsNone = new Tessellator({ retainMemory: 0 });
  assert.ok(build(keepsNone));
  assert.equal(keepsNone.capacity, 0);
});

test("outlines filled by the bands alone cover what libtess2's do", () => {
  const bands = new Tessellator({ bands: true }).tessellate.lines;
  const r = random(5);
  for (let k = 0; k < 50; k++) {
    const layer = layerOf(r, { alpha: 128 }, 3, (r) => curved(r, 8, k % 2 === 0, 20 + r() * 80));
    const covered = [builder, bands].map((by) => {
      const g = layerStrokes(layer, 1, 0, 0, 1, 1, by, null, false);
      assert.ok(g, `layer ${k}`);
      let sum = 0;
      const { positions: v, indices: t } = g;
      for (let i = 0; i < t.length; i += 3) {
        const [a, b, c] = [t[i] * 2, t[i + 1] * 2, t[i + 2] * 2];
        sum +=
          Math.abs((v[b] - v[a]) * (v[c + 1] - v[a + 1]) - (v[c] - v[a]) * (v[b + 1] - v[a + 1])) /
          2;
      }

      return sum;
    });
    // Within the f32 rounding of two triangulations' positions.
    assert.ok(
      Math.abs(covered[0] - covered[1]) <= covered[0] * 1e-5,
      `layer ${k}: libtess2 ${covered[0]}, the bands ${covered[1]}`,
    );
  }
});
