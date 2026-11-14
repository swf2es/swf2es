// The pixels a rect's numbers cover, as adl rounds and clamps its edges.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BitmapStore } from "../../../../packages/player/dist/bitmap/bitmap.js";
import {
  nearest,
  pixelEdge,
  pixelRect,
  spanRect,
} from "../../../../packages/player/dist/bitmap/pixel-rect.js";

test("a rect's edges round to the nearest pixel, a half to the even one, as adl's do", () => {
  assert.deepEqual(
    [0.5, 1.5, 2.5, -0.5, -1.5, -2.5, 1.49, 1.51, -0.7].map(nearest),
    [0, 2, 2, 0, -2, -2, 1, 2, -1],
  );
  // [x, y, width, height] as given, and the pixels adl's copies and fills cover.
  const cases: [number[], number[]][] = [
    [
      [0.5, 3, 5, 4],
      [0, 3, 6, 4],
    ],
    [
      [1.5, 3, 5, 4],
      [2, 3, 4, 4],
    ],
    [
      [2.5, 3, 5, 4],
      [2, 3, 6, 4],
    ],
    [
      [2.6, 3, 5.6, 4],
      [3, 3, 5, 4],
    ],
    [
      [-0.5, 3, 5, 4],
      [0, 3, 4, 4],
    ],
    [
      [-1.5, 3, 5, 4],
      [-2, 3, 6, 4],
    ],
    [
      [2.5, 1.7, 10.6, 10.2],
      [2, 2, 11, 10],
    ],
    [
      [3.5, 4, 1, 1],
      [4, 4, 0, 1],
    ],
    [
      [5, 5, -3, 4],
      [5, 5, -3, 4],
    ],
  ];
  for (const [[x, y, w, h], [ex, ey, ew, eh]] of cases) {
    assert.deepEqual(
      pixelRect(x, y, w, h),
      { x: ex, y: ey, width: ew, height: eh },
      `${[x, y, w, h]}`,
    );
  }
});

test("an edge clamps to 2^30 - 1 either way, and NaN is int's least, as adl converts them", () => {
  const limit = 2 ** 30 - 1;
  assert.deepEqual(
    [
      NaN,
      Infinity,
      -Infinity,
      1e20,
      -1e20,
      2 ** 31,
      -(2 ** 31),
      limit,
      limit + 0.6,
      -limit - 1,
      -0,
      2.5,
    ].map(pixelEdge),
    [-(2 ** 31), limit, -limit, limit, -limit, limit, -limit, limit, limit, -limit, 0, 2],
  );
  assert.ok(Object.is(pixelEdge(-0), 0));

  // [x, y, width, height] as given, and the pixels they cover: always finite.
  const cases: [number[], number[]][] = [
    [
      [2, 2, Infinity, 3],
      [2, 2, limit - 2, 3],
    ],
    [
      [2, 2, NaN, 3],
      [2, 2, -(2 ** 31) - 2, 3],
    ],
    [
      [NaN, 2, 3, 3],
      [-(2 ** 31), 2, 0, 3],
    ],
    [
      [Infinity, 2, 3, 3],
      [limit, 2, 0, 3],
    ],
    [
      [-Infinity, 2, Infinity, 3],
      [-limit, 2, -(2 ** 31) + limit, 3],
    ],
    [
      [-5e9, 2, 6e9, 3],
      [-limit, 2, 1e9 + limit, 3],
    ],
  ];
  for (const [[x, y, w, h], [ex, ey, ew, eh]] of cases) {
    assert.deepEqual(
      pixelRect(x, y, w, h),
      { x: ex, y: ey, width: ew, height: eh },
      `${[x, y, w, h]}`,
    );
  }

  // Each covers nothing of a store, or the part a reach to its edge would.
  const store = new BitmapStore(8, 8, true, 0);
  assert.deepEqual(store.clip(pixelRect(2, 2, Infinity, 3)), { x: 2, y: 2, width: 6, height: 3 });
  for (const r of [
    [NaN, 2, 3, 3],
    [2, 2, NaN, 3],
    [Infinity, 2, 3, 3],
    [-Infinity, 2, 3, 3],
    [2, 2, -Infinity, 3],
    [-Infinity, 2, Infinity, 3],
  ]) {
    assert.equal(store.clip(pixelRect(r[0], r[1], r[2], r[3])), null, `${r}`);
  }
});

test("a negative size spans back over the numbers, before their edges are made", () => {
  const limit = 2 ** 30 - 1;
  assert.deepEqual(spanRect(5, 2, -3, 3), { x: 2, y: 2, width: 3, height: 3 });
  assert.deepEqual(spanRect(2, 7, 3, -4.6), { x: 2, y: 2, width: 3, height: 5 });
  // From 1e20 back to 0, the clamp reaching past the bitmap.
  assert.deepEqual(spanRect(1e20, 2, -1e20, 3), { x: 0, y: 2, width: limit, height: 3 });
  // 5 - 1e20 + 1e20 is 0 in a double: a rect ending at 0, not reaching to 5.
  assert.deepEqual(spanRect(5, 5, -1e20, -1e20), {
    x: -limit,
    y: -limit,
    width: limit,
    height: limit,
  });
  assert.equal(new BitmapStore(8, 8, true, 0).clip(spanRect(5, 5, -Infinity, 2)), null);
});
