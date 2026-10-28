import assert from "node:assert/strict";
import { test } from "node:test";
import { filterDefaults, paddingCap } from "../../../../packages/player/dist/display/filters.js";
import { planFilters } from "../../../../packages/player/dist/scene/filters.js";
import { BLUR, CONVOLUTION, GLOW } from "../../../../packages/render/dist/index.js";

test("filters pad by their reach at the units a stage pixel, each inset by those after it", () => {
  const blur = { ...filterDefaults("blur"), blurX: 8, blurY: 4, quality: 2 };
  const shadow = { ...filterDefaults("dropShadow"), distance: 10 };
  const convolution = { ...filterDefaults("convolution"), matrixX: 5, matrixY: 3 };
  const plan = planFilters([blur, shadow, convolution], 2);
  assert.ok(plan);
  // The blur reaches 8 stage pixels, the shadow 2 of blur plus 10 away, the convolution its taps
  // and a pixel, whatever the units.
  assert.deepEqual(plan.wanted, [16, 24, 3]);
  assert.equal(plan.padding, 43);
  assert.deepEqual(
    plan.passes.map((p) => p.kind),
    [BLUR, GLOW, CONVOLUTION],
  );
  // How far in the object's pixels start for the convolution: its padding alone.
  assert.equal(plan.passes[2].values[11], 3);
});

test("a padding past the room is cut alike from the furthest reaching", () => {
  assert.equal(paddingCap([10, 20], 30), Number.POSITIVE_INFINITY);
  assert.equal(paddingCap([10, 1000], 30), 20);
  assert.equal(paddingCap([1000, 1000, 2], 30), 14);
  assert.equal(paddingCap([5, 5], -4), 0);
  const far = { ...filterDefaults("dropShadow"), distance: 1e9 };
  const plan = planFilters([far], 1, 100);
  assert.ok(plan);
  assert.equal(plan.padding, 100);
});

test("a gradient filter planned again keeps its texture where its colours are the same", () => {
  const glow = filterDefaults("gradientGlow");
  const first = planFilters([glow], 1);
  assert.ok(first);
  const texture = { id: 3, generation: 1 };
  first.passes[0].texture = texture;
  const blurred = planFilters([{ ...glow, blurX: 20 }], 1, Number.POSITIVE_INFINITY, first);
  assert.equal(blurred?.passes[0].texture, texture);
  const recoloured = planFilters(
    [{ ...glow, colors: [0xff0000, 0x00ff00] }],
    1,
    Number.POSITIVE_INFINITY,
    first,
  );
  assert.equal(recoloured?.passes[0].texture, null);
});

test("a displacement map with no map leaves the object be", () => {
  assert.equal(planFilters([filterDefaults("displacementMap")], 1), null);
});
