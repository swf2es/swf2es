// The pixel store on its own: Flash's premultiplication arithmetic, and that
// a store holds the Bitmaps showing it weakly.
import assert from "node:assert/strict";
import { test } from "node:test";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import {
  BitmapStore,
  nearest,
  pixelEdge,
  pixelRect,
  premultiply,
  spanRect,
  unmultiply,
} from "../../../../packages/player/dist/bitmap/bitmap.js";
import { drawBitmap, merge, scroll } from "../../../../packages/player/dist/bitmap/ops.js";
import { BitmapObject } from "../../../../packages/player/dist/display/display.js";

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
  const { pixelDissolve } = await import("../../../../packages/player/dist/bitmap/ops.js");
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
  // From seed 12345 on 10x10: stepped down to state 105, the pixel at (9, 6), the origin with it.
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
  const { isThresholdOperation } = await import("../../../../packages/player/dist/bitmap/ops.js");
  for (const op of ["<", "<=", ">", ">=", "==", "!="]) {
    assert.ok(isThresholdOperation(op), op);
  }

  for (const op of ["constructor", "toString", "hasOwnProperty", "__proto__", "=", "equals"]) {
    assert.ok(!isThresholdOperation(op), op);
  }
});

test("pixelDissolve takes a count past every pixel as Flash does, in a bounded number of steps", async () => {
  const { pixelDissolve } = await import("../../../../packages/player/dist/bitmap/ops.js");
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
    // Bounded, it takes well under a millisecond; unbounded, 2^31 steps take seconds.
    // The margin is for a busy runner, not for the loop.
    assert.ok(performance.now() - started < 1000, "bounded");
    assert.equal(got, next, `${w}x${h} seed ${seed} count ${count}`);
    assert.equal(store.pixels.filter((p) => p === 0xffff0000).length, filled);
  }
});

test("pixelDissolve steps a seed past its states down, and gives back one it does not use", async () => {
  const { pixelDissolve } = await import("../../../../packages/player/dist/bitmap/ops.js");
  // adl, from AS3 and AVM1 alike (the dissolve-noise case): a 5 by 5 source into a 5 by 5
  // destination at (1, 1), by rect, seed, and counts 0, 1, 2, 3 and 40.
  const runs: [number, number, number, number[]][] = [
    [2, 2, 0, [3, 2, 1, 3, 2]],
    [2, 2, 4, [4, 1, 3, 2, 1]],
    [2, 2, 7, [7, 0, 0, 0, 0]],
    [2, 2, 100, [100, 1, 3, 2, 1]],
    [2, 2, -1, [-1, 2, 1, 3, 2]],
    [3, 3, 100, [100, 0, 0, 0, 0]],
    [3, 3, -2, [-2, 4, 2, 1, 8]],
    [2, 1, 10, [10, 10, 10, 10, 10]],
  ];
  for (const [w, h, seed, answers] of runs) {
    const got = [0, 1, 2, 3, 40].map((count) =>
      pixelDissolve(
        new BitmapStore(5, 5, true, 0xaabbccdd),
        new BitmapStore(5, 5, true, 0x12345678),
        { x: 0, y: 0, width: w, height: h },
        1,
        1,
        seed,
        count,
        0,
      ),
    );
    assert.deepEqual(got, answers, `${w}x${h} seed ${seed}`);
  }

  // A count of 0 writes the origin, and tells what shows the store.
  const store = new BitmapStore(3, 3, true, 0);
  const version = store.version;
  pixelDissolve(
    store,
    new BitmapStore(3, 3, true, 0xff00ff00),
    { x: 0, y: 0, width: 2, height: 2 },
    0,
    0,
    5,
    0,
    0,
  );
  assert.equal(store.pixels[0], 0xff00ff00);
  assert.notEqual(store.version, version);
});

test("perlinNoise drops a base's sign and stitches each frequency by its own side", async () => {
  const { perlinNoise } = await import("../../../../packages/player/dist/bitmap/ops.js");
  // adl, from AS3 and AVM1 alike (the dissolve-noise case): 6 by 6, two octaves moved by
  // (1, 2) and (-3, 0.5), seed 100, every channel, the pixels at (0, 0), (1, 0) and (4, 5).
  const runs: [number, number, boolean, number[]][] = [
    [3, 5, false, [0x3ba8ff6c, 0x787d6e24, 0x5ab8b84a]],
    [-3, 5, false, [0x3ba8ff6c, 0x787d6e24, 0x5ab8b84a]],
    [3, -5, true, [0x27ffe5ff, 0x38e44d40, 0x11ffffff]],
    [-2.5, -4, true, [0x2cffffff, 0x76ee3f52, 0x1c76ffd1]],
    [-1, 3, true, [0x60ffffaf, 0x6f49e36e, 0x1fffffff]],
  ];
  for (const [x, y, stitch, pixels] of runs) {
    const store = new BitmapStore(6, 6, true, 0);
    perlinNoise(
      store,
      [x, y],
      [
        [1, 2],
        [-3, 0.5],
      ],
      100,
      stitch,
      false,
      15,
      false,
    );
    assert.deepEqual(
      [store.getPixel32(0, 0), store.getPixel32(1, 0), store.getPixel32(4, 5)],
      pixels,
      `${x}, ${y} ${stitch}`,
    );
  }
});

test("a draw at a whole pixel, unscaled, composites as the general path does", () => {
  let seed = 3;
  const random = () => {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    return seed;
  };
  const filled = (width: number, height: number, transparent: boolean) => {
    const store = new BitmapStore(width, height, transparent, 0);
    for (let i = 0; i < store.pixels.length; i++) {
      store.pixels[i] = store.premultiplied(random() | (i % 3 === 0 ? 0 : 0x40000000));
    }

    return store;
  };
  const source = filled(7, 5, true);
  const ct = { rMul: 0.5, gMul: 1, bMul: 1.5, aMul: 0.75, rAdd: 10, gAdd: -20, bAdd: 0, aAdd: 5 };
  for (const transparent of [true, false]) {
    for (const mode of ["normal", "multiply", "difference", "invert"]) {
      for (const colors of [null, ct]) {
        const clip = { x: 1, y: 0, width: 8, height: 6 };
        const fast = filled(10, 8, transparent);
        const general = fast.clone();
        // A skew too small to move any sample keeps the general path.
        drawBitmap(
          fast,
          source,
          { a: 1, b: 0, c: 0, d: 1, tx: 3, ty: 2 },
          colors,
          mode,
          clip,
          false,
        );
        drawBitmap(
          general,
          source,
          { a: 1, b: 0, c: 1e-12, d: 1, tx: 3, ty: 2 },
          colors,
          mode,
          clip,
          false,
        );
        assert.deepEqual(fast.pixels, general.pixels, `${mode} ${transparent} ${!!colors}`);
      }
    }
  }
});

test("a store written on the GPU is read back once, when its pixels are next read", () => {
  const store = new BitmapStore(2, 1, true, 0);
  let reads = 0;
  let destroyed = false;
  const copy = {
    version: -1,
    read: () => {
      reads++;
      return Uint32Array.of(0xff102030, 0x80402010);
    },
    copy: () => false,
    fill: () => false,
    destroy: () => {
      destroyed = true;
    },
  };
  store.copies.add(copy);
  const seen: boolean[] = [];
  const view = { pixelsChanged: (disposed: boolean) => seen.push(disposed) };
  store.views.add(new WeakRef(view));

  const version = store.version;
  store.drawnOnGpu(copy);
  // The change is told and counted at once; nothing comes back yet.
  assert.deepEqual([store.newerOnGpu, store.version, reads, seen], [true, version + 1, 0, [false]]);

  assert.equal(store.getPixel32(0, 0).toString(16), "ff102030");
  assert.equal(store.getPixel32(1, 0).toString(16), "807f4020");
  assert.deepEqual([store.newerOnGpu, reads], [false, 1]);

  store.dispose();
  assert.equal(destroyed, true);
  assert.equal(store.gpu, null);
  assert.deepEqual(seen, [false, true]);
});

test("moves and fills of a store newer on the GPU stay there; the rest bring it back once", () => {
  const store = new BitmapStore(4, 4, true, 0);
  const done: string[] = [];
  let reads = 0;
  const copy = {
    version: -1,
    read: () => {
      reads++;
      return new Uint32Array(16).fill(0xff0000ff);
    },
    copy: (
      source: BitmapStore,
      r: { x: number; y: number; width: number; height: number },
      dx: number,
      dy: number,
    ) => {
      done.push(
        `copy ${source === store ? "self" : "other"} ${r.x},${r.y} ${r.width}x${r.height} to ${dx},${dy}`,
      );
      return true;
    },
    fill: (r: { x: number; y: number; width: number; height: number }, pixel: number) => {
      done.push(`fill ${r.x},${r.y} ${r.width}x${r.height} ${pixel.toString(16)}`);
      return true;
    },
    destroy: () => {},
  };
  const opaque = new BitmapStore(2, 2, false, 0x00ff00);
  const faint = new BitmapStore(2, 2, true, 0x8000ff00);
  store.copies.add(copy);
  store.drawnOnGpu(copy);

  // A draw then a scroll a frame, as a trail does: nothing comes back.
  for (let frame = 0; frame < 3; frame++) {
    store.drawnOnGpu(copy);
    scroll(store, 0, -1);
  }

  scroll(store, 9, 0);
  scroll(store, 0, 0);
  // A scroll by nothing keeps the copy current: else the next move on it, finding its
  // texture behind, would read the store back and leave the CPU's pixels behind the GPU's.
  assert.equal(copy.version, store.version);
  store.fillRect({ x: -1, y: 1, width: 3, height: 9 }, 0x80ff0000);
  store.copyPixels(store, { x: 0, y: 0, width: 2, height: 2 }, 1, 0, false);
  store.copyPixels(opaque, { x: 0, y: 0, width: 2, height: 2 }, 3, 3, true);
  assert.deepEqual(done, [
    "copy self 0,1 4x3 to 0,0",
    "copy self 0,1 4x3 to 0,0",
    "copy self 0,1 4x3 to 0,0",
    "fill 0,1 2x3 80800000",
    "copy self 0,0 2x2 to 1,0",
    "copy other 0,0 1x1 to 3,3",
  ]);
  assert.deepEqual([reads, store.newerOnGpu, copy.version], [0, true, store.version]);

  // Moved down and left in place, Flash's order smears: the pixels come back, once.
  store.copyPixels(store, { x: 1, y: 0, width: 2, height: 2 }, 0, 1, false);
  assert.deepEqual([reads, store.newerOnGpu, done.length], [1, false, 6]);

  // Merged over a transparent store, the arithmetic is Flash's, on the CPU.
  store.drawnOnGpu(copy);
  store.copyPixels(faint, { x: 0, y: 0, width: 2, height: 2 }, 0, 0, true);
  assert.deepEqual([reads, store.newerOnGpu, done.length], [2, false, 6]);
  assert.equal(store.getPixel32(3, 3).toString(16), "ff0000ff");
});

test("a rect's edges round to the nearest pixel, a half to the even one, as adl's do", () => {
  assert.deepEqual(
    [0.5, 1.5, 2.5, -0.5, -1.5, -2.5, 1.49, 1.51, -0.7].map(nearest),
    [0, 2, 2, 0, -2, -2, 1, 2, -1],
  );
  // [x, y, width, height] as given, and the pixels adl's copies and fills cover.
  const cases: [number[], number[]][] = [
    [
      [0.5, 3, 5, 4],
      [0, 3, 6, 4],
    ],
    [
      [1.5, 3, 5, 4],
      [2, 3, 4, 4],
    ],
    [
      [2.5, 3, 5, 4],
      [2, 3, 6, 4],
    ],
    [
      [2.6, 3, 5.6, 4],
      [3, 3, 5, 4],
    ],
    [
      [-0.5, 3, 5, 4],
      [0, 3, 4, 4],
    ],
    [
      [-1.5, 3, 5, 4],
      [-2, 3, 6, 4],
    ],
    [
      [2.5, 1.7, 10.6, 10.2],
      [2, 2, 11, 10],
    ],
    [
      [3.5, 4, 1, 1],
      [4, 4, 0, 1],
    ],
    [
      [5, 5, -3, 4],
      [5, 5, -3, 4],
    ],
  ];
  for (const [[x, y, w, h], [ex, ey, ew, eh]] of cases) {
    assert.deepEqual(
      pixelRect(x, y, w, h),
      { x: ex, y: ey, width: ew, height: eh },
      `${[x, y, w, h]}`,
    );
  }
});

test("an edge clamps to 2^30 - 1 either way, and NaN is int's least, as adl converts them", () => {
  const limit = 2 ** 30 - 1;
  assert.deepEqual(
    [
      NaN,
      Infinity,
      -Infinity,
      1e20,
      -1e20,
      2 ** 31,
      -(2 ** 31),
      limit,
      limit + 0.6,
      -limit - 1,
      -0,
      2.5,
    ].map(pixelEdge),
    [-(2 ** 31), limit, -limit, limit, -limit, limit, -limit, limit, limit, -limit, 0, 2],
  );
  assert.ok(Object.is(pixelEdge(-0), 0));

  // [x, y, width, height] as given, and the pixels they cover: always finite.
  const cases: [number[], number[]][] = [
    [
      [2, 2, Infinity, 3],
      [2, 2, limit - 2, 3],
    ],
    [
      [2, 2, NaN, 3],
      [2, 2, -(2 ** 31) - 2, 3],
    ],
    [
      [NaN, 2, 3, 3],
      [-(2 ** 31), 2, 0, 3],
    ],
    [
      [Infinity, 2, 3, 3],
      [limit, 2, 0, 3],
    ],
    [
      [-Infinity, 2, Infinity, 3],
      [-limit, 2, -(2 ** 31) + limit, 3],
    ],
    [
      [-5e9, 2, 6e9, 3],
      [-limit, 2, 1e9 + limit, 3],
    ],
  ];
  for (const [[x, y, w, h], [ex, ey, ew, eh]] of cases) {
    assert.deepEqual(
      pixelRect(x, y, w, h),
      { x: ex, y: ey, width: ew, height: eh },
      `${[x, y, w, h]}`,
    );
  }

  // Each covers nothing of a store, or the part a reach to its edge would.
  const store = new BitmapStore(8, 8, true, 0);
  assert.deepEqual(store.clip(pixelRect(2, 2, Infinity, 3)), { x: 2, y: 2, width: 6, height: 3 });
  for (const r of [
    [NaN, 2, 3, 3],
    [2, 2, NaN, 3],
    [Infinity, 2, 3, 3],
    [-Infinity, 2, 3, 3],
    [2, 2, -Infinity, 3],
    [-Infinity, 2, Infinity, 3],
  ]) {
    assert.equal(store.clip(pixelRect(r[0], r[1], r[2], r[3])), null, `${r}`);
  }
});

test("a negative size spans back over the numbers, before their edges are made", () => {
  const limit = 2 ** 30 - 1;
  assert.deepEqual(spanRect(5, 2, -3, 3), { x: 2, y: 2, width: 3, height: 3 });
  assert.deepEqual(spanRect(2, 7, 3, -4.6), { x: 2, y: 2, width: 3, height: 5 });
  // From 1e20 back to 0, the clamp reaching past the bitmap.
  assert.deepEqual(spanRect(1e20, 2, -1e20, 3), { x: 0, y: 2, width: limit, height: 3 });
  // 5 - 1e20 + 1e20 is 0 in a double: a rect ending at 0, not reaching to 5.
  assert.deepEqual(spanRect(5, 5, -1e20, -1e20), {
    x: -limit,
    y: -limit,
    width: limit,
    height: limit,
  });
  assert.equal(new BitmapStore(8, 8, true, 0).clip(spanRect(5, 5, -Infinity, 2)), null);
});

test("a copy in place moved right and down by no more than its rect leaves what lay past the edge empty", () => {
  const store = new BitmapStore(16, 16, false, 0);
  const rect = (x: number, y: number, width: number, height: number) => ({ x, y, width, height });
  // The rect, the point, and the gaps: none where it moves left or up, or further than its size.
  assert.deepEqual(store.copyGaps(rect(-3, 2, 8, 4), 3, 4), [rect(3, 4, 3, 4)]);
  assert.deepEqual(store.copyGaps(rect(-3, 2, 8, 4), 5, 6), [rect(5, 6, 3, 4)]);
  assert.deepEqual(store.copyGaps(rect(-3, 2, 8, 4), 6, 3), []);
  assert.deepEqual(store.copyGaps(rect(-3, 2, 8, 4), 2, 0), []);
  assert.deepEqual(store.copyGaps(rect(2, -3, 4, 8), 6, 5), [rect(6, 5, 4, 3)]);
  assert.deepEqual(store.copyGaps(rect(-3, -3, 8, 8), 0, 0), [rect(0, 0, 3, 8), rect(3, 0, 5, 3)]);
  assert.deepEqual(store.copyGaps(rect(-2, -1, 4, 3), 3, 4), []);
  assert.deepEqual(store.copyGaps(rect(2, 3, 5, 4), 3, 4), []);

  // Filled opaque black, the copy itself clipped and moved as any other.
  for (let x = 0; x < 16; x++) {
    store.setPixel32(x, 2, 0xff000000 | x);
  }

  store.copyPixels(store, rect(-3, 2, 8, 1), 3, 4, false);
  const row = Array.from({ length: 12 }, (_, x) => store.getPixel32(x, 4).toString(16));
  assert.deepEqual(row.slice(3), [
    "ff000000",
    "ff000000",
    "ff000000",
    "ff000000",
    "ff000001",
    "ff000002",
    "ff000003",
    "ff000004",
    "ff000000",
  ]);

  // From another bitmap, the rect is clipped and the point moved with it.
  const other = new BitmapStore(16, 16, true, 0x80ffffff);
  const into = new BitmapStore(16, 16, true, 0);
  into.copyPixels(other, rect(-3, 2, 8, 1), 3, 4, false);
  assert.deepEqual(
    Array.from({ length: 12 }, (_, x) => into.getPixel32(x, 4) >>> 24),
    [0, 0, 0, 0, 0, 0, 0x80, 0x80, 0x80, 0x80, 0x80, 0],
  );

  // A rect wholly left of the bitmap copies nothing, but its gap is still a change shown.
  store.setPixel32(0, 1, 0xff123456);
  const version = store.version;
  store.copyPixels(store, rect(-5, 1, 3, 2), -2, 1, false);
  assert.equal(store.getPixel32(0, 1), 0xff000000);
  assert.notEqual(store.version, version);
});

test("a gap of a copy in place on the GPU is filled there, after the copy", () => {
  for (const transparent of [false, true]) {
    const store = new BitmapStore(8, 8, transparent, 0xff102030);
    const done: string[] = [];
    const copy = {
      version: -1,
      read: () => new Uint32Array(64),
      copy: (
        _: BitmapStore,
        r: { x: number; y: number; width: number; height: number },
        dx: number,
        dy: number,
      ) => {
        done.push(`copy ${r.x},${r.y} ${r.width}x${r.height} to ${dx},${dy}`);
        return true;
      },
      fill: (r: { x: number; y: number; width: number; height: number }, pixel: number) => {
        done.push(`fill ${r.x},${r.y} ${r.width}x${r.height} ${pixel.toString(16)}`);
        return true;
      },
      destroy: () => {},
    };
    store.copies.add(copy);
    store.drawnOnGpu(copy);
    store.copyPixels(store, { x: -2, y: 1, width: 5, height: 3 }, 1, 2, false);
    assert.deepEqual(done, [
      "copy 0,1 3x3 to 3,2",
      `fill 1,2 2x3 ${transparent ? "0" : "ff000000"}`,
    ]);
    assert.equal(store.newerOnGpu, true);
  }
});

test("merge in place reads each pixel as the ones before it left it", () => {
  const store = new BitmapStore(4, 1, false, 0);
  for (let x = 0; x < 4; x++) {
    store.setPixel32(x, 0, 0xff000000 | x);
  }

  merge(store, store, { x: 0, y: 0, width: 3, height: 1 }, 1, 0, [256, 256, 256, 256]);
  assert.deepEqual(
    Array.from({ length: 4 }, (_, x) => store.getPixel32(x, 0) & 0xff),
    [0, 0, 0, 0],
  );
});
