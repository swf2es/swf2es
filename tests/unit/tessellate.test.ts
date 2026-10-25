import assert from "node:assert/strict";
import { test } from "node:test";
import { Tessellator } from "@swf2es/tessellate";
import { binary } from "../../packages/tessellate/dist/binary.js";
import { tessellationFixtures } from "./tessellate-fixtures.ts";

const square = [0, 0, 10, 0, 10, 10, 0, 10];

function area(result: ReturnType<Tessellator["tessellate"]>): number {
  assert.ok(result);
  const { vertices: v, indices: p } = result;
  let area = 0;
  for (let i = 0; i < p.length; i += 3) {
    const a = p[i] * 2;
    const b = p[i + 1] * 2;
    const c = p[i + 2] * 2;
    area +=
      Math.abs((v[b] - v[a]) * (v[c + 1] - v[a + 1]) - (v[b + 1] - v[a + 1]) * (v[c] - v[a])) / 2;
  }

  return area;
}

for (const fixture of tessellationFixtures) {
  test(`native fill fixture: ${fixture.name}`, () => {
    const tessellator = new Tessellator();
    for (const nonZero of [false, true]) {
      const expected = fixture.area[Number(nonZero)];
      const actual = area(tessellator.tessellate(fixture.contours, nonZero));
      assert.ok(Math.abs(actual - expected) <= Math.max(1, expected) * 1e-9);
    }
  });
}

test("native tessellation resolves intersections and global winding rules", () => {
  const tess = new Tessellator();
  const nested = [square, [2, 2, 8, 2, 8, 8, 2, 8]];
  assert.equal(area(tess.tessellate(nested, false)), 64);
  assert.equal(area(tess.tessellate(nested, true)), 100);
  assert.equal(area(tess.tessellate([[0, 0, 10, 10, 0, 10, 10, 0]], false)), 50);
  assert.equal(area(tess.tessellate([square, square], false)), 0);
  assert.equal(area(tess.tessellate([square, square], true)), 100);
  assert.equal(area(tess.tessellate([[0, 0, 0, 0, 0, 0]], false)), 0);
});

test("the native module imports only its aborting allocation failure callback", async () => {
  const module = await WebAssembly.compile(Buffer.from(binary, "base64"));
  assert.deepEqual(WebAssembly.Module.imports(module), [
    { module: "env", name: "failure", kind: "function" },
  ]);
});

test("raw native getters expose only the current successful run", async () => {
  const module = await WebAssembly.compile(Buffer.from(binary, "base64"));
  const instance = await WebAssembly.instantiate(module, {
    env: { failure: () => assert.fail("unexpected native allocation failure") },
  });
  const x = instance.exports as unknown as {
    memory: WebAssembly.Memory;
    reset(): void;
    alloc(size: number): number;
    setLimit(size: number): void;
    run(coords: number, count: number, ends: number, contours: number, nonzero: number): number;
    vertices(): number;
    indices(): number;
    vertexCount(): number;
    triangleCount(): number;
  };
  const result = () => [x.vertices(), x.indices(), x.vertexCount(), x.triangleCount()];
  assert.deepEqual(result(), [0, 0, 0, 0]);
  x.reset();
  const coords = x.alloc(square.length * 8);
  const ends = x.alloc(4);
  new Float64Array(x.memory.buffer, coords, square.length).set(square);
  new Uint32Array(x.memory.buffer, ends, 1)[0] = 4;
  assert.equal(x.run(coords, 4, ends, 1, 0), 0);
  assert.ok(x.vertices() > 0 && x.indices() > 0);
  assert.equal(x.vertexCount(), 4);
  assert.equal(x.triangleCount(), 2);

  assert.equal(x.run(coords, 4, ends, 1, 2), -2);
  assert.deepEqual(result(), [0, 0, 0, 0]);
  assert.equal(x.run(coords, 4, ends, 1, 0), 0);
  x.setLimit(0);
  assert.equal(x.run(coords, 4, ends, 1, 0), -1);
  assert.deepEqual(result(), [0, 0, 0, 0]);
  x.reset();
  assert.deepEqual(result(), [0, 0, 0, 0]);
});

test("owned buffers survive arena reuse, growth and disposal", () => {
  for (const retainMemory of [0, 8 << 20]) {
    const tess = new Tessellator({ retainMemory });
    const first = tess.tessellate([square], false);
    assert.ok(first);
    const vertices = first.vertices.slice();
    const indices = first.indices.slice();
    const before = tess.capacity;
    const ring: number[] = [];
    for (let i = 0; i < 3000; i++) {
      const angle = (i * 2 * Math.PI) / 3000;
      ring.push(100 * Math.cos(angle), 100 * Math.sin(angle));
    }

    assert.ok(tess.tessellate([ring], false));
    if (retainMemory === 0) {
      assert.equal(tess.capacity, 0);
    } else {
      assert.ok(tess.capacity > before);
    }

    assert.equal(area(tess.tessellate([square], false)), 100);
    tess.dispose();
    assert.deepEqual(first.vertices, vertices);
    assert.deepEqual(first.indices, indices);
  }
});

test("double precision retains thin fills at a large origin", () => {
  const tess = new Tessellator();
  const origin = 8000000;
  const thin = [origin, 0, origin + 0.125, 0, origin + 0.125, 100, origin, 100];
  assert.equal(area(tess.tessellate([thin], false)), 12.5);
});

test("malformed inputs and allocation failure leave the next fill usable", () => {
  const tess = new Tessellator({ memoryLimit: 600000 });
  for (const input of [
    [[NaN, 0, 1, 1, 0, 1]],
    [[0, 0]],
    [[0, 0, 1, 0, 0, Infinity]],
    [[2 ** 24, 0, 1, 0, 0, 1]],
  ]) {
    assert.equal(tess.tessellate(input, false), null);
  }

  const many = Array.from({ length: 10000 }, (_, i) => {
    const x = i * 0.1;
    return [x, 0, x + 1, 1, x, 2];
  });
  // This input fits the packing allocation but exhausts the native sweep arena.
  assert.equal(tess.tessellate(many.slice(0, 50), false), null);
  assert.equal(tess.capacity, 0);
  assert.equal(area(tess.tessellate([square], false)), 100);
  assert.equal(tess.tessellate(many, false), null);
  assert.equal(tess.capacity, 0);
  assert.equal(area(tess.tessellate([square], false)), 100);
});

test("native owned indices fit 16 bits through vertex 65535 and retain wider indices above it", () => {
  const tess = new Tessellator();
  for (const count of [65536, 65537]) {
    const ring: number[] = [];
    for (let i = 0; i < count; i++) {
      const angle = (i * 2 * Math.PI) / count;
      ring.push(100 * Math.cos(angle), 100 * Math.sin(angle));
    }

    const result = tess.tessellate([ring], false);
    assert.ok(result);
    assert.equal(result.vertices.length / 2, count);
    assert.equal(result.indices instanceof Uint16Array, count === 65536);
    assert.equal(result.indices instanceof Uint32Array, count === 65537);
    let largest = 0;
    for (const index of result.indices) {
      largest = Math.max(largest, index);
    }

    assert.equal(largest, count - 1);
    assert.ok(Math.abs(area(result) - Math.PI * 10000) < 0.001);
  }
});
