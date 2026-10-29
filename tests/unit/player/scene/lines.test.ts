// The renderer of swf2es's own's line cache (scene/lines.ts): lines found
// again by their transform, and let go of within its budget.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Tessellator } from "@swf2es/native/tessellate";
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

test("lines that stroke to nothing are forgotten once undrawn for the idle frames", () => {
  const geometries = new Geometries();
  const lines = new LineCache(geometries, refuse);
  const layer = straightLine();
  // A transform that flattens the plane strokes nothing, here a new one on every frame.
  for (let frame = 0; frame < 600; frame++) {
    assert.equal(lines.take(layer, 0, 0, frame, 0, 0, 1, null, true), null);
    geometries.endFrame();
  }

  assert.ok(lines.kept < 400, `${lines.kept} kept`);
});

test("after a busy stretch, the lines no longer drawn go within a sweep", () => {
  const geometries = new Geometries();
  const lines = new LineCache(geometries, refuse, 1);
  const layer = straightLine();
  const busy = [];
  for (let k = 0; k < 10; k++) {
    busy.push(lines.take(layer, 0, k + 1, 0, 0, k + 1, 1, null, true));
  }

  geometries.endFrame();
  for (let frame = 1; frame < 70; frame++) {
    lines.take(layer, 0, 1, 0, 0, 1, 1, null, true);
    geometries.endFrame();
  }

  assert.deepEqual(
    busy.map((h) => h !== null && geometries.alive(h)),
    [true, false, false, false, false, false, false, false, false, false],
  );
  assert.equal(lines.kept, 1);
});

test("a tessellator that builds lines builds them, one that refuses leaves them to JS alike", () => {
  const tessellate = new Tessellator().tessellate;
  let built = 0;
  let refused = 0;
  const counting = (refuse: boolean) =>
    Object.assign(
      (contours: readonly (readonly number[])[], nonZero: boolean) => tessellate(contours, nonZero),
      {
        lines: {
          input: (n: number) => tessellate.lines.input(n),
          build: (length: number) => {
            if (refuse) {
              refused++;
              return undefined;
            }

            built++;
            return tessellate.lines.build(length);
          },
        },
      },
    );
  const layer = straightLine();
  const native = new Geometries();
  const js = new Geometries();
  // Drawn opaque, and through a fade, where the line is outlined and its outline tessellated.
  for (const opaque of [true, false]) {
    const a = new LineCache(native, counting(false)).take(layer, 0, 2, 0, 0, 2, 1, null, opaque);
    const b = new LineCache(js, counting(true)).take(layer, 0, 2, 0, 0, 2, 1, null, opaque);
    assert.ok(a && b);
    assert.deepEqual(native.get(a.id), js.get(b.id));
  }

  assert.equal(built, 2);
  assert.equal(refused, 2);
});

test("a layer the line builder refused goes to JS until its drawing changes", () => {
  const tessellate = new Tessellator().tessellate;
  let asked = 0;
  const refusing = Object.assign(
    (contours: readonly (readonly number[])[], nonZero: boolean) => tessellate(contours, nonZero),
    {
      lines: {
        input: (n: number) => tessellate.lines.input(n),
        build: () => {
          asked++;
          return undefined;
        },
      },
    },
  );
  const lines = new LineCache(new Geometries(), refusing);
  const layer = straightLine();
  for (let scale = 1; scale <= 3; scale++) {
    assert.ok(lines.take(layer, 0, scale, 0, 0, scale, 1, null, true));
  }

  assert.equal(asked, 1);
  assert.ok(lines.take(layer, 1, 1, 0, 0, 1, 1, null, true));
  assert.equal(asked, 2);
});
