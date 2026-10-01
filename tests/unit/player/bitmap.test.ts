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

test("pixelDissolve visits pixels in Flash's order and returns its seeds", async () => {
  const { pixelDissolve } = await import("../../../packages/player/dist/bitmap-ops.js");
  // What Flash writes and returns call by call under adl, numPixels 1 from seed 0.
  const runs: [number, number, string][] = [
    [
      4,
      4,
      "[0,12]>6 [6]>3 [3]>13 [13]>10 [10]>5 [5]>14 [14]>7 [7]>15 [15]>11 [11]>9 [9]>8 [8]>4 [4]>2 [2]>1 [1]>12 []>6",
    ],
    [
      10,
      10,
      "[0,17]>179 [64]>50 [32]>25 [19]>180 [57]>147 [93]>241 [60]>48 [30]>24 [18]>12 [6]>3 [3]>185 [72]>57",
    ],
    [
      3,
      5,
      "[0,8]>5 [4]>22 [13]>28 [11]>7 [9]>6 [5]>3 [10]>18 [14]>9 [7]>16 [12]>8 [6]>4 [3]>2 [2]>1 [1]>20 []>5",
    ],
    [7, 1, "[]>0 []>0"],
  ];
  // From seed 12345 on 10x10: reduced modulo 255 to 105, the pixel at (9, 6), the origin with it.
  const seeded = new BitmapStore(10, 10, false, 0);
  assert.equal(
    pixelDissolve(
      seeded,
      seeded,
      { x: 0, y: 0, width: 10, height: 10 },
      0,
      0,
      12345,
      1,
      0xffff0000,
    ),
    140,
  );
  assert.deepEqual(
    [...seeded.pixels.keys()].filter((i) => seeded.pixels[i] === 0xffff0000),
    [0, 69],
  );
  for (const [w, h, expected] of runs) {
    const store = new BitmapStore(w, h, false, 0);
    let seed = 0;
    const got: string[] = [];
    for (const _ of expected.split(" ")) {
      const before = store.pixels.slice();
      seed = pixelDissolve(
        store,
        store,
        { x: 0, y: 0, width: w, height: h },
        0,
        0,
        seed,
        1,
        0xffff0000,
      );
      const hit = [...before.keys()].filter((i) => store.pixels[i] !== before[i]);
      got.push(`[${hit.join(",")}]>${seed}`);
    }

    assert.equal(got.join(" "), expected, `${w}x${h}`);
  }
});

test("threshold takes its six operations and no name Object's prototype has", async () => {
  const { isThresholdOperation } = await import("../../../packages/player/dist/bitmap-ops.js");
  for (const op of ["<", "<=", ">", ">=", "==", "!="]) {
    assert.ok(isThresholdOperation(op), op);
  }

  for (const op of ["constructor", "toString", "hasOwnProperty", "__proto__", "=", "equals"]) {
    assert.ok(!isThresholdOperation(op), op);
  }
});

test("pixelDissolve takes a count past every pixel as Flash does, in a bounded number of steps", async () => {
  const { pixelDissolve } = await import("../../../packages/player/dist/bitmap-ops.js");
  // The seed Flash returns and the pixels it fills under adl, by count, from seeds 0 and 5.
  const runs: [number, number, number, number, number, number][] = [
    [4, 4, 0, 14, 1, 15],
    [4, 4, 0, 16, 6, 16],
    [4, 4, 0, 100, 9, 16],
    [4, 4, 0, 2147483647, 7, 16],
    [4, 4, 5, 15, 5, 16],
    [4, 4, 5, 100, 12, 16],
    [4, 4, 5, 2147483647, 4, 16],
    [3, 5, 0, 16, 22, 15],
    [3, 5, 0, 2147483647, 5, 15],
    [3, 5, 5, 17, 7, 15],
    [3, 5, 5, 2147483647, 22, 15],
  ];
  for (const [w, h, seed, count, next, filled] of runs) {
    const store = new BitmapStore(w, h, false, 0);
    const started = performance.now();
    const got = pixelDissolve(
      store,
      store,
      { x: 0, y: 0, width: w, height: h },
      0,
      0,
      seed,
      count,
      0xffff0000,
    );
    assert.ok(performance.now() - started < 100, "bounded");
    assert.equal(got, next, `${w}x${h} seed ${seed} count ${count}`);
    assert.equal(store.pixels.filter((p) => p === 0xffff0000).length, filled);
  }
});
