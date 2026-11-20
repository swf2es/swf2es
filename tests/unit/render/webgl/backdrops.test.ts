import assert from "node:assert/strict";
import { test } from "node:test";
import {
  Backdrops,
  SHARED_MOST,
  SPREAD,
} from "../../../../packages/render/dist/webgl/backdrops.js";

const boxes = (b: Backdrops): number[][] =>
  Array.from({ length: b.boxCount }, (_, k) => b.boxes.slice(k * 4, k * 4 + 4));

test("blends whose rectangles meet nothing drawn since the copy share it, in one box", () => {
  const b = new Backdrops();
  b.begin(true);
  assert.ok(b.offer(0, 0, 0, 10, 10, true));
  assert.ok(b.offer(3, 12, 0, 10, 10, true));
  // Touching the one before along an edge is not meeting it: each draws inside its rectangle.
  assert.ok(b.offer(6, 22, 0, 10, 10, true));
  assert.deepEqual(boxes(b), [[0, 0, 32, 10]]);
  assert.equal(b.boxFor(0), 0);
  assert.equal(b.boxFor(6), 0);
  assert.equal(b.boxFor(9), -1);
});

test("a blend that meets one drawn since the copy ends those that share it", () => {
  const b = new Backdrops();
  b.begin(true);
  assert.ok(b.offer(0, 0, 0, 10, 10, true));
  assert.ok(b.offer(3, 20, 0, 10, 10, true));
  // It meets the first, not the one just before it.
  assert.equal(b.offer(6, 5, 5, 10, 10, true), false);
  assert.equal(b.boxFor(6), -1);
});

test("a blend that does not read what is below still counts as drawn", () => {
  const b = new Backdrops();
  b.begin(true);
  assert.ok(b.offer(0, 0, 0, 10, 10, true));
  // An add over an opaque stage, by GL's blending: no copy, but it draws.
  assert.ok(b.offer(3, 20, 0, 10, 10, false));
  assert.equal(b.boxFor(3), -1);
  assert.equal(b.offer(6, 25, 5, 10, 10, true), false);
  // One that does not read may meet what was drawn: it reads nothing.
  b.begin(true);
  assert.ok(b.offer(0, 0, 0, 10, 10, true));
  assert.ok(b.offer(3, 5, 5, 10, 10, false));
  assert.equal(b.boxCount, 1);
});

test("rectangles far apart are copied in boxes of their own, or not shared without spread", () => {
  const b = new Backdrops();
  b.begin(true);
  assert.ok(b.offer(0, 0, 0, 10, 10, true));
  assert.ok(b.offer(3, 100, 100, 10, 10, true));
  assert.ok(b.offer(6, 12, 0, 10, 10, true));
  assert.deepEqual(boxes(b), [
    [0, 0, 22, 10],
    [100, 100, 10, 10],
  ]);
  assert.equal(b.boxFor(3), 1);
  assert.equal(b.boxFor(6), 0);

  b.begin(false);
  assert.ok(b.offer(0, 0, 0, 10, 10, true));
  assert.equal(b.offer(3, 100, 100, 10, 10, true), false);
  assert.deepEqual(boxes(b), [[0, 0, 10, 10]]);
});

test("a box grows while it is at most SPREAD times the area of what it holds", () => {
  const b = new Backdrops();
  b.begin(false);
  assert.ok(b.offer(0, 0, 0, 10, 10, true));
  // A gap as wide as both: the box is twice their area.
  const gap = (SPREAD - 1) * 20;
  assert.ok(b.offer(3, 10 + gap, 0, 10, 10, true));
  assert.equal(b.offer(6, 200, 0, 10, 10, true), false);
});

test("no more than SHARED_MOST blends share a copy", () => {
  const b = new Backdrops();
  b.begin(true);
  for (let k = 0; k < SHARED_MOST; k++) {
    assert.ok(b.offer(k * 3, k * 10, 0, 10, 10, true));
  }

  assert.equal(b.offer(SHARED_MOST * 3, SHARED_MOST * 10, 0, 10, 10, true), false);
});

test("beginning anew forgets the blends and the copy", () => {
  const b = new Backdrops();
  b.begin(true);
  b.offer(0, 0, 0, 10, 10, true);
  b.copy = 4;
  b.begin(true);
  assert.equal(b.boxFor(0), -1);
  assert.equal(b.boxCount, 0);
  assert.equal(b.copy, -1);
});
