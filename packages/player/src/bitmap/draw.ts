// A display object drawn into a bitmap: rendered by the host's renderer
// over its own bounds alone, then composited as a bitmap is (ops.ts
// drawBitmap). AS3's BitmapData.draw and AVM1's share it.

import { bounds } from "../display/bounds.js";
import { type DisplayObject, pickWork } from "../display/display.js";
import { transformRect } from "../display/geometry.js";
import { drawnAsStage } from "../display/perspective.js";
import type { Drawer } from "../hosts.js";
import { BitmapStore, type PixelRect } from "./bitmap.js";
import { type Affine, type ColorTransformValues, drawBitmap } from "./ops.js";

/** `d` drawn into `store` through `m`, as drawInto draws a display object. */
function drawObject(
  drawer: Drawer,
  store: BitmapStore,
  d: DisplayObject,
  m: Affine,
  c: ColorTransformValues | null,
  blend: string,
  r: PixelRect | null,
  samples: number,
): void {
  // Only the part the object can reach: its bounds through the matrix, a
  // pixel wider for anti-aliasing, within the clip and the bitmap; the
  // snapshot's cost is then the object's size, not the bitmap's.
  const local = bounds(d, true);
  if (!local) {
    return;
  }

  const reach = transformRect(local, m);
  const x0 = Math.max(0, Math.floor(reach.xMin) - 1, r ? r.x : 0);
  const y0 = Math.max(0, Math.floor(reach.yMin) - 1, r ? r.y : 0);
  const x1 = Math.min(store.width, Math.ceil(reach.xMax) + 1, r ? r.x + r.width : store.width);
  const y1 = Math.min(store.height, Math.ceil(reach.yMax) + 1, r ? r.y + r.height : store.height);
  if (x1 <= x0 || y1 <= y0) {
    return;
  }

  const placed = { ...m, tx: m.tx - x0, ty: m.ty - y0 };
  // Plain source over goes on the GPU, the store left there until a script reads it.
  if (
    !c &&
    blend === "normal" &&
    drawer.drawInto(store, d, placed, x0, y0, x1 - x0, y1 - y0, samples)
  ) {
    return;
  }

  // Erase and alpha go by where the object is, not how much of a pixel it covers: adl draws
  // them unsmoothed, as low quality draws.
  const grid = blend === "erase" || blend === "alpha" ? 1 : samples;
  const drawn = new BitmapStore(x1 - x0, y1 - y0, true, 0);
  drawn.pixels = drawer.snapshot(d, placed, x1 - x0, y1 - y0, grid);
  const at = { a: 1, b: 0, c: 0, d: 1, tx: x0, ty: y0 };
  drawBitmap(store, drawn, at, c, blend, r, false, false, "drawing");
}

/**
 * A display object drawn into `store` through `m` by `drawer`, the host's
 * renderer, over its own bounds alone, then composited as a bitmap is: an
 * AS3 BitmapData's draw, and an AVM1 one's.
 */
export function drawDisplayObject(
  drawer: Drawer,
  store: BitmapStore,
  d: DisplayObject,
  m: Affine,
  c: ColorTransformValues | null,
  blend: string,
  r: PixelRect | null,
  samples: number,
): void {
  // What is in 3D in an object on no stage projects as on a stage the bitmap's size.
  let top: DisplayObject = d;
  while (top.parent) {
    top = top.parent;
  }

  const restore = drawnAsStage(top, store.width, store.height);
  if (!restore) {
    drawObject(drawer, store, d, m, c, blend, r, samples);
    return;
  }

  // Planes in perspective made before are made again, for that stage and after it; only then,
  // as each change picks the pointer's hover again and remakes every plane.
  pickWork.changes++;
  try {
    drawObject(drawer, store, d, m, c, blend, r, samples);
  } finally {
    restore();
    pickWork.changes++;
  }
}
