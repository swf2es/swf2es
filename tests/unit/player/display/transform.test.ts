// A display object's scales and rotation apart from its matrix, as Flash
// keeps them: set, they make the matrix; a matrix set whole is taken apart.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DisplayObject,
  LEAST_SCALE_3D,
  normalizeDegrees,
} from "../../../../packages/player/dist/display/display.js";

const IDENTITY_MATRIX = { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 };

const near = (a: number, b: number, within = 1e-9) =>
  assert.ok(Math.abs(a - b) < within, `${a} is not ${b}`);

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

test("a 3D scale of 0 or NaN is kept at the least, so the matrix stays invertible and the scale comes back", () => {
  const d = new DisplayObject();
  d.set3D("rotationY", 0);
  for (const v of [0, -0, 1e-40, -1e-37, Number.NaN]) {
    d.setScaleX(v);
    assert.equal(d.scaleX, LEAST_SCALE_3D);
  }

  d.setScaleX(-1.18e-36);
  assert.equal(d.scaleX, -1.18e-36);
  d.setScaleX(0);
  d.set3D("rotationY", 45);
  const raw = d.space?.raw as Float32Array;
  assert.ok(raw.every((v) => !Number.isNaN(v)));
  d.setScaleX(1);
  near(d.space?.raw[0] as number, Math.SQRT1_2, 1e-6);
  near(d.space?.raw[2] as number, -Math.SQRT1_2, 1e-6);
  assert.equal(d.space?.rotationY, 45);
});

test("the first 3D scale set after the matrix is set whole is a float32", () => {
  const d = new DisplayObject();
  d.set3D("scaleZ", 0.1);
  assert.equal(d.space?.scaleZ, Math.fround(0.1));
  d.set3D("scaleZ", 0.1);
  assert.equal(d.space?.scaleZ, 0.1);
});

test("a 2D matrix with a column of no length goes 3D as the identity's properties, and a scale or rotation set then makes it the identity", () => {
  const d = new DisplayObject();
  d.setMatrix({ a: 1, b: 0, c: 0, d: 1, tx: 10, ty: 5 });
  d.setScaleX(0);
  d.set3D("z", 7);
  assert.deepEqual([d.scaleX, d.scaleY, d.space?.scaleZ, d.space?.rotationY], [1, 1, 1, 0]);
  assert.deepEqual([d.matrix.a, d.matrix.tx, d.matrix.ty, d.space?.z], [0, 10, 5, 7]);

  // The rotation is lost, the position too; the next one is taken.
  d.set3D("rotationY", 45);
  assert.deepEqual(
    Array.from(d.space?.raw as Float32Array),
    [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
  );
  assert.ok(d.space?.rotationY === 0);
  d.set3D("rotationY", 30);
  assert.equal(d.space?.rotationY, 30);
  near(d.matrix.a, Math.cos(Math.PI / 6), 1e-6);

  // A scale of 0 in y, and one set whole to 0 in both.
  const e = new DisplayObject();
  e.setScaleY(0);
  e.set3D("rotationX", 30);
  assert.ok(e.space?.rotationX === 0);
  assert.deepEqual([e.matrix.a, e.matrix.d], [1, 1]);
});

test("a negative 2D scale goes 3D as a half turn of +180, not -180", () => {
  const d = new DisplayObject();
  d.setScaleX(-1);
  d.set3D("rotationY", 5);
  near(d.space?.rotationX as number, 180, 1e-4);
  near(d.space?.rotationZ as number, 180, 1e-4);
  assert.equal(d.space?.scaleZ, -1);
});

test("matrix3D null changes nothing in 2D, and from 3D gives back the 2D scales from before", () => {
  const d = new DisplayObject();
  d.setMatrix({ a: 0, b: 0, c: 0, d: 1, tx: 10, ty: 5 });
  d.setMatrix3D(null);
  assert.deepEqual(d.matrix, { a: 0, b: 0, c: 0, d: 1, tx: 10, ty: 5 });

  const e = new DisplayObject();
  e.setScaleX(2);
  e.setScaleY(3);
  e.set3D("rotationY", 30);
  e.setScaleX(0);
  e.setMatrix3D(null);
  assert.equal(e.space, null);
  assert.deepEqual([e.scaleX, e.scaleY], [2, 3]);
  assert.deepEqual(e.matrix, IDENTITY_MATRIX);
});
