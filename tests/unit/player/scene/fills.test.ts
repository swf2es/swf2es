// A shape layer's fills resolved for drawing (scene/fills.ts): tessellated
// natively, a layer at a call, and left out where the tessellator refuses
// one.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Tessellator } from "@swf2es/native/render";
import type { Path, ShapeLayer } from "../../../../packages/player/dist/display/shapes.js";
import { resolveFills } from "../../../../packages/player/dist/scene/fills.js";

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
