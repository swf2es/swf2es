// A display object's scales and rotation apart from its matrix, as Flash
// keeps them: set, they make the matrix; a matrix set whole is taken apart.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DisplayObject,
  normalizeDegrees,
} from "../../../../packages/player/dist/display/display.js";

const near = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} is not ${b}`);

test("a negative scale keeps its sign, a matrix set whole reads as a turn, and rotation stays in Flash's range", () => {
  const d = new DisplayObject();
  d.setScaleX(-0.5);
  assert.equal(d.scaleX, -0.5);
  near(d.matrix.a, -0.5);
  near(d.matrix.b, 0);
  assert.equal(d.rotation, 0);

  // The same matrix set whole: a half turn at a positive scale, as the matrix alone can say.
  const e = new DisplayObject();
  e.setMatrix({ a: -0.5, b: 0, c: 0, d: 1, tx: 3, ty: 4 });
  near(e.scaleX, 0.5);
  near(Math.abs(e.rotation), 180);
  near(Math.abs(e.skew), 180);
  assert.equal(e.matrix.tx, 3);

  // Rotation wraps into -180..180 and keeps the scales; the translation stays.
  d.setRotation(450);
  assert.equal(d.rotation, 90);
  near(d.matrix.a, 0);
  near(d.matrix.b, -0.5);
  assert.equal(normalizeDegrees(-270), 90);
  assert.equal(normalizeDegrees(180), 180);
  assert.equal(normalizeDegrees(-180), -180);

  // A NaN scale zeroes its column and reads back as NaN; a NaN rotation leaves the matrix.
  const g = new DisplayObject();
  g.setMatrix({ a: 2, b: 0, c: 4, d: 0, tx: 5, ty: 6 });
  g.setScaleX(Number.NaN);
  assert.ok(Number.isNaN(g.scaleX));
  assert.deepEqual([g.matrix.a, g.matrix.b, g.matrix.c, g.matrix.d], [0, 0, 4, 0]);
  const before = { ...g.matrix };
  g.setRotation(Number.NaN);
  assert.ok(Number.isNaN(g.rotation));
  assert.deepEqual(g.matrix, before);

  // A skewing matrix comes back as it went.
  const f = new DisplayObject();
  f.setMatrix({ a: 2, b: 1, c: 0.5, d: 3, tx: 0, ty: 0 });
  f.setScaleX(f.scaleX);
  near(f.matrix.a, 2);
  near(f.matrix.b, 1);
  near(f.matrix.c, 0.5);
  near(f.matrix.d, 3);
});
