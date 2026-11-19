// A repeating bitmap fill whose matrix collapses the plane, drawn a texel to
// a stage pixel from the stage's corner (collapsed-bitmaps), on a stage
// shown at a half, a quarter and a tenth of its size: each screen pixel the
// texel of the stage pixel under its centre, every one of them. Those
// centres fall on whole stage pixels, where the interpolated position may
// come a hair either side, and the fill once read a texel or its neighbour
// as each pixel and triangle rounded it, a speckle that moved as the stage
// did. Smoothed and not, turned and not, which rounds the triangles apart.
//
//   node tests/player/stage-texels.ts
import assert from "node:assert/strict";
import { zlibCompress } from "../../packages/format/dist/index.js";
import * as w from "../swf-writer.ts";
import { runPlayer } from "./chrome.ts";
import { decodePng } from "./image.ts";

// 4 by 4 texels, each its own colour: red counts the column, green the row.
const pixels: number[] = [];
for (let i = 0; i < 16; i++) {
  pixels.push(255, 40 + (i % 4) * 70, 40 + (i >> 2) * 70, 120);
}

const SIZE = 400;
const square = (x: number, y: number, size: number) => [
  { move: [x, y] as [number, number] },
  { line: [x + size, y] as [number, number] },
  { line: [x + size, y + size] as [number, number] },
  { line: [x, y + size] as [number, number] },
  { line: [x, y] as [number, number] },
];
const tags: Uint8Array[] = [
  w.fileAttributes(true),
  w.backgroundColor(0x808080),
  w.tag(20, Uint8Array.from([1, 0, 5, 4, 0, 4, 0, ...zlibCompress(Uint8Array.from(pixels))]), true),
];
// Repeating, smoothed in a square over the stage turned in its place, so that its triangles cut
// the pixels otherwise, and not smoothed in one unturned over its left half.
[0x40, 0x42].forEach((type, i) => {
  const cover = i === 0 ? square(-8000, -8000, 16000) : square(0, 0, (SIZE / 2) * 20);
  tags.push(
    w.shape({
      id: 2 + i,
      version: 3,
      bounds: i === 0 ? [-8000, 8000, -8000, 8000] : [0, SIZE * 10, 0, SIZE * 10],
      fills: [{ bitmap: 1, type: type as 0x40 | 0x42, matrix: { a: 0, d: 0 } }],
      paths: [{ fill1: 1, commands: cover }],
    }),
  );
});
const turn = Math.SQRT1_2;
tags.push(
  w.place({
    depth: 1,
    character: 2,
    matrix: { a: turn, b: turn, c: -turn, d: turn, tx: (SIZE / 2) * 20, ty: (SIZE / 4) * 20 },
  }),
  w.place({ depth: 2, character: 3 }),
  w.showFrame(),
  w.end(),
);
const swf = w.swf({ width: SIZE, height: SIZE / 2, frameRate: 24, frameCount: 1, tags });

const zooms = [0.5, 0.25, 0.1];
const results = await runPlayer(
  zooms.map((zoom) => ({ swf, frames: 1, capture: [1], quality: "low", zoom, shown: true })),
);
for (const [k, zoom] of zooms.entries()) {
  const png = results[k].images.get(1);
  assert.ok(png, `no frame at a zoom of ${zoom}`);
  const image = decodePng(png);
  let wrong = 0;
  let first = "";
  // Each screen pixel away from the halves' edges: the texel of the stage pixel under its centre.
  for (let y = 1; y < image.height - 1; y++) {
    for (let x = 1; x < image.width - 1; x++) {
      if (Math.abs(x - image.width / 2) < 2) {
        continue;
      }

      const sx = Math.floor((x + 0.5) / zoom);
      const sy = Math.floor((y + 0.5) / zoom);
      const at = (y * image.width + x) * 4;
      const r = 40 + (sx % 4) * 70;
      const g = 40 + (sy % 4) * 70;
      if (Math.abs(image.data[at] - r) > 2 || Math.abs(image.data[at + 1] - g) > 2) {
        wrong++;
        first ||= `(${x}, ${y}) ${image.data[at]},${image.data[at + 1]} for ${r},${g}`;
      }
    }
  }

  assert.equal(wrong, 0, `at a zoom of ${zoom}, ${wrong} pixels of another texel, first ${first}`);
}

console.log(`stage texels: ok at zooms ${zooms.join(", ")}`);
