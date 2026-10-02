// A shape's bitmap fills tied to the SWF's bitmaps as it is read.
import assert from "node:assert/strict";
import { test } from "node:test";
import { readShape, readSwf } from "../../../packages/format/dist/index.js";
import { shapeLayers } from "../../../packages/player/dist/shapes.js";
import type { BitmapCharacter } from "../../../packages/player/dist/timeline.js";
import * as w from "../../swf-writer.ts";

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
