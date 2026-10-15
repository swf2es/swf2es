// A host resizing its renderer while filters inside filters play, as a
// page fitting the stage to a window being resized does: Pixi's texture
// pool lets go of the textures it kept for the old size, and the frames
// drawn after must not throw.
import assert from "node:assert/strict";
import * as w from "../swf-writer.ts";
import { playResized } from "./chrome.ts";

const square = w.shape({
  id: 1,
  bounds: [0, 2000, 0, 2000],
  fills: [0x3366cc],
  paths: [
    {
      fill1: 1,
      commands: [
        { move: [0, 0] },
        { line: [2000, 0] },
        { line: [2000, 2000] },
        { line: [0, 2000] },
        { line: [0, 0] },
      ],
    },
  ],
});
// Three levels of filtered sprites, the inner one moving every frame, and
// enough draws beside them for the view to give the middle one a render
// group of its own.
const inner = w.sprite(2, 2, [
  w.place({ depth: 1, character: 1, blurs: [4] }),
  w.showFrame(),
  w.place({ depth: 1, move: true, matrix: { tx: 40 } }),
  w.showFrame(),
]);
const middle = w.sprite(3, 1, [
  w.place({ depth: 1, character: 2, shadows: [{ blur: 6, distance: 4, angle: 45 }] }),
  w.place({ depth: 2, character: 2, matrix: { tx: 1200 }, cacheAsBitmap: true }),
  ...Array.from({ length: 80 }, (_, i) =>
    w.place({ depth: 3 + i, character: 1, matrix: { a: 0.1, d: 0.1, tx: i * 40, ty: 2400 } }),
  ),
  w.showFrame(),
]);
const outer = w.sprite(4, 1, [
  w.place({ depth: 1, character: 3, glows: [{ color: 0xffcc00, blur: 8, strength: 2 }] }),
  w.showFrame(),
]);
const swf = w.swf({
  width: 400,
  height: 300,
  frameCount: 1,
  tags: [
    w.fileAttributes(false),
    square,
    inner,
    middle,
    outer,
    w.place({ depth: 1, character: 4, matrix: { tx: 400, ty: 400 }, blurs: [2] }),
    w.showFrame(),
    w.end(),
  ],
});

const sizes: [number, number, number][] = [];
for (const resolution of [1, 1.25, 2, 1.5, 3, 0.75, 1]) {
  for (const [width, height] of [
    [400, 300],
    [640, 480],
    [333, 517],
    [1024, 600],
  ]) {
    sizes.push([width, height, resolution], [width, height, resolution]);
  }
}

assert.equal(await playResized(swf, sizes), null);
console.log("resize: ok");
