import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PATH_CUBIC,
  PATH_CURVE,
  PATH_LINE,
  PATH_MOVE,
  Tessellator,
} from "@swf2es/native/tessellate";
import { binary } from "../../packages/native/dist/render/binary.js";
import { tessellationFixtures } from "./tessellate-fixtures.ts";

const square = [0, 0, 10, 0, 10, 10, 0, 10];

function area(result: ReturnType<Tessellator["tessellate"]>): number {
  assert.ok(result);
  const { vertices: v, indices: p, indexOffset = 0 } = result;
  let area = 0;
  for (let i = 0; i < p.length; i += 3) {
    const a = (p[i] - indexOffset) * 2;
    const b = (p[i + 1] - indexOffset) * 2;
    const c = (p[i + 2] - indexOffset) * 2;
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

test("the native module imports only its aborting allocation failure callback, and sine and cosine", async () => {
  const module = await WebAssembly.compile(Buffer.from(binary, "base64"));
  assert.deepEqual(WebAssembly.Module.imports(module), [
    { module: "env", name: "cosine", kind: "function" },
    { module: "env", name: "sine", kind: "function" },
    { module: "env", name: "failure", kind: "function" },
  ]);
});

test("raw native getters expose only the current successful run", async () => {
  const module = await WebAssembly.compile(Buffer.from(binary, "base64"));
  const instance = await WebAssembly.instantiate(module, {
    env: {
      failure: () => assert.fail("unexpected native allocation failure"),
      sine: Math.sin,
      cosine: Math.cos,
    },
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

test("an instance's families share one arena, and a reset by one leaves another nothing stale", async () => {
  const module = await WebAssembly.compile(Buffer.from(binary, "base64"));
  const instance = await WebAssembly.instantiate(module, {
    env: {
      failure: () => assert.fail("unexpected native allocation failure"),
      sine: Math.sin,
      cosine: Math.cos,
    },
  });
  const x = instance.exports as unknown as {
    memory: WebAssembly.Memory;
    reset(): void;
    alloc(size: number): number;
    run(coords: number, count: number, ends: number, contours: number, nonzero: number): number;
    vertexCount(): number;
    resetArena(bytes: number): number;
    convolve(params: number): number;
    lineInput(n: number): number;
    lineBuild(length: number): number;
  };
  x.reset();
  const coords = x.alloc(square.length * 8);
  const ends = x.alloc(4);
  new Float64Array(x.memory.buffer, coords, square.length).set(square);
  new Uint32Array(x.memory.buffer, ends, 1)[0] = 4;
  assert.equal(x.run(coords, 4, ends, 1, 0), 0);
  assert.equal(x.vertexCount(), 4);

  // The lines' input, reserved after the fill, resets the arena: the fill's output is gone.
  const input = x.lineInput(6);
  assert.ok(input);
  new Float64Array(x.memory.buffer, input, 6).set([1, 0, 0, 1, 0.1, 0]);
  assert.equal(x.lineBuild(6), 0);
  assert.equal(x.vertexCount(), 0);

  // The bitmap kernel's reset leaves the lines no input, and the lines' none to the kernel.
  const params = x.resetArena(1024);
  assert.ok(params);
  assert.equal(x.lineBuild(6), -2);
  x.lineInput(6);
  assert.equal(x.convolve(params), 0);
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
  // This input fits the packing allocation but exhausts the native sweep arena,
  // which libtess2 reports without unwinding: the instance stays.
  assert.equal(tess.tessellate(many.slice(0, 50), false), null);
  assert.ok(tess.capacity > 0);
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

type Geometry = NonNullable<ReturnType<Tessellator["tessellate"]>>;

/** The geometry's bytes and its indices counted from its own first vertex. */
function plain(geometry: Geometry | null) {
  if (!geometry) {
    return null;
  }

  const { vertices, indices, indexOffset = 0 } = geometry;
  return {
    vertices: Array.from(new Uint8Array(vertices.buffer, vertices.byteOffset, vertices.byteLength)),
    indices: Array.from(indices, (index) => index - indexOffset),
  };
}

/** A polygon as the path commands a layer takes: a move to its first point, then lines. */
function path(points: readonly number[]): number[] {
  const commands = [PATH_MOVE, points[0], points[1]];
  for (let i = 2; i < points.length; i += 2) {
    commands.push(PATH_LINE, points[i], points[i + 1]);
  }

  return commands;
}

const paths = (fill: readonly (readonly number[])[]) => fill.map(path);

function ring(count: number, x = 0): number[] {
  const points: number[] = [];
  for (let i = 0; i < count; i++) {
    const angle = (i * 2 * Math.PI) / count;
    points.push(x + 100 * Math.cos(angle), 100 * Math.sin(angle));
  }

  return points;
}

test("a layer call tessellates each fill as a call of its own does, into one buffer each", () => {
  const fills = tessellationFixtures.flatMap((fixture) => [fixture.contours, fixture.contours]);
  const rules = fills.map((_, i) => i % 2 === 1);
  const tess = new Tessellator();
  const layer = tess.tessellate.layer(fills.map(paths), rules);
  assert.ok(layer);
  const alone = new Tessellator();
  for (let i = 0; i < fills.length; i++) {
    assert.deepEqual(plain(layer[i]), plain(alone.tessellate(fills[i], rules[i])));
  }

  const drawn = layer.filter((geometry) => geometry !== null);
  assert.ok(drawn.every((geometry) => geometry.vertices.buffer === drawn[0].vertices.buffer));
  assert.ok(drawn.every((geometry) => geometry.indices.buffer === drawn[0].indices.buffer));
  let vertices = 0;
  for (const geometry of drawn) {
    assert.equal(geometry.indexOffset, vertices);
    vertices += geometry.vertices.length / 2;
  }

  assert.deepEqual(tess.tessellate.layer([], []), []);
});

test("a layer leaves rejected fills to JS and draws the rest", () => {
  const tess = new Tessellator();
  const fills = [
    [path(square)],
    [path([NaN, 0, 1, 1, 0, 1])],
    [],
    // Fewer than three points enclose nothing: left out, as the JS fill leaves them.
    [path([0, 0, 1, 0])],
    [[PATH_MOVE, 0, 0, PATH_LINE, 1]],
    [[5, 0, 0, PATH_LINE, 1, 0, PATH_LINE, 1, 1]],
    [path([2 ** 24, 0, 1, 0, 0, 1])],
    [path(square), path([2, 2, 8, 2, 8, 8, 2, 8])],
  ];
  const layer = tess.tessellate.layer(
    fills,
    fills.map(() => false),
  );
  assert.ok(layer);
  assert.deepEqual(
    layer.map((geometry) => geometry && area(geometry)),
    [100, null, 0, 0, null, null, null, 64],
  );
  assert.deepEqual(
    plain(layer[7]),
    plain(tess.tessellate([square, [2, 2, 8, 2, 8, 8, 2, 8]], false)),
  );
});

/** A contour flattened as the player's scene/fills.ts trace does. */
function flattened(commands: readonly number[]): number[] {
  const points: number[] = [];
  const append = (x: number, y: number) => {
    if (points.length === 0 || points.at(-2) !== x || points.at(-1) !== y) {
      points.push(x, y);
    }
  };
  let x = 0;
  let y = 0;
  for (let i = 0; i < commands.length; ) {
    const command = commands[i];
    if (command === PATH_MOVE || command === PATH_LINE) {
      x = commands[i + 1];
      y = commands[i + 2];
      append(x, y);
      i += 3;
      continue;
    }

    if (command === PATH_CUBIC) {
      const [c1x, c1y, c2x, c2y, ax, ay] = commands.slice(i + 1, i + 7);
      const bend = Math.max(
        Math.hypot(x - 2 * c1x + c2x, y - 2 * c1y + c2y),
        Math.hypot(c1x - 2 * c2x + ax, c1y - 2 * c2y + ay),
      );
      const n = Math.min(256, Math.max(1, Math.ceil(Math.sqrt((3 * bend) / 0.08))));
      for (let k = 1; k < n; k++) {
        const t = k / n;
        const u = 1 - t;
        append(
          u * u * u * x + 3 * u * u * t * c1x + 3 * u * t * t * c2x + t * t * t * ax,
          u * u * u * y + 3 * u * u * t * c1y + 3 * u * t * t * c2y + t * t * t * ay,
        );
      }

      append(ax, ay);
      x = ax;
      y = ay;
      i += 7;
      continue;
    }

    const [cx, cy, ax, ay] = commands.slice(i + 1, i + 5);
    const n = Math.min(
      256,
      Math.max(1, Math.ceil(Math.sqrt(Math.hypot(x - 2 * cx + ax, y - 2 * cy + ay) / 0.08))),
    );
    for (let k = 1; k < n; k++) {
      const t = k / n;
      const u = 1 - t;
      append(u * u * x + 2 * u * t * cx + t * t * ax, u * u * y + 2 * u * t * cy + t * t * ay);
    }

    append(ax, ay);
    x = ax;
    y = ay;
    i += 5;
  }

  if (points.length > 2 && points[0] === points.at(-2) && points[1] === points.at(-1)) {
    points.length -= 2;
  }

  return points;
}

test("a layer flattens curves as the player's JS does", () => {
  const tess = new Tessellator();
  const fills = [
    // A circle of quadratics, and one of cubics with a hole.
    [
      [
        PATH_MOVE,
        100,
        0,
        PATH_CURVE,
        100,
        100,
        0,
        100,
        PATH_CURVE,
        -100,
        100,
        -100,
        0,
        PATH_CURVE,
        -100,
        -100,
        0,
        -100,
        PATH_CURVE,
        100,
        -100,
        100,
        0,
      ],
    ],
    [
      [
        PATH_MOVE,
        0,
        0,
        PATH_CUBIC,
        0,
        55,
        45,
        100,
        100,
        100,
        PATH_CUBIC,
        155,
        100,
        200,
        55,
        200,
        0,
        PATH_LINE,
        0,
        0,
      ],
      [PATH_MOVE, 50, 10, PATH_CURVE, 100, 80, 150, 10],
    ],
    // A curve so bent it takes the most chords, and one that is a point.
    [[PATH_MOVE, 0, 0, PATH_CURVE, 5e4, 5e4, 10, 0, PATH_LINE, 10, -10]],
    [[PATH_MOVE, 3, 3, PATH_CURVE, 3, 3, 3, 3]],
  ];
  const layer = tess.tessellate.layer(fills, [false, true, false, false]);
  assert.ok(layer);
  for (let i = 0; i < fills.length; i++) {
    const polygons = fills[i].map(flattened).filter((points) => points.length >= 6);
    assert.deepEqual(plain(layer[i]), plain(tess.tessellate(polygons, i === 1)));
  }

  // Its two ends, 255 points between, and the line's end.
  assert.equal(flattened(fills[2][0]).length / 2, 258);
  assert.equal(area(layer[3]), 0);
});

test("a layer's indices are 16 bits through 65,536 vertices in all, else 32", () => {
  const tess = new Tessellator();
  for (const [count, wide] of [
    [32768, false],
    [32769, true],
  ] as const) {
    const fills = [[ring(count)], [ring(count, 300)]];
    const layer = tess.tessellate.layer(fills.map(paths), [false, true]);
    assert.ok(layer?.[0] && layer[1]);
    assert.equal(layer[1].indices instanceof Uint32Array, wide);
    assert.equal(layer[1].indexOffset, count);
    for (let i = 0; i < fills.length; i++) {
      assert.deepEqual(plain(layer[i]), plain(tess.tessellate(fills[i], i === 1)));
    }
  }
});

test("a layer short of memory gives each fill what a layer of its own would", () => {
  const fills = Array.from({ length: 40 }, (_, i) => [path(ring(300 + i, i * 10))]);
  const rules = fills.map((_, i) => i % 3 === 0);
  const expected = fills.map((fill, i) =>
    plain(new Tessellator().tessellate.layer([fill], [rules[i]])?.[0] ?? null),
  );
  // Short of memory for the input, for a fill (unwound, then not), for the layer's output, and not.
  for (const memoryLimit of [400000, 600000, 800000, 900000, 1200000, 4000000]) {
    const alone = new Tessellator({ memoryLimit });
    const together = new Tessellator({ memoryLimit }).tessellate.layer(fills, rules);
    assert.ok(together);
    for (let i = 0; i < fills.length; i++) {
      const own = plain(alone.tessellate.layer([fills[i]], [rules[i]])?.[0] ?? null);
      assert.deepEqual(plain(together[i]), own);
      assert.ok(own === null || JSON.stringify(own) === JSON.stringify(expected[i]));
    }
  }
});
