import assert from "node:assert/strict";
import { test } from "node:test";

const { addParts, layerParts, thickEnough, THICK_TEXELS } = await import(
  "../../../../packages/player/dist/render/detail.js"
);

const MOVE = 1;
const LINE = 2;

function rect(x: number, y: number, w: number, h: number): number[] {
  return [MOVE, x, y, LINE, x + w, y, LINE, x + w, y + h, LINE, x, y + h, LINE, x, y];
}

// The few fields of a shape's layers that the parts read.
function layers(contours: number[][], lines: { width: number; paths: number[][] }[] = []): never {
  return [
    {
      fills: [{ fill: { type: "solid", color: 0 }, contours, winding: "evenOdd" }],
      strokes: lines.map(({ width, paths }) => ({
        line: { width, noHScale: false, noVScale: false },
        paths,
      })),
    },
  ] as never;
}

test("a fill's parts are its area and outline, holes taken out", () => {
  assert.deepEqual(layerParts(layers([rect(0, 0, 40, 20)])), [0, 800, 120]);
  // A 2 px ring: a square with a square hole.
  const [kind, area, outline] = layerParts(layers([rect(0, 0, 20, 20), rect(2, 2, 16, 16)]));
  assert.equal(kind, 0);
  assert.equal(area, 400 - 256);
  assert.equal(outline, 80 + 64);
});

test("parts on the stage are thick by twice their area over their outline", () => {
  const out: number[] = [];
  addParts(out, layers([rect(0, 0, 40, 20)]), [2, 0, 0, 2], 1 / 3);
  assert.deepEqual(out, [(2 * 800 * 4) / (120 * Math.hypot(2, 0, 0, 2)), 120 * Math.hypot(2, 2)]);

  const lines: number[] = [];
  addParts(lines, layers([], [{ width: 0, paths: [rect(0, 0, 10, 10)] }]), [1, 0, 0, 1], 0.5);
  // A hairline is a screen pixel wide, `least` stage pixels; its outline both its sides.
  assert.deepEqual(lines, [0.5, 80 * Math.hypot(1, 1)]);
});

test("bitmap fills and drawTriangles count as thin past any budget", () => {
  const out: number[] = [];
  const bitmap = [
    { fills: [{ fill: { type: "bitmap" }, contours: [rect(0, 0, 50, 50)] }], strokes: [] },
  ] as never;
  addParts(out, bitmap, [1, 0, 0, 1], 1);
  assert.deepEqual(out, [0, Number.POSITIVE_INFINITY]);
  assert.equal(thickEnough(out, 0.5, 64, 1, 2), false);
});

test("thick enough: wide parts pass, thin repeated ones spend the budget", () => {
  const texel = 1 / 3;
  // A disc-like part far wider than a texel.
  assert.equal(thickEnough([30, 200], texel, 20, 1, 2), true);
  assert.equal(thickEnough([THICK_TEXELS * texel - 0.01, 1], texel, 20, 1, 2), true);
  // A hundred half-pixel stripes 120 long.
  assert.equal(thickEnough([0.5, 100 * 241], texel, 64, 1, 2), false);
  // The same thinness, a small detail: its outline moves little of a wide blur's box.
  assert.equal(thickEnough([0.5, 6], texel, 20, 1, 2), true);
  assert.equal(thickEnough([0.5, 6], texel, 20, 50, 2), false);
});
