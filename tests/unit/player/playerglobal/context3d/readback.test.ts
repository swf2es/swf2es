import assert from "node:assert/strict";
import { test } from "node:test";
import { BitmapStore } from "../../../../../packages/player/dist/bitmap/bitmap.js";
import { writeReadback } from "../../../../../packages/player/dist/playerglobal/context3d/readback.js";

/** One column of a 2-row back buffer: green 255 over alpha 128, then red 255 over alpha 0. */
const COLUMN = new Uint8Array([0, 255, 0, 128, 255, 0, 0, 0]);

test("a transparent destination taller than the back buffer keeps its raw rows premultiplied", () => {
  // Rows 0 and 1 are above the destination's last two, so AIR keeps their raw alpha.
  const store = new BitmapStore(1, 4, true, 0xff123456);
  writeReadback(store, COLUMN, 1, 2, 2);

  // AIR reads 8001fc00 for the first, its channel above alpha spilling into the next.
  assert.equal(store.pixels[0], 0x80008000);
  assert.equal(store.pixels[1], 0);
  assert.equal(store.getPixel32(0, 0), 0x8000ff00);
  assert.equal(store.getPixel32(0, 1), 0);
  assert.equal(store.getPixel32(0, 2), 0xff123456);
});

test("rows the back buffer's height covers from the destination's bottom raise alpha", () => {
  const store = new BitmapStore(1, 2, true, 0);
  writeReadback(store, COLUMN, 1, 2, 2);

  assert.equal(store.pixels[0], 0xff00ff00);
  assert.equal(store.pixels[1], 0xffff0000);
});

test("an opaque destination keeps raw alpha, and loses holdsAlpha once rewritten whole at 255", () => {
  const store = new BitmapStore(1, 4, false, 0x123456);
  writeReadback(store, COLUMN, 1, 2, 2);

  assert.equal(store.getPixel32(0, 0), 0x8000ff00);
  assert.equal(store.getPixel32(0, 1), 0x00ff0000);
  assert.equal(store.holdsAlpha, true);
  assert.equal(store.drawable[1], 0xffff0000);

  // A copy of part of the store at 255 leaves the alpha elsewhere held.
  writeReadback(store, new Uint8Array([1, 2, 3, 255]), 1, 1, 1);
  assert.equal(store.holdsAlpha, true);

  const whole = new Uint8Array(16);
  for (let i = 0; i < 16; i += 4) {
    whole.set([10, 20, 30, 255], i);
  }

  writeReadback(store, whole, 1, 4, 4);
  assert.equal(store.holdsAlpha, false);
  assert.equal(store.drawable, store.pixels);
});
