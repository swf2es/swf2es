import assert from "node:assert/strict";
import { test } from "node:test";
import { readSwf } from "@swf2es/format";
import { Tessellator } from "@swf2es/native/render";
import { framePassed } from "../../../../packages/player/dist/display/shapeobject.js";
import type { ShapeLayer } from "../../../../packages/player/dist/display/shapes.js";
import {
  PATHS_IDLE_FRAMES,
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

/** A shape of a colour of its own, a fill and a line around it; filled with a bitmap, its SWF's own. */
function shapeOf(color: number, bitmap = false): ShapeCharacter {
  const swf = w.swf({
    width: 100,
    height: 100,
    frameRate: 24,
    frameCount: 1,
    tags: [
      w.fileAttributes(false),
      w.shape({
        id: 1,
        bounds: [0, 400, 0, 400],
        fills: [bitmap ? { bitmap: 7, type: 0x41, matrix: { a: 20, d: 20 } } : color],
        lines: [{ width: 20, color }],
        paths: [
          {
            fill1: 1,
            line: 1,
            commands: [
              { move: [0, 0] },
              { curve: [200, -100, 400, 0] },
              { line: [400, 400] },
              { line: [0, 0] },
            ],
          },
        ],
      }),
      w.showFrame(),
      w.end(),
    ],
  });
  const shape = readLibrary(readSwf(swf)).characters.get(1);
  assert.ok(shape?.type === "shape");
  return shape;
}

function pathsOf(layers: ShapeLayer[]): number[][][] {
  return layers.flatMap((layer) => [
    ...layer.fills.map((f) => f.contours),
    ...layer.strokes.map((s) => s.paths),
  ]);
}

/** Frames enough for paths unread since the first to be let go of, a sweep's wait included. */
function idle(): void {
  for (let i = 0; i < PATHS_IDLE_FRAMES * 2; i++) {
    framePassed();
  }
}

test("a shape's paths unread for long are let go of, and read again from its tag alike", () => {
  for (const bitmap of [false, true]) {
    const shape = shapeOf(0x123456 + (bitmap ? 1 : 0), bitmap);
    const layers = shape.layers;
    const fill = layers[0].fills[0];
    const stroke = layers[0].strokes[0];
    const first = pathsOf(layers);
    const paint = fill.fill;
    assert.ok(first.length === 2 && first.every((paths) => paths.length > 0));

    idle();
    assert.equal(
      shapesHoldingPaths(),
      0,
      "every shape's paths let go of once unread for long enough",
    );

    // The same layers, fills, lines and paints, which the renderer keeps its geometry by.
    assert.equal(shape.layers, layers);
    assert.equal(layers[0].fills[0], fill);
    assert.equal(layers[0].strokes[0], stroke);
    assert.equal(fill.fill, paint);
    const again = pathsOf(layers);
    assert.notEqual(again[0], first[0]);
    assert.deepEqual(again, first);
    assert.equal(shapesHoldingPaths(), 1);
  }
});

test("a shape's paths read on every frame are kept", () => {
  const shape = shapeOf(0x223344);
  const contours = shape.layers[0].fills[0].contours;
  for (let i = 0; i < PATHS_IDLE_FRAMES * 3; i++) {
    framePassed();
    assert.equal(shape.layers[0].fills[0].contours, contours);
  }
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
  const shape = shapeOf(0x334455);
  const made = parts.partsOf(shape.layers[0], 0);
  assert.equal(calls, 1);

  for (let i = 0; i < PATHS_IDLE_FRAMES * 2; i++) {
    for (const part of parts.partsOf(shape.layers[0], 0)) {
      geometries.use(part.handle.id);
    }

    framePassed();
    geometries.endFrame();
  }

  assert.equal(shapesHoldingPaths(), 0);
  assert.equal(parts.partsOf(shape.layers[0], 0), made);
  assert.equal(calls, 1);
});
