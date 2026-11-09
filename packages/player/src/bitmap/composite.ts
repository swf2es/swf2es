// BitmapData.draw of a bitmap on the CPU: a source composited onto a
// store through a matrix, a colour transform, a clip and a blend mode,
// as Flash's pixels under adl have it, a row at a time; the render
// module's DrawKernel draws what it can natively. Display objects reach
// it as a bitmap of what the renderer drew (draw.ts).
import {
  DRAW_OPAQUE,
  DRAW_SKIP_ZERO_ALPHA,
  DRAW_SMOOTH,
  DRAW_TRANSFORM,
  DrawKernel,
} from "@swf2es/native/render";
import { BitmapStore, over, type PixelRect } from "./bitmap.js";
import { drawKernel } from "./kernel.js";

/** An affine matrix as Flash's flash.geom.Matrix has it: x' = a x + c y + tx, y' = b x + d y + ty. */
export interface Affine {
  a: number;
  b: number;
  c: number;
  d: number;
  tx: number;
  ty: number;
}

export interface ColorTransformValues {
  rMul: number;
  gMul: number;
  bMul: number;
  aMul: number;
  rAdd: number;
  gAdd: number;
  bAdd: number;
  aAdd: number;
}

interface PreparedColorTransform extends ColorTransformValues {
  skipZeroAlpha: boolean;
}

/** A display object's layer drawn (drawBitmap): a Bitmap's, a drawing's snapshot, or none. */
export type Layer = "bitmap" | "drawing" | null;

// The blend modes draw composites with, as the numbers the pixel loops take,
// worked out once a draw.
const NORMAL = 0;
const MULTIPLY = 1;
const SCREEN = 2;
const LIGHTEN = 3;
const DARKEN = 4;
const DIFFERENCE = 5;
const ADD = 6;
const SUBTRACT = 7;
const INVERT = 8;
const OVERLAY = 9;
const HARDLIGHT = 10;
const ERASE = 11;
const ALPHA = 12;

/**
 * Each blend mode draw takes, by its name; any other draws nothing. Alpha
 * and erase need a layer: a display object drawn has one, and they then
 * scale the destination's alpha where it covers; a BitmapData drawn has
 * not, and they do nothing.
 */
const MODES = new Map([
  ["normal", NORMAL],
  ["layer", NORMAL],
  ["multiply", MULTIPLY],
  ["screen", SCREEN],
  ["lighten", LIGHTEN],
  ["darken", DARKEN],
  ["difference", DIFFERENCE],
  ["add", ADD],
  ["subtract", SUBTRACT],
  ["invert", INVERT],
  ["overlay", OVERLAY],
  ["hardlight", HARDLIGHT],
  ["erase", ERASE],
  ["alpha", ALPHA],
]);

/**
 * draw of a bitmap source: each destination pixel in the clip takes the
 * source pixel under its centre, through the matrix's inverse, clamped to
 * the source's edges (bilinear when smoothing), scaled by how much of the
 * pixel the transformed source covers (a 4 x 4 sample grid), passed
 * through the colour transform as colorTransform does, and composited by
 * the blend mode. Flash's own pixels, under adl: nearest at the centre,
 * normal as the store's source-over, alpha and erase as nothing unless the
 * source is a display object's `layer`: a Bitmap's, every pixel of which it
 * covers, or a drawing's snapshot, which covers only where it drew.
 */
export function drawBitmap(
  store: BitmapStore,
  source: BitmapStore,
  m: Affine,
  ct: ColorTransformValues | null,
  mode: string,
  clip: PixelRect | null,
  smooth: boolean,
  rows = false,
  layer: Layer = null,
): void {
  const code = MODES.get(mode);
  const whole = code === ERASE || code === ALPHA;
  if (code === undefined || (whole && layer === null)) {
    return;
  }

  // A drawing's alpha blend leaves the destination where it drew nothing, or drew clear (adl).
  const keepClear = code === ALPHA && layer === "drawing";

  // Flash rasterises the translation snapped down to quarter pixels, which
  // its 4 x 4 coverage then reads exactly (a move of 0.49 covers 3/4 and
  // 1/4 of the edge pixels under adl).
  m = { ...m, tx: Math.floor(m.tx * 4) / 4, ty: Math.floor(m.ty * 4) / 4 };
  const det = m.a * m.d - m.b * m.c;
  if (det === 0) {
    return;
  }

  // The destination pixels the source can reach: its corners through the matrix.
  const corners = [
    [0, 0],
    [source.width, 0],
    [0, source.height],
    [source.width, source.height],
  ].map(([x, y]) => [m.a * x + m.c * y + m.tx, m.b * x + m.d * y + m.ty]);
  const xs = corners.map((p) => p[0]);
  const ys = corners.map((p) => p[1]);
  let area: PixelRect | null = store.clip({
    x: Math.floor(Math.min(...xs)),
    y: Math.floor(Math.min(...ys)),
    width: Math.ceil(Math.max(...xs)) - Math.floor(Math.min(...xs)),
    height: Math.ceil(Math.max(...ys)) - Math.floor(Math.min(...ys)),
  });
  if (area && clip) {
    area = store.clip({
      x: Math.max(area.x, clip.x),
      y: Math.max(area.y, clip.y),
      width: Math.min(area.x + area.width, clip.x + clip.width) - Math.max(area.x, clip.x),
      height: Math.min(area.y + area.height, clip.y + clip.height) - Math.max(area.y, clip.y),
    });
  }

  if (!area) {
    return;
  }

  // A layer's blend reads the source as it was: of a Bitmap of the bitmap itself, the part
  // that can reach the area is copied first.
  if (whole && source === store) {
    [source, m] = reachable(store, m, area);
  }

  const transform = ct ? prepareColorTransform(ct) : null;
  // Unscaled at a whole pixel, as every snapshot of a display object is
  // composited: each covered pixel is covered whole and is the source's
  // own, so it is copied straight, as the general path below would.
  const moved =
    m.a === 1 &&
    m.b === 0 &&
    m.c === 0 &&
    m.d === 1 &&
    Number.isInteger(m.tx) &&
    Number.isInteger(m.ty) &&
    source !== store;
  // The inverse: from a destination point to the source's.
  const ia = m.d / det;
  const ib = -m.b / det;
  const ic = -m.c / det;
  const id = m.a / det;
  const itx = -(ia * m.tx + ic * m.ty);
  const ity = -(ib * m.tx + id * m.ty);
  if (code === NORMAL && source !== store) {
    const inverse = job.inverse;
    inverse[0] = ia;
    inverse[1] = ib;
    inverse[2] = ic;
    inverse[3] = id;
    inverse[4] = itx;
    inverse[5] = ity;
    if (drawnNatively(store, source, m, moved, area, transform, smooth)) {
      return;
    }
  }

  if (moved) {
    if (composite(store, source, area, m.tx, m.ty, transform, code, keepClear)) {
      store.changed();
    }

    return;
  }

  // How many of the pixel's 4 x 4 samples fall inside the source.
  const coverage = (x: number, y: number) => {
    let hits = 0;
    for (let k = 0; k < 16; k++) {
      const px = x + ((k & 3) + 0.5) / 4;
      const py = y + ((k >> 2) + 0.5) / 4;
      const sx = ia * px + ic * py + itx;
      const sy = ib * px + id * py + ity;
      if (sx >= 0 && sy >= 0 && sx < source.width && sy < source.height) {
        hits++;
      }
    }

    return hits;
  };

  // The arrays taken once. What the source reads as: its own pixels drawn into itself, else as
  // a draw reads them. The store's, which bring back what the GPU drew last or copy a library
  // bitmap's, are taken at the first pixel put, but first when the source is the store, which
  // reads them as written.
  let into = source === store ? store.pixels : null;
  const pixels = source === store ? source.readable : source.drawable;
  // Whether a pixel was put, for the store to count a change: a draw that puts none is none.
  let wrote = false;

  // Through a Bitmap of itself, a BitmapData is drawn in plain scan order,
  // each pixel reading what the ones before it wrote, which smears both
  // ways (adl): pixel by pixel. A layer's blend has a copy of it by now.
  if (source === store && !rows) {
    for (let y = area.y; y < area.y + area.height; y++) {
      for (let x = area.x; x < area.x + area.width; x++) {
        const hits = coverage(x, y);
        if (hits === 0) {
          continue;
        }

        const cx = x + 0.5;
        const cy = y + 0.5;
        const sx = ia * cx + ic * cy + itx;
        const sy = ib * cx + id * cy + ity;
        let p = smooth
          ? bilinear(pixels, source.width, source.height, sx - 0.5, sy - 0.5)
          : nearest(pixels, source.width, source.height, sx, sy);
        if (transform) {
          p = transformed(p, transform);
        }

        if (hits < 16) {
          p = scaleBy(p, hits / 16);
        }

        into ??= store.pixels;
        put(store, into, y * store.width + x, code, p);
        wrote = true;
      }
    }

    if (wrote) {
      store.changed();
    }

    return;
  }

  // Otherwise a row at a time, each pass over it in a loop of its own, so
  // that no pixel crosses a call: a pixel past 2^30 a call returns is a
  // number V8 allocates. Every pixel of a row is read before one is
  // written, which is how Flash draws a BitmapData into itself: a move
  // right keeps the pixels, a move down smears rows.
  const n = area.width;
  const buffers = takeRows(n);
  try {
    const { pixels: row, hits, us, vs } = buffers;
    const w = source.width;
    const h = source.height;

    for (let y = area.y; y < area.y + area.height; y++) {
      // Where all 16 samples of a pixel surely fall inside the source, and
      // where none can: only the pixels between are tested sample by sample.
      spanFrom = Number.NEGATIVE_INFINITY;
      spanTo = Number.POSITIVE_INFINITY;
      const spans = !whole && coveredSpan(ia, ic, itx, w, y) && coveredSpan(ib, id, ity, h, y);
      const fullFrom = spans ? Math.max(area.x, spanFrom) : 0;
      const fullTo = spans ? Math.min(area.x + n, spanTo) : 0;
      let any = 0;

      for (let x = area.x, k = 0; k < n; x++, k++) {
        const cx = x + 0.5;
        const cy = y + 0.5;
        const sx = ia * cx + ic * cy + itx;
        const sy = ib * cx + id * cy + ity;
        let hit = 16;
        if (whole) {
          // Erase and alpha take a pixel whole where the source is at its centre, as adl
          // draws a shape's edge for them, an edge through the centre counted on its right
          // and below.
          hit = sx > 0 && sy > 0 && sx <= w && sy <= h ? 16 : 0;
        } else if (x < fullFrom || x >= fullTo) {
          hit = coverage(x, y);
        }

        hits[k] = hit;
        if (hit === 0) {
          continue;
        }

        any++;
        us[k] = sx;
        vs[k] = sy;
      }

      if (any === 0) {
        continue;
      }

      sampleRow(pixels, w, h, us, vs, hits, row, n, smooth);
      if (transform) {
        transformRow(row, hits, n, transform);
      }

      coverRow(row, hits, n);
      into ??= store.pixels;
      blendRow(store, into, y * store.width + area.x, row, hits, n, code, keepClear);
      wrote = true;
    }
  } finally {
    giveRowsBack(buffers);
  }

  if (wrote) {
    store.changed();
  }
}

/** The draw kernel's job, filled for each draw: drawBitmap allocates nothing for it. */
const job = DrawKernel.job();

/** How far a source point may lie for the draw kernel, whose numbers are then exact as drawBitmap's. */
const REACH = 2 ** 30;

/**
 * A draw in the normal blend mode of another store, by the draw kernel
 * (draw.zig), whose pixels are those of the paths below, to the bit, the
 * matrix's inverse in `job.inverse` already: whether it drew it, which it
 * does not for numbers it cannot take as they are, nor where the realm has
 * no kernel.
 */
function drawnNatively(
  store: BitmapStore,
  source: BitmapStore,
  m: Affine,
  moved: boolean,
  area: PixelRect,
  ct: PreparedColorTransform | null,
  smooth: boolean,
): boolean {
  // A store the GPU drew last is read back only by a draw that puts a pixel, as below.
  if (store.newerOnGpu) {
    return false;
  }

  // The source rows the draw reads: the area's, moved; else those its corners reach, and one
  // more each way for smoothing and rounding. A point far out, or not finite, is drawn below.
  const inverse = job.inverse;
  let top: number;
  let bottom: number;
  if (moved) {
    if (Math.abs(m.tx) >= 2 ** 31 || Math.abs(m.ty) >= 2 ** 31) {
      return false;
    }

    top = area.y - m.ty;
    bottom = top + area.height;
  } else {
    const x0 = area.x;
    const x1 = area.x + area.width;
    const y0 = area.y;
    const y1 = area.y + area.height;
    const ia = inverse[0];
    const ib = inverse[1];
    const ic = inverse[2];
    const id = inverse[3];
    const itx = inverse[4];
    const ity = inverse[5];
    const ya = ib * x0 + id * y0 + ity;
    const yb = ib * x1 + id * y0 + ity;
    const yc = ib * x0 + id * y1 + ity;
    const yd = ib * x1 + id * y1 + ity;
    const xa = ia * x0 + ic * y0 + itx;
    const xb = ia * x1 + ic * y0 + itx;
    const xc = ia * x0 + ic * y1 + itx;
    const xd = ia * x1 + ic * y1 + itx;
    const low = Math.min(ya, yb, yc, yd);
    const high = Math.max(ya, yb, yc, yd);
    const far = Math.max(Math.abs(xa), Math.abs(xb), Math.abs(xc), Math.abs(xd));
    if (!(Math.abs(low) < REACH && Math.abs(high) < REACH && far < REACH)) {
      return false;
    }

    top = Math.max(0, Math.min(source.height - 1, Math.floor(low) - 1));
    bottom = Math.max(top + 1, Math.min(source.height, Math.ceil(high) + 1));
  }

  if (ct) {
    const t = job.transform;
    t[0] = ct.rMul;
    t[1] = ct.gMul;
    t[2] = ct.bMul;
    t[3] = ct.aMul;
    t[4] = ct.rAdd;
    t[5] = ct.gAdd;
    t[6] = ct.bAdd;
    t[7] = ct.aAdd;
    if (!t.every(Number.isFinite)) {
      return false;
    }
  }

  // Copying wide source rows for a small clip can cost more than the draw.
  // Whole-pixel moves do less work per destination pixel, so their limit is lower.
  const sourcePixels = source.width * (bottom - top);
  const copiedPerPixel = moved ? 32 : 128;
  if (sourcePixels > Math.max(1024, area.width * area.height * copiedPerPixel)) {
    return false;
  }

  const kernel = drawKernel();
  if (!kernel) {
    return false;
  }

  job.source = source.drawable;
  job.sourceWidth = source.width;
  job.sourceHeight = source.height;
  job.sourceTop = top;
  job.sourceRows = bottom - top;
  job.into = store.readable;
  job.intoWidth = store.width;
  job.x = area.x;
  job.y = area.y;
  job.width = area.width;
  job.height = area.height;
  job.moved = moved;
  job.tx = moved ? m.tx : 0;
  job.ty = moved ? m.ty : 0;
  job.flags =
    (smooth ? DRAW_SMOOTH : 0) |
    (ct ? DRAW_TRANSFORM : 0) |
    (store.transparent ? 0 : DRAW_OPAQUE) |
    (ct?.skipZeroAlpha ? DRAW_SKIP_ZERO_ALPHA : 0);
  const result = kernel.draw(job);
  // The job holds no store's pixels past the draw.
  job.source = EMPTY;
  job.into = EMPTY;
  if (result === "refused") {
    return false;
  }

  if (result === "written") {
    kernel.writeBack(job, store.pixels);
    store.changed();
  }

  return true;
}

const EMPTY = new Uint32Array(0);

/** drawBitmap's buffers for a row. */
interface RowScratch {
  pixels: Uint32Array;
  hits: Uint8Array;
  /** Each pixel's point in the source. */
  us: Float64Array;
  vs: Float64Array;
}

/**
 * The row buffers kept between draws, which drawBitmap and composite take
 * for a draw and give back after it. A draw runs to its end without
 * calling out, so no other draw can take them in the middle of one:
 * `scratchTaken` holds that, and a draw that finds them taken throws
 * rather than overwrite a row another is working on.
 */
let scratch: RowScratch = {
  pixels: new Uint32Array(0),
  hits: new Uint8Array(0),
  us: new Float64Array(0),
  vs: new Float64Array(0),
};
let scratchTaken = false;

/** The widest row whose buffers are kept for the next draw: a wider one's go with its draw. */
const ROW_KEPT = 8192;

/** Buffers for rows of `n` pixels: the kept ones where they are wide enough, until given back. */
function takeRows(n: number): RowScratch {
  if (scratch.pixels.length >= n) {
    if (scratchTaken) {
      throw new Error("drawBitmap's row buffers are taken by a draw already under way");
    }

    scratchTaken = true;
    return scratch;
  }

  const buffers = {
    pixels: new Uint32Array(n),
    hits: new Uint8Array(n),
    us: new Float64Array(n),
    vs: new Float64Array(n),
  };
  if (n <= ROW_KEPT && !scratchTaken) {
    scratch = buffers;
    scratchTaken = true;
  }

  return buffers;
}

function giveRowsBack(buffers: RowScratch): void {
  if (buffers === scratch) {
    scratchTaken = false;
  }
}

/** coveredSpan's answer: the first pixel of a row covered whole and the one past the last. */
let spanFrom = 0;
let spanTo = 0;

/**
 * Narrows spanFrom to spanTo, the destination pixels in row y whose 16 samples
 * all have u = a x + c y' + t within [0, size), y' each of the row's four
 * sample rows; false where u barely moves along x without being still,
 * which leaves every pixel to be tested. The span keeps a margin of a
 * thousandth of a pixel, and more where the numbers are large, from where
 * the samples' own arithmetic decides, so a pixel in it is one the tests
 * find whole.
 */
function coveredSpan(a: number, c: number, t: number, size: number, y: number): boolean {
  if (a === 0) {
    // u is the same all along a sample row, worked out as the tests do.
    for (let k = 0; k < 4; k++) {
      const u = c * (y + (k + 0.5) / 4) + t;
      if (!(u >= 0 && u < size)) {
        spanFrom = Number.POSITIVE_INFINITY;
      }
    }

    return true;
  }

  if (Math.abs(a) < 1e-6) {
    return false;
  }

  for (let k = 0; k < 4; k++) {
    const offset = c * (y + (k + 0.5) / 4) + t;
    // The x where u is 0 and where it is size, in either order.
    const at0 = -offset / a;
    const atSize = (size - offset) / a;
    const margin =
      0.001 +
      (1e-12 * (Math.abs(offset) + size + Math.abs(a) * (Math.abs(at0) + Math.abs(atSize)))) /
        Math.abs(a);
    const low = Math.min(at0, atSize) + margin;
    const high = Math.max(at0, atSize) - margin;
    if (!Number.isFinite(low) || !Number.isFinite(high)) {
      return false;
    }

    // Samples lie at x + 1/8 to x + 7/8.
    spanFrom = Math.max(spanFrom, Math.ceil(low - 0.125));
    spanTo = Math.min(spanTo, Math.floor(high - 0.875) + 1);
  }

  return true;
}

/** The source's pixel under each covered pixel's point of the row, nearest or bilinear. */
function sampleRow(
  from: Uint32Array,
  width: number,
  height: number,
  us: Float64Array,
  vs: Float64Array,
  hits: Uint8Array,
  row: Uint32Array,
  n: number,
  smooth: boolean,
): void {
  for (let k = 0; k < n; k++) {
    if (hits[k] === 0) {
      continue;
    }

    row[k] = smooth
      ? bilinear(from, width, height, us[k] - 0.5, vs[k] - 0.5)
      : nearest(from, width, height, us[k], vs[k]);
  }
}

/** The row's covered pixels through the colour transform, a run of one pixel transformed once. */
function transformRow(
  row: Uint32Array,
  hits: Uint8Array,
  n: number,
  ct: PreparedColorTransform,
): void {
  let last = -1;
  let out = 0;
  for (let k = 0; k < n; k++) {
    if (hits[k] === 0) {
      continue;
    }

    const p = row[k];
    if (p !== last) {
      last = p;
      out = transformed(p, ct);
    }

    row[k] = out;
  }
}

/** The row's partly covered pixels scaled by their coverage. */
function coverRow(row: Uint32Array, hits: Uint8Array, n: number): void {
  for (let k = 0; k < n; k++) {
    const hit = hits[k];
    if (hit !== 0 && hit < 16) {
      row[k] = scaleBy(row[k], hit / 16);
    }
  }
}

/**
 * The row's covered pixels composited into the store's pixels from `at` by
 * the blend mode; with `keepClear`, a clear one leaves the destination be.
 */
function blendRow(
  store: BitmapStore,
  into: Uint32Array,
  at: number,
  row: Uint32Array,
  hits: Uint8Array,
  n: number,
  mode: number,
  keepClear: boolean,
): void {
  if (mode === NORMAL) {
    const opaque = store.transparent ? 0 : 0xff000000;
    for (let k = 0; k < n; k++) {
      if (hits[k] === 0) {
        continue;
      }

      const p = row[k];
      const sa = p >>> 24;
      into[at + k] = sa === 255 ? p : (over(p, into[at + k]) | opaque) >>> 0;
    }

    return;
  }

  for (let k = 0; k < n; k++) {
    if (hits[k] !== 0 && !(keepClear && row[k] >>> 24 === 0)) {
      put(store, into, at + k, mode, row[k]);
    }
  }
}

/** `source` at (tx, ty) composited into `area` of the store, a pixel each; whether it put one. */
function composite(
  store: BitmapStore,
  source: BitmapStore,
  area: PixelRect,
  tx: number,
  ty: number,
  ct: PreparedColorTransform | null,
  mode: number,
  keepClear: boolean,
): boolean {
  const from = source.drawable;
  const opaque = store.transparent ? 0 : 0xff000000;
  // The store's pixels, taken as drawBitmap takes them: at the first pixel put.
  let into: Uint32Array | null = null;
  if (!ct && mode === NORMAL) {
    for (let y = area.y; y < area.y + area.height; y++) {
      let i = y * store.width + area.x;
      let j = (y - ty) * source.width + (area.x - tx);
      for (let x = 0; x < area.width; x++, i++, j++) {
        // Source over, inline: what blend("normal") computes.
        const p = from[j];
        const sa = p >>> 24;
        if (sa === 0) {
          continue;
        }

        into ??= store.pixels;
        into[i] = sa === 255 ? p : (over(p, into[i]) | opaque) >>> 0;
      }
    }

    return into !== null;
  }

  // A row at a time through the passes drawBitmap's rows take, every pixel covered.
  const n = area.width;
  const buffers = takeRows(n);
  try {
    const { pixels: row, hits } = buffers;
    hits.fill(16, 0, n);
    into = store.pixels;

    for (let y = area.y; y < area.y + area.height; y++) {
      const j = (y - ty) * source.width + (area.x - tx);
      // A view and a copy: a loop copying it was slower, for all a view allocates.
      row.set(from.subarray(j, j + n));
      if (ct) {
        transformRow(row, hits, n, ct);
      }

      blendRow(store, into, y * store.width + area.x, row, hits, n, mode, keepClear);
    }
  } finally {
    giveRowsBack(buffers);
  }

  return true;
}

/**
 * A drawn pixel composited into the store by the blend mode, opaque where
 * the store is, but for erase and alpha: an opaque bitmap holds the alpha
 * they leave, as Flash's memory does, and reads it back (getPixel32).
 */
function put(store: BitmapStore, into: Uint32Array, i: number, mode: number, p: number): void {
  const out = blend(mode, p, into[i]);
  if (store.transparent) {
    into[i] = out;
  } else if (mode === ERASE || mode === ALPHA) {
    into[i] = out;
    store.holdsAlpha ||= out >>> 24 !== 255;
  } else {
    into[i] = (out | 0xff000000) >>> 0;
  }
}

/**
 * The part of `store` a draw of itself through `m` into `area` can read,
 * copied, as a layer reads it before the draw writes, and the matrix that
 * draws the copy where the store would be drawn: the area's corners taken
 * back through the matrix, a pixel wider for smoothing, within the store.
 */
function reachable(store: BitmapStore, m: Affine, area: PixelRect): [BitmapStore, Affine] {
  const det = m.a * m.d - m.b * m.c;
  const back = [
    [area.x, area.y],
    [area.x + area.width, area.y],
    [area.x, area.y + area.height],
    [area.x + area.width, area.y + area.height],
  ].map(([x, y]) => [
    (m.d * (x - m.tx) - m.c * (y - m.ty)) / det,
    (m.a * (y - m.ty) - m.b * (x - m.tx)) / det,
  ]);
  const x0 = Math.max(0, Math.floor(Math.min(...back.map((p) => p[0]))) - 1);
  const y0 = Math.max(0, Math.floor(Math.min(...back.map((p) => p[1]))) - 1);
  const x1 = Math.min(store.width, Math.ceil(Math.max(...back.map((p) => p[0]))) + 1);
  const y1 = Math.min(store.height, Math.ceil(Math.max(...back.map((p) => p[1]))) + 1);
  const width = Math.max(0, x1 - x0);
  const height = Math.max(0, y1 - y0);
  const copy = new BitmapStore(width, height, store.transparent, 0);
  const from = store.readable;
  const into = copy.pixels;
  for (let y = 0; y < height; y++) {
    into.set(
      from.subarray((y0 + y) * store.width + x0, (y0 + y) * store.width + x0 + width),
      y * width,
    );
  }

  copy.holdsAlpha = store.holdsAlpha;
  return [copy, { ...m, tx: m.tx + m.a * x0 + m.c * y0, ty: m.ty + m.b * x0 + m.d * y0 }];
}

function nearest(from: Uint32Array, width: number, height: number, x: number, y: number): number {
  const px = Math.min(width - 1, Math.max(0, Math.floor(x)));
  const py = Math.min(height - 1, Math.max(0, Math.floor(y)));
  return from[py * width + px];
}

/** Bilinear between the four premultiplied pixels round (x, y), clamped to the edges. */
function bilinear(from: Uint32Array, width: number, height: number, x: number, y: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const left = Math.min(width - 1, Math.max(0, x0));
  const right = Math.min(width - 1, Math.max(0, x0 + 1));
  const top = Math.min(height - 1, Math.max(0, y0)) * width;
  const bottom = Math.min(height - 1, Math.max(0, y0 + 1)) * width;
  const p00 = from[top + left];
  const p10 = from[top + right];
  const p01 = from[bottom + left];
  const p11 = from[bottom + right];
  const gx = 1 - fx;
  const gy = 1 - fy;

  return (
    ((lerp4(p00, p10, p01, p11, 24, fx, fy, gx, gy) << 24) |
      (lerp4(p00, p10, p01, p11, 16, fx, fy, gx, gy) << 16) |
      (lerp4(p00, p10, p01, p11, 8, fx, fy, gx, gy) << 8) |
      lerp4(p00, p10, p01, p11, 0, fx, fy, gx, gy)) >>>
    0
  );
}

/** One channel of bilinear's four pixels, weighed by fx and fy and by gx and gy, their complements. */
function lerp4(
  p00: number,
  p10: number,
  p01: number,
  p11: number,
  shift: number,
  fx: number,
  fy: number,
  gx: number,
  gy: number,
): number {
  const top = ((p00 >>> shift) & 0xff) * gx + ((p10 >>> shift) & 0xff) * fx;
  const bottom = ((p01 >>> shift) & 0xff) * gx + ((p11 >>> shift) & 0xff) * fx;
  return Math.round(top * gy + bottom * fy);
}

/** A premultiplied pixel through a colour transform, as colorTransform computes it. */
function transformed(p: number, ct: PreparedColorTransform): number {
  const a0 = p >>> 24;
  if (a0 === 0 && ct.skipZeroAlpha) {
    return 0;
  }

  const a = colorChannel(a0, ct.aMul, ct.aAdd);
  return (
    ((a << 24) |
      (drawColorChannel(p, a0, 16, ct.rMul, ct.rAdd, a) << 16) |
      (drawColorChannel(p, a0, 8, ct.gMul, ct.gAdd, a) << 8) |
      drawColorChannel(p, a0, 0, ct.bMul, ct.bAdd, a)) >>>
    0
  );
}

function prepareColorTransform(ct: ColorTransformValues): PreparedColorTransform {
  return {
    rMul: Math.trunc(ct.rMul * 256),
    gMul: Math.trunc(ct.gMul * 256),
    bMul: Math.trunc(ct.bMul * 256),
    aMul: Math.trunc(ct.aMul * 256),
    rAdd: Math.trunc(ct.rAdd),
    gAdd: Math.trunc(ct.gAdd),
    bAdd: Math.trunc(ct.bAdd),
    aAdd: Math.trunc(ct.aAdd),
    // The alpha-zero guard tests the original offset before truncation.
    skipZeroAlpha: ct.aAdd <= 0,
  };
}

// These stay outside the pixel loops so a transform creates no per-pixel closures.
function colorChannel(v: number, mul: number, add: number): number {
  return Math.max(0, Math.min(255, Math.floor((v * mul) / 256) + add));
}

function straightChannel(p: number, alpha: number, shift: number): number {
  return alpha === 0 ? 0 : Math.min(255, Math.floor((((p >>> shift) & 0xff) * 255) / alpha));
}

function premultipliedChannel(v: number, alpha: number): number {
  return alpha === 255 ? v : (v * (alpha + 1)) >> 8;
}

function drawColorChannel(
  p: number,
  alpha: number,
  shift: number,
  mul: number,
  add: number,
  outAlpha: number,
): number {
  const v = colorChannel(straightChannel(p, alpha, shift), mul, add);

  return premultipliedChannel(v, outAlpha);
}

/** A premultiplied pixel with all four channels scaled by a coverage. */
function scaleBy(p: number, f: number): number {
  return (
    ((Math.round((p >>> 24) * f) << 24) |
      (Math.round(((p >>> 16) & 0xff) * f) << 16) |
      (Math.round(((p >>> 8) & 0xff) * f) << 8) |
      Math.round((p & 0xff) * f)) >>>
    0
  );
}

/**
 * The destination alone, as erase and alpha leave it: each channel scaled
 * by k / 255, what the source's alpha leaves or is, floored, as adl's are.
 */
function scaleFloored(d: number, k: number): number {
  const a = Math.floor(((d >>> 24) * k) / 255);
  const r = Math.floor((((d >>> 16) & 0xff) * k) / 255);
  const g = Math.floor((((d >>> 8) & 0xff) * k) / 255);
  const b = Math.floor(((d & 0xff) * k) / 255);
  return ((a << 24) | (r << 16) | (g << 8) | b) >>> 0;
}

/** x * y / 255, rounded as the blend modes' arithmetic has it. */
function mul(x: number, y: number): number {
  return (x * y + 127) / 255;
}

/**
 * Premultiplied s over d by a blend mode, the W3C's compositing with each
 * mode's mix. Every helper takes its operands as arguments, so a pixel
 * allocates nothing: a closure over them would take a context each call.
 */
function blend(mode: number, s: number, d: number): number {
  if (mode === NORMAL) {
    return over(s, d);
  }

  const sa = s >>> 24;
  if (mode === ERASE || mode === ALPHA) {
    return scaleFloored(d, mode === ERASE ? 255 - sa : sa);
  }

  const da = d >>> 24;
  const a =
    mode === ADD || mode === SUBTRACT
      ? Math.min(255, sa + da)
      : Math.min(255, Math.round(sa + da - mul(sa, da)));
  return (
    ((a << 24) |
      (blendChannel(mode, (s >>> 16) & 0xff, (d >>> 16) & 0xff, sa, da) << 16) |
      (blendChannel(mode, (s >>> 8) & 0xff, (d >>> 8) & 0xff, sa, da) << 8) |
      blendChannel(mode, s & 0xff, d & 0xff, sa, da)) >>>
    0
  );
}

/** A colour channel of blend: source cs and destination cd under alphas sa and da. */
function blendChannel(mode: number, cs: number, cd: number, sa: number, da: number): number {
  let b: number;
  switch (mode) {
    case MULTIPLY:
      b = mul(cs, cd);
      break;
    case SCREEN:
      b = (cs * da) / 255 + (cd * sa) / 255 - mul(cs, cd);
      break;
    case LIGHTEN:
      b = Math.max(mul(cs, da), mul(cd, sa));
      break;
    case DARKEN:
      b = Math.min(mul(cs, da), mul(cd, sa));
      break;
    case DIFFERENCE:
      b = Math.abs(mul(cs, da) - mul(cd, sa));
      break;
    case ADD:
      return Math.min(255, cs + cd);
    case SUBTRACT:
      return Math.max(0, cd - cs);
    case INVERT:
      // The destination inverted, the source's colour unused.
      return Math.max(0, Math.min(255, Math.floor(mul(255 - cd, sa) + mul(cd, 255 - sa))));
    case OVERLAY:
      b = 2 * cd <= da ? 2 * mul(cs, cd) : mul(sa, da) - 2 * mul(da - cd, sa - cs);
      break;
    default:
      b = 2 * cs <= sa ? 2 * mul(cs, cd) : mul(sa, da) - 2 * mul(da - cd, sa - cs);
      break;
  }

  return Math.max(0, Math.min(255, Math.floor(b + mul(cs, 255 - da) + mul(cd, 255 - sa))));
}
