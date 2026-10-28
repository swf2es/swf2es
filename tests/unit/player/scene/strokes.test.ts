import assert from "node:assert/strict";
import { test } from "node:test";
import { outline, strokeWidth } from "../../../../packages/player/dist/scene/strokes.js";

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
