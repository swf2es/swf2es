// 9-slice scaling's geometry: where a grid moves points, when Flash slices
// at all, and the hit tests that follow what is drawn.
import assert from "node:assert/strict";
import { test } from "node:test";
import { hitsPoint } from "../../../../packages/player/dist/display/bounds.js";
import { Container, ShapeObject } from "../../../../packages/player/dist/display/display.js";
import { Drawing } from "../../../../packages/player/dist/display/drawing.js";
import {
  axis,
  onAxis,
  sliceBounds,
  sliceFor,
  sliceLayers,
  sliceOf,
} from "../../../../packages/player/dist/display/scale9.js";

const grey = { type: "solid" as const, color: 0xffcccccc };

/** A sprite drawing a 100 by 60 rectangle with a 4 wide bar at x 8 and one at x 88, its grid 20 to 80 by 20 to 40. */
function panel(): Container {
  const s = new Container();
  s.drawing = new Drawing();
  s.drawing.beginFill(grey);
  s.drawing.drawRect(0, 0, 100, 60);
  s.drawing.beginFill(grey);
  s.drawing.drawRect(8, 20, 4, 20);
  s.drawing.drawRect(88, 20, 4, 20);
  s.drawing.endFill();
  s.scale9Grid = { xMin: 20, yMin: 20, xMax: 80, yMax: 40 };
  return s;
}

const scaled = (a: number, d: number, b = 0, c = 0) => ({ a, b, c, d, tx: 0, ty: 0 });

test("an axis keeps its corners' size in the parent's units, and shares a size too small for them", () => {
  // Scaled 3: 300 wide, the corners 20 each, the centre the other 260.
  const x = axis(0, 20, 80, 100, 3);
  const drawn = (v: number) => onAxis(x, v) * 3;
  assert.equal(drawn(0), 0);
  assert.equal(drawn(8), 8);
  assert.equal(drawn(20), 20);
  assert.ok(Math.abs(drawn(50) - 150) < 1e-9);
  assert.ok(Math.abs(drawn(92) - 292) < 1e-9);
  assert.equal(drawn(100), 300);
  // Past the bounds, as a curve's control point may be, at the corners' rate.
  assert.ok(Math.abs(drawn(-6) + 6) < 1e-9);

  // Scaled 0.3: 30 wide, less than the corners' 40; they take 15 each and the centre none.
  const small = axis(0, 20, 80, 100, 0.3);
  assert.ok(Math.abs(onAxis(small, 8) * 0.3 - 6) < 1e-9);
  assert.ok(Math.abs(onAxis(small, 50) * 0.3 - 15) < 1e-9);
  assert.ok(Math.abs(onAxis(small, 92) * 0.3 - 24) < 1e-9);

  // Bounds off the origin: the corners run from the bounds' edges to the grid.
  const wide = axis(-50, 20, 80, 150, 2);
  assert.ok(Math.abs(onAxis(wide, -40) * 2 - -90) < 1e-9);
  assert.ok(Math.abs(onAxis(wide, 140) * 2 - 290) < 1e-9);
});

test("Flash slices under a scale alone, with the grid strictly inside the bounds without lines", () => {
  const s = panel();
  assert.ok(sliceOf(s, scaled(3, 1)));
  assert.ok(sliceOf(s, scaled(0.5, 2)));
  // Turned, skewed past a 4096th, or mirrored: scaled as ever.
  assert.ok(sliceOf(s, scaled(3, 1, 0.000244)));
  assert.equal(sliceOf(s, scaled(3, 1, 0.0002442)), null);
  assert.equal(sliceOf(s, scaled(3, 1, 0, 0.3)), null);
  assert.equal(sliceOf(s, scaled(-3, 1)), null);
  assert.equal(sliceOf(s, scaled(3, -1)), null);
  // Unscaled, nothing moves.
  assert.equal(sliceOf(s, scaled(1, 1)), null);

  // A grid on the bounds' edge, or past it, is ignored.
  s.scale9Grid = { xMin: 0, yMin: 20, xMax: 80, yMax: 40 };
  assert.equal(sliceOf(s, scaled(3, 1)), null);
  s.scale9Grid = { xMin: 20, yMin: 20, xMax: 80, yMax: 60 };
  assert.equal(sliceOf(s, scaled(3, 1)), null);
  s.scale9Grid = null;
  assert.equal(sliceOf(s, scaled(3, 1)), null);
});

test("a grid divides what the object and each child draw, each child in its own space", () => {
  const s = panel();
  // A child's drawing at 110 to 120, moved 50 to the right: the edge is at 120, not 170.
  const kid = new Container();
  kid.drawing = new Drawing();
  kid.drawing.beginFill(grey);
  kid.drawing.drawRect(110, 0, 10, 20);
  kid.setMatrix({ a: 2, b: 0, c: 0, d: 1, tx: 50, ty: 0 });
  s.addChildAt(kid, 0);
  // A grandchild's moves nothing.
  const deep = new Container();
  deep.drawing = new Drawing();
  deep.drawing.beginFill(grey);
  deep.drawing.drawRect(-300, 0, 10, 20);
  const holder = new Container();
  holder.addChildAt(deep, 0);
  s.addChildAt(holder, 1);
  assert.deepEqual(sliceBounds(s), { xMin: 0, yMin: 0, xMax: 120, yMax: 60 });
  assert.deepEqual(sliceOf(s, scaled(2, 1))?.x.from, [0, 20, 80, 120]);
});

test("a sprite's grid slices its Shape children through their matrices, not its sprites", () => {
  const s = panel();
  s.setMatrix(scaled(3, 1));
  const shape = new ShapeObject(null);
  shape.drawing = new Drawing();
  shape.setMatrix({ a: 0.5, b: 0, c: 0, d: 1, tx: 4, ty: 0 });
  s.addChildAt(shape, 0);
  const sprite = new Container();
  s.addChildAt(sprite, 1);

  assert.equal(sliceFor(s)?.m, null);
  assert.deepEqual(sliceFor(shape)?.m, shape.placed);
  assert.equal(sliceFor(sprite), null);

  // A bar at 8 to 12 in the shape is 8 to 10 in the sprite, in its left corner: drawn 8 to 10.
  shape.drawing.beginFill(grey);
  shape.drawing.drawRect(8, 20, 4, 20);
  const slice = sliceFor(shape);
  assert.ok(slice);
  const [layer] = sliceLayers(shape.drawing.layers, slice.slice, slice.m);
  const contour = layer.fills[0].contours.find((c) => c.length > 3) ?? [];
  const xs = contour.filter((_, i) => i % 3 === 1);
  assert.deepEqual(
    xs.map((x) => Math.round(((x * 0.5 + 4) * 3) / 0.01) * 0.01),
    [8, 10, 10, 8, 8],
  );
});

test("a hit test finds what the slice draws, not what the shape had", () => {
  const root = new Container();
  root.loaderInfo = {} as never;
  const s = panel();
  s.drawing = new Drawing();
  s.drawing.beginFill(grey);
  s.drawing.drawRect(0, 0, 1, 1);
  s.drawing.drawRect(99, 59, 1, 1);
  s.drawing.drawRect(8, 20, 4, 20);
  s.drawing.drawRect(88, 20, 4, 20);
  s.drawing.endFill();
  s.setMatrix(scaled(3, 1));
  root.addChildAt(s, 0);

  // The bars are drawn at 8 to 12 and 288 to 292; scaled as ever they would be at 24 to 36.
  assert.equal(hitsPoint(s, 10.5, 30, true, root), true);
  assert.equal(hitsPoint(s, 290.5, 30, true, root), true);
  assert.equal(hitsPoint(s, 30.5, 30, true, root), false);
});

test("a curve across a grid line is hit where the slice draws it, its control point moved", () => {
  const root = new Container();
  root.loaderInfo = {} as never;
  const s = new Container();
  s.drawing = new Drawing();
  s.drawing.beginFill(grey);
  s.drawing.moveTo(0, 30);
  s.drawing.curveTo(0, 0, 40, 0);
  s.drawing.lineTo(100, 0);
  s.drawing.lineTo(100, 60);
  s.drawing.lineTo(0, 60);
  s.drawing.lineTo(0, 30);
  s.drawing.endFill();
  s.scale9Grid = { xMin: 20, yMin: 20, xMax: 80, yMax: 40 };
  s.setMatrix(scaled(3, 1));
  root.addChildAt(s, 0);

  // The curve's end at 40 is drawn at 106.7 and its control point stays at
  // 0: 2.5 down, it starts at 56, where adl's first hit is 55.5. The curve
  // flattened and then moved would start at 21.
  let first = -1;
  for (let x = 0; x < 150 && first < 0; x += 0.5) {
    if (hitsPoint(s, x, 2.5, true, root)) {
      first = x;
    }
  }

  assert.ok(Math.abs(first - 55.5) <= 1, String(first));
});

test("a mask is not sliced, an owner that masks nor a Shape child that does", () => {
  const s = panel();
  s.setMatrix(scaled(3, 1));
  const shape = new ShapeObject(null);
  shape.drawing = new Drawing();
  s.addChildAt(shape, 0);
  assert.ok(sliceFor(shape));

  const masked = new Container();
  s.addChildAt(masked, 1);
  masked.setMask(shape);
  assert.equal(sliceFor(shape), null);
  assert.ok(sliceFor(s));

  masked.setMask(null);
  const other = new Container();
  other.setMask(s);
  assert.equal(sliceFor(s), null);
  assert.equal(sliceFor(shape), null);
});
