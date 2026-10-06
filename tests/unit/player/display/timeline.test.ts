import assert from "node:assert/strict";
import { test } from "node:test";
import { readShape, readSwf } from "@swf2es/format";
import { shapeLayers } from "../../../../packages/player/dist/display/shapes.js";
import { readLibrary } from "../../../../packages/player/dist/display/timeline.js";
import * as w from "../../../swf-writer.ts";

function movie(fill: number | w.BitmapFill): Uint8Array {
  return w.swf({
    width: 100,
    height: 100,
    frameRate: 24,
    frameCount: 1,
    tags: [
      w.fileAttributes(false),
      w.shape({
        id: 1,
        bounds: [0, 400, 0, 400],
        fills: [fill],
        lines: [{ width: 20, color: 0x000000 }],
        paths: [
          {
            fill1: 1,
            line: 1,
            commands: [
              { move: [0, 0] },
              { line: [400, 0] },
              { line: [400, 400] },
              { line: [0, 0] },
            ],
          },
        ],
      }),
      w.place({ depth: 1, character: 1 }),
      w.showFrame(),
      w.end(),
    ],
  });
}

const shapeIn = (bytes: Uint8Array) => readLibrary(readSwf(bytes)).characters.get(1);

test("a SWF read again shares its shapes with the first, and only the shapes alike", () => {
  const red = movie(0xff0000);
  const first = shapeIn(red);
  assert.equal(first?.type, "shape");

  // Read again, from a copy of its bytes, as a second load would be.
  assert.equal(shapeIn(red.slice()), first);

  // Another colour is another shape.
  assert.notEqual(shapeIn(movie(0x00ff00)), first);
});

test("a shape filled with a bitmap keeps to its SWF", () => {
  const filled = movie({ bitmap: 7, type: 0x41, matrix: { a: 20, d: 20 } });
  assert.notEqual(shapeIn(filled), shapeIn(filled.slice()));
});

test("a shape is drawn into layers when first asked for, as it was at once", () => {
  const bytes = movie(0x0000ff);
  const swf = readSwf(bytes);
  const shape = readLibrary(swf).characters.get(1);
  assert.equal(shape?.type, "shape");
  if (shape?.type !== "shape") {
    return;
  }

  // An accessor, not layers made as the SWF was read.
  assert.equal(typeof Object.getOwnPropertyDescriptor(shape, "layers")?.get, "function");
  assert.deepEqual(Object.keys(shape.shape).sort(), ["bounds", "edgeBounds"]);

  const tag = swf.tags.find((t) => t.code === 2 || t.code === 22 || t.code === 32 || t.code === 83);
  assert.ok(tag);
  const eager = shapeLayers(readShape(swf.bytes, tag.code, tag.offset, tag.length));
  assert.deepEqual(shape.layers, eager);
  assert.equal(shape.layers, shape.layers);
});
