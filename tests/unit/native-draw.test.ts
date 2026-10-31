// BitmapData.draw of a bitmap in the normal blend mode by the render
// module's draw kernel (draw.zig, through draw-kernel.ts), held to the draw
// a pixel at a time (player/bitmap/draw-reference.ts) on random bitmaps:
// scaled, mirrored, turned and moved by whole pixels, smoothed or not,
// through colour transforms, clipped, into transparent and opaque stores;
// and a source drawn again after it changed, which the module holds a copy
// of, drawn as it is now.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BitmapStore } from "../../packages/player/dist/bitmap/bitmap.js";
import { drawKernel } from "../../packages/player/dist/bitmap/kernel.js";
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
  assert.ok(drawKernel(), "the realm has the module");
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
    drawBitmap(into, source, m, ct, "normal", clip, smooth);
    referenceDraw(expected, source, m, ct, "normal", clip, smooth);
    const what = `draw ${i}: ${JSON.stringify({ m, ct, clip, smooth })}`;
    assert.deepEqual(into.pixels, expected.pixels, what);
  }
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
