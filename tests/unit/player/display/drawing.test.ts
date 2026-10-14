// The Graphics recorder on its own: what a drawing's layers hold, and the
// edges Flash has around them.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BitmapStore } from "../../../../packages/player/dist/bitmap/bitmap.js";
import { Drawing } from "../../../../packages/player/dist/display/drawing.js";
import { facing, LINE, MOVE } from "../../../../packages/player/dist/display/shapes.js";

const red = { type: "solid" as const, color: 0xffff0000 };

test("a fill's contours close, a drawPath's winding is the fill's, and copying from itself empties the drawing, as in Flash", () => {
  const d = new Drawing();
  d.beginFill(red);
  d.drawRect(0, 0, 10, 10);
  d.endFill();
  assert.equal(d.layers.length, 1);
  assert.equal(d.layers[0].fills[0].winding, "evenOdd");
  assert.deepEqual(d.bounds(true), { xMin: 0, yMin: 0, xMax: 10, yMax: 10 });

  d.beginFill(red);
  d.drawPath([1, 2, 2, 2], [0, 0, 20, 0, 20, 20, 0, 20], "nonZero");
  // Another rule in the same fill: an entry of its own, the first's rule kept.
  d.drawPath([1, 2, 2, 2], [30, 0, 40, 0, 40, 10, 30, 10], "evenOdd");
  d.endFill();
  assert.equal(d.layers[1].fills.length, 2);
  assert.equal(d.layers[1].fills[0].winding, "nonZero");
  assert.equal(d.layers[1].fills[1].winding, "evenOdd");

  // Copied from another: the layers come over, winding included.
  const copy = new Drawing();
  copy.copyFrom(d);
  assert.equal(copy.layers.length, 2);
  assert.equal(copy.layers[1].fills[0].winding, "nonZero");
  assert.deepEqual(copy.bounds(false), { xMin: 0, yMin: 0, xMax: 40, yMax: 20 });

  // Copied from itself: cleared first, so nothing is left to copy, as Flash has it.
  d.copyFrom(d);
  assert.equal(d.layers.length, 0);

  // A move alone has no extent; a line from it does, its width counted when asked.
  const e = new Drawing();
  e.lineStyle({
    width: 40,
    color: 0xff000000,
    startCap: 0,
    endCap: 0,
    join: 0,
    miterLimit: 3,
    noHScale: false,
    noVScale: false,
    pixelHinting: false,
    noClose: false,
    fill: null,
  });
  e.moveTo(50, 50);
  assert.equal(e.bounds(true), null);
  e.lineTo(60, 50);
  assert.deepEqual(e.bounds(false), { xMin: 50, yMin: 50, xMax: 60, yMax: 50 });
  assert.deepEqual(e.bounds(true), { xMin: 49, yMin: 49, xMax: 61, yMax: 51 });
});

test("each fill begins a layer, and the lines drawn till the next fill go over it, as Flash draws them", () => {
  const line = (color: number) => ({
    width: 80,
    color,
    startCap: 0,
    endCap: 0,
    join: 0,
    miterLimit: 3,
    noHScale: false,
    noVScale: false,
    pixelHinting: false,
    noClose: false,
    fill: null,
  });
  const blue = { type: "solid" as const, color: 0xff0000ff };
  const colors = (d: Drawing) =>
    d.layers.map((l) => [
      l.fills.map((f) => (f.fill.type === "solid" ? f.fill.color : 0)),
      l.strokes.map((s) => s.line.color),
    ]);

  // A line open as a fill begins goes on over it; one that drew nothing is
  // taken away when the next begins.
  const d = new Drawing();
  d.lineStyle(line(0xff000000));
  d.beginFill(red);
  d.drawRect(10, 10, 40, 40);
  d.beginFill(blue);
  d.lineStyle(line(0xff00ff00));
  d.drawRect(30, 30, 40, 40);
  d.endFill();
  assert.deepEqual(colors(d), [
    [[0xffff0000], [0xff000000]],
    [[0xff0000ff], [0xff00ff00]],
  ]);

  // A line drawn before any fill stays under it, its own layer; one after
  // endFill over the fill before, the next fill's line not yet begun.
  const e = new Drawing();
  e.lineStyle(line(0xff000000));
  e.moveTo(0, 40);
  e.lineTo(90, 40);
  e.beginFill(blue);
  e.drawRect(30, 30, 40, 40);
  e.endFill();
  e.lineStyle(line(0xff00ff00));
  e.moveTo(40, 0);
  e.lineTo(40, 90);
  e.lineStyle(null);
  e.beginFill(red);
  e.drawRect(35, 60, 20, 20);
  assert.deepEqual(colors(e), [
    [[], [0xff000000]],
    [[0xff0000ff], [0xff000000, 0xff00ff00]],
    [[0xffff0000], []],
  ]);
});

test("an open contour is closed with a line in the line style of the time, kept apart from the paths, as in Flash", () => {
  const line = (color: number) => ({
    width: 80,
    color,
    startCap: 0,
    endCap: 0,
    join: 0,
    miterLimit: 3,
    noHScale: false,
    noVScale: false,
    pixelHinting: false,
    noClose: false,
    fill: null,
  });
  const triangle = (d: Drawing) => {
    d.lineStyle(line(0xff000000));
    d.beginFill(red);
    d.moveTo(10, 10);
    d.lineTo(80, 10);
    d.lineTo(80, 80);
  };

  // Closed on the path's end while open, out of the bounds; endFill keeps
  // it, and a move after keeps it for good.
  const d = new Drawing();
  triangle(d);
  const stroke = d.layers[0].strokes[0];
  assert.deepEqual(stroke.paths.at(-1), [MOVE, 10, 10, LINE, 80, 10, LINE, 80, 80]);
  assert.deepEqual(stroke.closes, [{ at: 1, x: 10, y: 10 }]);
  assert.deepEqual(d.bounds(true), { xMin: 8, yMin: 8, xMax: 82, yMax: 82 });
  d.endFill();
  d.moveTo(0, 0);
  d.lineTo(5, 5);
  assert.deepEqual(stroke.closes, [{ at: 1, x: 10, y: 10 }]);

  // A line on from the pen after endFill takes it away.
  const e = new Drawing();
  triangle(e);
  e.endFill();
  e.lineTo(10, 80);
  assert.deepEqual(e.layers[0].strokes[0].closes, []);

  // A new line style while the fill is open takes it up; none, and there is none.
  const f = new Drawing();
  triangle(f);
  f.lineStyle(line(0xff00ff00));
  f.endFill();
  assert.deepEqual(f.layers[0].strokes[0].closes, []);
  assert.deepEqual(f.layers[0].strokes[1].closes, [{ at: 0, x: 10, y: 10 }]);
  const g = new Drawing();
  triangle(g);
  g.lineStyle(null);
  g.endFill();
  assert.deepEqual(g.layers[0].strokes[0].closes, []);

  // A contour along one line has none, nor does one drawPath drew.
  const h = new Drawing();
  h.lineStyle(line(0xff000000));
  h.beginFill(red);
  h.moveTo(10, 45);
  h.lineTo(80, 45);
  h.lineTo(45, 45);
  h.drawPath([1, 2, 2], [10, 10, 80, 10, 80, 80], "evenOdd");
  h.lineTo(10, 80);
  h.endFill();
  assert.equal(h.layers[0].strokes[0].closes, undefined);
});

test("drawTriangles' triangles are a layer of fills of their own, the line around each, the fill going on after, as adl draws them", () => {
  const line = {
    width: 40,
    color: 0xff000000,
    startCap: 0,
    endCap: 0,
    join: 0,
    miterLimit: 3,
    noHScale: false,
    noVScale: false,
    pixelHinting: false,
    noClose: false,
    fill: null,
  };
  const d = new Drawing();
  d.lineStyle(line);
  d.beginFill(red);
  d.moveTo(0, 0);
  d.lineTo(50, 0);
  d.lineTo(50, 20);
  // The second clockwise, culled; the third's index past the vertices ends them.
  d.drawTriangles([0, 0, 40, 0, 0, 40, 40, 40], [3, 1, 2, 0, 1, 2, 0, 1, 9], null, 1);
  d.lineTo(50, 50);
  d.endFill();

  const [before, triangles, after] = d.layers;
  assert.equal(d.layers.length, 3);
  // The open contour ends at them, its closing line kept.
  assert.deepEqual(before.fills[0].contours.at(-1), [MOVE, 0, 0, LINE, 50, 0, LINE, 50, 20]);
  assert.deepEqual(before.strokes[0].closes, [{ at: 1, x: 0, y: 0 }]);
  assert.deepEqual(triangles.fills, [
    {
      fill: red,
      contours: [[MOVE, 40, 40, LINE, 40, 0, LINE, 0, 40, LINE, 40, 40]],
      winding: "evenOdd",
    },
  ]);
  assert.deepEqual(triangles.strokes[0].paths, [
    [MOVE, 40, 40, LINE, 40, 0, LINE, 0, 40, LINE, 40, 40],
  ]);
  assert.equal(triangles.strokes[0].triangles, true);
  // The bounds count the culled one, the line's width too.
  assert.deepEqual(triangles.extent, [0, 0, 40, 40, 1]);
  // On from the pen, closing to where the contour began.
  assert.deepEqual(after.fills[0].contours, [[MOVE, 0, 0, LINE, 50, 20, LINE, 50, 50]]);
  assert.deepEqual(after.strokes[0].paths, [[MOVE, 50, 20, LINE, 50, 50]]);
  assert.deepEqual(after.strokes[0].closes, [{ at: 0, x: 0, y: 0 }]);
  // Mirrored on the screen, adl culls the other: the layers as drawn there, the rest as they were.
  const outline = [MOVE, 0, 0, LINE, 40, 0, LINE, 0, 40, LINE, 0, 0];
  const turned = facing(d.layers, true, d.version);
  assert.equal(facing(d.layers, false, d.version), d.layers);
  assert.equal(facing(d.layers, true, d.version), turned);
  assert.equal(turned[0], before);
  assert.equal(turned[2], after);
  assert.deepEqual(turned[1].fills, [{ fill: red, contours: [outline], winding: "evenOdd" }]);
  assert.deepEqual(turned[1].strokes, [{ line, paths: [outline], triangles: true }]);
  assert.equal(turned[1].extent, triangles.extent);

  // A bitmap fill with u, v and t: a mesh, three vertices a triangle; a solid one draws nothing.
  const store = new BitmapStore(2, 2, true, 0xffffffff);
  const t = new Drawing();
  t.beginFill({
    type: "image",
    image: store,
    matrix: { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 },
    repeat: true,
    smooth: false,
  });
  t.drawTriangles([0, 0, 10, 0, 0, 10], null, [0, 0, 1, 1, 0, 0.5, 0, 1, 1], 0);
  t.endFill();
  assert.equal(t.layers.length, 1);
  assert.deepEqual(t.layers[0].meshes, [
    {
      image: store,
      repeat: true,
      smooth: false,
      positions: [0, 0, 10, 0, 0, 10],
      uvt: [0, 0, 1, 1, 0, 0.5, 0, 1, 1],
    },
  ]);
  const s = new Drawing();
  s.lineStyle(line);
  s.beginFill(red);
  s.drawTriangles([0, 0, 10, 0, 0, 10], null, [0, 0, 1, 1, 0, 1, 0, 1, 1], 0);
  assert.deepEqual(s.layers[0].fills, []);
  assert.deepEqual(s.layers[0].strokes, []);
  assert.deepEqual(s.bounds(false), { xMin: 0, yMin: 0, xMax: 10, yMax: 10 });
});
