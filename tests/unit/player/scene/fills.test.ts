// A shape layer's fills resolved for drawing (scene/fills.ts): tessellated
// natively, a layer at a call where the tessellator takes layers, else a
// call a fill, and left to JS where it fails or gives what cannot be drawn.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Tessellator } from "@swf2es/native/tessellate";
import type { ShapeLayer } from "../../../../packages/player/dist/display/shapes.js";
import { resolveFills } from "../../../../packages/player/dist/scene/fills.js";

const geometry = {
  vertices: new Float64Array([0, 0, 10, 0, 10, 10, 0, 10]),
  indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
};
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

test("a fill the tessellator refuses, fails or gives bad indices for is left to JS, after one call", () => {
  for (const reject of [
    () => null,
    () => {
      throw new Error("rejected");
    },
    () => ({ ...geometry, indices: new Uint32Array([0, 1, 999]) }),
  ]) {
    let calls = 0;
    const [resolved] = resolveFills(layer, false, () => {
      calls++;
      return reject();
    });
    assert.equal(calls, 1);
    assert.equal(resolved.geometry, null);
    assert.equal(resolved.roots.length, 1);
  }
});

test("a mask's fills are tessellated non-zero, though drawPath asked for even-odd", () => {
  const rules: boolean[] = [];
  resolveFills(layer, false, (_, nonZero) => {
    rules.push(nonZero);
    return geometry;
  });
  resolveFills(layer, true, (_, nonZero) => {
    rules.push(nonZero);
    return geometry;
  });
  assert.deepEqual(rules, [false, true]);
});

test("a layer's fills tessellated together share their positions and indices, each as alone", () => {
  const doubled = structuredClone(layer);
  doubled.fills.push(structuredClone(doubled.fills[0]));
  const tess = new Tessellator();
  let layers = 0;
  const resolved = resolveFills(
    doubled,
    false,
    Object.assign(tess.tessellate.bind(null), {
      layer: (fills: number[][][], nonZero: boolean[]) => {
        layers++;
        return tess.tessellate.layer(fills, nonZero);
      },
    }),
  );
  assert.equal(layers, 1);
  const first = resolved[0].geometry;
  const second = resolved[1].geometry;
  assert.ok(first && second);
  assert.equal(first.vertices.buffer, second.vertices.buffer);
  assert.equal(second.vertices.byteOffset, first.vertices.byteOffset + first.vertices.byteLength);
  assert.equal(first.indices.buffer, second.indices.buffer);
  assert.equal(second.indexOffset, first.vertices.length / 2);
  assert.deepEqual(
    Array.from(first.indices),
    Array.from(second.indices, (index) => index - first.vertices.length / 2),
  );

  // Each fill as a call of its own makes it.
  const alone = resolveFills(doubled, false, (contours, nonZero) =>
    tess.tessellate(contours, nonZero),
  );
  for (let i = 0; i < 2; i++) {
    const own = alone[i].geometry;
    const together = resolved[i].geometry;
    assert.ok(own && together);
    assert.deepEqual(Array.from(together.vertices), Array.from(own.vertices));
    assert.deepEqual(
      Array.from(together.indices, (index) => index - (together.indexOffset ?? 0)),
      Array.from(own.indices),
    );
  }

  tess.dispose();
});

test("a layer call takes the fills' path commands, and a fill it leaves goes to JS", () => {
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
  const tess = new Tessellator();
  let given: readonly (readonly number[][])[] = [];
  const resolved = resolveFills(
    curved,
    false,
    Object.assign(() => assert.fail("no fill alone"), {
      layer: (fills: readonly (readonly number[][])[], nonZero: readonly boolean[]) => {
        given = fills;
        const out = tess.tessellate.layer(fills, nonZero);
        return out && [out[0], null];
      },
    }),
  );
  // The contours as the shape holds them, curves and all: no points are built for the call.
  assert.equal(given[0], curved.fills[0].contours);
  assert.equal(given[1], curved.fills[1].contours);
  assert.ok(resolved[0].geometry);
  assert.equal(resolved[1].geometry, null);
  assert.equal(resolved[1].roots.length, 1);
  // The curve's 16 chords, flattened in JS.
  assert.equal(resolved[1].roots[0].points.length, 17 * 2);
  tess.dispose();
});

test("of a layer's fills tessellated a call each, one left to JS keeps the other's geometry", () => {
  const doubled = structuredClone(layer);
  doubled.fills.push(structuredClone(doubled.fills[0]));
  let calls = 0;
  const resolved = resolveFills(doubled, false, () => (++calls === 1 ? geometry : null));
  assert.equal(calls, 2);
  assert.equal(resolved[0].geometry, geometry);
  assert.equal(resolved[1].geometry, null);
  assert.equal(resolved[1].roots.length, 1);
});
