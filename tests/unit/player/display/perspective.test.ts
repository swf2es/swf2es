// A 3D object's plane in perspective, against what adl reported for the
// same objects: local3DToGlobal and getBounds of cards turned about y on a
// stage 420 by 300, the root's projection centred on it.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BitmapStore } from "../../../../packages/player/dist/bitmap/bitmap.js";
import { bounds, hitsPoint } from "../../../../packages/player/dist/display/bounds.js";
import { BitmapObject, Container } from "../../../../packages/player/dist/display/display.js";
import {
  apply,
  concat,
  invert,
  transformRect,
} from "../../../../packages/player/dist/display/geometry.js";
import {
  setStageSize,
  stagePoint3D,
} from "../../../../packages/player/dist/display/perspective.js";

const near = (a: number, b: number, within = 1e-6) =>
  assert.ok(Math.abs(a - b) < within, `${a} is not ${b}`);

/** The stage and its root, and a card 80 by 100 centred on its origin at (x, y) in the root. */
function scene(x: number, y: number) {
  const stage = new Container();
  setStageSize(stage, 420, 300);
  stage.loaderInfo = {} as never;
  const root = new Container();
  root.loaderInfo = {} as never;
  stage.addChildAt(root, 0);
  const card = new Container();
  const art = new BitmapObject(new BitmapStore(80, 100, true, 0xffcc3333));
  art.setMatrix({ a: 1, b: 0, c: 0, d: 1, tx: -40, ty: -50 });
  card.addChildAt(art, 0);
  card.setMatrix({ a: 1, b: 0, c: 0, d: 1, tx: x, ty: y });
  root.addChildAt(card, 0);
  return { stage, root, card };
}

test("a card turned about y is projected through the root's projection, its nearer edge larger", () => {
  const { stage, root, card } = scene(200, 70);
  card.set3D("rotationY", 30);

  // adl: (236, 118.5) and (167.5, 26.25), to the quarter pixel it reports.
  const [x1, y1] = stagePoint3D(card, 40, 50, 0, stage);
  const [x2, y2] = stagePoint3D(card, -40, -50, 0, stage);
  assert.deepEqual(
    [x1, y1, x2, y2].map((v) => Math.round(v * 4) / 4),
    [236, 118.5, 167.5, 26.25],
  );

  // Its plane in its parent's space takes its own points there, and back.
  const m = card.placed;
  const [px, py] = apply(m, 40, 50);
  near(px, x1);
  near(py, y1);
  const back = invert(m);
  assert.ok(back);
  const [lx, ly] = apply(back, px, py);
  near(lx, 40);
  near(ly, 50);
  near(apply(concat(m, back), 7, -3)[0], 7);

  // Out to whole pixels: adl's getBounds of the card with a hairline across it, half a pixel
  // further each way, was (167, 13, 70, 109).
  assert.deepEqual(transformRect(bounds(card, true) as never, m), {
    xMin: 167,
    yMin: 13,
    xMax: 236,
    yMax: 122,
  });

  // The shape test hits where the plane is drawn: the far edge is short of its unturned place.
  assert.ok(hitsPoint(card, 200 + 30, 70, true, root));
  assert.ok(!hitsPoint(card, 200 - 34, 70 - 45, true, root));
});

test("a card in another is in one 3D space with it, and a card behind the eye counts for nothing", () => {
  const { stage, root, card } = scene(150, 150);
  card.set3D("rotationY", 40);
  const inner = new Container();
  inner.set3D("rotationX", 50);
  card.addChildAt(inner, 1);
  // Turned about x, then about y with the card, then projected once: not flattened into the card.
  const flat = Math.cos((50 * Math.PI) / 180) * 10;
  const [x, y] = stagePoint3D(inner, 0, 10, 0, stage);
  const [fx, fy] = stagePoint3D(card, 0, flat, 0, stage);
  assert.notEqual(Math.round(y * 100), Math.round(fy * 100));
  near(apply(card.placed, ...apply(inner.placed, 0, 10))[0], x);
  near(apply(card.placed, ...apply(inner.placed, 0, 10))[1], y);
  assert.ok(Number.isFinite(fx));

  const before = bounds(root, true);
  const behind = scene(0, 0).card;
  behind.set3D("z", -1000);
  root.addChildAt(behind, 1);
  assert.deepEqual(bounds(root, true), before);
  assert.ok(!hitsPoint(behind, 210, 150, true, root));
});
