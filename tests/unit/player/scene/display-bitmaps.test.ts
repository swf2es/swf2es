// Bitmaps kept at the display's resolution (scene/display-bitmaps.ts): how
// many texels a store takes at a scale, a texture averaged down to the
// store's pixels by area, and which stores are promoted, at what scale,
// within the budget; and the change stamps a record of draws is judged by.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BitmapStore } from "../../../../packages/player/dist/bitmap/bitmap.js";
import { ShapeObject } from "../../../../packages/player/dist/display/display.js";
import {
  areaDown,
  DisplayBitmaps,
  texelsOf,
} from "../../../../packages/player/dist/scene/display-bitmaps.js";
import { Paints } from "../../../../packages/player/dist/scene/paints.js";
import { Textures } from "../../../../packages/render/dist/index.js";

test("a store takes the texels its pixels cover at a scale, the last partly covered counting", () => {
  assert.equal(texelsOf(200, 2.7), 540);
  assert.equal(texelsOf(201, 2.7), 543);
  assert.equal(texelsOf(10, 1), 10);
  assert.equal(texelsOf(1, 0.2), 1);
});

test("a texture is averaged down by area: whole squares as their mean, parts by how much they cover", () => {
  // Two by one pixels at two texels a pixel: each pixel the mean of its square.
  const texels = new Uint32Array([
    0xff000000, 0xff0000ff, 0xffffffff, 0xffffffff, 0xff000000, 0xff0000ff, 0xffffffff, 0xff000000,
  ]);
  const out = areaDown(texels, 4, 2, 2, 1, 2);
  assert.deepEqual(
    [...out].map((p) => p.toString(16)),
    ["ff000080", "ffbfbfbf"],
  );

  // One colour stays itself at any scale, the store's last partial texels included.
  const solid = new Uint32Array(texelsOf(3, 2.7) * texelsOf(2, 2.7)).fill(0x80402010);
  for (const p of areaDown(solid, texelsOf(3, 2.7), texelsOf(2, 2.7), 3, 2, 2.7)) {
    assert.equal(p, 0x80402010);
  }

  // Premultiplied stays premultiplied: no channel above alpha.
  const mixed = new Uint32Array(27 * 27);
  for (let i = 0; i < mixed.length; i++) {
    const a = (i * 37) & 0xff;
    mixed[i] = ((a << 24) | (((a * i) % (a + 1)) << 16)) >>> 0;
  }

  for (const p of areaDown(mixed, 27, 27, 10, 10, 2.7)) {
    assert.ok(((p >>> 16) & 0xff) <= p >>> 24);
  }
});

function keeper(shown: number, budget: number) {
  const paints = new Paints(new Textures());
  const host = {
    textureLimit: () => 16384,
    shownScale: () => shown,
    drawer: null as never,
    draw: () => true,
  };
  return new DisplayBitmaps(paints, host, budget);
}

test("a store of one colour is drawn at the screen's scale, as a texture, its cap and the budget allow", () => {
  const store = new BitmapStore(200, 100, true, 0);
  assert.equal(keeper(2.7, 1 << 30).zoomFor(store), 2.7);
  // At most 4, and none below 1.1, where it would gain nothing.
  assert.equal(keeper(6, 1 << 30).zoomFor(store), 4);
  assert.equal(keeper(1.05, 1 << 30).zoomFor(store), null);
  // Its texture at most 16M texels.
  const large = new BitmapStore(2000, 2000, true, 0);
  assert.equal(keeper(4, 1 << 30).zoomFor(large), Math.sqrt((1 << 24) / (2000 * 2000)));
  // Past the budget, at a texel a pixel.
  // The texture and the store at its size, which scripts read.
  const bytes = 4 * (400 * 200 + 200 * 100);
  assert.equal(keeper(2, bytes - 1).zoomFor(store), null);
  assert.equal(keeper(2, bytes).zoomFor(store), 2);
});

test("a store read, written, or holding pixels is not promoted", () => {
  const read = new BitmapStore(20, 20, true, 0);
  read.getPixel32(1, 1);
  assert.equal(keeper(2, 1 << 30).zoomFor(read), null);

  const written = new BitmapStore(20, 20, true, 0);
  written.setPixel32(1, 1, 0xffffffff);
  assert.equal(keeper(2, 1 << 30).zoomFor(written), null);

  const refused = new BitmapStore(20, 20, true, 0);
  refused.displayRefused = true;
  assert.equal(keeper(2, 1 << 30).zoomFor(refused), null);
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
