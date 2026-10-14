// A WebGL context lost and given back while a SWF plays: what the view
// and Pixi keep on the CPU of what they uploaded must draw the same again.
// Large shapes, drawn alone through the transform table's atlas, small
// ones batched, a colour transform, a gradient and a line.
import assert from "node:assert/strict";
import * as w from "../swf-writer.ts";
import { playLosingContext } from "./chrome.ts";

/** A closed ring of `n` curves round (cx, cy), `r` twips out: hundreds of vertices once flattened. */
function ring(cx: number, cy: number, r: number, n: number): w.PathCommand[] {
  const at = (a: number, k: number): [number, number] => [
    Math.round(cx + Math.cos(a) * r * k),
    Math.round(cy + Math.sin(a) * r * k),
  ];
  const commands: w.PathCommand[] = [{ move: at(0, 1) }];
  for (let i = 0; i < n; i++) {
    const a = ((i + 0.5) * 2 * Math.PI) / n;
    const b = ((i + 1) * 2 * Math.PI) / n;
    commands.push({ curve: [...at(a, i % 2 ? 1.2 : 0.8), ...at(b, 1)] });
  }

  return commands;
}

const large = w.shape({
  id: 1,
  bounds: [-1400, 1400, -1400, 1400],
  fills: [0x3366cc],
  lines: [{ width: 40, color: 0x113355 }],
  paths: [{ fill1: 1, line: 1, commands: ring(0, 0, 1000, 160) }],
});
const small = w.shape({
  id: 2,
  bounds: [0, 400, 0, 400],
  fills: [0xcc6633],
  paths: [
    {
      fill1: 1,
      commands: [{ move: [0, 0] }, { line: [400, 0] }, { line: [200, 400] }, { line: [0, 0] }],
    },
  ],
});
const shaded = w.shape({
  id: 3,
  bounds: [-1400, 1400, -1400, 1400],
  fills: [
    {
      type: 0x12,
      matrix: { a: 0.08, d: 0.08 },
      stops: [
        [0, 0xffffff],
        [255, 0x228822],
      ],
    },
  ],
  paths: [{ fill1: 1, commands: ring(0, 0, 1200, 120) }],
});
const turning = w.sprite(4, 2, [
  w.place({ depth: 1, character: 1 }),
  w.showFrame(),
  w.place({ depth: 1, move: true, matrix: { a: 0.9, b: 0.3, c: -0.3, d: 0.9 } }),
  w.showFrame(),
]);

const tags: Uint8Array[] = [w.fileAttributes(false), large, small, shaded, turning];
let depth = 1;
for (let i = 0; i < 24; i++) {
  const tx = 600 + (i % 6) * 1300;
  const ty = 600 + Math.floor(i / 6) * 1300;
  tags.push(
    w.place({
      depth: depth++,
      character: i % 3 === 2 ? 4 : 1,
      matrix: { a: 0.5, d: 0.5, tx, ty },
      colorTransform: i % 5 === 0 ? { mult: [0.5, 1, 1, 1], add: [60, 0, 0, 0] } : undefined,
    }),
    w.place({ depth: depth++, character: 2, matrix: { tx: tx + 200, ty: ty + 200 } }),
  );
}

tags.push(
  w.place({ depth: depth++, character: 3, matrix: { a: 0.6, d: 0.6, tx: 7000, ty: 5000 } }),
  w.showFrame(),
  w.end(),
);
const swf = w.swf({ width: 400, height: 300, frameCount: 1, tags });

// Through the table's atlas, and drawn alone from what Pixi packed of each, as without the table.
assert.equal(await playLosingContext(swf, 4, true), null, "with the transform table");
assert.equal(await playLosingContext(swf, 4, false), null, "without the transform table");
assert.equal(await playLosingContext(swf, 4, true, true), null, "with objects turned in 3D");
console.log("context-loss: ok");
