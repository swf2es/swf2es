// The renderer of swf2es's own's line cache (scene/lines.ts): lines found
// again by their transform, and let go of within its budget.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Tessellator } from "@swf2es/native/render";
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

const tessellate = new Tessellator().tessellate;

test("a layer seen again through a transform finds its lines, another strokes them anew", () => {
  const geometries = new Geometries();
  const lines = new LineCache(geometries, tessellate);
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
  const lines = new LineCache(geometries, tessellate, 1);
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
  const lines = new LineCache(geometries, tessellate);
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
  const lines = new LineCache(geometries, tessellate, 1);
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

/** A builder that builds nothing, as if refusing each layer or, where `unwinding`, trapping. */
function failing(unwinding: boolean) {
  const builder = {
    asked: 0,
    unwound: false,
    input: (n: number) => tessellate.lines.input(n),
    build: () => {
      builder.asked++;
      builder.unwound = unwinding;
      return undefined;
    },
  };
  return builder;
}

test("a layer the line builder refuses has no lines, kept so", () => {
  const builder = failing(false);
  const lines = new LineCache(new Geometries(), { layer: tessellate.layer, lines: builder });
  const layer = straightLine();
  assert.equal(lines.take(layer, 0, 1, 0, 0, 1, 1, null, true), null);
  assert.equal(lines.take(layer, 0, 1, 0, 0, 1, 1, null, true), null);
  assert.equal(builder.asked, 1);
});

test("a layer the line builder unwound on is asked for once more, and again on a later take", () => {
  const builder = failing(true);
  const lines = new LineCache(new Geometries(), { layer: tessellate.layer, lines: builder });
  const layer = straightLine();
  assert.equal(lines.take(layer, 0, 1, 0, 0, 1, 1, null, true), null);
  // Once more, as after libtess2 trapped, when the builder's next instance fills by the bands.
  assert.equal(builder.asked, 2);
  // Not kept as none: what failed for a while is built when it can be.
  assert.equal(lines.take(layer, 0, 1, 0, 0, 1, 1, null, true), null);
  assert.equal(builder.asked, 4);
});

test("a painted layer's lines come in pieces in order: runs of a colour together, each painted line alone and textured where it lies in the shape", () => {
  const geometries = new Geometries();
  const lines = new LineCache(geometries, tessellate);
  const drawing = new Drawing();
  const line = {
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
    fill: null,
  };
  // A bitmap mapped by the identity: a vertex samples its own place in the shape.
  const bitmap = {
    type: "image" as const,
    image: null as never,
    matrix: { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 },
    repeat: true,
    smooth: false,
  };
  drawing.lineStyle(line);
  drawing.moveTo(0, 0);
  drawing.lineTo(50, 0);
  drawing.lineStyle({ ...line, color: 0xff00ff00 });
  drawing.lineTo(50, 50);
  drawing.lineStyle(line);
  drawing.lineBitmap(bitmap);
  drawing.lineTo(0, 50);
  drawing.lineStyle(line);
  drawing.lineTo(0, 0);
  const layer = drawing.layers[0];
  assert.equal(lines.of(layer, 0).painted, true);

  // Turned a quarter and scaled twice: the texels are the shape's points all the same.
  const pieces = lines.pieces(layer, 0, 0, 2, -2, 0, 1, null, true);
  assert.ok(pieces);
  assert.deepEqual(
    pieces.map((p) => p.part.paint?.type ?? null),
    [null, "image", null],
  );
  const { positions, texels } = pieces[1].part.geometry;
  assert.ok(texels);
  for (let k = 0; k < positions.length; k += 2) {
    // (x, y) went to (-2 y, 2 x).
    assert.ok(Math.abs(texels[k] - positions[k + 1] / 2) < 1e-4);
    assert.ok(Math.abs(texels[k + 1] + positions[k] / 2) < 1e-4);
    assert.ok(texels[k + 1] >= 49 && texels[k + 1] <= 51);
  }

  // Found again, and stroked anew once a piece is let go of.
  assert.equal(lines.pieces(layer, 0, 0, 2, -2, 0, 1, null, true), pieces);
  geometries.remove(pieces[2].handle.id);
  const again = lines.pieces(layer, 0, 0, 2, -2, 0, 1, null, true);
  assert.notEqual(again, pieces);
  assert.equal(geometries.alive(pieces[0].handle), false);
  assert.ok(again?.every((p) => geometries.alive(p.handle)));
});
