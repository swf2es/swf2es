// The Graphics recorder on its own: what a drawing's layers hold, and the
// edges Flash has around them.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Drawing } from "../../../packages/player/dist/drawing.js";

const red = { type: "solid" as const, color: 0xffff0000 };

test("a fill's contours close, a drawPath's winding is the fill's, and copying from itself empties the drawing, as in Flash", () => {
  const d = new Drawing();
  d.beginFill(red);
  d.drawRect(0, 0, 10, 10);
  d.endFill();
  assert.equal(d.layers.length, 1);
  assert.equal(d.layers[0].fills[0].winding, "evenOdd");
  assert.deepEqual(d.bounds(), { xMin: 0, yMin: 0, xMax: 10, yMax: 10 });

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
  assert.deepEqual(copy.bounds(), { xMin: 0, yMin: 0, xMax: 40, yMax: 20 });

  // Copied from itself: cleared first, so nothing is left to copy, as Flash has it.
  d.copyFrom(d);
  assert.equal(d.layers.length, 0);
});
