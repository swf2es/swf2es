// A shape layer's fills resolved for drawing (scene/fills.ts): tessellated
// natively, a layer at a call, and left out where the tessellator refuses
// one; and whether fills that share a part overlap (fillsApart).
import assert from "node:assert/strict";
import { test } from "node:test";
import { Tessellator } from "@swf2es/native/render";
import type { Path, ShapeLayer } from "../../../../packages/player/dist/display/shapes.js";
import {
  fillsApart,
  partArea,
  resolveFills,
} from "../../../../packages/player/dist/scene/fills.js";
import { layerParts } from "../../../../packages/player/dist/scene/shapes.js";

const layer: ShapeLayer = {
  fills: [
    {
      fill: { type: "solid", color: 0xffff0000 },
      contours: [[1, 0, 0, 2, 10, 0, 2, 10, 10, 2, 0, 10, 2, 0, 0]],
      winding: "evenOdd",
    },
  ],
  strokes: [],
};

const tess = new Tessellator();

test("a mask's fills are tessellated non-zero, though drawPath asked for even-odd", () => {
  const rules: boolean[] = [];
  for (const masking of [false, true]) {
    resolveFills(layer, masking, {
      layer: (fills, nonZero) => {
        rules.push(...nonZero);
        return tess.tessellate.layer(fills, nonZero);
      },
      lines: tess.tessellate.lines,
    });
  }

  assert.deepEqual(rules, [false, true]);
});

test("a layer's fills tessellated together share their positions and indices, each as alone", () => {
  const doubled = structuredClone(layer);
  doubled.fills.push(structuredClone(doubled.fills[0]));
  let layers = 0;
  const resolved = resolveFills(doubled, false, {
    layer: (fills, nonZero) => {
      layers++;
      return tess.tessellate.layer(fills, nonZero);
    },
    lines: tess.tessellate.lines,
  });
  assert.equal(layers, 1);
  const [first, second] = resolved;
  assert.ok(first && second);
  assert.equal(first.vertices.buffer, second.vertices.buffer);
  assert.equal(second.vertices.byteOffset, first.vertices.byteOffset + first.vertices.byteLength);
  assert.equal(first.indices.buffer, second.indices.buffer);
  assert.equal(second.indexOffset, first.vertices.length / 2);

  // Each fill as a layer of its own makes it.
  for (let i = 0; i < 2; i++) {
    const together = resolved[i];
    const own = tess.tessellate.layer([doubled.fills[i].contours], [false])?.[0];
    assert.ok(own && together);
    assert.deepEqual(Array.from(together.vertices), Array.from(own.vertices));
    assert.deepEqual(
      Array.from(together.indices, (index) => index - (together.indexOffset ?? 0)),
      Array.from(own.indices, (index) => index - (own.indexOffset ?? 0)),
    );
  }
});

test("a layer call takes the fills' path commands, and a fill it refuses is left out", () => {
  const curved: ShapeLayer = {
    fills: [
      layer.fills[0],
      {
        fill: { type: "solid", color: 0xff00ff00 },
        contours: [[1, 0, 0, 3, 5, 10, 10, 0, 2, 0, 0]],
        winding: "nonZero",
      },
    ],
    strokes: [],
  };
  let given: readonly (readonly Path[])[] = [];
  const resolved = resolveFills(curved, false, {
    layer: (fills, nonZero) => {
      given = fills;
      const out = tess.tessellate.layer(fills, nonZero);
      return out && [out[0], null];
    },
    lines: tess.tessellate.lines,
  });
  // The contours as the shape holds them, curves and all: no points are built for the call.
  assert.equal(given[0], curved.fills[0].contours);
  assert.equal(given[1], curved.fills[1].contours);
  assert.ok(resolved[0]);
  assert.equal(resolved[1], null);
});

test("a layer the tessellator refuses whole has none of its fills", () => {
  const resolved = resolveFills(layer, false, { layer: () => null, lines: tess.tessellate.lines });
  assert.deepEqual(resolved, [null]);
});

/** A solid fill of `contours`, flat path commands, filled by parity unless `winding` says. */
function solid(contours: Path[], winding: "evenOdd" | "nonZero" = "evenOdd") {
  return { fill: { type: "solid" as const, color: 0xff336699 }, contours, winding };
}

const square = (x: number, y: number, size: number): Path => [
  1,
  x,
  y,
  2,
  x + size,
  y,
  2,
  x + size,
  y + size,
  2,
  x,
  y + size,
  2,
  x,
  y,
];

/** A circle in four curves, its control points on the square around it. */
const circle = (cx: number, cy: number, r: number): Path => [
  1,
  cx + r,
  cy,
  3,
  cx + r,
  cy + r,
  cx,
  cy + r,
  3,
  cx - r,
  cy + r,
  cx - r,
  cy,
  3,
  cx - r,
  cy - r,
  cx,
  cy - r,
  3,
  cx + r,
  cy - r,
  cx + r,
  cy,
];

/** Whether `layer`'s one part of several fills is found to hold them apart. */
function apart(layer: ShapeLayer): boolean {
  const parts = layerParts(layer, tess.tessellate);
  assert.equal(parts.length, 1);
  const [{ geometry, fillsFrom, fillsTo }] = parts;
  assert.equal(geometry.flat, false);
  assert.deepEqual([fillsFrom, fillsTo], [0, layer.fills.length]);
  return fillsApart(
    layer,
    0,
    layer.fills.length,
    partArea(geometry.positions, geometry.indices),
    tess.tessellate,
  );
}

test("a part of one fill is flat, and one of several only once they are found apart", () => {
  const parts = layerParts(layer, tess.tessellate);
  assert.equal(parts[0].geometry.flat, true);
  assert.equal(parts[0].fillsTo, undefined);
});

test("a part of fills with one left out between them is not looked into", () => {
  // A fill of nothing between two that meet adds no vertex, but its contours would count.
  const gapped: ShapeLayer = {
    fills: [solid([square(0, 0, 10)]), solid([]), solid([square(10, 0, 10)])],
    strokes: [],
  };
  const [part] = layerParts(gapped, tess.tessellate);
  assert.equal(part.geometry.flat, false);
  assert.equal(part.fillsTo, undefined);
});

test("fills that meet edge to edge, along lines or curves, are apart", () => {
  const side: ShapeLayer = {
    fills: [solid([square(0, 0, 10)]), solid([square(10, 0, 10)])],
    strokes: [],
  };
  assert.equal(apart(side), true);
  // A disc in a square with the disc's hole, the hole's edge both fills'.
  const disc: ShapeLayer = {
    fills: [solid([square(0, 0, 40), circle(20, 20, 12)]), solid([circle(20, 20, 12)])],
    strokes: [],
  };
  assert.equal(apart(disc), true);
});

test("fills that meet far from the origin, or large, are apart", () => {
  for (const at of [1e5, 1e6]) {
    const far: ShapeLayer = {
      fills: [solid([square(at, at, 10)]), solid([square(at + 10, at, 10)])],
      strokes: [],
    };
    assert.equal(apart(far), true, `at ${at}`);
  }

  const large: ShapeLayer = {
    fills: [
      solid([square(-8000, -8000, 16000), circle(1000, 1000, 5000)]),
      solid([circle(1000, 1000, 5000)]),
    ],
    strokes: [],
  };
  assert.equal(apart(large), true);
});

test("fills that overlap, or filled non-zero, are not apart", () => {
  const over: ShapeLayer = {
    fills: [solid([square(0, 0, 10)]), solid([square(5, 5, 10)])],
    strokes: [],
  };
  assert.equal(apart(over), false);
  // A small square over a large one, which a share of the whole area would let pass.
  for (const [size, over] of [
    [4000, 8.6],
    [16000, 32],
  ]) {
    const large: ShapeLayer = {
      fills: [solid([square(0, 0, size)]), solid([square(size - over, 0, over * 2)])],
      strokes: [],
    };
    assert.equal(apart(large), false, `${over} over ${size}`);
  }

  // A sliver of a tenth of a pixel over the other, along an edge of 100.
  const sliver: ShapeLayer = {
    fills: [
      solid([square(0, 0, 100)]),
      solid([[1, 99.9, 0, 2, 200, 0, 2, 200, 100, 2, 99.9, 100, 2, 99.9, 0]]),
    ],
    strokes: [],
  };
  assert.equal(apart(sliver), false);
  const wound: ShapeLayer = {
    fills: [solid([square(0, 0, 10)]), solid([square(10, 0, 10)], "nonZero")],
    strokes: [],
  };
  assert.equal(apart(wound), false);
});
