import assert from "node:assert/strict";
import { test } from "node:test";
import { readMorphShape, readSwf } from "../../packages/format/dist/index.js";
import { Container, ShapeObject } from "../../packages/player/dist/display/display.js";
import { morphAt } from "../../packages/player/dist/display/morph.js";
import { morphShape, swf } from "../swf-writer.ts";
import { presentedMorph } from "./scene/presented.ts";

test("acknowledging an older rendered morph preserves its live animation ratio", () => {
  const parsed = readSwf(
    swf({
      width: 100,
      height: 100,
      frameRate: 24,
      frameCount: 1,
      tags: [
        morphShape({
          id: 1,
          startBounds: [0, 100, 0, 100],
          endBounds: [0, 200, 0, 200],
          fills: [{ start: 0xffff0000, end: 0xff0000ff }],
          start: [
            {
              fill1: 1,
              commands: [
                { move: [0, 0] },
                { line: [100, 0] },
                { line: [100, 100] },
                { line: [0, 100] },
                { line: [0, 0] },
              ],
            },
          ],
          end: [
            [
              { move: [0, 0] },
              { line: [200, 0] },
              { line: [200, 200] },
              { line: [0, 200] },
              { line: [0, 0] },
            ],
          ],
        }),
      ],
    }),
  );
  const tag = parsed.tags[0];
  const morph = {
    type: "morph" as const,
    id: 1,
    morph: readMorphShape(parsed.bytes, tag.code, tag.offset, tag.length),
    blends: new Map(),
    bitmap: () => null,
  };
  const object = ShapeObject.ofMorph(morph),
    stage = new Container();
  stage.addChildAt(object, 0);
  object.ratio = 65535;
  presentedMorph(stage, { object, morph, ratio: 21845 });
  assert.equal(object.ratio, 65535);
  assert.equal(object.shape, morphAt(morph, 21845));
  stage.removeChild(object);
  const shape = object.shape;
  presentedMorph(stage, { object, morph, ratio: 65535 });
  assert.equal(object.shape, shape);
  assert.equal(object.ratio, 65535);
});
