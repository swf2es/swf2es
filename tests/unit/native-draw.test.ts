// BitmapData.draw of a bitmap in the normal blend mode by the render
// module's draw kernel (draw.zig, through draw-kernel.ts), held to the draw
// a pixel at a time (player/bitmap/draw-reference.ts) on random bitmaps:
// scaled, mirrored, turned and moved by whole pixels, smoothed or not,
// through colour transforms, clipped, into transparent and opaque stores;
// what it leaves to the JS (a disposed source, numbers too far out), a
// trap, and the instance let go of when its players end or it goes idle.
import assert from "node:assert/strict";
import { test } from "node:test";
import { DrawKernel } from "@swf2es/native/render";
import { BitmapStore } from "../../packages/player/dist/bitmap/bitmap.js";
import {
  drawKernel,
  drawKernelFrame,
  drawKernelLetGo,
  drawKernelUsed,
} from "../../packages/player/dist/bitmap/kernel.js";
import { drawBitmap } from "../../packages/player/dist/bitmap/ops.js";
import {
  type Affine,
  type ColorTransformValues,
  referenceDraw,
} from "./player/bitmap/draw-reference.ts";

function random(seed: number): () => number {
  let s = seed;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/** A store of random premultiplied pixels, some clear, some translucent. */
function store(r: () => number, w: number, h: number, transparent: boolean): BitmapStore {
  const s = new BitmapStore(w, h, transparent, 0);
  for (let i = 0; i < s.pixels.length; i++) {
    const roll = r();
    const a = !transparent || roll < 0.5 ? 255 : roll < 0.6 ? 0 : Math.floor(r() * 256);
    s.pixels[i] = s.premultiplied(((a << 24) | Math.floor(r() * 0x1000000)) >>> 0);
  }

  return s;
}

function copy(s: BitmapStore): BitmapStore {
  const c = new BitmapStore(s.width, s.height, s.transparent, 0);
  c.pixels.set(s.pixels);
  return c;
}

function matrix(r: () => number): Affine {
  const tx = r() * 30 - 8;
  const ty = r() * 30 - 8;
  switch (Math.floor(r() * 4)) {
    case 0:
      // Moved by whole pixels: composite's.
      return { a: 1, b: 0, c: 0, d: 1, tx: Math.round(tx), ty: Math.round(ty) };
    case 1: {
      // Scaled and mirrored, unturned: the columns and rows worked out once.
      const sx = (0.2 + r() * 3) * (r() < 0.3 ? -1 : 1);
      const sy = (0.2 + r() * 3) * (r() < 0.3 ? -1 : 1);
      return { a: sx, b: 0, c: 0, d: sy, tx: sx < 0 ? tx + 20 : tx, ty: sy < 0 ? ty + 20 : ty };
    }
    case 2: {
      const turn = r() * 7;
      const scale = 0.3 + r() * 2;
      return {
        a: Math.cos(turn) * scale,
        b: Math.sin(turn) * scale,
        c: -Math.sin(turn) * scale,
        d: Math.cos(turn) * scale,
        tx: tx + 10,
        ty: ty + 10,
      };
    }
    default:
      return { a: 1, b: 0, c: 0, d: 1, tx, ty };
  }
}

function transform(r: () => number): ColorTransformValues | null {
  if (r() < 0.5) {
    return null;
  }

  const mul = () => (r() < 0.2 ? 1 : r() * 2 - 0.2);
  const add = () => (r() < 0.4 ? 0 : Math.round(r() * 400 - 200));
  return {
    rMul: mul(),
    gMul: mul(),
    bMul: mul(),
    aMul: mul(),
    rAdd: add(),
    gAdd: add(),
    bAdd: add(),
    aAdd: add(),
  };
}

test("the kernel draws what a draw a pixel at a time draws, every pixel", () => {
  const kernel = drawKernel();
  assert.ok(kernel, "the realm has the module");
  const before = kernel.drawn;
  let skipped = 0;
  const r = random(17);
  for (let i = 0; i < 600; i++) {
    const source = store(r, 2 + Math.floor(r() * 20), 2 + Math.floor(r() * 20), r() < 0.8);
    const into = store(r, 24 + Math.floor(r() * 16), 20 + Math.floor(r() * 16), r() < 0.7);
    const expected = copy(into);
    const m = matrix(r);
    const ct = transform(r);
    const clip =
      r() < 0.3 ? { x: Math.floor(r() * 10), y: Math.floor(r() * 10), width: 12, height: 9 } : null;
    const smooth = r() < 0.4;
    const drawn = kernel.drawn;
    const version = into.version;
    drawBitmap(into, source, m, ct, "normal", clip, smooth);
    referenceDraw(expected, source, m, ct, "normal", clip, smooth);
    const what = `draw ${i}: ${JSON.stringify({ m, ct, clip, smooth })}`;
    assert.deepEqual(into.pixels, expected.pixels, what);
    // Drawn by the kernel, not the JS, but where the draw reaches no pixel of the destination.
    if (kernel.drawn === drawn) {
      skipped++;
      assert.equal(into.version, version, `${what} left to the JS`);
    }
  }

  assert.ok(kernel.drawn - before > 400 && skipped + kernel.drawn - before === 600);
});

test("a store drawn into, then drawn, is drawn as the draw left it", () => {
  const kernel = drawKernel() as DrawKernel;
  const r = random(5);
  const source = store(r, 9, 7, true);
  const middle = store(r, 20, 20, true);
  const into = store(r, 30, 30, false);
  const expectedMiddle = copy(middle);
  const expectedInto = copy(into);
  const before = kernel.drawn;
  const m = { a: 1.5, b: 0, c: 0, d: -1.25, tx: 2.5, ty: 15 };
  drawBitmap(middle, source, m, null, "normal", null, true);
  referenceDraw(expectedMiddle, source, m, null, "normal", null, true);
  const turned = { a: 0.8, b: 0.6, c: -0.6, d: 0.8, tx: 10, ty: 2 };
  drawBitmap(into, middle, turned, null, "normal", null, false);
  referenceDraw(expectedInto, expectedMiddle, turned, null, "normal", null, false);
  assert.deepEqual(into.pixels, expectedInto.pixels);
  assert.equal(kernel.drawn - before, 2);
});

test("a disposed source and a matrix reaching too far are left to the JS, as it draws them", () => {
  const kernel = drawKernel() as DrawKernel;
  const r = random(9);
  const source = store(r, 6, 6, true);
  source.dispose();
  const into = store(r, 16, 16, true);
  const before = kernel.drawn;
  drawBitmap(into, source, { a: 2, b: 0, c: 0, d: 2, tx: 1, ty: 1 }, null, "normal", null, false);
  assert.equal(kernel.drawn, before, "its pixels are not as many as its size says");

  // A scale so small that the source's points are past any number: the JS's path draws it.
  const live = store(r, 6, 6, true);
  for (const smooth of [false, true]) {
    const target = store(r, 16, 16, true);
    const expected = copy(target);
    const m = { a: 1, b: 0, c: 0, d: 1e-308, tx: 1, ty: 3 };
    drawBitmap(target, live, m, null, "normal", null, smooth);
    referenceDraw(expected, live, m, null, "normal", null, smooth);
    assert.deepEqual(target.pixels, expected.pixels);
  }

  assert.equal(kernel.drawn, before);
});

test("a draw that throws in the kernel is refused, and the next is drawn by a new instance", () => {
  const kernel = drawKernel() as DrawKernel;
  const job = DrawKernel.job();
  Object.assign(job, { sourceWidth: 2, sourceHeight: 1, sourceRows: 1, width: 1, height: 1 });
  job.source = new Uint32Array(2);
  job.into = {
    subarray() {
      throw new Error("a trap");
    },
  } as unknown as Uint32Array;
  assert.equal(kernel.draw(job), "refused");
  assert.equal(kernel.held, false);

  const r = random(11);
  const into = store(r, 10, 10, true);
  const expected = copy(into);
  const source = store(r, 4, 4, true);
  const before = kernel.drawn;
  drawBitmap(into, source, { a: 1, b: 0, c: 0, d: 1, tx: 2, ty: 2 }, null, "normal", null, false);
  referenceDraw(
    expected,
    source,
    { a: 1, b: 0, c: 0, d: 1, tx: 2, ty: 2 },
    null,
    "normal",
    null,
    false,
  );
  assert.deepEqual(into.pixels, expected.pixels);
  assert.equal(kernel.drawn, before + 1);
  assert.equal(kernel.held, true);
});

test("the kernel lets its instance go when its last player ends, or after idle frames", () => {
  const kernel = drawKernel() as DrawKernel;
  const r = random(13);
  const draw = () =>
    drawBitmap(
      store(r, 8, 8, true),
      store(r, 3, 3, true),
      { a: 2, b: 0, c: 0, d: 2, tx: 0, ty: 0 },
      null,
      "normal",
      null,
      false,
    );

  drawKernelUsed();
  drawKernelUsed();
  draw();
  assert.equal(kernel.held, true);
  drawKernelLetGo();
  assert.equal(kernel.held, true, "a player still plays");
  drawKernelLetGo();
  assert.equal(kernel.held, false);

  draw();
  for (let i = 0; i < 100; i++) {
    drawKernelFrame();
  }

  assert.equal(kernel.held, true, "not idle long enough");
  for (let i = 0; i < 30; i++) {
    drawKernelFrame();
  }

  assert.equal(kernel.held, false);
});

test("a source drawn again after it changed is drawn as it is now", () => {
  const r = random(3);
  const source = store(r, 6, 5, true);
  const into = new BitmapStore(16, 16, true, 0);
  const m = { a: 2, b: 0, c: 0, d: 2, tx: 1, ty: 1 };
  drawBitmap(into, source, m, null, "normal", null, false);

  // Changed in place, then given a new array: each drawn as it is, not as the module held it.
  source.fillRect({ x: 0, y: 0, width: 6, height: 5 }, 0xff102030);
  const first = new BitmapStore(16, 16, true, 0);
  drawBitmap(first, source, m, null, "normal", null, false);
  assert.equal(first.pixels[3 * 16 + 3], 0xff102030);

  source.pixels = new Uint32Array(30).fill(0xff405060);
  const second = new BitmapStore(16, 16, true, 0);
  drawBitmap(second, source, m, null, "normal", null, false);
  assert.equal(second.pixels[3 * 16 + 3], 0xff405060);
});
