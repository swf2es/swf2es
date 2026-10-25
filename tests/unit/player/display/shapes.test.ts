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
    assert.deepEqual(
      joined([
        [0, 0, size, 0],
        [size, 0, size, size],
        [size, size, 0, 0],
      ]),
      [[1, 0, 0, 2, size / 20, 0, 2, size / 20, size / 20, 2, 0, 0]],
    );
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
