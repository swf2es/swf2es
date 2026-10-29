import assert from "node:assert/strict";
import { test } from "node:test";
import { makeRoom, moveLast, same } from "../../../../packages/player/dist/display/value-lists.js";

test("numbers are the same as keys as their strings were: NaN as NaN, 0 as -0", () => {
  assert.ok(same(1.5, 1.5));
  assert.ok(same(Number.NaN, Number.NaN));
  assert.ok(same(0, -0));
  assert.ok(!same(1, Number.NaN));
});

test("an entry used moves last, and room is made by the gone, then the least lately used", () => {
  const list = [1, 2, 3, 4];
  assert.equal(moveLast(list, 1), 2);
  assert.deepEqual(list, [1, 3, 4, 2]);
  const dropped: number[] = [];
  makeRoom(
    list,
    4,
    (n) => n === 3,
    (n) => dropped.push(n),
  );
  assert.deepEqual(list, [1, 4, 2]);
  assert.deepEqual(dropped, [3]);
  makeRoom(
    list,
    2,
    () => false,
    (n) => dropped.push(n),
  );
  // Room for one more under two: the least lately used two go.
  assert.deepEqual(list, [2]);
  assert.deepEqual(dropped, [3, 1, 4]);
  makeRoom(
    list,
    4,
    () => true,
    (n) => dropped.push(n),
  );
  // Under its most, nothing is looked at.
  assert.deepEqual(list, [2]);
});
