// readGraphicsData's reading of a drawing on its own: the numbers are adl's
// (the player's read-graphics-data case has the rest).
import assert from "node:assert/strict";
import { test } from "node:test";
import { Drawing } from "../../../../packages/player/dist/display/drawing.js";
import {
  type GraphicsDatum,
  graphicsData,
  storedColor,
} from "../../../../packages/player/dist/display/graphicsdata.js";

const IDENTITY = { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 };

function read(d: Drawing): GraphicsDatum[] {
  const out: GraphicsDatum[] = [];
  graphicsData(d.layers, IDENTITY, new WeakSet(), out);
  return out;
}

const line = (width: number) => ({
  width,
  color: 0xff808080,
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

test("a colour comes back through Flash's premultiplied store", () => {
  assert.deepEqual(storedColor(0xff123456), { color: 0x123456, alpha: 1 });
  assert.deepEqual(storedColor(0x3f123456), { color: 0x103555, alpha: 63 / 255 });
  assert.deepEqual(storedColor(0x19123456), { color: 0x0a3352, alpha: 25 / 255 });
  assert.deepEqual(storedColor(0x00ffffff), { color: 0, alpha: 0 });
});

test("a fill reads back as its fill, a path in twips and an end, its open contour closed", () => {
  const d = new Drawing();
  d.beginFill({ type: "solid", color: 0xffff0000 });
  d.moveTo(1.33, 2.66);
  d.lineTo(10, 2.66);
  d.lineTo(10, 10);
  assert.deepEqual(read(d), [
    { type: "solid", color: 0xff0000, alpha: 1 },
    {
      type: "path",
      winding: "evenOdd",
      commands: [1, 2, 2, 2],
      data: [1.35, 2.65, 10, 2.65, 10, 10, 1.35, 2.65],
    },
    { type: "end" },
  ]);
});

test("a cubic comes back as quadratics, more of them the further it strays from one", () => {
  const pieces = (size: number) => {
    const d = new Drawing();
    d.beginFill({ type: "solid", color: 0xff000000 });
    d.cubicCurveTo(size / 4, size, (size * 3) / 4, -size / 2, size, 0);
    const path = read(d)[1];
    return path.type === "path" ? path.commands.filter((c) => c === 3).length : 0;
  };

  // adl's counts for these sizes.
  assert.deepEqual([1, 4, 6, 50, 400].map(pieces), [2, 2, 4, 8, 16]);
});

test("a line reads back as the outline of its stroke, a nonZero fill of its colour", () => {
  const d = new Drawing();
  d.lineStyle(line(200));
  d.moveTo(0, 0);
  d.lineTo(100, 0);
  const [fill, path] = read(d);
  assert.deepEqual(fill, { type: "solid", color: 0x808080, alpha: 1 });
  assert.deepEqual(path, {
    type: "path",
    winding: "nonZero",
    commands: [1, 2, 3, 3, 3, 3, 2, 3, 3, 3, 3],
    data: [
      100, -5, 0, -5, -2.05, -5, -3.55, -3.55, -5, -2.05, -5, 0, -5, 2.05, -3.55, 3.5, -2.05, 5, 0,
      5, 100, 5, 102.05, 5, 103.5, 3.5, 105, 2.05, 105, 0, 105, -2.05, 103.5, -3.55, 102.05, -5,
      100, -5,
    ],
  });

  // A hairline is a sliver a twip across.
  const h = new Drawing();
  h.lineStyle(line(0));
  h.moveTo(10, 10);
  h.lineTo(13, 50);
  assert.deepEqual(read(h)[1], {
    type: "path",
    winding: "nonZero",
    commands: [1, 2, 2, 2, 2],
    data: [13.05, 50, 10.05, 10, 10, 10, 13, 50, 13.05, 50],
  });
});
