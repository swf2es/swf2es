import assert from "node:assert/strict";
import { test } from "node:test";
import { PATH_CUBIC, PATH_CURVE, PATH_LINE, PATH_MOVE, Tessellator } from "@swf2es/native/render";
import { binary } from "../../packages/native/dist/render/binary.js";
import { deckContours } from "../player/deck.ts";
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

test("small simple concave fills retain their input vertices in either winding and rule", () => {
  const tess = new Tessellator();
  for (const fixture of tessellationFixtures.slice(0, 3)) {
    const points = fixture.contours[0];
    const reversed = Array.from({ length: points.length / 2 }, (_, i) =>
      points.slice(i * 2, i * 2 + 2),
    )
      .reverse()
      .flat();
    for (const contour of [points, reversed]) {
      for (const nonZero of [false, true]) {
        const result = tess.tessellate([contour], nonZero);
        assert.ok(result);
        assert.deepEqual(Array.from(result.vertices), contour);
        assert.equal(result.indices.length, (contour.length / 2 - 2) * 3);
        assert.equal(area(result), fixture.area[Number(nonZero)]);
      }
    }
  }
});

test("a thin contour once along an axis and back keeps its input vertices, past ear clipping's size", () => {
  const tess = new Tessellator();
  // A saw of 150 teeth a pixel high over a shallower one, 600 points: along x and, turned, along y.
  const saw: number[] = [];
  for (let i = 0; i <= 300; i++) {
    saw.push(i, i % 2 ? 31 : 30);
  }

  for (let i = 299; i > 0; i--) {
    saw.push(i, i % 2 ? 28 : 28.5);
  }

  let twice = 0;
  for (let i = 0; i < saw.length; i += 2) {
    const j = (i + 2) % saw.length;
    twice += saw[i] * saw[j + 1] - saw[j] * saw[i + 1];
  }

  for (const contour of [saw, saw.map((_, i) => saw[i ^ 1])]) {
    for (const nonZero of [false, true]) {
      const result = tess.tessellate([contour], nonZero);
      assert.ok(result);
      assert.deepEqual(Array.from(result.vertices), contour);
      assert.equal(result.indices.length, (contour.length / 2 - 2) * 3);
      assert.ok(Math.abs(area(result) - Math.abs(twice) / 2) < 1e-9);
    }
  }

  // Its chains touching, it is libtess2's, which gives the vertices in its own order; so is a wide one.
  const touching = saw.slice();
  touching[302 * 2 + 1] = 30;
  assert.deepEqual(touching.slice(302 * 2, 302 * 2 + 2), touching.slice(298 * 2, 298 * 2 + 2));
  const wide = saw.map((value, i) => (i % 2 ? value * 40 : value));
  for (const contour of [touching, wide]) {
    const result = tess.tessellate([contour], false);
    assert.ok(result);
    assert.notDeepEqual(Array.from(result.vertices), contour);
  }
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
  for (const input of [[[NaN, 0, 1, 1, 0, 1]], [[0, 0]], [[0, 0, 1, 0, 0, Infinity]]]) {
    assert.equal(tess.tessellate(input, false), null);
  }

  // Past libtess2's range, filled by the bands.
  assert.equal(area(tess.tessellate([[2 ** 24, 0, 1, 0, 0, 1]], false)), 2 ** 23 - 0.5);

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

test("a borrowed layer is the layer copied, until the next call; a copied one stays", () => {
  const fills = tessellationFixtures.map((fixture) => fixture.contours).map(paths);
  const rules = fills.map((_, i) => i % 2 === 1);
  const tess = new Tessellator();
  const copied = tess.tessellate.layer(fills, rules);
  assert.ok(copied);
  const kept = copied.map(plain);
  const borrowed = tess.tessellate.layer(fills, rules, true);
  assert.ok(borrowed);
  assert.deepEqual(borrowed.map(plain), kept);
  // The module's memory itself, read before another call writes it.
  const lent = borrowed.find((geometry) => geometry !== null);
  assert.ok(lent && lent.vertices.buffer.byteLength >= 65536);

  // Another layer, and a fill alone, change no copy handed out before.
  assert.ok(tess.tessellate.layer([[path([0, 0, 9, 0, 0, 9])]], [true], true));
  assert.ok(tess.tessellate([square], false));
  assert.deepEqual(copied.map(plain), kept);
});

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

test("a layer refuses malformed fills and draws the rest, past libtess2's range by the bands", () => {
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
    [100, null, 0, 0, null, null, 2 ** 23 - 0.5, 64],
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

    // Borrowed, the fills tried again alone overwrite nothing lent.
    const lent = new Tessellator({ memoryLimit }).tessellate.layer(fills, rules, true);
    assert.deepEqual(lent?.map(plain), together.map(plain));
  }
});

test("one convex contour is a fan, its points as given; one that winds round twice is not", () => {
  const tess = new Tessellator();
  for (const n of [3, 4, 7, 32]) {
    const points = Array.from({ length: n }, (_, i) => [
      100 * Math.cos((2 * Math.PI * i) / n),
      100 * Math.sin((2 * Math.PI * i) / n),
    ]).flat();

    for (const nonZero of [false, true]) {
      const geometry = tess.tessellate([points], nonZero);
      assert.ok(geometry);
      assert.deepEqual(Array.from(geometry.vertices), points);
      assert.equal(geometry.indices.length, (n - 2) * 3);
      const expected = (n / 2) * 100 * 100 * Math.sin((2 * Math.PI) / n);
      assert.ok(Math.abs(area(geometry) - expected) < 1e-6 * expected, `${n}-gon`);
    }
  }

  // A point along an edge, and the other way round: a fan still.
  assert.equal(area(tess.tessellate([[0, 0, 5, 0, 10, 0, 0, 10]], false)), 50);
  assert.equal(area(tess.tessellate([[0, 0, 0, 10, 10, 0]], true)), 50);

  // A pentagram turns one way all round but winds twice: even-odd leaves its centre empty.
  const star = Array.from({ length: 5 }, (_, i) => [
    100 * Math.cos(Math.PI / 2 + (4 * Math.PI * i) / 5),
    100 * Math.sin(Math.PI / 2 + (4 * Math.PI * i) / 5),
  ]).flat();
  const odd = area(tess.tessellate([star], false));
  const all = area(tess.tessellate([star], true));
  const inner = (100 * Math.sin(Math.PI / 10)) / Math.sin((7 * Math.PI) / 10);
  const pentagon = 2.5 * inner * inner * Math.sin((2 * Math.PI) / 5);
  assert.ok(Math.abs(all - odd - pentagon) < 1e-6 * pentagon);

  // A concave contour so large that its turns' products overflow is no fan: past libtess2's range,
  // the bands fill it. Its notch, (7, 6) at a scale of one, stays out; (8, 1) is in.
  const scale = 1e160;
  const dent = [0, 0, 10, 0, 10, 10, 5, 2].map((v) => v * scale);
  const geometry = tess.tessellate([dent], false);
  assert.ok(geometry);
  const v = Array.from(geometry.vertices, (x) => x / scale);
  const covers = (x: number, y: number) => {
    for (let k = 0; k < geometry.indices.length; k += 3) {
      const [a, b, c] = [0, 1, 2].map((j) => geometry.indices[k + j] * 2);
      const side = (p: number, q: number) =>
        (v[q] - v[p]) * (y - v[p + 1]) - (v[q + 1] - v[p + 1]) * (x - v[p]);
      const d = [side(a, b), side(b, c), side(c, a)];
      if (d.every((e) => e > 0) || d.every((e) => e < 0)) {
        return true;
      }
    }

    return false;
  };
  assert.equal(covers(7, 6), false);
  assert.equal(covers(8, 1), true);
  tess.dispose();
});

/** The render module alone, to see which filler took a fill and to make lyon fail (lyonFault). */
interface RawRender {
  memory: WebAssembly.Memory;
  reset(): void;
  alloc(size: number): number;
  setLimit(size: number): void;
  run(coords: number, count: number, ends: number, contours: number, nonzero: number): number;
  vertices(): number;
  indices(): number;
  vertexCount(): number;
  triangleCount(): number;
  filledBy(): number;
  lyonFault(fault: number): void;
  checkFill(
    coords: number,
    count: number,
    ends: number,
    contours: number,
    nonzero: number,
    positions: number,
    vertexCount: number,
    indices: number,
    indexCount: number,
  ): number;
}

const LIBTESS2 = 4;
const LYON = 5;
const BANDS = 6;
const LYON_X = 7;

async function rawRender(): Promise<RawRender> {
  const module = await WebAssembly.compile(Buffer.from(binary, "base64"));
  const instance = await WebAssembly.instantiate(module, {
    env: {
      failure: () => {
        throw new Error("native failure");
      },
      sine: Math.sin,
      cosine: Math.cos,
    },
  });
  return instance.exports as unknown as RawRender;
}

interface RawFill {
  status: number;
  ms: number;
  by: number;
  vertices: Float64Array;
  indices: Int32Array;
}

/** A fill by `x`, lyon made to fail as `fault` says, in an arena of `limit` bytes. */
function rawFill(
  x: RawRender,
  contours: number[][],
  nonZero: boolean,
  fault = 0,
  limit = 128 << 20,
): RawFill {
  x.reset();
  x.setLimit(limit);
  x.lyonFault(fault);
  const flat = contours.flat();
  const coords = x.alloc(flat.length * 8);
  const ends = x.alloc(contours.length * 4);
  new Float64Array(x.memory.buffer, coords, flat.length).set(flat);
  let end = 0;
  new Uint32Array(x.memory.buffer, ends, contours.length).set(
    contours.map((points) => (end += points.length / 2)),
  );
  const start = performance.now();
  const status = x.run(coords, flat.length / 2, ends, contours.length, Number(nonZero));
  return {
    status,
    ms: performance.now() - start,
    by: x.filledBy(),
    vertices: new Float64Array(x.memory.buffer, x.vertices(), x.vertexCount() * 2).slice(),
    indices: new Int32Array(x.memory.buffer, x.indices(), x.triangleCount() * 3).slice(),
  };
}

function rawArea(fill: { vertices: Float64Array; indices: Int32Array }): number {
  return area({ vertices: fill.vertices, indices: Uint32Array.from(fill.indices) });
}

function winding(contours: number[][], px: number, py: number): number {
  let n = 0;
  for (const p of contours) {
    for (let i = 0, j = p.length - 2; i < p.length; j = i, i += 2) {
      const cross = (p[i] - p[j]) * (py - p[j + 1]) - (p[i + 1] - p[j + 1]) * (px - p[j]);
      if (p[j + 1] <= py && p[i + 1] > py && cross > 0) {
        n++;
      } else if (p[j + 1] > py && p[i + 1] <= py && cross < 0) {
        n--;
      }
    }
  }

  return n;
}

/** Whether a point lies within `margin` of an edge of the contours. */
function nearEdge(contours: number[][], px: number, py: number, margin: number): boolean {
  for (const p of contours) {
    for (let i = 0, j = p.length - 2; i < p.length; j = i, i += 2) {
      const dx = p[i] - p[j];
      const dy = p[i + 1] - p[j + 1];
      const length = dx * dx + dy * dy;
      const s =
        length === 0
          ? 0
          : Math.min(1, Math.max(0, ((px - p[j]) * dx + (py - p[j + 1]) * dy) / length));
      if (Math.hypot(p[j] + s * dx - px, p[j + 1] + s * dy - py) < margin) {
        return true;
      }
    }
  }

  return false;
}

/**
 * `samples` points over the contours' box, but those near an edge, each covered by the fill's
 * triangles once where the rule fills it and not at all elsewhere: lyon's positions are f32s,
 * so a point this close to an edge may fall either side of it.
 */
function checkCoverage(
  contours: number[][],
  nonZero: boolean,
  fill: RawFill,
  samples: number,
): void {
  const { vertices: v, indices: t } = fill;
  let [x0, x1, y0, y1] = [Infinity, -Infinity, Infinity, -Infinity];
  for (const p of contours) {
    for (let i = 0; i < p.length; i += 2) {
      [x0, x1] = [Math.min(x0, p[i]), Math.max(x1, p[i])];
      [y0, y1] = [Math.min(y0, p[i + 1]), Math.max(y1, p[i + 1])];
    }
  }

  const margin = Math.max(1e-3, Math.max(Math.abs(x1), Math.abs(y1)) * 2e-7);
  let checked = 0;
  for (let k = 0; checked < samples && k < samples * 10; k++) {
    const px = x0 + ((k * 0.6180339887 + 0.1) % 1) * (x1 - x0);
    const py = y0 + ((k * 0.7548776662 + 0.1) % 1) * (y1 - y0);
    let covered = 0;
    let edge = false;
    for (let i = 0; i < t.length && !edge; i += 3) {
      const [a, b, c] = [t[i] * 2, t[i + 1] * 2, t[i + 2] * 2];
      if (
        px < Math.min(v[a], v[b], v[c]) ||
        px > Math.max(v[a], v[b], v[c]) ||
        py < Math.min(v[a + 1], v[b + 1], v[c + 1]) ||
        py > Math.max(v[a + 1], v[b + 1], v[c + 1])
      ) {
        continue;
      }

      const p = (v[b] - v[a]) * (py - v[a + 1]) - (v[b + 1] - v[a + 1]) * (px - v[a]);
      const q = (v[c] - v[b]) * (py - v[b + 1]) - (v[c + 1] - v[b + 1]) * (px - v[b]);
      const r = (v[a] - v[c]) * (py - v[c + 1]) - (v[a + 1] - v[c + 1]) * (px - v[c]);
      // Within a ten-millionth of a pixel of an edge's line, inside the triangle's box, the
      // sample says nothing: the bands leave triangles with sides that short.
      const ab = Math.hypot(v[b] - v[a], v[b + 1] - v[a + 1]);
      const bc = Math.hypot(v[c] - v[b], v[c + 1] - v[b + 1]);
      const ca = Math.hypot(v[a] - v[c], v[a + 1] - v[c + 1]);
      edge = Math.min(Math.abs(p) / ab, Math.abs(q) / bc, Math.abs(r) / ca) < 1e-7;
      if ((p > 0 && q > 0 && r > 0) || (p < 0 && q < 0 && r < 0)) {
        covered++;
      }
    }

    if (edge || nearEdge(contours, px, py, margin)) {
      continue;
    }

    const w = winding(contours, px, py);
    assert.equal(covered, Number(nonZero ? w !== 0 : w % 2 !== 0), `at ${px}, ${py}`);
    checked++;
  }

  assert.equal(checked, samples);
}

/**
 * How much area lyon's fill of the contours may differ from libtess2's by: slivers between
 * contours about as thin as the module's check's quarter pixel, which it lets lyon leave out or add
 * between its scanlines, and positions narrowed to f32, along the contours' length.
 */
function slivers(contours: number[][]): number {
  let length = 0;
  for (const p of contours) {
    for (let i = 0, j = p.length - 2; i < p.length; j = i, i += 2) {
      length += Math.hypot(p[i] - p[j], p[i + 1] - p[j + 1]);
    }
  }

  return 2e-4 * length;
}

/** deckContours' shape, `count` contours turned `turn` apart about (`centre`, `centre`), unrounded. */
function deckAt(count: number, turn: number, centre: number, points = 200, scale = 1): number[][] {
  const contours: number[][] = [];
  for (let c = 0; c < count; c++) {
    const [cos, sin] = [Math.cos(c * turn), Math.sin(c * turn)];
    const contour: number[] = [];
    for (let k = 0; k < points; k++) {
      const u = (k / points) * Math.PI * 2;
      const r = 200 + 12 * Math.sin(u * 9);
      const [x, y] = [r * Math.cos(u) * 0.7, r * Math.sin(u)];
      contour.push((centre + x * cos - y * sin) * scale, (centre + x * sin + y * cos) * scale);
    }

    contours.push(contour);
  }

  return contours;
}

test("many densely crossing contours go to lyon, fast and covered once; other fills do not", async () => {
  const x = await rawRender();
  // libtess2 takes over a second over 80 such contours in wasm; lyon about a tenth of one.
  const deck = deckContours(80);
  for (const nonZero of [false, true]) {
    const fill = rawFill(x, deck, nonZero);
    assert.equal(fill.status, 0);
    assert.equal(fill.by, LYON);
    assert.ok(fill.ms < 1000, `${fill.ms} ms`);
    checkCoverage(deck, nonZero, fill, 200);
  }

  // The same area as libtess2's (lyon refused, -2), where it is quick enough to compare with.
  const twenty = deckContours(20);
  const lyon = rawFill(x, twenty, false);
  const libtess2 = rawFill(x, twenty, false, -2);
  assert.equal(lyon.by, LYON);
  assert.equal(libtess2.by, LIBTESS2);
  assert.ok(Math.abs(rawArea(lyon) - rawArea(libtess2)) < 1e-4 * rawArea(libtess2));

  // Ten crossing contours are too few to be worth it; a thousand squares side by side cross nowhere.
  assert.equal(rawFill(x, deckContours(10), false).by, LIBTESS2);
  const grid = Array.from({ length: 1024 }, (_, k) => {
    const [gx, gy] = [k % 32, Math.floor(k / 32)];
    return [gx, gy, gx + 1, gy, gx + 1, gy + 1, gx, gy + 1];
  });
  assert.equal(rawFill(x, grid, false).by, LIBTESS2);
});

test("contours a hundredth of a pixel apart fill right by either rule, near the origin or far", async () => {
  const x = await rawRender();
  for (const turn of [1e-5, 1e-4, 1e-3]) {
    for (const centre of [400, 3000]) {
      const deck = deckAt(40, turn, centre);
      for (const nonZero of [false, true]) {
        const fill = rawFill(x, deck, nonZero);
        const context = `turn ${turn} about ${centre}, ${nonZero ? "non-zero" : "even-odd"}`;
        assert.equal(fill.status, 0, context);
        // Whichever filler took it, lyon or, where its triangles failed the check, libtess2.
        assert.ok(fill.by === LYON || fill.by === LYON_X || fill.by === LIBTESS2, context);
        checkCoverage(deck, nonZero, fill, 60);
        const reference = rawFill(x, deck, nonZero, -2);
        assert.ok(
          Math.abs(rawArea(fill) - rawArea(reference)) <= 2e-3 * rawArea(reference) + slivers(deck),
          `${context}: area ${rawArea(fill)} against libtess2's ${rawArea(reference)}`,
        );
      }
    }
  }
});

test("where lyon fails, refuses or is wrong, the fill goes on to the bands or to libtess2", async () => {
  const x = await rawRender();
  // Twelve contours of a hundred points, which the bands can fill too.
  const deck = deckAt(12, 0.004, 300, 100);
  for (const nonZero of [false, true]) {
    const own = rawFill(x, deck, nonZero);
    assert.equal(own.by, LYON);
    // lyon failing (-1) or out of memory for its own buffers (-3): the bands.
    for (const fault of [-1, -3]) {
      const fill = rawFill(x, deck, nonZero, fault);
      assert.equal(fill.status, 0);
      assert.equal(fill.by, BANDS);
      checkCoverage(deck, nonZero, fill, 60);
    }

    // lyon refusing the coordinates (-2), or its triangles failing the check: libtess2.
    for (const fault of [-2, 2]) {
      const fill = rawFill(x, deck, nonZero, fault);
      assert.equal(fill.status, 0);
      assert.equal(fill.by, LIBTESS2);
      checkCoverage(deck, nonZero, fill, 60);
    }
  }

  // A deck wider than lyon's twips reach about its centre is refused, and libtess2 fills it.
  const wide = deckAt(12, 0.004, 300, 200, 5000);
  assert.equal(rawFill(x, wide, false).by, LIBTESS2);
  // A fault applies to one fill.
  assert.equal(rawFill(x, deck, false).by, LYON);
});

test("a trap in lyon, as running out of memory inside it is, leaves the bands to fill in a new instance", async () => {
  // Out of memory in lyon's own allocations traps (unreachable) rather than returning -3, which
  // only the crate's own buffers report.
  const x = await rawRender();
  const deck = deckContours(40);
  assert.throws(() => rawFill(x, deck, false, 0, 3 << 20), /unreachable/);

  // The tessellator lets that instance go and fills by the bands alone in a new one.
  const tessellator = new Tessellator({ memoryLimit: 3 << 20 });
  const instance = () => (tessellator as unknown as { instance: unknown }).instance;
  assert.equal(tessellator.tessellate([square], false)?.indices.length, 6);
  const before = instance();
  tessellator.tessellate(deck, false);
  assert.notEqual(instance(), before);

  // A trap made to happen where the bands can fill: their triangles, in a new instance.
  const small = deckAt(12, 0.004, 300, 100);
  const banded = new Tessellator({ bands: true }).tessellate(small, false);
  const tess = new Tessellator();
  assert.equal(tess.tessellate([square], false)?.indices.length, 6);
  const first = (tess as unknown as { instance: RawRender }).instance;
  first.lyonFault(1);
  const fill = tess.tessellate(small, false);
  assert.ok(fill && banded);
  assert.notEqual((tess as unknown as { instance: RawRender }).instance, first);
  assert.deepEqual(Array.from(fill.vertices), Array.from(banded.vertices));
  assert.deepEqual(Array.from(fill.indices), Array.from(banded.indices));
});

test("lyon's triangles wrong both ways are caught and libtess2 fills the deck instead", async () => {
  // The smallest such deck found: 80 contours of 200 points, each turned 1e-4 from the last.
  const x = await rawRender();
  const deck = deckAt(80, 1e-4, 400);
  const fill = rawFill(x, deck, false);
  assert.equal(fill.status, 0);
  assert.equal(fill.by, LIBTESS2);
  checkCoverage(deck, false, fill, 60);
});

test("the check adds up thin wrong stretches, which pass one at a time", async () => {
  // libtess2's even-odd triangles judged as the non-zero rule's fill of 41 contours turned 1e-4
  // apart: wrong by some 140 px², all of it in stretches under a quarter of a pixel.
  const x = await rawRender();
  const deck = deckAt(41, 1e-4, 400);
  const evenOdd = rawFill(x, deck, false, -2);
  assert.equal(evenOdd.by, LIBTESS2);
  const check = (nonZero: boolean) => {
    x.reset();
    const flat = deck.flat();
    const coords = x.alloc(flat.length * 8);
    const ends = x.alloc(deck.length * 4);
    const positions = x.alloc(evenOdd.vertices.length * 8);
    const indices = x.alloc(evenOdd.indices.length * 4);
    new Float64Array(x.memory.buffer, coords, flat.length).set(flat);
    let end = 0;
    new Uint32Array(x.memory.buffer, ends, deck.length).set(
      deck.map((points) => (end += points.length / 2)),
    );
    new Float64Array(x.memory.buffer, positions, evenOdd.vertices.length).set(evenOdd.vertices);
    new Int32Array(x.memory.buffer, indices, evenOdd.indices.length).set(evenOdd.indices);
    return x.checkFill(
      coords,
      flat.length / 2,
      ends,
      deck.length,
      Number(nonZero),
      positions,
      evenOdd.vertices.length / 2,
      indices,
      evenOdd.indices.length,
    );
  };
  assert.equal(check(false), 0);
  assert.equal(check(true), 1);
});

test("where lyon's sweep along y fails the check, its sweep along x can fill the deck right", async () => {
  // 95 contours each turned 1e-3 from the last: lyon along y fails the check, along x passes.
  const x = await rawRender();
  const deck = deckAt(95, 1e-3, 400);
  const fill = rawFill(x, deck, false);
  assert.equal(fill.status, 0);
  assert.equal(fill.by, LYON_X);
  checkCoverage(deck, false, fill, 60);
});

test("where lyon's sweep along y fails the check and along x fails outright, libtess2 fills it", async () => {
  const x = await rawRender();
  const deck = deckAt(12, 0.004, 300, 100);
  const fill = rawFill(x, deck, false, 3);
  assert.equal(fill.status, 0);
  assert.equal(fill.by, LIBTESS2);
  checkCoverage(deck, false, fill, 60);
});
