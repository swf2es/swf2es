// A filtered layer's chain as passes planned ahead of the GPU
// (render/filter-plan.ts): which programs, through which slots, with what.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BOX_PASS,
  FilterPlan,
  GLOW_PASS,
  INPUT_BLUR,
  MATRIX_PASS,
  NO_BLUR,
  planChain,
  READ_BACK_PASS,
  SHRINK_PASS,
} from "../../../packages/render/dist/filter-plan.js";
import * as filterShaders from "../../../packages/render/dist/filter-shaders.js";
import {
  BLUR,
  COLOR_MATRIX,
  DISPLACEMENT,
  Filters,
  GLOW,
} from "../../../packages/render/dist/filters.js";

/** The plan's passes as [program, input, output, blurred] each. */
function passes(plan: FilterPlan): number[][] {
  return plan.passes.slice(0, plan.count).map((p) => [p.program, p.input, p.output, p.blurred]);
}

/** A plan of the one chain of `add`'s filters, over a layer of 40 by 30 at a texel a unit. */
function planned(add: (filters: Filters) => void, hasTexture = (_: number) => true): FilterPlan {
  const filters = new Filters();
  add(filters);
  const chain = filters.close();
  const plan = new FilterPlan();
  planChain(plan, filters, chain, 40, 30, 1, hasTexture);
  return plan;
}

test("a blur of quality 2 both ways is four runs in turn, through two slots between", () => {
  const plan = planned((f) => f.add(BLUR, [4, 4, 2, 1]));
  assert.deepEqual(passes(plan), [
    [BOX_PASS, 0, 2, NO_BLUR],
    [BOX_PASS, 2, 3, NO_BLUR],
    [BOX_PASS, 3, 2, NO_BLUR],
    [BOX_PASS, 2, 1, NO_BLUR],
  ]);
  assert.equal(plan.result, 1);
  // Across, then down, each run as wide as the blur.
  const direction = (k: number) => {
    const at = plan.uniformAt[plan.passes[k].first];
    return [plan.values[at], plan.values[at + 1]];
  };
  assert.deepEqual([0, 1, 2, 3].map(direction), [
    [1, 0],
    [0, 1],
    [1, 0],
    [0, 1],
  ]);
});

test("a blur that changes nothing plans nothing, and the layer is its own output", () => {
  const plan = planned((f) => f.add(BLUR, [1, 1, 1, 1]));
  assert.equal(plan.count, 0);
  assert.equal(plan.result, 0);
});

test("a wide glow blurs its input coarser and reads it back in its pass, its colour a uniform", () => {
  const plan = planned((f) => f.add(GLOW, [64, 64, 1, 3, 1, 0.5, 0, 1, 1, 0, 0, 0, 0, 0]));
  const list = passes(plan);
  assert.equal(list[0][0], SHRINK_PASS);
  assert.deepEqual(list.at(-1), [GLOW_PASS, 0, plan.result, list.at(-2)?.[2]]);
  const glow = plan.passes[plan.count - 1];
  assert.ok(glow.across > 1 && glow.down > 1);
  const names = plan.uniformName.slice(glow.first, glow.end);
  assert.deepEqual(names, [
    "uColor",
    "uAlpha",
    "uStrength",
    "uOffset",
    "uInner",
    "uKnockout",
    "uHide",
  ]);
  // Shrunk into a slot of the coarser frame.
  assert.equal(plan.slotWidth[list[0][2]], Math.ceil(40 / glow.across));
});

test("a glow that blurs nothing reads its input as its blur", () => {
  const plan = planned((f) => f.add(GLOW, [0, 0, 1, 1, 1, 0, 0, 1, 1, 0, 0, 0, 0, 0]));
  assert.deepEqual(passes(plan), [[GLOW_PASS, 0, 1, INPUT_BLUR]]);
});

test("filters in a chain read each other's output, and one whose texture is gone is passed over", () => {
  const matrix = Array.from({ length: 20 }, (_, i) => (i % 5 === 0 ? 1 : 0));
  const plan = planned(
    (f) => {
      f.add(COLOR_MATRIX, matrix);
      f.add(DISPLACEMENT, new Array(22).fill(0), 7);
      f.add(BLUR, [4, 1, 1, 1]);
    },
    () => false,
  );
  assert.deepEqual(passes(plan), [
    [MATRIX_PASS, 0, 1, NO_BLUR],
    [BOX_PASS, 1, 2, NO_BLUR],
  ]);
  assert.equal(plan.result, 2);
});

test("a blur close enough coarser is drawn back between its texels", () => {
  const plan = planned((f) => f.add(BLUR, [64, 64, 1, 3]));
  const last = plan.passes[plan.count - 1];
  assert.equal(last.program, READ_BACK_PASS);
  assert.equal(last.input, 0);
  assert.ok(last.blurred > 0);
});

test("every filter shader reads its input and its blur as the runner can keep them to a rectangle", () => {
  for (const [name, source] of Object.entries(filterShaders)) {
    if (typeof source !== "string") {
      continue;
    }

    const reads = source.replaceAll("texture(uTexture,", "").replaceAll("texture(uBlurred,", "");
    assert.doesNotMatch(reads, /\b(texture\w*|texelFetch\w*)\s*\(\s*u(Texture|Blurred)\b/, name);
  }
});
