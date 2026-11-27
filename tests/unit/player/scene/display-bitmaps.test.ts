// Bitmaps shown at the display's resolution (scene/display-bitmaps.ts): how
// many texels a store takes at a scale; which stores' draws are followed, and
// when a texture of one is made, kept or let go of; the budget; and the
// change stamps a record of draws is judged by.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BitmapStore } from "../../../../packages/player/dist/bitmap/bitmap.js";
import {
  BitmapObject,
  Container,
  ShapeObject,
} from "../../../../packages/player/dist/display/display.js";
import {
  DisplayBitmaps,
  texelsOf,
} from "../../../../packages/player/dist/scene/display-bitmaps.js";
import { Textures } from "../../../../packages/render/dist/index.js";

const IDENTITY = { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 };

test("a store takes the texels its pixels cover at a scale, the last partly covered counting", () => {
  assert.equal(texelsOf(200, 2.7), 540);
  assert.equal(texelsOf(201, 2.7), 543);
  assert.equal(texelsOf(10, 1), 10);
  assert.equal(texelsOf(1, 0.2), 1);
});

function follower(budget = 1 << 30) {
  const draws: number[] = [];
  const display = new DisplayBitmaps(
    new Textures(),
    {
      textureLimit: () => 16384,
      stage: () => null,
      draw: (_o, _m, _x, _y, _w, _h, _samples, zoom) => {
        draws.push(zoom);
        return true;
      },
      fill: () => true,
    },
    budget,
  );
  return { display, draws };
}

/** A draw of `o` into `store`, as drawObject goes: the store changed, then the renderer told. */
function draw(display: DisplayBitmaps, store: BitmapStore, o: object, plain = true): void {
  const before = store.version;
  const solid = store.solidPixel;
  store.changed();
  display.drawn(
    store,
    o as never,
    IDENTITY,
    0,
    0,
    store.width,
    store.height,
    4,
    plain,
    before,
    solid,
  );
}

test("a store drawn into from one colour gets a texture once shown larger, at the scale shown", (t) => {
  const { display, draws } = follower();
  t.after(() => display.destroy());
  const store = new BitmapStore(200, 100, true, 0);
  draw(display, store, new ShapeObject(null));
  // Nothing made till a Bitmap on the stage shows it.
  display.frame();
  assert.equal(display.texture(store), null);
  assert.deepEqual(draws, []);

  display.shown(store, 2.7);
  display.frame();
  const shown = display.texture(store);
  assert.equal(shown?.zoom, 2.7);
  assert.equal(display.heldBytes, 4 * texelsOf(200, 2.7) * texelsOf(100, 2.7));
  assert.deepEqual(draws, [2.7]);

  // A draw after goes into the texture too.
  draw(display, store, new ShapeObject(null));
  assert.deepEqual(draws, [2.7, 2.7]);
  assert.equal(display.texture(store), shown);
});

test("shown at about a pixel a stage pixel, or over the budget, a store keeps no texture", (t) => {
  const small = follower();
  t.after(() => small.display.destroy());
  const store = new BitmapStore(200, 100, true, 0);
  draw(small.display, store, new ShapeObject(null));
  small.display.shown(store, 1.05);
  small.display.frame();
  assert.equal(small.display.texture(store), null);

  const tight = follower(4 * texelsOf(200, 2) * texelsOf(100, 2) - 1);
  t.after(() => tight.display.destroy());
  const other = new BitmapStore(200, 100, true, 0);
  draw(tight.display, other, new ShapeObject(null));
  tight.display.shown(other, 2);
  tight.display.frame();
  assert.equal(tight.display.texture(other), null);
});

test("a change it did not follow leaves the texture behind; a whole fill starts the record again", (t) => {
  const { display } = follower();
  t.after(() => display.destroy());
  const store = new BitmapStore(20, 20, true, 0);
  draw(display, store, new ShapeObject(null));
  display.shown(store, 2);
  display.frame();
  assert.ok(display.texture(store));

  store.setPixel32(1, 1, 0xffffffff);
  assert.equal(display.texture(store), null);
  display.frame();
  assert.equal(display.heldBytes, 0);

  // Filled whole, then drawn into: followed again.
  store.fillRect({ x: 0, y: 0, width: 20, height: 20 }, 0);
  draw(display, store, new ShapeObject(null));
  display.shown(store, 2);
  display.frame();
  assert.ok(display.texture(store));
});

test("a draw that changes colours, shows the store itself or whose object changed is not drawn again", (t) => {
  const { display } = follower();
  t.after(() => display.destroy());

  const tinted = new BitmapStore(20, 20, true, 0);
  draw(display, tinted, new ShapeObject(null), false);
  display.shown(tinted, 2);
  display.frame();
  assert.equal(display.texture(tinted), null);

  const itself = new BitmapStore(20, 20, true, 0);
  const holder = new Container();
  holder.addChildAt(new BitmapObject(itself), 0);
  draw(display, itself, holder);
  display.shown(itself, 2);
  display.frame();
  assert.equal(display.texture(itself), null);

  const changed = new BitmapStore(20, 20, true, 0);
  const shape = new ShapeObject(null);
  draw(display, changed, shape);
  shape.invalidate(4);
  display.shown(changed, 2);
  display.frame();
  assert.equal(display.texture(changed), null);
});

test("a record no Bitmap shows for 300 frames lets go of what it drew; a lost context ends it", (t) => {
  const { display } = follower();
  t.after(() => display.destroy());

  const unshown = new BitmapStore(20, 20, true, 0);
  draw(display, unshown, new ShapeObject(null));
  for (let i = 0; i < 301; i++) {
    display.frame();
  }

  display.shown(unshown, 2);
  display.frame();
  assert.equal(display.texture(unshown), null);

  const lost = new BitmapStore(20, 20, true, 0);
  draw(display, lost, new ShapeObject(null));
  display.contextLost();
  display.shown(lost, 2);
  display.frame();
  assert.equal(display.texture(lost), null);
});

test("each change of a display object stamps it later than any draw before", () => {
  const shape = new ShapeObject(null);
  const before = shape.changedAt;
  shape.invalidate(1);
  assert.ok(shape.changedAt > before);
  const stamp = shape.changedAt;
  new ShapeObject(null).invalidate(1);
  assert.ok(shape.changedAt === stamp);
});
