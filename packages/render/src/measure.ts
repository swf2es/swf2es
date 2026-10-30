import type { Geometries } from "./geometry.js";
import { ROW_FLOATS, type Rows } from "./rows.js";
import {
  DRAW,
  KEPT,
  LAYER_BEGIN,
  LAYER_END,
  MASK_BEGIN,
  MASK_POP,
  MASK_USE,
  NO_WHOLE,
  type SceneList,
  WHOLE_ALIASED,
  WHOLE_SMOOTH,
} from "./scene.js";

/**
 * What measuring a frame's layers needs of its target: its size in pixels,
 * its pixels a stage pixel, and its pixels a unit of its own (resolution),
 * which a filtered layer is padded in.
 */
export interface MeasureTarget {
  width: number;
  height: number;
  scale: number;
  resolution: number;
}

/** A hair, which keeps a padded edge on the pixel it lies on at any resolution. */
const TEXEL_SNAP = 1e-6;

// Scratch stacks, four numbers an open area: least x and y, greatest x and y, in target pixels.
const areas: number[] = [];
const clips: number[] = [];
const open: number[] = [];

/**
 * Each layer's rectangle of the target (SceneList.layerRect), from what is
 * drawn in it: its draws' geometries placed by their rows, a mask's own
 * draws apart, what a mask clips cut to that mask's draws as it pops, and
 * the rectangles of the layers in it; out to whole pixels and a pixel more
 * each way, cut to the target. What is drawn is what is measured, so a
 * layer covers its draws however they came to be where they are. A
 * filtered layer is measured as PixiJS's filter system measures it, which
 * the filters' exactness rules were found with: cut to the target, out to
 * whole pixels, then padded, not cut again; where nothing is drawn in it,
 * it draws nothing.
 */
export function measureLayers(
  scene: SceneList,
  rows: Rows,
  geometries: Geometries,
  target: MeasureTarget,
): void {
  if (scene.layerCount === 0) {
    return;
  }

  areas.length = 0;
  clips.length = 0;
  open.length = 0;
  pushEmpty(areas);
  const k = target.scale;
  const box = geometries.box;
  const m = rows.data;

  for (let i = 0; i < scene.length; i++) {
    switch (scene.kind[i]) {
      case DRAW:
        placeDraw(scene, i, box, m, k, areas);
        break;

      case MASK_BEGIN:
        // The mask's own draws, measured apart.
        pushEmpty(areas);
        break;
      case LAYER_BEGIN:
        open.push(scene.geometry[i]);
        pushEmpty(areas);
        break;
      case MASK_USE:
        // The mask's draws clip what follows, measured apart till it pops.
        moveTop(areas, clips);
        pushEmpty(areas);
        break;
      case MASK_POP: {
        const n = areas.length;
        const c = clips.length;
        const left = Math.max(areas[n - 4], clips[c - 4]);
        const top = Math.max(areas[n - 3], clips[c - 3]);
        const right = Math.min(areas[n - 2], clips[c - 2]);
        const bottom = Math.min(areas[n - 1], clips[c - 1]);
        areas.length = n - 4;
        clips.length = c - 4;
        if (right > left && bottom > top) {
          unionTop(left, top, right, bottom);
        }

        break;
      }

      case LAYER_END: {
        const n = areas.length;
        const layer = open.pop() as number;
        const pad = scene.pads[layer];
        if (pad < 0) {
          const left = Math.max(0, Math.floor(areas[n - 4]) - 1);
          const top = Math.max(0, Math.floor(areas[n - 3]) - 1);
          const right = Math.min(target.width, Math.ceil(areas[n - 2]) + 1);
          const bottom = Math.min(target.height, Math.ceil(areas[n - 1]) + 1);
          areas.length = n - 4;
          if (right > left && bottom > top) {
            scene.layerRect(layer, left, top, right - left, bottom - top);
            unionTop(left, top, right, bottom);
          }

          break;
        }

        const kept = scene.areas;
        for (let k = 0; k < 4; k++) {
          kept[layer * 4 + k] = areas[n - 4 + k];
        }

        filteredRect(
          scene.areas,
          layer * 4,
          pad,
          target,
          scene.layers,
          layer * 4,
          scene.wholes[layer],
        );
        areas.length = n - 4;
        const r = scene.layers;
        const at = layer * 4;
        if (r[at + 2] > 0) {
          unionTop(r[at], r[at + 1], r[at] + r[at + 2], r[at + 1] + r[at + 3]);
        }

        break;
      }

      case KEPT: {
        // A kept output covers its rectangle, which its owner placed.
        const r = scene.layers;
        const at = scene.geometry[i] * 4;
        if (r[at + 2] > 0 && r[at + 3] > 0) {
          unionTop(r[at], r[at + 1], r[at] + r[at + 2], r[at + 1] + r[at + 3]);
        }

        break;
      }
    }
  }
}

/**
 * The rectangle a filtered layer padded by `pad` units covers, from its
 * area (least x and y, greatest x and y in target pixels, from `area[at]`)
 * as PixiJS's filter system has it (FilterSystem's _calculateFilterArea): in
 * units, the area cut to the target, out to whole pixels at the
 * resolution, or to whole units as `whole` says (SceneList.wholes),
 * padded; nothing where it has no size then; its edges snapped to the
 * pixels they lie on. Into `out` from `to`: x, y, width, height, of no
 * size for nothing.
 */
export function filteredRect(
  area: ArrayLike<number>,
  at: number,
  pad: number,
  target: MeasureTarget,
  out: Int32Array,
  to: number,
  whole = NO_WHOLE,
): void {
  const res = target.resolution;
  let x0 = area[at] / res;
  let y0 = area[at + 1] / res;
  let x1 = area[at + 2] / res;
  let y1 = area[at + 3] / res;
  out[to] = 0;
  out[to + 1] = 0;
  out[to + 2] = 0;
  out[to + 3] = 0;
  if (!(x1 > x0 && y1 > y0)) {
    return;
  }

  // Each edge moved in alone, as Bounds.fitBounds does: an area off the target turns inside out,
  // and its padding may yet give it a size.
  x0 = Math.max(x0, 0);
  y0 = Math.max(y0, 0);
  x1 = Math.min(x1, target.width / res);
  y1 = Math.min(y1, target.height / res);
  if (whole !== NO_WHOLE) {
    // Out to twips first, as Flash keeps an object's bounds.
    x0 = Math.floor(x0 * 20 + TEXEL_SNAP) / 20;
    y0 = Math.floor(y0 * 20 + TEXEL_SNAP) / 20;
    x1 = Math.ceil(x1 * 20 - TEXEL_SNAP) / 20;
    y1 = Math.ceil(y1 * 20 - TEXEL_SNAP) / 20;
  }

  switch (whole) {
    case WHOLE_SMOOTH:
      x0 = Math.floor(x0) - pad;
      y0 = Math.floor(y0) - pad;
      x1 = Math.floor(x1) + 1 + pad;
      y1 = Math.floor(y1) + 1 + pad;
      break;
    case WHOLE_ALIASED:
      x0 = Math.ceil(x0 - 0.5) - pad;
      y0 = Math.ceil(y0 - 0.5) - pad;
      x1 = Math.ceil(x1 - 0.5) + pad;
      y1 = Math.ceil(y1 - 0.5) + pad;
      break;
    default:
      x0 = Math.floor(x0 * res) / res - pad;
      y0 = Math.floor(y0 * res) / res - pad;
      x1 = Math.ceil(x1 * res) / res + pad;
      y1 = Math.ceil(y1 * res) / res + pad;
  }
  if (!(x1 - x0 > 0 && y1 - y0 > 0)) {
    return;
  }

  const left = Math.floor(x0 * res + TEXEL_SNAP);
  const top = Math.floor(y0 * res + TEXEL_SNAP);
  out[to] = left;
  out[to + 1] = top;
  out[to + 2] = Math.ceil(x1 * res - TEXEL_SNAP) - left;
  out[to + 3] = Math.ceil(y1 * res - TEXEL_SNAP) - top;
}

/**
 * The area of the target the draws from entry `from` on cover, at `scale`
 * target pixels a stage pixel, masks' own draws apart and nothing cut by
 * the masks: into `out`, its least x and y, then its greatest, in target
 * pixels; nothing drawn leaves the least past the greatest.
 */
export function drawnArea(
  scene: SceneList,
  rows: Rows,
  geometries: Geometries,
  from: number,
  scale: number,
  out: number[],
): void {
  out.length = 0;
  pushEmpty(out);
  let defining = 0;
  for (let i = from; i < scene.length; i++) {
    switch (scene.kind[i]) {
      case DRAW:
        if (defining === 0) {
          placeDraw(scene, i, geometries.box, rows.data, scale, out);
        }

        break;
      case MASK_BEGIN:
        defining++;
        break;
      case MASK_USE:
        defining--;
        break;
    }
  }
}

/** Entry `i`'s geometry box placed by its row at `k` target pixels a stage pixel, taken into the area atop `stack`. */
function placeDraw(
  scene: SceneList,
  i: number,
  box: Float32Array,
  m: Float32Array,
  k: number,
  stack: number[],
): void {
  const g = scene.geometry[i] * 4;
  const x0 = box[g];
  const y0 = box[g + 1];
  const x1 = box[g + 2];
  const y1 = box[g + 3];
  if (!(x1 >= x0 && y1 >= y0)) {
    return;
  }

  const r = scene.row[i] * ROW_FLOATS;
  const a = m[r] * k;
  const b = m[r + 1] * k;
  const c = m[r + 2] * k;
  const d = m[r + 3] * k;
  const tx = m[r + 4] * k;
  const ty = m[r + 5] * k;
  // The box's corners placed: each of the least and greatest a coordinate takes, by sign.
  const n = stack.length;
  stack[n - 4] = Math.min(stack[n - 4], tx + Math.min(a * x0, a * x1) + Math.min(c * y0, c * y1));
  stack[n - 3] = Math.min(stack[n - 3], ty + Math.min(b * x0, b * x1) + Math.min(d * y0, d * y1));
  stack[n - 2] = Math.max(stack[n - 2], tx + Math.max(a * x0, a * x1) + Math.max(c * y0, c * y1));
  stack[n - 1] = Math.max(stack[n - 1], ty + Math.max(b * x0, b * x1) + Math.max(d * y0, d * y1));
}

function pushEmpty(stack: number[]): void {
  stack.push(
    Number.POSITIVE_INFINITY,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
  );
}

/** The top area of `from` moved onto `to`. */
function moveTop(from: number[], to: number[]): void {
  const n = from.length;
  to.push(from[n - 4], from[n - 3], from[n - 2], from[n - 1]);
  from.length = n - 4;
}

/** The open area on top grown to take in the rectangle. */
function unionTop(left: number, top: number, right: number, bottom: number): void {
  const n = areas.length;
  areas[n - 4] = Math.min(areas[n - 4], left);
  areas[n - 3] = Math.min(areas[n - 3], top);
  areas[n - 2] = Math.max(areas[n - 2], right);
  areas[n - 1] = Math.max(areas[n - 1], bottom);
}
