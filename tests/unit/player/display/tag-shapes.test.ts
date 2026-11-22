import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { readShape, readSwf, zlibCompress } from "@swf2es/format";
import { Tessellator } from "@swf2es/native/render";
import { hitsPoint } from "../../../../packages/player/dist/display/bounds.js";
import { Container } from "../../../../packages/player/dist/display/container.js";
import { ShapeObject } from "../../../../packages/player/dist/display/display.js";
import { graphicsData } from "../../../../packages/player/dist/display/graphicsdata.js";
import { axis, sliceLayers } from "../../../../packages/player/dist/display/scale9.js";
import { framePassed } from "../../../../packages/player/dist/display/shapeobject.js";
import { type ShapeLayer, shapeLayers } from "../../../../packages/player/dist/display/shapes.js";
import {
  PATHS_IDLE_MS,
  shapesHoldingPaths,
} from "../../../../packages/player/dist/display/tag-shapes.js";
import {
  readLibrary,
  type ShapeCharacter,
} from "../../../../packages/player/dist/display/timeline.js";
import { LineCache } from "../../../../packages/player/dist/scene/lines.js";
import { Parts } from "../../../../packages/player/dist/scene/parts.js";
import { Geometries } from "../../../../packages/render/dist/index.js";
import * as w from "../../../swf-writer.ts";

// The paths go by the clock, which the tests move on.
mock.timers.enable({ apis: ["Date"], now: Date.now() });

/** Time enough for paths unread since the last frame to be let go of, and a frame to sweep them. */
function idle(): void {
  mock.timers.tick(PATHS_IDLE_MS + 1000);
  framePassed();
}

/** A 2 by 3 DefineBitsLossless2 of id 7. */
function bitmapTag(): Uint8Array {
  const raw = new Uint8Array(2 * 3 * 4).fill(0xff);
  return w.tag(36, Uint8Array.from([7, 0, 5, 2, 0, 3, 0, ...zlibCompress(raw)]), true);
}

/**
 * Two sets of styles: the first's second fill and its two lines, its first fill unused, so
 * that a fill's slot is not its style's index; then a style change to a fill and a line of
 * their own. A `bitmap` fills the first set's drawn fill with bitmap 7, which the SWF defines.
 */
function shapeTag(color: number, bitmap = false): Uint8Array {
  return w.shape({
    id: 1,
    version: 3,
    bounds: [-100, 1100, -200, 1100],
    fills: [
      0xff000000 | color,
      bitmap ? { bitmap: 7, type: 0x41, matrix: { a: 20, d: 20 } } : 0xff00ff00,
    ],
    lines: [
      { width: 20, color: 0xff000000 },
      { width: 60, color: 0xff0000ff | color },
    ],
    paths: [
      {
        fill1: 2,
        line: 1,
        commands: [
          { move: [0, 0] },
          { curve: [200, -100, 400, 0] },
          { line: [400, 400] },
          { line: [0, 0] },
        ],
      },
      { fill1: 0, line: 2, commands: [{ move: [0, 600] }, { line: [400, 600] }] },
      {
        styles: { fills: [0xffff0000], lines: [{ width: 40, color: 0xff00ff00 }] },
        fill1: 1,
        line: 1,
        commands: [
          { move: [600, 600] },
          { line: [1000, 600] },
          { line: [1000, 1000] },
          { line: [600, 1000] },
          { line: [600, 600] },
        ],
      },
    ],
  });
}

function movie(color: number, bitmap = false): Uint8Array {
  return w.swf({
    width: 100,
    height: 100,
    frameRate: 24,
    frameCount: 1,
    tags: [
      w.fileAttributes(false),
      ...(bitmap ? [bitmapTag()] : []),
      shapeTag(color, bitmap),
      w.showFrame(),
      w.end(),
    ],
  });
}

function shapeIn(bytes: Uint8Array): ShapeCharacter {
  const shape = readLibrary(readSwf(bytes)).characters.get(1);
  assert.ok(shape?.type === "shape");
  return shape;
}

/** Layers as plain objects, as shapeLayers makes them. */
function plain(layers: ShapeLayer[]): ShapeLayer[] {
  return layers.map((layer) => ({
    fills: layer.fills.map(({ fill, contours, winding }) => ({ fill, contours, winding })),
    strokes: layer.strokes.map(({ line, paths, paint }) =>
      paint ? { line, paths, paint } : { line, paths },
    ),
  }));
}

function pathsOf(layers: ShapeLayer[]): number[][][] {
  return layers.flatMap((layer) => [
    ...layer.fills.map((f) => f.contours),
    ...layer.strokes.map((s) => s.paths),
  ]);
}

test("a shape's paths unread for long are let go of, and read again from its tag alike", () => {
  const bytes = movie(0x123456);
  const shape = shapeIn(bytes);
  const layers = shape.layers;
  // Two layers, the first of one fill (the second style) and two lines, the second of one each.
  assert.deepEqual(
    layers.map((l) => [l.fills.length, l.strokes.length]),
    [
      [1, 2],
      [1, 1],
    ],
  );
  assert.ok(layers[0].strokes.every((s) => !Object.hasOwn(s, "paint")));

  const swf = readSwf(bytes);
  const tag = swf.tags.find((t) => t.code === 32);
  assert.ok(tag);
  const eager = shapeLayers(readShape(swf.bytes, tag.code, tag.offset, tag.length, swf.version));
  assert.deepEqual(plain(layers), eager);
  const fills = layers.flatMap((l) => l.fills);
  const strokes = layers.flatMap((l) => l.strokes);
  const first = pathsOf(layers);

  idle();
  assert.equal(shapesHoldingPaths(), 0, "every shape's paths let go of once unread long enough");

  // The same layers, fills, lines and paints, which the renderer keeps its geometry by.
  assert.equal(shape.layers, layers);
  assert.ok(layers.flatMap((l) => l.fills).every((f, i) => f === fills[i]));
  assert.ok(layers.flatMap((l) => l.strokes).every((s, i) => s === strokes[i]));
  const again = pathsOf(layers);
  assert.notEqual(again[0], first[0]);
  assert.deepEqual(again, first);
  assert.deepEqual(plain(layers), eager);
  assert.equal(shapesHoldingPaths(), 1);
});

test("a shape filled with its SWF's bitmap keeps the paint it was drawn with, read again", () => {
  const shape = shapeIn(movie(0x234567, true));
  const fill = shape.layers[0].fills[0];
  const paint = fill.fill;
  assert.equal(paint.type, "image");
  const contours = fill.contours;

  idle();
  assert.equal(shapesHoldingPaths(), 0);
  assert.deepEqual(fill.contours, contours);
  assert.equal(shape.layers[0].fills[0].fill, paint);
});

test("a shape two SWFs share reads its paths again for both", () => {
  const bytes = movie(0x345678);
  const shape = shapeIn(bytes);
  const contours = shape.layers[1].fills[0].contours;
  assert.equal(shapeIn(bytes.slice()), shape);

  idle();
  assert.equal(shapesHoldingPaths(), 0);
  assert.equal(shapeIn(bytes.slice()), shape);
  assert.deepEqual(shape.layers[1].fills[0].contours, contours);
});

test("a shape's paths read on every frame are kept", () => {
  const shape = shapeIn(movie(0x456789));
  const contours = shape.layers[0].fills[0].contours;
  for (let i = 0; i < 300; i++) {
    mock.timers.tick(100);
    framePassed();
    assert.equal(shape.layers[0].fills[0].contours, contours);
  }
});

test("a shape test far from a shape whose paths were let go of reads none of them", () => {
  const shape = shapeIn(movie(0x56789a));
  const root = new Container();
  root.loaderInfo = {} as never;
  const o = new ShapeObject(shape);
  root.addChildAt(o, 0);
  // Inside the first fill, on the second line, and in nothing.
  assert.equal(hitsPoint(o, 15, 8, true, root), true);
  assert.equal(hitsPoint(o, 10, 30, true, root), true);
  assert.equal(hitsPoint(o, 25, 10, true, root), false);

  idle();
  assert.equal(shapesHoldingPaths(), 0);
  // Past the paths' box and the widest line's half: no paths read.
  assert.equal(hitsPoint(o, 200, 200, true, root), false);
  assert.equal(hitsPoint(o, -1.6, 10, true, root), false);
  assert.equal(shapesHoldingPaths(), 0);
  // Within the box, even where nothing is hit: read again, and hit as before.
  assert.equal(hitsPoint(o, 25, 10, true, root), false);
  assert.equal(shapesHoldingPaths(), 1);
  assert.equal(hitsPoint(o, 15, 8, true, root), true);
  assert.equal(hitsPoint(o, 10, 30, true, root), true);
  // The 2-pixel line around the square, within its half width, past the box's edge.
  assert.equal(hitsPoint(o, 50.8, 40, true, root), true);
});

test("readGraphicsData, a 9-slice and lines stroked anew read a shape's paths again alike", () => {
  const tessellator = new Tessellator();
  const geometries = new Geometries();
  let strokes = 0;
  const t = tessellator.tessellate;
  const tessellate = {
    layer: t.layer,
    lines: {
      input: (n: number) => t.lines.input(n),
      build: (...args: Parameters<typeof t.lines.build>) => {
        strokes++;
        return t.lines.build(...args);
      },
    },
  };
  const lines = new LineCache(geometries, tessellate);
  const shape = shapeIn(movie(0x6789ab));
  const layers = shape.layers;
  const read = () => {
    const out: unknown[] = [];
    graphicsData(layers, { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 }, new WeakSet(), out as never);
    return out;
  };
  const data = read();
  const slice = { x: axis(0, 10, 40, 50, 2), y: axis(0, 10, 40, 50, 2), key: "2x2" };
  const sliced = sliceLayers(layers, slice, null);
  assert.ok(lines.take(layers[0], 0, Float64Array.of(1, 0, 0, 1, 1), null, true));
  const stroked = strokes;
  assert.ok(stroked > 0);

  idle();
  assert.equal(shapesHoldingPaths(), 0);
  // The slice kept for the layers, which are the same.
  assert.equal(sliceLayers(layers, slice, null), sliced);
  assert.equal(shapesHoldingPaths(), 0);
  assert.ok(lines.take(layers[0], 0, Float64Array.of(2, 0, 0, 2, 1), null, true));
  assert.ok(strokes > stroked);
  assert.equal(shapesHoldingPaths(), 1);
  assert.deepEqual(read(), data);
});

test("a shape drawn on, its paths let go of, is not tessellated again", () => {
  const tessellator = new Tessellator();
  const geometries = new Geometries();
  let calls = 0;
  const tessellate = {
    layer: (...args: Parameters<typeof tessellator.tessellate.layer>) => {
      calls++;
      return tessellator.tessellate.layer(...args);
    },
    lines: tessellator.tessellate.lines,
  };
  const parts = new Parts(geometries, tessellate, new LineCache(geometries, tessellate));
  const shape = shapeIn(movie(0x789abc));
  const made = parts.partsOf(shape.layers[0], 0);
  assert.equal(calls, 1);

  for (let i = 0; i < 120; i++) {
    for (const part of parts.partsOf(shape.layers[0], 0)) {
      geometries.use(part.handle.id);
    }

    mock.timers.tick(100);
    framePassed();
    geometries.endFrame();
  }

  assert.equal(shapesHoldingPaths(), 0);
  assert.equal(parts.partsOf(shape.layers[0], 0), made);
  assert.equal(calls, 1);
});
