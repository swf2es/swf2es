// BitmapData.applyFilter and generateFilterRect, on the CPU, as adl
// computes them (docs/architecture.md, "Filters"): the source filtered, past
// the source rect too, and the filter's rect written whole into the
// destination; a blur's runs truncated to 8 bits each, a glow's alpha from
// the blur so truncated times strength, a bevel's from the difference of two
// reads of it, a colour matrix of straight colour, rounded, a convolution of
// straight colour, truncated; the blurs, glows, shadows, bevels and
// convolutions by the render module.

import type { Filter } from "../display/filters.js";
import { ramp } from "../display/gradients.js";
import {
  type BitmapStore,
  EDGE_LIMIT,
  NAN_EDGE,
  over,
  type PixelRect,
  premultiply,
  unmultiply,
} from "./bitmap.js";
import { bitmapKernel } from "./kernel.js";

/** The filters with a glow, a shadow or a bevel, which an opaque destination refuses. */
export const GLOWS: ReadonlySet<string> = new Set([
  "glow",
  "dropShadow",
  "bevel",
  "gradientGlow",
  "gradientBevel",
]);

/** The filters this filters: the others' rects and pixels are still to come. */
export const filtersDrawn: ReadonlySet<string> = new Set([
  "blur",
  "glow",
  "dropShadow",
  "colorMatrix",
  "convolution",
  "bevel",
  "gradientGlow",
  "gradientBevel",
  "displacementMap",
]);

/**
 * How far adl's rect for a blur of `quality` passes reaches, a blur below
 * 1 counting as 1: the passes' spread, which grows slower than their
 * number, as a float, times the blur; for a blur that rounded up from a
 * quarter, for the others half to even from a half, as x87 rounds.
 */
const PASS_SPREADS = [
  1.0, 2.1, 2.7, 3.1, 3.5, 3.8, 4.0, 4.2, 4.4, 4.6, 5.0, 6.0, 6.0, 7.0, 7.0,
].map((spread) => Math.fround(spread) / 2);

function spreadOf(blur: number, quality: number, kind: string): number {
  if (quality < 1) {
    return 0;
  }

  const x = Math.max(blur || 0, 1) * PASS_SPREADS[Math.min(quality, 15) - 1];
  if (kind === "blur") {
    return Math.floor(x + 0.75);
  }

  const v = x + 0.5;
  const whole = Math.floor(v);
  return v - whole === 0.5 ? whole + (whole % 2) : Math.round(v);
}

/** How far a filter's rect reaches past what it filters, each way, before any offset: [x, y], whole pixels. */
function reach(f: Filter): [number, number] {
  if (f.kind === "convolution") {
    return [f.matrixX >> 1, f.matrixY >> 1];
  }

  if (f.kind === "colorMatrix") {
    return [0, 0];
  }

  // A displacement map's reach, by its scale, as adl reckons it: a quarter of it, whole; none with no map.
  if (f.kind === "displacementMap") {
    return f.mapBitmap
      ? [Math.floor(Math.abs(f.scaleX) / 4) || 0, Math.floor(Math.abs(f.scaleY) / 4) || 0]
      : [0, 0];
  }

  return [spreadOf(f.blurX, f.quality, f.kind), spreadOf(f.blurY, f.quality, f.kind)];
}

/** Where adl's offsets in 256ths run out: the most a part of one reaches, as -2^23 - 256. */
const FAR = -(2 ** 23 + 256);

/**
 * How far off adl's angle is, in radians: its offset has a part across the
 * angle of 6.79e-9 of the distance, back, even on the axes, so 4e9 at 0°
 * reaches 30 up past a reach of 2 and 27 right at 90°, and 1e11 679 both
 * ways (fitted from 5e5 to 1e11 at the four axes, either sign).
 */
const SKEW = -6.79e-9;

/**
 * A shadow's or a bevel's offset, down: [x, y], unrounded. adl keeps each
 * part in 256ths in an int, so one of 2^23 - 1 or more wraps round and one
 * below FAR stops there, both at FAR (generateFilterRect's -8388866 past
 * a reach of 2), as Infinity does; its angle is off by SKEW, which this
 * takes where it comes to a 512th, from a distance of some 288,000, and
 * leaves out nearer, where it would only move a sample between pixels by
 * a hair. A distance of NaN is FAR both ways for an outer shadow or
 * gradient glow, none for the rest; an angle of NaN or Infinity is 0 (an
 * outer shadow refuses either NaN: filterRefusal).
 */
function shadowOffset(f: Filter): [number, number] {
  const d = f.distance;
  if (Number.isNaN(d)) {
    return (f.kind === "dropShadow" || f.kind === "gradientGlow") && !isInner(f)
      ? [FAR, FAR]
      : [0, 0];
  }

  const skew = Math.abs(d * SKEW) >= 1 / 512 ? SKEW : 0;
  const radians = ((f.angle || 0) * Math.PI) / 180 + skew;
  // A part a whisker off whole is whole, as adl's 256ths have it: 3 at
  // 180° is -3 across and 0 down, not 3.7e-16, which would read between rows.
  const part = (v: number) => {
    const whole = Math.round(v);
    return !(v < 2 ** 23 - 1 && v >= FAR) ? FAR : Math.abs(v - whole) < 1e-9 ? whole : v;
  };
  return [part(d * Math.cos(radians)), part(d * Math.sin(radians))];
}

/**
 * A shadow's or a bevel's offset in whole pixels, down: [x, y]. adl has it
 * in 256ths, to the nearest, so the cosine of 90° is 0, not just under it,
 * and 6 × sin 30° is 3, not just under.
 */
function offsetOf(f: Filter): [number, number] {
  const whole = (v: number) => Math.floor(Math.round(v * 256) / 256);
  const [ox, oy] = shadowOffset(f);
  return [whole(ox), whole(oy)];
}

/** Whether `f` is drawn within what it filters: an inner glow, shadow, bevel or gradient one. */
export function isInner(f: Filter): boolean {
  return f.kind === "glow" || f.kind === "dropShadow" ? f.inner : f.type === "inner";
}

/**
 * The rect a filter makes of `rect`, as generateFilterRect gives it: grown
 * by its reach; a shadow's, inner too, by its offset where it moves and
 * less it on the other side, never inward; a bevel's by the offset's size
 * both ways.
 */
export function filterRect(rect: PixelRect, f: Filter): PixelRect {
  const [rx, ry] = reach(f);
  let [left, right, top, bottom] = [rx, rx, ry, ry];
  if (f.kind === "dropShadow" || f.kind === "gradientGlow") {
    const [ox, oy] = offsetOf(f);
    left = Math.max(0, rx - ox);
    right = Math.max(0, rx + ox);
    top = Math.max(0, ry - oy);
    bottom = Math.max(0, ry + oy);
  } else if (f.kind === "bevel" || f.kind === "gradientBevel") {
    const [ox, oy] = offsetOf(f);
    left = right = rx + Math.abs(ox);
    top = bottom = ry + Math.abs(oy);
  }

  return {
    x: rect.x - left,
    y: rect.y - top,
    width: rect.width + left + right,
    height: rect.height + top + bottom,
  };
}

/**
 * generateFilterRect's rect of `given` on a bitmap of `width` by `height`:
 * the rect within the bitmap first, an edge of it a rect of no width, and
 * grown by the filter; one apart from it Flash makes 2^27 - 1 on each side,
 * of no size, grown as any other but an inner filter's, which stays where
 * it is. A displacement map's result is within the bitmap too, and an
 * inner filter's, which draws within what it filters.
 */
export function generatedRect(
  width: number,
  height: number,
  given: PixelRect,
  f: Filter,
): PixelRect {
  const x0 = Math.max(0, given.x);
  const y0 = Math.max(0, given.y);
  const x1 = Math.min(width, given.x + given.width);
  const y1 = Math.min(height, given.y + given.height);
  if (x1 < x0 || y1 < y0) {
    const apart = { x: 0x7ffffff, y: 0x7ffffff, width: 0, height: 0 };
    return isInner(f) ? apart : filterRect(apart, f);
  }

  const r = filterRect({ x: x0, y: y0, width: x1 - x0, height: y1 - y0 }, f);
  if (f.kind !== "displacementMap" && !isInner(f)) {
    return r;
  }

  const rx0 = Math.max(0, r.x);
  const ry0 = Math.max(0, r.y);
  const rx1 = Math.min(width, r.x + r.width);
  const ry1 = Math.min(height, r.y + r.height);
  return rx1 > rx0 && ry1 > ry0
    ? { x: rx0, y: ry0, width: rx1 - rx0, height: ry1 - ry0 }
    : { x: 0, y: 0, width: 0, height: 0 };
}

/** The filters adl refuses a rect for whose left or top edge lies as far as an edge can. */
const EDGED = new Set(["bevel", "gradientBevel", "gradientGlow", "displacementMap"]);

/** The filters whose buffers adl sizes by the rect they write, and refuses past its reach. */
const SIZED = new Set(["colorMatrix", "convolution", "blur", "glow", "dropShadow"]);

/**
 * The error adl refuses applyFilter's `rect` (bitmap.ts pixelRect) for `f`
 * with, as it does where it cannot make the filter's buffers: 2015
 * (ArgumentError), 2077 (IllegalOperationError), or 0 for none. Probed
 * under adl: an x or y of NaN, 2015, for every filter but a colour matrix
 * and a drop shadow cast some distance; a left or top edge clamped to the
 * farthest, as -Infinity is (-2^29 passes), 2015 for the bevels, a
 * gradient glow and a displacement map; and for the filters sized by what
 * they write, 2015 for a filter rect a side of which passes 2^31 / 20
 * pixels (106e6 passes, 108e6 is refused) or of more than 2^29 pixels, a
 * width or height of NaN or Infinity among them, the sizes in int
 * arithmetic as the edges' difference wraps; an outer shadow's grown by
 * its offset (1e5 at 45° is refused), an inner one's not. By its offset
 * alone, as what the rect holds of the source grows by it: a gradient
 * glow outer or full past 2^29 pixels, 2015, and a bevel past a side of
 * 2^31 / 20 or 2^29 pixels, 2077, but outer or full 2015, and 2077 past
 * 2^31 / 10 pixels already; and an outer shadow or gradient glow of
 * a distance or angle of NaN (or Infinity, which the angle keeps as NaN),
 * 2015. A blur or glow some way short of those is refused with 2077,
 * which this leaves.
 */
export function filterRefusal(rect: PixelRect, f: Filter, source: PixelRect): number {
  if (rect.x === NAN_EDGE || rect.y === NAN_EDGE) {
    return f.kind !== "colorMatrix" && !(f.kind === "dropShadow" && f.distance) ? 2015 : 0;
  }

  if (EDGED.has(f.kind) && (rect.x <= 1 - EDGE_LIMIT || rect.y <= 1 - EDGE_LIMIT)) {
    return 2015;
  }

  const outerShadow = (f.kind === "dropShadow" || f.kind === "gradientGlow") && !isInner(f);
  if (outerShadow && (Number.isNaN(f.distance) || Number.isNaN(f.angle))) {
    return 2015;
  }

  const side = 2 ** 31 / 20;
  const held = intersect(rect, source);
  if (held && (f.kind === "gradientGlow" || f.kind === "bevel" || f.kind === "gradientBevel")) {
    const out = filterRect(held, f);
    const pixels = out.width * out.height;
    if (f.kind === "gradientGlow") {
      return !isInner(f) && pixels > 2 ** 29 ? 2015 : 0;
    }

    const past = out.width > side || out.height > side || pixels > 2 ** 29;
    // A bevel outer or full is refused sooner, with 2077 (16777740 by 14, not by
    // 12), and past the rest with 2015.
    if (!isInner(f)) {
      return past ? 2015 : pixels > 2 ** 31 / 10 ? 2077 : 0;
    }

    return past ? 2077 : 0;
  }

  if (!SIZED.has(f.kind)) {
    return 0;
  }

  const sized = isInner(f) ? { ...f, distance: 0 } : f;
  const out = filterRect({ ...rect, width: rect.width | 0, height: rect.height | 0 }, sized);
  const w = Math.abs(out.width);
  const h = Math.abs(out.height);
  return w > side || h > side || w * h > 2 ** 29 ? 2015 : 0;
}

/**
 * `f` with what a filter from a SWF's tags may hold past the ranges the
 * player's filter objects keep (passes to 31, blurs signed 16.16, strength
 * signed 8.8, copied as they are: filterOfSwf) brought within them, as the
 * render module's kernels take them: a blur under 0 none and past 255 255,
 * NaN kept; quality to 15; a strength under 0 none.
 */
function kept(f: Filter): Filter {
  const blur = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : v);
  return {
    ...f,
    blurX: blur(f.blurX),
    blurY: blur(f.blurY),
    quality: Math.max(0, Math.min(15, Math.trunc(f.quality) || 0)),
    strength: Math.max(0, Math.min(255, f.strength || 0)),
  };
}

/**
 * Filter `rect` of `source` into `dest` at (dx, dy), as applyFilter does:
 * the filter's rect, moved there and clipped, written whole. True where the
 * filter is one this draws; the others leave `dest` as it was.
 */
export function applyFilter(
  dest: BitmapStore,
  source: BitmapStore,
  rect: PixelRect,
  dx: number,
  dy: number,
  given: Filter,
  map: BitmapStore | null = null,
): boolean {
  if (!filtersDrawn.has(given.kind)) {
    return false;
  }

  const f = given.kind === "blur" || GLOWS.has(given.kind) ? kept(given) : given;

  const out = filterRect(rect, f);
  // What the destination shows of the filter's rect, in the filter's
  // coordinates, and the work: that and as far round it as the filter
  // reaches into it, so that a rect far past the destination costs nothing.
  let mx = dx - rect.x;
  let my = dy - rect.y;
  // A displacement map writes the rect alone: what adl writes past it is a quirk of its own.
  let written = f.kind === "displacementMap" ? rect : out;
  if (isInner(f)) {
    // adl writes an inner filter's rect as generateFilterRect gives it, within the bitmap, and
    // moves it by that rect's corner from the source rect's a second time (apply-filter-inner).
    const bitmap = { x: 0, y: 0, width: source.width, height: source.height };
    const held = intersect(rect, bitmap);
    const grown = held && intersect(filterRect(held, f), bitmap);
    if (!grown) {
      return true;
    }

    mx += grown.x - rect.x;
    my += grown.y - rect.y;
    written = grown;
  }

  const shown = intersect(written, { x: -mx, y: -my, width: dest.width, height: dest.height });
  if (!shown) {
    return true;
  }

  if (f.kind === "displacementMap") {
    write(dest, displace(source, rect, shown, f, map), shown, shown, mx, my);
    return true;
  }

  if (f.kind === "convolution" && (f.matrixX === 0 || f.matrixY === 0)) {
    copyEmpty(dest, source, rect, out, shown, mx, my);
    return true;
  }

  if (f.kind === "convolution") {
    const pixels = convolve(source, shown, f, dest.transparent);
    if (pixels) {
      write(dest, pixels, shown, shown, mx, my);
    }

    return true;
  }

  if (f.kind === "colorMatrix") {
    colorMatrix(dest, source, rect, dx, dy, f.matrix);
    return true;
  }

  if (f.kind === "blur") {
    // What is shown, blurred as far round it as the blur reaches into it, which may be past the
    // rect, whose edge cuts what is written alone.
    const pixels = bitmapKernel()?.blur(source, shown, f.blurX, f.blurY, f.quality);
    if (pixels) {
      write(dest, pixels, shown, shown, mx, my);
    }

    return true;
  }

  // The source's pixels where they are shown, and its alpha blurred and read
  // from the offset, each over what is shown alone: however far the offset
  // reaches, the work is the destination's size.
  const [ox, oy] = f.kind === "glow" ? [0, 0] : shadowOffset(f);
  // An outer shadow cast as far as an offset goes adl writes empty, the
  // source's own pixels too.
  const outer = (f.kind === "dropShadow" || f.kind === "gradientGlow") && !isInner(f);
  if (outer && (ox === FAR || oy === FAR)) {
    write(dest, new Uint32Array(shown.width * shown.height), shown, shown, mx, my);
    return true;
  }

  const glowing = f.kind === "glow" || f.kind === "dropShadow";
  const bevelled = f.kind === "bevel" || f.kind === "gradientBevel";
  const pixels = bitmapKernel()?.layer(
    source,
    shown,
    {
      kind: f.kind as "glow",
      inner: glowing && f.inner,
      knockout: f.knockout,
      hideObject: f.kind === "dropShadow" && f.hideObject,
      type: f.type,
      // An inner glow blurs what the source leaves.
      invert: glowing && f.inner,
      quality: f.quality,
      blurX: f.blurX,
      blurY: f.blurY,
      strength: f.strength,
      // What the kind does not have, 0, as the kernel takes only values the player's filters hold.
      alpha: glowing ? f.alpha : 0,
      highlightAlpha: f.kind === "bevel" ? f.highlightAlpha : 0,
      shadowAlpha: f.kind === "bevel" ? f.shadowAlpha : 0,
      color: glowing ? f.color : 0,
      highlightColor: f.kind === "bevel" ? f.highlightColor : 0,
      shadowColor: f.kind === "bevel" ? f.shadowColor : 0,
      table: f.kind === "gradientGlow" || f.kind === "gradientBevel" ? gradientTable(f) : null,
    },
    // Read on and back for a bevel, from the offset back for the rest.
    bevelled
      ? [
          [ox, oy],
          [-ox, -oy],
        ]
      : [[-ox, -oy]],
  );
  if (pixels) {
    write(dest, pixels, shown, shown, mx, my);
  }

  return true;
}

function intersect(p: PixelRect, q: PixelRect): PixelRect | null {
  const x0 = Math.max(p.x, q.x);
  const y0 = Math.max(p.y, q.y);
  const x1 = Math.min(p.x + p.width, q.x + q.width);
  const y1 = Math.min(p.y + p.height, q.y + q.height);
  return x1 > x0 && y1 > y0 ? { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } : null;
}

/** The bounds of the pixels of `rect` of the source that are not transparent: null for none. */
function contentOf(source: BitmapStore, rect: PixelRect): PixelRect | null {
  const area = intersect(rect, { x: 0, y: 0, width: source.width, height: source.height });
  if (!area) {
    return null;
  }

  const pixels = source.pixels;
  let x0 = Number.POSITIVE_INFINITY;
  let y0 = Number.POSITIVE_INFINITY;
  let x1 = -1;
  let y1 = -1;
  for (let y = area.y; y < area.y + area.height; y++) {
    for (let x = area.x; x < area.x + area.width; x++) {
      if (pixels[y * source.width + x] >>> 24) {
        x0 = Math.min(x0, x);
        y0 = Math.min(y0, y);
        x1 = Math.max(x1, x);
        y1 = Math.max(y1, y);
      }
    }
  }

  return x1 < 0 ? null : { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 };
}

/**
 * A colour matrix of each pixel's straight colour, rounded, into `dest`.
 * adl maps the pixels about what the source has, its bounds and one more
 * each way, one by one, their colour premultiplied by the new alpha and
 * truncated; the rest of the rect it fills with the map of a transparent
 * pixel, written as the store premultiplies it. Of the rect, only what
 * lies within the source is written, the point moved with the clip, as a
 * copy's is.
 */
function colorMatrix(
  dest: BitmapStore,
  source: BitmapStore,
  rect: PixelRect,
  dx: number,
  dy: number,
  m: number[],
): void {
  const area = intersect(rect, { x: 0, y: 0, width: source.width, height: source.height });
  const mx = dx - rect.x;
  const my = dy - rect.y;
  const shown = area && intersect(area, { x: -mx, y: -my, width: dest.width, height: dest.height });
  if (!shown) {
    return;
  }

  // The map of a transparent pixel, each channel clamped and rounded.
  const [er, eg, eb, ea] = [0, 1, 2, 3].map((row) => {
    const v =
      m[row * 5] * 0 +
      m[row * 5 + 1] * 0 +
      m[row * 5 + 2] * 0 +
      m[row * 5 + 3] * 0 +
      m[row * 5 + 4];
    return Math.max(0, Math.min(255, Math.round(Number.isNaN(v) ? 0 : v)));
  });
  const empty = dest.premultiplied(((ea << 24) | (er << 16) | (eg << 8) | eb) >>> 0);

  // What the source has, and one more each way.
  const content = contentOf(source, area);
  const near = content && {
    x: content.x - 1,
    y: content.y - 1,
    width: content.width + 2,
    height: content.height + 2,
  };
  // Rows down, each in fours from its start, a four read whole before it is
  // written, the rest one by one: in place, a move right repeats what the
  // fours before wrote, as 480 rows under adl show (pixels.zig).
  const into = dest.pixels;
  bitmapKernel()?.copy(
    into,
    dest.width,
    source.pixels,
    source.width,
    { x: shown.x + mx, y: shown.y + my, width: shown.width, height: shown.height },
    shown.x,
    shown.y,
    dest.transparent,
    { op: "matrix", matrix: m, near, empty, opaque: !dest.transparent },
  );
  dest.changed();
}

/** The channel of an unmultiplied pixel a displacement reads: red 1, green 2, blue 4, alpha 8; any other none, 128. */
function channelOf(pixel: number, component: number): number {
  switch (component) {
    case 1:
      return (pixel >>> 16) & 0xff;
    case 2:
      return (pixel >>> 8) & 0xff;
    case 4:
      return pixel & 0xff;
    case 8:
      return pixel >>> 24;
    default:
      return 128;
  }
}

/**
 * A displacement map over `area` of the source: each pixel takes the
 * source's at itself moved by the map's channels there, (c − 128) × scale
 * / 256, between pixels linearly with weights in 256ths; past the source
 * rect as the mode says: wrapped, clamped, the pixel's own (ignore) or the
 * filter's colour. Where the map is not, it keeps its own.
 */
function displace(
  source: BitmapStore,
  rect: PixelRect,
  area: PixelRect,
  f: Filter,
  map: BitmapStore | null,
): Uint32Array {
  const pixels = source.pixels;
  const sw = source.width;
  const own = (x: number, y: number) =>
    x >= 0 && y >= 0 && x < sw && y < source.height ? pixels[y * sw + x] : 0;
  const a = Math.floor(f.alpha * 255);
  const colour = premultiply(((a << 24) | (f.color & 0xffffff)) >>> 0);
  const result = new Uint32Array(area.width * area.height);
  for (let y = 0; y < area.height; y++) {
    const sy = area.y + y;
    for (let x = 0; x < area.width; x++) {
      const sx = area.x + x;
      const mx = sx - rect.x - f.mapPoint[0];
      const my = sy - rect.y - f.mapPoint[1];
      if (!map || mx < 0 || my < 0 || mx >= map.width || my >= map.height) {
        result[y * area.width + x] = own(sx, sy);
        continue;
      }

      const m = unmultiply(map.pixels[my * map.width + mx]);
      // Where to read, in 256ths, the offset truncated toward 0 as adl's fixed point has it.
      const px = sx * 256 + Math.trunc((channelOf(m, f.componentX) - 128) * f.scaleX);
      const py = sy * 256 + Math.trunc((channelOf(m, f.componentY) - 128) * f.scaleY);
      let x0 = px >> 8;
      let y0 = py >> 8;
      const fx = px & 255;
      const fy = py & 255;
      const left = rect.x;
      const top = rect.y;
      const right = rect.x + rect.width - 1;
      const bottom = rect.y + rect.height - 1;
      // Ignoring, a place past the rect takes the pixel's own, its fraction kept.
      if (f.mode === "ignore") {
        x0 = x0 < left || x0 > right ? sx : x0;
        y0 = y0 < top || y0 > bottom ? sy : y0;
      }

      const at = (cx: number, cy: number) => {
        let ix = cx - rect.x;
        let iy = cy - rect.y;
        if (ix >= 0 && iy >= 0 && ix < rect.width && iy < rect.height) {
          return own(cx, cy);
        }

        if (f.mode === "wrap") {
          ix = ((ix % rect.width) + rect.width) % rect.width;
          iy = ((iy % rect.height) + rect.height) % rect.height;
        } else if (f.mode === "color") {
          return colour;
        } else {
          ix = Math.max(0, Math.min(rect.width - 1, ix));
          iy = Math.max(0, Math.min(rect.height - 1, iy));
        }

        return own(rect.x + ix, rect.y + iy);
      };
      // The corners' weights in 256ths, each truncated, as adl's fixed point has them.
      const w00 = ((256 - fx) * (256 - fy)) >> 8;
      const w10 = (fx * (256 - fy)) >> 8;
      const w01 = ((256 - fx) * fy) >> 8;
      const w11 = (fx * fy) >> 8;
      const c00 = at(x0, y0);
      const c10 = at(x0 + 1, y0);
      const c01 = at(x0, y0 + 1);
      const c11 = at(x0 + 1, y0 + 1);
      let out = 0;
      for (const shift of [24, 16, 8, 0]) {
        const v =
          ((c00 >>> shift) & 0xff) * w00 +
          ((c10 >>> shift) & 0xff) * w10 +
          ((c01 >>> shift) & 0xff) * w01 +
          ((c11 >>> shift) & 0xff) * w11;
        out |= (v >> 8) << shift;
      }

      result[y * area.width + x] = out >>> 0;
    }
  }

  return result;
}

/**
 * What adl makes of a convolution with no taps: a copy, of as much of the
 * source as the filter's rect is big (the other size of the matrix still
 * grows it) from the source rect's corner, to that rect's corner; over
 * what an opaque destination has, into a transparent one as it is; what
 * lies past the source left as it was, and in place the source as it was
 * before. `shown` is what the destination shows of `out`, and (mx, my)
 * moves both there.
 */
function copyEmpty(
  dest: BitmapStore,
  source: BitmapStore,
  rect: PixelRect,
  out: PixelRect,
  shown: PixelRect,
  mx: number,
  my: number,
): void {
  const target = dest.pixels;
  const pixels = source === dest ? source.pixels.slice() : source.pixels;
  for (let y = shown.y; y < shown.y + shown.height; y++) {
    const sy = rect.y + y - out.y;
    if (sy < 0 || sy >= source.height) {
      continue;
    }

    for (let x = shown.x; x < shown.x + shown.width; x++) {
      const sx = rect.x + x - out.x;
      if (sx >= 0 && sx < source.width) {
        const p = pixels[sy * source.width + sx];
        const at = (y + my) * dest.width + x + mx;
        target[at] = dest.transparent ? p : over(p, target[at]);
      }
    }
  }

  dest.changed();
}

/**
 * A convolution over `area` of the source, as adl computes it, by the
 * render module (convolve.zig): each tap reads the source's straight
 * colour, past the rect too, and past the bitmap the nearest edge's or the
 * filter's colour; the sum divided (0 counting as 1), the bias added,
 * clamped and truncated, the alpha the source's where the filter keeps it;
 * the colour premultiplied by that alpha, or kept straight for an opaque
 * destination. Null where the kernel could not, as out of memory, or the
 * realm has none.
 */
function convolve(
  source: BitmapStore,
  area: PixelRect,
  f: Filter,
  transparent: boolean,
): Uint32Array | null {
  return bitmapKernel()?.convolve(source, area, f, transparent) ?? null;
}

/**
 * The reciprocal adl divides a 3 × 3 kernel by in fixed point, where it
 * takes that way, which it does inside the bitmap for whole weights whose
 * positive and negative sums each stay within 127 and a divisor from 1.1,
 * or past 2.0001 with a negative weight: 65536 / divisor, truncated, plus
 * one, wrapped to a short. That way also reads the centre for the last tap.
 * Null where it takes the other.
 */
export function integerKernel(matrix: number[], divisor: number): number | null {
  if (matrix.length !== 9 || !matrix.every(Number.isInteger)) {
    return null;
  }

  const positive = matrix.reduce((s, m) => s + Math.max(0, m), 0);
  const negative = matrix.reduce((s, m) => s + Math.min(0, m), 0);
  const enough = negative < 0 ? divisor > Math.fround(2.0001) : divisor >= Math.fround(1.1);
  if (positive > 127 || negative < -127 || !enough) {
    return null;
  }

  return ((Math.floor(65536 / divisor) + 1) << 16) >> 16;
}

/** A gradient filter's 256 colours, premultiplied, from its stops, as a gradient fill's ramp; with none, none. */
export function gradientTable(f: Filter): Uint32Array {
  if (f.colors.length === 0) {
    return new Uint32Array(256);
  }

  const stops = f.colors.map((c, k) => ({
    ratio: f.ratios[k],
    color: ((Math.round((f.alphas[k] ?? 1) * 255) << 24) | (c & 0xffffff)) >>> 0,
  }));
  return ramp(stops, false);
}

/** `part` of `pixels`, which cover `rect`, into `dest`, moved by (mx, my), clipped; an opaque store keeps its alpha. */
function write(
  dest: BitmapStore,
  pixels: Uint32Array,
  rect: PixelRect,
  part: PixelRect,
  mx: number,
  my: number,
): void {
  const target = dest.pixels;
  const to = intersect(
    { x: part.x + mx, y: part.y + my, width: part.width, height: part.height },
    { x: 0, y: 0, width: dest.width, height: dest.height },
  );
  if (to) {
    const opaque = dest.transparent ? 0 : 0xff000000;
    for (let ty = to.y; ty < to.y + to.height; ty++) {
      let i = (ty - my - rect.y) * rect.width + to.x - mx - rect.x;
      let t = ty * dest.width + to.x;
      for (let n = 0; n < to.width; n++) {
        target[t++] = (pixels[i++] | opaque) >>> 0;
      }
    }
  }

  dest.changed();
}

/**
 * A distance as far as a display object's filter pads: NaN none; Infinity,
 * or the -8388866 generateFilterRect makes of NaN, as far as a GPU's
 * texture could be, which the renderer cuts to what it can draw
 * (paddingCap).
 */
export function paddedDistance(distance: number): number {
  return Number.isNaN(distance) ? 0 : Math.max(-(2 ** 24), Math.min(2 ** 24, distance));
}

/**
 * How far a gradient filter's rect grows past a display object in stage
 * pixels, as applyFilter's does: left, top, right, bottom.
 */
export function filterGrowth(f: Filter): number[] {
  const rect = filterRect(
    { x: 0, y: 0, width: 1, height: 1 },
    { ...f, distance: paddedDistance(f.distance) },
  );
  return [-rect.x, -rect.y, rect.x + rect.width - 1, rect.y + rect.height - 1];
}

/** A displacement's channel (1 red, 2 green, 4 blue, 8 alpha) as weights of the four; none, all 0. */
export function channelWeights(channel: number): number[] {
  return [
    channel === 1 ? 1 : 0,
    channel === 2 ? 1 : 0,
    channel === 4 ? 1 : 0,
    channel === 8 ? 1 : 0,
  ];
}

/** How far a displacement in colour mode fills round the object, as adl draws it: half its scale. */
export function displacementGrowth(f: Filter): [number, number] {
  return f.mode === "color"
    ? [Math.floor(Math.abs(f.scaleX) / 2) || 0, Math.floor(Math.abs(f.scaleY) / 2) || 0]
    : [0, 0];
}

/** A displacement's colour mode's alpha, in whole 255ths down, as adl takes it. */
export function displacementAlpha(f: Filter): number {
  return Math.floor(f.alpha * 255) / 255;
}
