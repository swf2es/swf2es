// A shape layer's fills made geometries (scene/shapes.ts): solid fills in
// one part, and fills of one bitmap sampled alike one after another in one
// part too, each sampling through its own matrix.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Tessellator } from "@swf2es/native/render";
import { BitmapStore } from "../../../../packages/player/dist/bitmap/bitmap.js";
import type { ShapeLayer } from "../../../../packages/player/dist/display/shapes.js";
import { layerParts } from "../../../../packages/player/dist/scene/shapes.js";

const tessellate = new Tessellator().tessellate;
const square = (x: number) => [[1, x, 0, 2, x + 10, 0, 2, x + 10, 10, 2, x, 10, 2, x, 0]];
const image = (store: BitmapStore, tx: number, smooth = false) => ({
  type: "image" as const,
  image: store,
  matrix: { a: 1, b: 0, c: 0, d: 1, tx, ty: 0 },
  repeat: false,
  smooth,
});

test("fills of one bitmap sampled alike, one after another, are one part; any other fill between parts them", () => {
  const a = new BitmapStore(8, 8, true, 0xff00ff00);
  const b = new BitmapStore(8, 8, true, 0xff0000ff);
  const layer: ShapeLayer = {
    fills: [
      { fill: image(a, 0), contours: square(0), winding: "evenOdd" },
      { fill: image(a, 20), contours: square(20), winding: "evenOdd" },
      { fill: image(a, 40, true), contours: square(40), winding: "evenOdd" },
      { fill: image(b, 60), contours: square(60), winding: "evenOdd" },
      { fill: image(a, 80), contours: square(80), winding: "evenOdd" },
    ],
    strokes: [],
  };
  const parts = layerParts(layer, tessellate);
  assert.deepEqual(
    parts.map((p) => [
      p.paint?.type === "image" && p.paint.image === a ? "a" : "b",
      p.geometry.indices.length / 3,
    ]),
    [
      ["a", 4],
      ["a", 2],
      ["b", 2],
      ["a", 2],
    ],
  );

  // Each fill samples through its own matrix: the second square's corner at its bitmap's origin.
  const [merged] = parts;
  const { positions, texels } = merged.geometry;
  assert.ok(texels);
  for (let i = 0; i < positions.length; i += 2) {
    const tx = positions[i] >= 20 ? 20 : 0;
    assert.equal(texels[i], positions[i] - tx);
    assert.equal(texels[i + 1], positions[i + 1]);
  }
});
