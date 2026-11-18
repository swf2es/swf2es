// A shape's records as layers: its bitmap fills tied to the SWF's bitmaps,
// its edges joined into each fill's contours.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  readShape,
  readSwf,
  type Shape,
  type ShapeRecord,
} from "../../../../packages/format/dist/index.js";
import { shapeLayers } from "../../../../packages/player/dist/display/shapes.js";
import type { BitmapCharacter } from "../../../../packages/player/dist/display/timeline.js";
import * as w from "../../../swf-writer.ts";

function joined(edges: [number, number, number, number, number?, number?][]): number[][] {
  const records: ShapeRecord[] = [];
  for (const [x0, y0, x1, y1, cx, cy = 0] of edges) {
    records.push({
      type: "style",
      moveTo: { x: x0, y: y0 },
      fill0: 0,
      fill1: 1,
      line: 0,
      styles: null,
    });
    records.push(
      cx === undefined
        ? { type: "line", dx: x1 - x0, dy: y1 - y0 }
        : { type: "curve", cx: cx - x0, cy: cy - y0, ax: x1 - cx, ay: y1 - cy },
    );
  }

  const shape: Shape = {
    id: 1,
    bounds: { xMin: 0, xMax: 0, yMin: 0, yMax: 0 },
    edgeBounds: null,
    fills: [{ type: "solid", color: 0xff336699 }],
    lines: [],
    records,
    truncated: false,
  };

  return shapeLayers(shape)[0]?.fills[0]?.contours ?? [];
}

test("contours choose the first unused edge at a shared junction, preserving curves", () => {
  assert.deepEqual(
    joined([
      [-20, 0, 0, 0],
      [0, 0, 20, 0],
      [0, 0, 0, 20, 20, 20],
      [20, 0, 0, 0],
      [0, 20, -20, 0],
    ]),
    [[1, -1, 0, 2, 0, 0, 2, 1, 0, 2, 0, 0, 3, 1, 1, 0, 1, 2, -1, 0]],
  );
});

test("ordered edges that return to the start twice remain two contours", () => {
  assert.deepEqual(
    joined([
      [0, 0, 20, 0],
      [20, 0, 0, 0],
      [0, 0, 0, 20],
      [0, 20, 0, 0],
    ]),
    [
      [1, 0, 0, 2, 1, 0, 2, 0, 0],
      [1, 0, 0, 2, 0, 1, 2, 0, 0],
    ],
  );
});

test("an open endpoint never joins an edge that starts at a different coordinate", () => {
  assert.deepEqual(
    joined([
      [0, 0, 0, 20],
      [20, 0, 40, 0],
    ]),
    [
      [1, 0, 0, 2, 0, 1],
      [1, 1, 0, 2, 2, 0],
    ],
  );
});

test("contour joining retains fractional coordinates and very large coordinate spans", () => {
  for (const size of [0.25, 20, 1e9, Number.MAX_SAFE_INTEGER]) {
    const edges: [number, number, number, number][] = [
      [0, 0, size, 0],
      [size, 0, size, size],
      [size, size, 0, 0],
    ];
    const expected = [[1, 0, 0, 2, size / 20, 0, 2, size / 20, size / 20, 2, 0, 0]];
    assert.deepEqual(joined(edges), expected);
    assert.deepEqual(joined([edges[0], edges[2], edges[1]]), expected);
  }
});

test("completed zero-length contours are not reused by later open contours", () => {
  assert.deepEqual(
    joined([
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [20, 0, 0, 0],
      [40, 0, 0, 0],
    ]),
    [
      [1, 0, 0, 2, 0, 0],
      [1, 0, 0, 2, 0, 0],
      [1, 1, 0, 2, 0, 0],
      [1, 2, 0, 2, 0, 0],
    ],
  );
});

type Edges = Parameters<typeof joined>[0];

/** mulberry32, so that a failing case repeats from its seed. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Whether `edges` follow one contour in record order, back at the start only after the last. */
function chained(edges: Edges): boolean {
  const [startX, startY] = edges[0];
  let x = startX;
  let y = startY;
  for (let i = 0; i < edges.length; i++) {
    const [x0, y0, x1, y1] = edges[i];
    if (x0 !== x || y0 !== y || (i > 0 && x === startX && y === startY)) {
      return false;
    }

    x = x1;
    y = y1;
  }

  return true;
}

test("contours built in record order match the indexed walk on random edges", () => {
  const seed = 0x5eed;
  const random = mulberry32(seed);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)];
  // Few values, so that junctions collide: -0 meets 0, and fractions take the string keys.
  const values = [0, -0, 20, 0.5, -7.25, 40];
  // An edge that meets no other is a contour of its own, and makes the rest take the indexed walk.
  const detached: Edges[number] = [1e4, 1e4, 1e4 + 20, 1e4];
  const cases = 5000;
  let ordered = 0;
  for (let n = 0; n < cases; n++) {
    const points: (readonly [number, number])[] = [];
    for (let i = 2 + Math.floor(random() * 3); i > 0; i--) {
      points.push([pick(values), pick(values)]);
    }

    // Half the cases try to close one loop, coming back to its start only at the end.
    const loop = random() < 0.5;
    const start = pick(points);
    const count = 1 + Math.floor(random() * 8);
    const edges: Edges = [];
    let at = start;
    for (let i = 0; i < count; i++) {
      if (random() < 0.1) {
        at = pick(points);
      }

      let to = pick(points);
      if (loop && i === count - 1 && random() < 0.8) {
        to = start;
      }

      for (let tries = 0; loop && i < count - 1 && to === start && tries < 4; tries++) {
        to = pick(points);
      }

      edges.push(
        random() < 0.5
          ? [at[0], at[1], to[0], to[1]]
          : [at[0], at[1], to[0], to[1], pick(values), pick(values)],
      );
      at = to;
    }

    if (count > 1 && random() < 0.2) {
      const i = Math.floor(random() * count);
      const j = Math.floor(random() * count);
      [edges[i], edges[j]] = [edges[j], edges[i]];
    }

    if (chained(edges)) {
      ordered++;
    }

    const [alone, ...indexed] = joined([detached, ...edges]);
    assert.deepEqual(alone, [1, 500, 500, 2, 501, 500]);
    assert.deepEqual(joined(edges), indexed, `seed ${seed}, case ${n}`);
  }

  // Enough of the cases take the path built in record order for it to be what is tested.
  assert.ok(ordered > cases / 4, `${ordered} of ${cases} in record order`);
});

test("a bitmap fill takes its bitmap, its matrix from twips to pixels; one the SWF lacks stays its own", () => {
  const square = (fill: w.BitmapFill) =>
    w.shape({
      id: 2,
      bounds: [0, 200, 0, 200],
      fills: [fill],
      paths: [
        {
          fill1: 1,
          commands: [
            { move: [0, 0] },
            { line: [200, 0] },
            { line: [200, 200] },
            { line: [0, 200] },
            { line: [0, 0] },
          ],
        },
      ],
      version: 3,
    });
  const character = { type: "bitmap", id: 1 } as BitmapCharacter;
  const resolve = (id: number) => (id === 1 ? character : null);
  const layersOf = (fill: w.BitmapFill) => {
    const swf = readSwf(
      w.swf({ width: 10, height: 10, frameCount: 1, tags: [square(fill), w.end()] }),
    );
    const t = swf.tags[0];
    return shapeLayers(readShape(swf.bytes, t.code, t.offset, t.length), resolve);
  };

  const [found] = layersOf({ bitmap: 1, type: 0x43, matrix: { a: 100, d: 40, tx: 200, ty: -60 } });
  assert.deepEqual(found.fills[0].fill, {
    type: "image",
    image: character,
    matrix: { a: 5, b: 0, c: 0, d: 2, tx: 10, ty: -3 },
    repeat: false,
    smooth: false,
  });

  const [missing] = layersOf({ bitmap: 9, type: 0x40 });
  assert.equal(missing.fills[0].fill.type, "bitmap");
  assert.deepEqual(
    missing.fills[0].fill.type === "bitmap" && [
      missing.fills[0].fill.repeat,
      missing.fills[0].fill.smooth,
    ],
    [true, true],
  );
});

test("an edge with one fill on both sides bounds none, and is still stroked", () => {
  const swf = readSwf(
    w.swf({
      width: 10,
      height: 10,
      frameCount: 1,
      tags: [
        w.shape({
          id: 1,
          bounds: [0, 200, 0, 200],
          fills: [0x806655],
          lines: [{ width: 20, color: 0 }],
          paths: [
            { fill0: 1, fill1: 1, line: 1, commands: [{ move: [0, 100] }, { line: [200, 100] }] },
            {
              fill1: 1,
              commands: [
                { move: [0, 0] },
                { line: [200, 0] },
                { line: [200, 100] },
                { line: [200, 200] },
                { line: [0, 200] },
                { line: [0, 100] },
                { line: [0, 0] },
              ],
            },
          ],
        }),
        w.end(),
      ],
    }),
  );
  const t = swf.tags[0];
  const [layer] = shapeLayers(readShape(swf.bytes, t.code, t.offset, t.length));

  assert.deepEqual(layer.fills[0].contours, [
    [1, 0, 0, 2, 10, 0, 2, 10, 5, 2, 10, 10, 2, 0, 10, 2, 0, 5, 2, 0, 0],
  ]);
  assert.deepEqual(layer.strokes[0].paths, [[1, 0, 5, 2, 10, 5]]);
});

test("a DefineShape4 line's gradient or bitmap fill paints it, mapped as a fill's; a solid one is its colour", () => {
  const character = { type: "bitmap", id: 1 } as BitmapCharacter;
  const layerOf = (fill: number | w.BitmapFill | w.GradientFillSpec) => {
    const swf = readSwf(
      w.swf({
        width: 10,
        height: 10,
        frameCount: 1,
        tags: [
          w.shape({
            id: 2,
            version: 4,
            bounds: [0, 200, 0, 200],
            fills: [],
            lines: [{ width: 40, color: 0, fill }],
            paths: [{ fill1: 0, line: 1, commands: [{ move: [0, 0] }, { line: [200, 0] }] }],
          }),
          w.end(),
        ],
      }),
    );
    const t = swf.tags[0];
    const [layer] = shapeLayers(readShape(swf.bytes, t.code, t.offset, t.length), (id) =>
      id === 1 ? character : null,
    );
    return layer.strokes[0];
  };

  const gradient = layerOf({
    type: 0x10,
    matrix: { a: 0.5, d: 0.5, tx: 100, ty: 40 },
    stops: [
      [0, 0x80ff0000],
      [255, 0xff0000ff],
    ],
  });
  assert.equal(gradient.paint?.type, "gradient");
  assert.deepEqual(gradient.paint?.matrix, { a: 0.5, b: 0, c: 0, d: 0.5, tx: 5, ty: 2 });
  // The colour stays for what reads one alone: the first stop's.
  assert.equal(gradient.line.color, 0x80ff0000);

  const bitmap = layerOf({ bitmap: 1, type: 0x42, matrix: { a: 20, d: 20 } });
  assert.equal(bitmap.paint?.type, "image");
  assert.deepEqual(bitmap.paint?.matrix, { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 });

  assert.equal(layerOf(0xff336699).paint, undefined);
  assert.equal(layerOf(0xff336699).line.color, 0xff336699);
  // One of a bitmap the SWF lacks is its colour.
  assert.equal(layerOf({ bitmap: 7, type: 0x42 }).paint, undefined);
});
