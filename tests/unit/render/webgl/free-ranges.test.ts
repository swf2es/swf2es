import assert from "node:assert/strict";
import { test } from "node:test";
import { FreeRanges } from "../../../../packages/render/dist/webgl/free-ranges.js";

const holes = (ranges: FreeRanges): [number, number][] =>
  ranges.starts.map((start, k) => [start, ranges.lengths[k]]);

test("ranges are taken from the top while it has room", () => {
  const ranges = new FreeRanges();
  ranges.reset(100);
  assert.equal(ranges.take(30), 0);
  assert.equal(ranges.take(30), 30);
  ranges.give(0, 30);
  // A hole below, and room at the top: the top first, so that a frame's adds lie in a row.
  assert.equal(ranges.take(20), 60);
  assert.equal(ranges.top, 80);
  assert.deepEqual(holes(ranges), [[0, 30]]);
  assert.equal(ranges.room(), 50);
});

test("past the top, the first hole that holds a range gives it its start", () => {
  const ranges = new FreeRanges();
  ranges.reset(100);
  for (let i = 0; i < 10; i++) {
    assert.equal(ranges.take(10), i * 10);
  }

  ranges.give(10, 10);
  ranges.give(40, 10);
  ranges.give(50, 10);
  assert.deepEqual(holes(ranges), [
    [10, 10],
    [40, 20],
  ]);
  // Too large for the first hole: the second, from its start.
  assert.equal(ranges.take(15), 40);
  assert.deepEqual(holes(ranges), [
    [10, 10],
    [55, 5],
  ]);
  // An exact fit takes the hole whole.
  assert.equal(ranges.take(10), 10);
  assert.deepEqual(holes(ranges), [[55, 5]]);
  assert.equal(ranges.free, 5);
});

test("a range given back merges with the holes on either side", () => {
  const ranges = new FreeRanges();
  ranges.reset(100);
  for (let i = 0; i < 10; i++) {
    ranges.take(10);
  }

  ranges.give(20, 10);
  ranges.give(40, 10);
  assert.deepEqual(holes(ranges), [
    [20, 10],
    [40, 10],
  ]);
  ranges.give(30, 10);
  assert.deepEqual(holes(ranges), [[20, 30]]);
  ranges.give(10, 10);
  assert.deepEqual(holes(ranges), [[10, 40]]);
  ranges.give(50, 10);
  assert.deepEqual(holes(ranges), [[10, 50]]);
  ranges.give(80, 10);
  assert.deepEqual(holes(ranges), [
    [10, 50],
    [80, 10],
  ]);
  assert.equal(ranges.free, 60);
  // A hole that fits nowhere else stays apart, sorted.
  ranges.give(0, 10);
  assert.deepEqual(holes(ranges), [
    [0, 60],
    [80, 10],
  ]);
});

test("a range given back at the top lowers it, with the hole just below", () => {
  const ranges = new FreeRanges();
  ranges.reset(100);
  for (let i = 0; i < 5; i++) {
    ranges.take(10);
  }

  ranges.give(20, 10);
  ranges.give(40, 10);
  assert.equal(ranges.top, 40);
  assert.deepEqual(holes(ranges), [[20, 10]]);
  ranges.give(30, 10);
  assert.equal(ranges.top, 20);
  assert.deepEqual(holes(ranges), []);
  assert.equal(ranges.free, 0);
  assert.equal(ranges.take(10), 20);
});

test("a range no hole holds, nor the top, is refused for the atlas to grow", () => {
  const ranges = new FreeRanges();
  ranges.reset(100);
  for (let i = 0; i < 10; i++) {
    ranges.take(10);
  }

  ranges.give(10, 10);
  ranges.give(30, 10);
  ranges.give(50, 10);
  // Room for 30 in all, but in pieces of 10.
  assert.equal(ranges.room(), 30);
  assert.equal(ranges.take(20), -1);
  assert.equal(ranges.take(40), -1);
  assert.equal(ranges.room(), 30);
  assert.equal(ranges.take(10), 10);
  assert.equal(ranges.take(0), 100);
  ranges.reset(200);
  assert.equal(ranges.take(150), 0);
  assert.deepEqual(holes(ranges), []);
});

test("random takes and gives keep the ranges disjoint and the holes sorted and merged", () => {
  let seed = 7;
  const next = (n: number): number => {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    return seed % n;
  };

  const capacity = 1000;
  const ranges = new FreeRanges();
  ranges.reset(capacity);
  const taken: [number, number][] = [];
  for (let step = 0; step < 20000; step++) {
    if (taken.length > 0 && next(2) === 0) {
      const [start, length] = taken.splice(next(taken.length), 1)[0];
      ranges.give(start, length);
    } else {
      const length = 1 + next(40);
      const at = ranges.take(length);
      if (at >= 0) {
        taken.push([at, length]);
      } else {
        // Refused only where no hole and not the top holds it.
        assert.ok(ranges.top + length > capacity);
        assert.ok(ranges.lengths.every((l) => l < length));
      }
    }

    const used = new Uint8Array(capacity);
    for (const [start, length] of taken) {
      assert.ok(start + length <= ranges.top);
      for (let i = start; i < start + length; i++) {
        assert.equal(used[i], 0);
        used[i] = 1;
      }
    }

    let free = 0;
    for (let k = 0; k < ranges.starts.length; k++) {
      const start = ranges.starts[k];
      const end = start + ranges.lengths[k];
      assert.ok(ranges.lengths[k] > 0);
      if (k > 0) {
        // Sorted, and never touching the one before, which would have merged.
        assert.ok(start > ranges.starts[k - 1] + ranges.lengths[k - 1]);
      }

      assert.ok(end < ranges.top);
      for (let i = start; i < end; i++) {
        assert.equal(used[i], 0);
        used[i] = 2;
      }

      free += ranges.lengths[k];
    }

    assert.equal(ranges.free, free);
    // Below the top, every unit is taken or in a hole.
    for (let i = 0; i < ranges.top; i++) {
      assert.notEqual(used[i], 0);
    }
  }
});
