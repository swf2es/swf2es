// A morph shape blended at a ratio, and a MorphShape taking its ratio on as it is drawn.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ShapeRecord } from "../../../packages/format/dist/index.js";
import { readMorphShape, readPlace, readSwf } from "../../../packages/format/dist/index.js";
import { ShapeObject } from "../../../packages/player/dist/display.js";
import { blend, morphAt } from "../../../packages/player/dist/morph.js";
import type { MorphCharacter } from "../../../packages/player/dist/timeline.js";
import * as w from "../../swf-writer.ts";

// A square whose top and left sides bend into curves, red to blue, its
// path filled on both sides.
const tag = w.morphShape({
  id: 1,
  startBounds: [0, 1200, 0, 1200],
  endBounds: [-200, 1400, -200, 1400],
  fills: [
    { start: 0xffff0000, end: 0xff0000ff },
    { start: 0xff00ff00, end: 0xff00ff00 },
  ],
  start: [
    {
      fill0: 1,
      fill1: 2,
      commands: [
        { move: [0, 0] },
        { line: [1200, 0] },
        { line: [1200, 1200] },
        { line: [0, 1200] },
        { line: [0, 0] },
      ],
    },
  ],
  end: [
    [
      { move: [600, -200] },
      { curve: [1400, -200, 1400, 600] },
      { line: [600, 1400] },
      { curve: [-200, 1400, -200, 600] },
      { line: [600, -200] },
    ],
  ],
});

function character(): MorphCharacter {
  const swf = readSwf(
    w.swf({ width: 100, height: 100, frameRate: 12, frameCount: 1, tags: [tag] }),
  );
  const t = swf.tags[0];
  const morph = readMorphShape(swf.bytes, t.code, t.offset, t.length);
  return { type: "morph", id: 1, morph, blends: new Map(), bitmap: () => null };
}

/** Where each record leaves the pen. */
function pens(records: ShapeRecord[]): [number, number][] {
  let x = 0;
  let y = 0;
  return records.map((r) => {
    if (r.type === "style") {
      x = r.moveTo?.x ?? x;
      y = r.moveTo?.y ?? y;
    } else if (r.type === "line") {
      x += r.dx;
      y += r.dy;
    } else {
      x += r.cx + r.ax;
      y += r.cy + r.ay;
    }

    return [x, y];
  });
}

test("a morph blends to its start and its end, a straight edge paired with a curve as a curve", () => {
  const c = character();
  const start = blend(c.morph, 0);
  assert.deepEqual(pens(start.records), [
    [0, 0],
    [1200, 0],
    [1200, 1200],
    [0, 1200],
    [0, 0],
  ]);
  assert.deepEqual(start.records[1], { type: "curve", cx: 600, cy: 0, ax: 600, ay: 0 });
  assert.deepEqual(start.fills[0], { type: "solid", color: 0xffff0000 });

  const end = blend(c.morph, 1);
  assert.deepEqual(end.records.slice(1), c.morph.end.slice(1));
  assert.deepEqual(end.fills[0], { type: "solid", color: 0xff0000ff });
  assert.deepEqual(end.bounds, { xMin: -200, xMax: 1400, yMin: -200, yMax: 1400 });
});

test("a blend's points are whole twips, its paths stay closed and keep both their fills", () => {
  const c = character();
  const half = blend(c.morph, 21845 / 65535);
  const at = pens(half.records);
  assert.deepEqual(at[0], at[at.length - 1]);
  for (const [x, y] of at) {
    assert.ok(Number.isInteger(x) && Number.isInteger(y));
  }

  const style = half.records[0];
  assert.equal(style.type === "style" && style.fill0, 1);
  assert.equal(style.type === "style" && style.fill1, 2);
});

test("a blend's shape keeps its bounds alone, drawn into layers once, and is kept for its ratio", () => {
  const c = character();
  const half = morphAt(c, 21845);
  assert.deepEqual(Object.keys(half.shape).sort(), ["bounds", "edgeBounds"]);
  assert.ok(half.layers.length > 0);
  assert.equal(morphAt(c, 21845), half);
});

test("a morph keeps its 16 latest blends, the one asked for again among them", () => {
  const c = character();
  const first = morphAt(c, 0);
  for (let ratio = 1; ratio < 16; ratio++) {
    morphAt(c, ratio);
  }

  assert.equal(morphAt(c, 0), first);
  morphAt(c, 100);
  assert.equal(c.blends.size, 16);
  assert.equal(c.blends.has(1), false);
  assert.equal(morphAt(c, 0), first);
});

test("a MorphShape keeps the blend it last drew until it is drawn at a new ratio", () => {
  const c = character();
  const shape = ShapeObject.ofMorph(c);
  const swf = readSwf(
    w.swf({
      width: 100,
      height: 100,
      frameRate: 12,
      frameCount: 1,
      tags: [w.place({ depth: 1, move: true, ratio: 65535 })],
    }),
  );
  shape.applyPlace(readPlace(swf.bytes, swf.tags[0]));
  assert.equal(shape.shape, morphAt(c, 0));

  assert.equal(shape.drawn(), morphAt(c, 65535));
  assert.equal(shape.shape, morphAt(c, 65535));
});

test("a MorphShape swapped to a shape and back to its morph at the same ratio draws the morph", async () => {
  const { Player } = await import("../../../packages/player/dist/player.js");
  const square = w.shape({
    id: 2,
    bounds: [0, 200, 0, 200],
    fills: [0x00ff00],
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
  });
  const player = new Player(
    w.swf({
      width: 100,
      height: 100,
      frameRate: 12,
      frameCount: 3,
      tags: [
        tag,
        square,
        w.place({ depth: 1, character: 1, ratio: 30000 }),
        w.showFrame(),
        w.place({ depth: 1, move: true, character: 2 }),
        w.showFrame(),
        w.place({ depth: 1, move: true, character: 1 }),
        w.showFrame(),
        w.end(),
      ],
    }),
  );
  const drawn = () => (player.root.depths.get(1) as InstanceType<typeof ShapeObject>).drawn();
  assert.equal(drawn()?.id, 1);

  player.tick();
  assert.equal(drawn()?.id, 2);

  player.tick();
  const shape = drawn();
  assert.equal(shape?.id, 1);
  const morph = (player.root.depths.get(1) as InstanceType<typeof ShapeObject>).morph;
  assert.ok(morph);
  assert.equal(shape, morphAt(morph, 30000));
});
