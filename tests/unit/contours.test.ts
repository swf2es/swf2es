import assert from "node:assert/strict";
import { test } from "node:test";
import { type ContourEdge, Tessellator } from "@swf2es/tessellate";
import type { Shape, ShapeRecord } from "../../packages/format/dist/index.js";
import {
  extent,
  flatten,
  type ShapeLayer,
  shapeLayers,
} from "../../packages/player/dist/display/shapes.js";
import { trace } from "../../packages/player/dist/render/tessellate.js";

const edge = (x0: number, y0: number, x1: number, y1: number, cx = NaN, cy = NaN): ContourEdge => ({
  x0,
  y0,
  x1,
  y1,
  cx,
  cy,
});
const square = [edge(0, 0, 200, 0), edge(200, 0, 200, 200), edge(200, 200, 0, 0)];

function shape(edges: ContourEdge[]): Shape {
  const records: ShapeRecord[] = [];
  for (const e of edges) {
    records.push({
      type: "style",
      moveTo: { x: e.x0, y: e.y0 },
      fill0: 0,
      fill1: 1,
      line: 0,
      styles: null,
    });
    records.push(
      Number.isNaN(e.cx)
        ? { type: "line", dx: e.x1 - e.x0, dy: e.y1 - e.y0 }
        : { type: "curve", cx: e.cx - e.x0, cy: e.cy - e.y0, ax: e.x1 - e.cx, ay: e.y1 - e.cy },
    );
  }

  return {
    id: 1,
    bounds: { xMin: 0, xMax: 0, yMin: 0, yMax: 0 },
    edgeBounds: null,
    fills: [{ type: "solid", color: 0xff336699 }],
    lines: [],
    records,
    truncated: false,
  };
}

const plain = (layers: ShapeLayer[]) =>
  layers.map((layer) => ({
    ...layer,
    fills: layer.fills.map((fill) => ({
      ...fill,
      contours: fill.contours.map((path) => Array.from(path)),
    })),
  }));

test("native contour joining preserves junction priority, curves and disconnected paths", () => {
  const tess = new Tessellator();
  const edges = [
    edge(-20, 0, 0, 0),
    edge(0, 0, 20, 0),
    edge(0, 0, 0, 20, 20, 20),
    edge(20, 0, 0, 0),
    edge(0, 20, -20, 0),
    edge(40, 40, 60, 40),
    edge(80, 80, 80, 80),
  ];
  const s = shape(edges);
  const native = shapeLayers(s, undefined, tess.joinContours);
  assert.ok(native[0].fills[0].contours.every((path) => path instanceof Float64Array));
  assert.deepEqual(plain(native), plain(shapeLayers(s)));

  let seed = 71;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 0x100000000;
  };
  for (let i = 0; i < 200; i++) {
    const points = Array.from({ length: 3 + (i % 17) }, () => [
      Math.floor(random() * 31) - 15,
      Math.floor(random() * 31) - 15,
    ]);
    const soup = Array.from({ length: i % 80 }, (_, k) => {
      const a = points[Math.floor(random() * points.length)];
      const b = points[Math.floor(random() * points.length)];
      return edge(a[0], a[1], b[0], b[1], k % 3 === 0 ? 2.5 : NaN, -1.25);
    });
    const s = shape(soup);
    assert.deepEqual(plain(shapeLayers(s, undefined, tess.joinContours)), plain(shapeLayers(s)));
  }
});

test("owned contour views survive joining, tessellation, growth, rejection and disposal", () => {
  for (const retainMemory of [0, 8 << 20]) {
    const tess = new Tessellator({ retainMemory });
    const first = tess.joinContours(square);
    assert.ok(first);
    const copies = first.map((path) => path.slice());
    const many = Array.from({ length: 20000 }, (_, i) => edge(i, 0, i, 0));
    assert.ok(tess.joinContours(many));
    assert.ok(tess.tessellate([[0, 0, 10, 0, 0, 10]], false));
    assert.equal(tess.joinContours([edge(0.25, 0, 1, 1)]), null);
    assert.ok(tess.joinContours(square));
    if (retainMemory === 0) {
      assert.equal(tess.capacity, 0);
    }

    tess.dispose();
    assert.equal(tess.capacity, 0);
    assert.deepEqual(first, copies);
  }
});

test("one fill's contour views share owned doubles without retaining unused output capacity", () => {
  const tess = new Tessellator();
  const paths = tess.joinContours([edge(-0, 0, 20, -0), edge(40, 40, 60, 60)]);
  assert.ok(paths);
  assert.equal(paths.length, 2);
  assert.equal(paths[0].buffer, paths[1].buffer);
  assert.equal(paths[0].buffer.byteLength, (paths[0].length + paths[1].length) * 8);
  assert.ok(Object.is(paths[0][1], -0));
  assert.ok(Object.is(paths[0][5], -0));
  tess.dispose();
  assert.deepEqual(Array.from(paths[1]), [1, 2, 2, 2, 3, 3]);
});

test("oversized contour scratch is released before later small fills", () => {
  const tess = new Tessellator();
  const large = tess.joinContours(Array.from({ length: 50000 }, (_, i) => edge(i, 0, i, 0)));
  assert.ok(large);
  assert.equal(tess.capacity, 0);
  assert.ok(tess.joinContours(square));
  assert.ok(tess.capacity > 0 && tess.capacity <= 8 << 20);
  assert.deepEqual(Array.from(large[49999]), [1, 49999 / 20, 0, 2, 49999 / 20, 0]);
});

test("native contour limits and unsupported coordinates reject without poisoning later calls", () => {
  const tess = new Tessellator();
  for (const coordinate of [NaN, Infinity, -Infinity, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(tess.joinContours([edge(coordinate, 0, 1, 1)]), null);
  }

  assert.deepEqual(tess.joinContours([]), []);
  assert.equal(tess.joinContours(Array<ContourEdge>(262145).fill(square[0])), null);
  assert.equal(new Tessellator({ memoryLimit: 0 }).joinContours(square), null);
  assert.ok(tess.joinContours(square));
  assert.ok(tess.joinContours([edge(Number.MAX_SAFE_INTEGER, 0, 0, Number.MAX_SAFE_INTEGER)]));
});

test("a rejecting or throwing contour hook retains the JS result", () => {
  const s = shape(square);
  const expected = shapeLayers(s);
  for (const joiner of [
    () => null,
    () => {
      throw new Error("unavailable");
    },
  ]) {
    assert.deepEqual(shapeLayers(s, undefined, joiner), expected);
  }
});

test("typed contour readers preserve curve flattening, tracing and exact bounds", () => {
  const commands = [1, -2, 3, 3, 10, -20, 30, 40, 4, 10, 20, -40, 50, 60, -70, 2, -2, 3];
  const typed = Float64Array.from(commands);
  assert.deepEqual(flatten(typed), flatten(commands));
  assert.deepEqual(extent(typed), extent(commands));
  const traced = (path: typeof commands | Float64Array) => {
    const points: number[] = [];
    trace({ moveTo: (x, y) => points.push(x, y), lineTo: (x, y) => points.push(x, y) }, path);
    return points;
  };
  assert.deepEqual(traced(typed), traced(commands));
});
