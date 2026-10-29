import assert from "node:assert/strict";
import { test } from "node:test";
import { Tessellator } from "@swf2es/native/tessellate";
import { Drawing } from "../../../../packages/player/dist/display/drawing.js";
import {
  layerStrokes,
  lineTriangles,
  outline,
  strokeWidth,
} from "../../../../packages/player/dist/scene/strokes.js";

/** The signed area of a contour, positive turning clockwise on a y-down stage. */
const area = (p: number[]) => {
  let sum = 0;
  for (let i = 0, j = p.length - 2; i < p.length; j = i, i += 2) {
    sum += p[j] * p[i + 1] - p[i] * p[j + 1];
  }

  return sum / 2;
};

const line = (width: number, noHScale = false, noVScale = false) =>
  ({ width, noHScale, noVScale }) as Parameters<typeof strokeWidth>[0];

test("a line is as wide as its scale mode lets the transform make it, never under a screen pixel", () => {
  assert.equal(strokeWidth(line(40), 3, 0, 0, 3, 0.5), 6);
  assert.equal(strokeWidth(line(40, true, true), 3, 0, 0, 3, 0.5), 2);
  assert.equal(strokeWidth(line(40, false, true), 3, 0, 0, 1, 0.5), 6);
  assert.equal(strokeWidth(line(0), 1, 0, 0, 1, 0.5), 0.5);
});

test("an open line with no caps is the rectangle along it", () => {
  const [contour] = outline([0, 0, 10, 0], false, 1, 1, 1, 3);
  assert.equal(Math.abs(area(contour)), 20);
});

test("square caps reach half the width past each end", () => {
  const [contour] = outline([0, 0, 10, 0], false, 1, 2, 1, 3);
  assert.equal(Math.abs(area(contour)), 24);
});

test("round caps add a half disc at each end", () => {
  const [contour] = outline([0, 0, 10, 0], false, 1, 0, 1, 3);
  // Chords at most 0.02 from the arc: a little less than the half discs.
  assert.ok(Math.abs(Math.abs(area(contour)) - (20 + Math.PI)) < 0.15);
});

test("a closed path is two loops, wound opposite ways, its ring between them", () => {
  const square = [0, 0, 10, 0, 10, 10, 0, 10, 0, 0];
  const [outer, inner] = outline(square, true, 1, 0, 2, 3);
  assert.ok(Math.sign(area(outer)) !== Math.sign(area(inner)));
  // Mitred corners: the outer loop 12 a side. The inner one goes through the path's own corners,
  // into the ring, which only makes the hole's outline smaller there: no more than 8 a side.
  assert.ok(Math.abs(Math.abs(area(outer)) - 144) < 1e-9);
  assert.ok(Math.abs(area(inner)) <= 64 && Math.abs(area(inner)) > 56);
});

test("a miter past its limit is cut, a bevel cuts it at the corner", () => {
  const corner = [0, 10, 0, 0, 10, 0];
  const mitred = Math.abs(area(outline(corner, false, 1, 1, 2, 3)[0]));
  const cut = Math.abs(area(outline(corner, false, 1, 1, 2, 1)[0]));
  const bevelled = Math.abs(area(outline(corner, false, 1, 1, 1, 3)[0]));
  assert.ok(mitred > cut && cut >= bevelled);
});

test("a single point with round caps is a dot, with others nothing", () => {
  const [dot] = outline([5, 5], false, 2, 0, 0, 3);
  assert.ok(Math.abs(Math.abs(area(dot)) - 4 * Math.PI) < 0.25);
  assert.deepEqual(outline([5, 5], false, 2, 1, 0, 3), []);
});

test("a way turned right back is joined around its tip", () => {
  // Out to 10 and back to 5, round joins: the outline reaches past 10 by the half width.
  const [contour] = outline([0, 0, 10, 0, 5, 0], false, 1, 1, 0, 3);
  const xs = contour.filter((_, i) => i % 2 === 0);
  assert.ok(Math.abs(Math.max(...xs) - 11) < 1e-9);
});

test("a closed path there and back is its one side, joined at both ends", () => {
  const loops = outline([0, 0, 10, 0, 0, 0], true, 1, 1, 0, 3);
  assert.equal(loops.length, 1);
  // A capsule: the rectangle and a disc's worth of round ends.
  assert.ok(Math.abs(Math.abs(area(loops[0])) - (20 + Math.PI)) < 0.15);
});

/** The non-zero winding of `contours` about (x, y). */
const winding = (contours: number[][], x: number, y: number) => {
  let w = 0;
  for (const c of contours) {
    const n = c.length / 2;
    for (let i = 0; i < n; i++) {
      const [ax, ay] = [c[i * 2], c[i * 2 + 1]];
      const [bx, by] = [c[((i + 1) % n) * 2], c[((i + 1) % n) * 2 + 1]];
      const side = (bx - ax) * (y - ay) - (x - ax) * (by - ay);
      if (ay <= y && by > y && side > 0) {
        w++;
      } else if (ay > y && by <= y && side < 0) {
        w--;
      }
    }
  }

  return w;
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
    const contours = outline(p, false, h, caps, join, 4);
    // Places well within a segment, out from it less than the half width, are in the line.
    for (let s = 0; s < 500; s++) {
      const i = Math.floor(random() * n) * 2;
      const [dx, dy] = [p[i + 2] - p[i], p[i + 3] - p[i + 1]];
      const l = Math.hypot(dx, dy);
      const t = 0.05 + random() * 0.9;
      const off = (random() * 2 - 1) * (h - 0.05);
      const x = p[i] + dx * t - (dy / l) * off;
      const y = p[i + 1] + dy * t + (dx / l) * off;
      assert.notEqual(winding(contours, x, y), 0, `path ${k}: (${x}, ${y}) left out`);
    }
  }
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
  const tessellator = new Tessellator();
  const g = layerStrokes(drawing.layers[0], 1, 0, 0, 1, 0.25, (c, nonZero) =>
    tessellator.tessellate(c, nonZero),
  );
  tessellator.dispose();
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
  const tessellator = new Tessellator();
  const g = layerStrokes(drawing.layers[0], 1, 0, 0, 1, 0.25, (c, nonZero) =>
    tessellator.tessellate(c, nonZero),
  );
  tessellator.dispose();
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
    const contours = outline(p, closed, h, caps, join, 3, 0.05);
    const g = { positions: [] as number[], indices: [] as number[] };
    lineTriangles(p, closed, h, caps, join, 3, 0.05, 0, g.positions, [], g.indices);
    const xs = p.filter((_, i) => i % 2 === 0);
    const ys = p.filter((_, i) => i % 2 === 1);

    for (let s = 0; s < 400; s++) {
      const x = Math.min(...xs) - 4 * h + random() * (Math.max(...xs) - Math.min(...xs) + 8 * h);
      const y = Math.min(...ys) - 4 * h + random() * (Math.max(...ys) - Math.min(...ys) + 8 * h);
      assert.equal(
        coverings(g, x, y) > 0,
        winding(contours, x, y) !== 0,
        `path ${k} (${closed ? "closed" : "open"}, caps ${caps}, join ${join}): (${x}, ${y})`,
      );
    }
  }
});

test("a line of whole alpha drawn opaque takes no tessellator, any other is tessellated", () => {
  const drawing = new Drawing();
  drawing.lineStyle({ ...(halfClear(4) as object), color: 0xff000000 } as never);
  drawing.moveTo(0, 0);
  drawing.lineTo(60, 60);
  drawing.lineTo(0, 60);
  const tessellator = new Tessellator();
  let calls = 0;
  const counted = (c: number[][], nonZero: boolean) => {
    calls++;
    return tessellator.tessellate(c, nonZero);
  };
  const g = layerStrokes(drawing.layers[0], 1, 0, 0, 1, 0.25, counted, null, true);
  assert.ok(g);
  assert.equal(calls, 0);
  // The turn's inner corner, where the segments' quads overlap.
  assert.equal(coverings(g, 57, 59), 2);
  assert.equal(coverings(g, 30, 29.5), 1);

  const tessellated = layerStrokes(drawing.layers[0], 1, 0, 0, 1, 0.25, counted, null, false);
  tessellator.dispose();
  assert.ok(tessellated);
  assert.equal(calls, 1);
  assert.equal(coverings(tessellated, 57, 59), 1);
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
  const square = [0, 0, 30, 0, 30, 30, 0, 30, 0, 0];
  const curve = [0, 0, 10, 1, 20, 3, 30, 6, 40, 10];
  for (const [name, p, closed] of [
    ["zigzag", zigzag, false],
    ["square", square, true],
    ["curve", curve, false],
  ] as const) {
    for (let join = 0; join < 3; join++) {
      for (let caps = 0; caps < 3; caps++) {
        const positions: number[] = [];
        const indices: number[] = [];
        lineTriangles([...p], closed, 3, caps, join, 3, 0.1, 0, positions, [], indices);
        assert.deepEqual(tJunctions(positions, indices), [], `${name}, join ${join}, caps ${caps}`);
      }
    }
  }
});
