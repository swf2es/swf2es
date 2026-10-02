// Colour transforms composed as Flash composes them: the child's first, then the parent's.
import assert from "node:assert/strict";
import { test } from "node:test";
import { concatColor, multipliesOnly } from "../../../packages/player/dist/color.js";

const ct = (mul: number[], add: number[]) => ({
  rMul: mul[0],
  gMul: mul[1],
  bMul: mul[2],
  aMul: mul[3],
  rAdd: add[0],
  gAdd: add[1],
  bAdd: add[2],
  aAdd: add[3],
});

test("a child's colour transform applies first, then its parent's", () => {
  // adl: a child halving 0x408020 under a parent adding 100 red draws 132, 64, 16.
  const parent = ct([1, 1, 1, 1], [100, 0, 0, 0]);
  const child = ct([0.5, 0.5, 0.5, 1], [0, 0, 0, 0]);
  const both = concatColor(parent, child);
  const apply = (c: number, mul: number, add: number) => Math.min(255, c * mul + add);
  assert.deepEqual(
    [0x40, 0x80, 0x20].map((c, i) =>
      apply(c, [both.rMul, both.gMul, both.bMul][i], [both.rAdd, both.gAdd, both.bAdd][i]),
    ),
    [132, 64, 16],
  );

  // The parent's multipliers scale the child's offsets.
  const scaled = concatColor(
    ct([0.5, 2, 1, 0.5], [1, 2, 3, 4]),
    ct([1, 1, 1, 1], [10, 10, 10, 10]),
  );
  assert.deepEqual([scaled.rAdd, scaled.gAdd, scaled.bAdd, scaled.aAdd], [6, 22, 13, 9]);
});

test("only a transform that multiplies by 0 to 1 is left to Pixi's tint", () => {
  assert.equal(multipliesOnly(ct([0.5, 1, 0, 0.25], [0, 0, 0, 0])), true);
  assert.equal(multipliesOnly(ct([1, 1, 1, 1], [0, 1, 0, 0])), false);
  assert.equal(multipliesOnly(ct([2, 1, 1, 1], [0, 0, 0, 0])), false);
  assert.equal(multipliesOnly(ct([1, -1, 1, 1], [0, 0, 0, 0])), false);
});
