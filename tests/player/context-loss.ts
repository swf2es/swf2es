// A WebGL context lost and given back while a SWF plays: what the view
// and its renderer keep on the CPU of what they uploaded must draw the same
// again. Large shapes and small ones in the geometry atlas, a colour
// transform, a gradient and a line; a bitmap that never changes, placed and
// as a smoothed fill, which uploads again from its store; glows, and a
// blurred sprite holding a glowing one, filtered layers drawn ahead of the
// stage, whose kept outputs go with the context.
import assert from "node:assert/strict";
import { deflateSync } from "node:zlib";
import * as w from "../swf-writer.ts";
import { playLosingContext, playLosingContextPlan } from "./chrome.ts";

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

// Small shapes moving every frame: batched elements written in place, not rebuilt.
const moving = w.sprite(5, 4, [
  w.place({ depth: 1, character: 2 }),
  w.place({ depth: 2, character: 2, matrix: { tx: 500 } }),
  w.showFrame(),
  w.place({ depth: 1, move: true, matrix: { tx: 120, ty: 40 } }),
  w.place({ depth: 2, move: true, matrix: { tx: 620, ty: -40 } }),
  w.showFrame(),
  w.place({ depth: 1, move: true, matrix: { tx: 240, ty: 80 } }),
  w.place({ depth: 2, move: true, matrix: { tx: 740, ty: -80 } }),
  w.showFrame(),
  w.place({ depth: 1, move: true, matrix: { tx: 120, ty: 120 } }),
  w.place({ depth: 2, move: true, matrix: { tx: 620, ty: 0 } }),
  w.showFrame(),
]);

// DefineBitsLossless2: 16 by 16 premultiplied ARGB, no two rows alike.
const argb = new Uint8Array(16 * 16 * 4);
for (let i = 0; i < 256; i++) {
  argb.set([255, (i * 7) & 0xff, (i * 13) & 0xff, (i * 29) & 0xff], i * 4);
}

const image = w.tag(36, Uint8Array.from([6, 0, 5, 16, 0, 16, 0, ...deflateSync(argb)]), true);
const filled = w.shape({
  id: 7,
  bounds: [0, 1200, 0, 1200],
  fills: [{ type: 0x41, bitmap: 6, matrix: { a: 75, d: 75 } }],
  paths: [
    {
      fill1: 1,
      commands: [{ move: [0, 0] }, { line: [1200, 0] }, { line: [1200, 1200] }, { line: [0, 0] }],
    },
  ],
});

// A blurred sprite holding a glowing one: filtered layers in a filtered layer.
const nested = w.sprite(8, 1, [
  w.place({ depth: 1, character: 2, glows: [{ color: 0x00ccff, blur: 4, strength: 2 }] }),
  w.showFrame(),
]);

const tags: Uint8Array[] = [
  w.fileAttributes(false),
  large,
  small,
  shaded,
  turning,
  moving,
  image,
  filled,
  nested,
];
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
      // Glowing: filtered layers drawn ahead of the stage.
      glows: i % 4 === 1 ? [{ color: 0xff3300, blur: 6, strength: 2 }] : undefined,
    }),
    w.place({ depth: depth++, character: 2, matrix: { tx: tx + 200, ty: ty + 200 } }),
  );
}

for (let i = 0; i < 6; i++) {
  tags.push(w.place({ depth: depth++, character: 5, matrix: { tx: 300 + i * 1200, ty: 5200 } }));
}

tags.push(
  w.place({ depth: depth++, character: 3, matrix: { a: 0.6, d: 0.6, tx: 7000, ty: 5000 } }),
  w.place({
    depth: depth++,
    character: 6,
    matrix: { a: 4, d: 4, tx: 200, ty: 3800 },
    hasImage: true,
  }),
  w.place({ depth: depth++, character: 7, matrix: { tx: 1700, ty: 3800 } }),
  w.place({ depth: depth++, character: 8, matrix: { tx: 4500, ty: 4300 }, blurs: [3] }),
  w.showFrame(),
  w.end(),
);
const swf = w.swf({ width: 400, height: 300, frameCount: 1, tags });

// Layers: a glowing sprite's, and sprites blended over (overlay, read from a copy of what is
// below) and screened (blended by the GPU), all drawn again from their objects once the context
// is back.
const parts = w.sprite(8, 1, [
  w.place({ depth: 1, character: 2 }),
  w.place({ depth: 2, character: 2, matrix: { tx: 200, ty: 150 } }),
  w.showFrame(),
]);
const layered = w.swf({
  width: 400,
  height: 300,
  frameCount: 1,
  tags: [
    w.fileAttributes(false),
    large,
    small,
    parts,
    w.place({ depth: 1, character: 1, matrix: { a: 2, d: 2, tx: 4000, ty: 3000 } }),
    w.place({
      depth: 2,
      character: 8,
      matrix: { tx: 800, ty: 800 },
      glows: [{ color: 0xffff00, blur: 8, strength: 2 }],
    }),
    w.place({ depth: 3, character: 8, matrix: { tx: 2400, ty: 800 }, blendMode: 13 }),
    w.place({ depth: 4, character: 8, matrix: { tx: 4000, ty: 800 }, blendMode: 4 }),
    w.place({
      depth: 5,
      character: 8,
      matrix: { tx: 5600, ty: 800 },
      blendMode: 13,
      glows: [{ color: 0x00ffff, blur: 4, strength: 1 }],
    }),
    w.showFrame(),
    w.end(),
  ],
});
assert.equal(await playLosingContext(layered, 4), null, "kept filter outputs and blend layers");

assert.equal(await playLosingContext(swf, 4), null, "drawn again");
assert.equal(await playLosingContext(swf, 4, true), null, "with objects turned in 3D");
// Lost for frames that draw into nothing, lost twice, and resized while lost and after: every
// frame drawn with a context matches a renderer that kept its own.
for (const plan of ["tttltttrtt", "ttltrtltrtt", "ttlstrtstt", "tltttrsttltrt"]) {
  assert.equal(await playLosingContextPlan(swf, plan), null, plan);
}

console.log("context-loss: ok");
