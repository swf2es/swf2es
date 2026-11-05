import assert from "node:assert/strict";
import { test } from "node:test";
import { outlineOf } from "./outline.ts";

const square = () => ({
  positions: new Float32Array([0, 0, 20, 0, 20, 4, 0, 4]),
  colors: new Uint32Array(4).fill(0xffffffff),
  indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
});

test("interior diagonals are not treated as edges", () => {
  assert.deepEqual(outlineOf(square()), [0, 0, 20, 0, 20, 4, 0, 4]);
});

test("duplicate vertices join at the boundary", () => {
  assert.deepEqual(
    outlineOf({
      positions: new Float32Array([0, 0, 20, 0, 20, 4, 0, 0, 20, 4, 0, 4]),
      colors: new Uint32Array(6).fill(0xffffffff),
      indices: new Uint32Array([0, 1, 2, 3, 4, 5]),
    }),
    outlineOf(square()),
  );
});

test("unsupported paints, malformed indices and duplicate faces are refused", () => {
  const data = square();
  assert.equal(outlineOf({ ...data, texels: new Float32Array(8) }), null);
  data.colors[0] = 0x80ffffff;
  assert.equal(outlineOf(data), null);
  data.colors.fill(0xffffffff);
  data.indices[0] = 100;
  assert.equal(outlineOf(data), null);
  assert.equal(
    outlineOf({ ...square(), indices: new Uint32Array([0, 1, 2, 0, 1, 2, 0, 2, 3]) }),
    null,
  );
});

test("separate islands are refused", () => {
  assert.equal(
    outlineOf({
      positions: new Float32Array([0, 0, 10, 0, 0, 10, 20, 0, 30, 0, 20, 10]),
      colors: new Uint32Array(6).fill(0xffffffff),
      indices: new Uint32Array([0, 1, 2, 3, 4, 5]),
    }),
    null,
  );
});
