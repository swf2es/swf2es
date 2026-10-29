// The renderer of swf2es's own's line cache (scene/lines.ts): lines found
// again by their transform, and let go of within its budget.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Drawing } from "../../../../packages/player/dist/display/drawing.js";
import { LineCache } from "../../../../packages/player/dist/scene/lines.js";
import { Geometries } from "../../../../packages/render/dist/index.js";

/** A layer of one opaque straight line with butt caps: four vertices however it is scaled. */
function straightLine() {
  const drawing = new Drawing();
  drawing.lineStyle({
    width: 40,
    color: 0xff000000,
    startCap: 1,
    endCap: 1,
    join: 1,
    miterLimit: 3,
    noHScale: false,
    noVScale: false,
    pixelHinting: false,
    noClose: false,
  } as never);
  drawing.moveTo(0, 0);
  drawing.lineTo(50, 0);
  return drawing.layers[0];
}

const refuse = () => {
  throw new Error("an opaque line takes no tessellator");
};

test("a layer seen again through a transform finds its lines, another strokes them anew", () => {
  const geometries = new Geometries();
  const lines = new LineCache(geometries, refuse);
  const layer = straightLine();
  const first = lines.take(layer, 0, 1, 0, 0, 1, 1, null, true);
  assert.ok(first);
  assert.equal(lines.take(layer, 0, 1, 0, 0, 1, 1, null, true), first);
  // Zero's two signs are one transform, as compared.
  assert.equal(lines.take(layer, 0, 1, -0, 0, 1, 1, null, true), first);
  assert.notEqual(lines.take(layer, 0, 2, 0, 0, 2, 1, null, true), first);
  assert.deepEqual(lines.counts, { strokeContexts: 2, strokeReuses: 2 });

  // A new version of its drawing strokes them again, the old let go of.
  const again = lines.take(layer, 1, 1, 0, 0, 1, 1, null, true);
  assert.ok(again);
  assert.equal(geometries.alive(first), false);
});

test("past its budget, lines drawn neither this frame nor the last go, the least lately drawn first", () => {
  const geometries = new Geometries();
  // Past any lines at all: what is drawn lately stays, and the budget grows to it.
  const lines = new LineCache(geometries, refuse, 1);
  const layer = straightLine();
  const handles = [];
  for (let frame = 0; frame < 4; frame++) {
    handles.push(lines.take(layer, 0, frame + 1, 0, 0, frame + 1, 1, null, true));
    geometries.endFrame();
  }

  assert.deepEqual(
    handles.map((h) => h !== null && geometries.alive(h)),
    [false, false, true, true],
  );
  assert.equal(lines.take(layer, 0, 4, 0, 0, 4, 1, null, true), handles[3]);
  assert.deepEqual(lines.counts, { strokeContexts: 4, strokeReuses: 1 });
});
