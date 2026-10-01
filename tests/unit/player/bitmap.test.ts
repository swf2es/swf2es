// The pixel store on its own: Flash's premultiplication arithmetic, and that
// a store holds the Bitmaps showing it weakly.
import assert from "node:assert/strict";
import { test } from "node:test";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { BitmapStore, premultiply, unmultiply } from "../../../packages/player/dist/bitmap.js";
import { BitmapObject } from "../../../packages/player/dist/display.js";

setFlagsFromString("--expose-gc");
const gc = runInNewContext("gc") as () => void;

test("a pixel goes in premultiplied and comes back as Flash rounds it", () => {
  assert.equal(premultiply(0x80ff8040).toString(16), "80804020");
  assert.equal(unmultiply(premultiply(0x80ff8040)).toString(16), "80ff7f40");
  assert.equal(unmultiply(premultiply(0x7f3366cc)).toString(16), "7f3266cd");
  assert.equal(premultiply(0x00123456), 0);
});

test("a store tells the Bitmaps showing it of a change, and lets go of one dropped", async () => {
  const store = new BitmapStore(2, 2, true, 0);
  const kept = new BitmapObject(store);
  kept.dirty = 0;
  store.setPixel32(0, 0, 0xffffffff);
  assert.notEqual(kept.dirty, 0);

  // A Bitmap no one holds, shown by the same store: collected all the same.
  (() => {
    new BitmapObject(store);
  })();
  assert.equal(store.views.size, 2);
  await new Promise((resolve) => setImmediate(resolve));
  gc();
  store.setPixel32(1, 1, 0xffffffff);
  assert.equal(store.views.size, 1);

  // Shown no more: it leaves the store's views.
  kept.store = null;
  assert.equal(store.views.size, 0);
});
