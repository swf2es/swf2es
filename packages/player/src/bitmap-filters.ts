// BitmapData.applyFilter and generateFilterRect, on the CPU, as adl
// computes them (docs/architecture.md, "Filters"): the source filtered, past
// the source rect too, and the filter's rect written whole into the
// destination; a blur's runs truncated to 8 bits each, a glow's alpha from
// the blur so truncated times strength, a bevel's from the difference of two
// reads of it, a colour matrix of straight colour, rounded, a convolution of
// straight colour, truncated.
import { type BitmapStore, over, type PixelRect, unmultiply } from "./bitmap.js";
import type { Filter } from "./filters.js";

/** The filters this filters: the others' rects and pixels are still to come. */
export const filtersDrawn: ReadonlySet<string> = new Set([
  "blur",
  "glow",
  "dropShadow",
  "colorMatrix",
  "convolution",
  "bevel",
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

  if (f.kind === "colorMatrix" || f.kind === "displacementMap") {
    return [0, 0];
  }

  return [spreadOf(f.blurX, f.quality, f.kind), spreadOf(f.blurY, f.quality, f.kind)];
}

/**
 * A shadow's or a bevel's offset in whole pixels, down: [x, y]. adl has it
 * in 256ths, to the nearest, so the cosine of 90° is 0, not just under it,
 * and 6 × sin 30° is 3, not just under.
 */
function offsetOf(f: Filter): [number, number] {
  const radians = ((f.angle || 0) * Math.PI) / 180;
  const whole = (v: number) => Math.floor(Math.round(v * 256) / 256);
  return [
    whole((f.distance || 0) * Math.cos(radians)),
    whole((f.distance || 0) * Math.sin(radians)),
  ];
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
  if (f.kind === "dropShadow") {
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
 * One run of a box `width` pixels wide over `planes` (each w × h), along x
 * or y, each value truncated to 8 bits. Its taps from the pixel out are
 * whole while they lie within half the width, and the next one weighs the
 * part of it the box covers: the whole ones a running sum of integers,
 * exact, the two partial ones added to it. Along y the sums run down
 * whole rows at once, which the planes keep together.
 */
function run(planes: Int32Array[], w: number, h: number, width: number, alongX: boolean): void {
  if (width <= 1) {
    return;
  }

  const half = width / 2;
  // The whole taps reach `full` each way; the partial one past them weighs `part`.
  const full = Math.floor(half - 0.5);
  const part = Math.min(1, Math.max(0, half - full - 0.5));
  const scale = 1 / width;
  if (alongX) {
    // The line between zeros, as far as the taps reach past its ends.
    const pad = full + 1;
    const line = new Int32Array(w + 2 * pad + 1);
    for (const plane of planes) {
      for (let row = 0; row < h * w; row += w) {
        line.set(plane.subarray(row, row + w), pad);
        let sum = 0;
        for (let i = pad - full; i <= pad + full; i++) {
          sum += line[i];
        }

        for (let i = 0; i < w; i++) {
          const at = i + pad;
          // A hair over, so that a value the sum hits exactly stays.
          plane[row + i] =
            ((sum + part * (line[at - full - 1] + line[at + full + 1])) * scale + 1e-7) | 0;
          sum += line[at + full + 1] - line[at - full];
        }
      }
    }

    return;
  }

  // Along y, rows past the plane's ends are zeros.
  const zeros = new Int32Array(w);
  const rowOf = (plane: Int32Array, y: number) =>
    y >= 0 && y < h ? plane.subarray(y * w, y * w + w) : zeros;
  const sums = new Int32Array(w);
  const out = new Int32Array(w * h);
  for (const plane of planes) {
    sums.fill(0);
    for (let j = -full; j <= full; j++) {
      const r = rowOf(plane, j);
      for (let x = 0; x < w; x++) {
        sums[x] += r[x];
      }
    }

    for (let y = 0; y < h; y++) {
      const lo = rowOf(plane, y - full - 1);
      const hi = rowOf(plane, y + full + 1);
      const leaving = rowOf(plane, y - full);
      const o = y * w;
      for (let x = 0; x < w; x++) {
        out[o + x] = ((sums[x] + part * (lo[x] + hi[x])) * scale + 1e-7) | 0;
        // The rows entering and leaving the whole taps, for the next.
        sums[x] += hi[x] - leaving[x];
      }
    }

    plane.set(out);
  }
}

/** The blur's runs: each quality's run along x, then along y. */
function blur(planes: Int32Array[], w: number, h: number, f: Filter): void {
  for (let q = 0; q < f.quality; q++) {
    run(planes, w, h, f.blurX || 0, true);
    run(planes, w, h, f.blurY || 0, false);
  }
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
  f: Filter,
): boolean {
  if (!filtersDrawn.has(f.kind)) {
    return false;
  }

  const out = filterRect(rect, f);
  // What the destination shows of the filter's rect, in the filter's
  // coordinates, and the work: that and as far round it as the filter
  // reaches into it, so that a rect far past the destination costs nothing.
  const mx = dx - rect.x;
  const my = dy - rect.y;
  const shown = intersect(out, { x: -mx, y: -my, width: dest.width, height: dest.height });
  if (!shown) {
    return true;
  }

  if (f.kind === "convolution" && (f.matrixX === 0 || f.matrixY === 0)) {
    copyEmpty(dest, source, rect, out, shown, mx, my);
    return true;
  }

  if (f.kind === "convolution") {
    write(dest, convolve(source, shown, f, dest.transparent), shown, shown, mx, my);
    return true;
  }

  // The work: what is shown and as far round it as the filter reaches into
  // it, which may be past the rect, whose edge cuts what is written alone.
  const [hx, hy] = halo(f);
  const work = {
    x: shown.x - hx,
    y: shown.y - hy,
    width: shown.width + 2 * hx,
    height: shown.height + 2 * hy,
  };
  const w = work.width;
  const h = work.height;

  // The source's premultiplied channels over the work, past `rect` too, as
  // far as the bitmap goes.
  const pixels = source.pixels;
  const sw = source.width;
  const a = new Int32Array(w * h);
  const r = new Int32Array(w * h);
  const g = new Int32Array(w * h);
  const b = new Int32Array(w * h);
  const from = intersect(work, { x: 0, y: 0, width: sw, height: source.height });
  if (from) {
    for (let sy = from.y; sy < from.y + from.height; sy++) {
      let i = (sy - work.y) * w + from.x - work.x;
      for (let sx = from.x; sx < from.x + from.width; sx++, i++) {
        const p = pixels[sy * sw + sx];
        a[i] = p >>> 24;
        r[i] = (p >>> 16) & 0xff;
        g[i] = (p >>> 8) & 0xff;
        b[i] = p & 0xff;
      }
    }
  }

  const result = new Uint32Array(w * h);
  if (f.kind === "blur") {
    blur([a, r, g, b], w, h, f);
    for (let i = 0; i < result.length; i++) {
      result[i] = ((a[i] << 24) | (r[i] << 16) | (g[i] << 8) | b[i]) >>> 0;
    }
  } else if (f.kind === "colorMatrix") {
    colorMatrix(dest, result, [a, r, g, b], work, contentOf(source, rect), f.matrix);
  } else if (f.kind === "bevel") {
    bevel(result, [a, r, g, b], w, h, f);
  } else {
    glow(result, [a, r, g, b], w, h, f);
  }

  write(dest, result, work, shown, mx, my);
  return true;
}

function intersect(p: PixelRect, q: PixelRect): PixelRect | null {
  const x0 = Math.max(p.x, q.x);
  const y0 = Math.max(p.y, q.y);
  const x1 = Math.min(p.x + p.width, q.x + q.width);
  const y1 = Math.min(p.y + p.height, q.y + q.height);
  return x1 > x0 && y1 > y0 ? { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } : null;
}

/**
 * How far a pixel's result reaches for the source, each way: a blur's
 * `quality` runs each reach half its box, whole taps; a shadow's offset,
 * and the next pixel it samples between, beyond that.
 */
function halo(f: Filter): [number, number] {
  if (f.kind === "colorMatrix") {
    return [0, 0];
  }

  let hx = f.quality * Math.ceil((f.blurX || 0) / 2);
  let hy = f.quality * Math.ceil((f.blurY || 0) / 2);
  if (f.kind === "dropShadow" || f.kind === "bevel") {
    const radians = ((f.angle || 0) * Math.PI) / 180;
    hx += Math.ceil(Math.abs((f.distance || 0) * Math.cos(radians))) + 1;
    hy += Math.ceil(Math.abs((f.distance || 0) * Math.sin(radians))) + 1;
  }

  return [hx, hy];
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
 * A colour matrix of each pixel's straight colour, rounded. adl maps the
 * pixels about what the source has, its bounds and one more each way, one
 * by one, their colour premultiplied by the new alpha and truncated; the
 * rest of the rect it fills with the map of a transparent pixel, written as
 * the store premultiplies it.
 */
function colorMatrix(
  dest: BitmapStore,
  result: Uint32Array,
  [a, r, g, b]: Int32Array[],
  work: PixelRect,
  content: PixelRect | null,
  m: number[],
): void {
  // The map of straight (r, g, b, a) into `mapped`, each clamped and rounded.
  const mapped = [0, 0, 0, 0];
  const map = (cr: number, cg: number, cb: number, ca: number) => {
    for (let row = 0; row < 4; row++) {
      const v =
        m[row * 5] * cr +
        m[row * 5 + 1] * cg +
        m[row * 5 + 2] * cb +
        m[row * 5 + 3] * ca +
        m[row * 5 + 4];
      mapped[row] = Math.max(0, Math.min(255, Math.round(Number.isNaN(v) ? 0 : v)));
    }

    return mapped;
  };
  const empty = [...map(0, 0, 0, 0)];
  result.fill(
    dest.premultiplied(((empty[3] << 24) | (empty[0] << 16) | (empty[1] << 8) | empty[2]) >>> 0),
  );
  if (!content) {
    return;
  }

  // What the source has, and one more each way, as far as the work goes.
  const near = intersect(
    { x: content.x - 1, y: content.y - 1, width: content.width + 2, height: content.height + 2 },
    work,
  );
  if (!near) {
    return;
  }

  for (let y = near.y; y < near.y + near.height; y++) {
    for (let x = near.x; x < near.x + near.width; x++) {
      const i = (y - work.y) * work.width + (x - work.x);
      const s = a[i] > 0 ? 255 / a[i] : 0;
      const [nr, ng, nb, na] = map(r[i] * s, g[i] * s, b[i] * s, a[i]);
      result[i] =
        ((na << 24) |
          (Math.floor((nr * na) / 255) << 16) |
          (Math.floor((ng * na) / 255) << 8) |
          Math.floor((nb * na) / 255)) >>>
        0;
    }
  }
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
 * A convolution over `area` of the source, as adl computes it: each tap
 * reads the source's straight colour, past the rect too, and past the
 * bitmap the nearest edge's or the filter's colour; the sum divided (0
 * counting as 1), the bias added, clamped and truncated, the alpha the
 * source's where the filter keeps it; the colour premultiplied by that alpha,
 * or kept straight for an opaque destination.
 */
function convolve(
  source: BitmapStore,
  area: PixelRect,
  f: Filter,
  transparent: boolean,
): Uint32Array {
  const cols = f.matrixX;
  const rows = f.matrixY;
  const hx = cols >> 1;
  const hy = rows >> 1;
  const divisor = f.divisor || 1;
  const matrix = Array.from({ length: cols * rows }, (_, k) => f.matrix[k] || 0);
  const weights = matrix.map((m) => m / divisor);
  const integer = integerKernel(matrix, divisor);
  const sw = source.width;
  const sh = source.height;
  const preserveAlpha = f.preserveAlpha;

  // The straight colour of the pixels the taps reach, clamped to the bitmap,
  // a plane a channel, and after each the filter's colour.
  const clampX = (x: number) => Math.max(0, Math.min(sw - 1, x));
  const clampY = (y: number) => Math.max(0, Math.min(sh - 1, y));
  const x0 = clampX(area.x - hx);
  const y0 = clampY(area.y - hy);
  const nw = clampX(area.x + area.width + cols - hx - 2) - x0 + 1;
  const nh = clampY(area.y + area.height + rows - hy - 2) - y0 + 1;
  const colour = nw * nh;
  const planes = [0, 1, 2, 3].map(() => new Int32Array(colour + 1));
  const [pr, pg, pb, pa] = planes;
  const pixels = source.pixels;
  for (let y = 0; y < nh; y++) {
    for (let x = 0; x < nw; x++) {
      const stored = pixels[(y0 + y) * sw + x0 + x];
      // Opaque pixels, most of a picture's, are straight already.
      const p = stored >>> 24 === 255 ? stored : unmultiply(stored);
      const i = y * nw + x;
      pr[i] = (p >>> 16) & 0xff;
      pg[i] = (p >>> 8) & 0xff;
      pb[i] = p & 0xff;
      pa[i] = source.transparent ? p >>> 24 : 255;
    }
  }

  pr[colour] = (f.color >> 16) & 0xff;
  pg[colour] = (f.color >> 8) & 0xff;
  pb[colour] = f.color & 0xff;
  pa[colour] = Math.floor(f.alpha * 255);
  const at = (x: number, y: number) =>
    !f.clamp && (x < 0 || x >= sw || y < 0 || y >= sh)
      ? colour
      : (clampY(y) - y0) * nw + clampX(x) - x0;
  // The taps that weigh anything: where each reads from the pixel, and its
  // place in the planes from the pixel's where it lies in the bitmap.
  const tapsOf = (ws: number[], centreLast: boolean) => {
    const dx: number[] = [];
    const dy: number[] = [];
    const w: number[] = [];
    for (let k = 0; k < ws.length; k++) {
      if (ws[k] !== 0) {
        const last = centreLast && k === ws.length - 1;
        dx.push(last ? 0 : (k % cols) - hx);
        dy.push(last ? 0 : Math.floor(k / cols) - hy);
        w.push(ws[k]);
      }
    }

    return { dx, dy, w, at: dx.map((x, k) => dy[k] * nw + x) };
  };
  const general = tapsOf(weights, false);
  const fixedTaps = tapsOf(matrix, true);
  const bias = f.bias;
  // A channel's sum biased, clamped and truncated: a hair over, so that a
  // value the sum hits exactly stays; NaN, from a NaN bias, 0.
  const straight = (v: number) => {
    const c = v + bias;
    return c >= 255 ? 255 : c > 0 ? Math.floor(c + 1e-7) : 0;
  };
  const scale = integer === null ? 0 : integer / 65536;

  const sums = [0, 1, 2, 3].map(() => new Float64Array(area.width));
  const [sr, sg, sb, sa] = sums;
  const result = new Uint32Array(area.width * area.height);
  for (let y = 0; y < area.height; y++) {
    const sy = area.y + y;
    for (const sum of sums) {
      sum.fill(0);
    }

    // The pixels whose taps all lie in the bitmap, x from `x1` to before `x2`,
    // sum a tap at a time along the row; the rest a pixel at a time.
    const rowInside = sy >= hy && sy <= sh - rows + hy;
    const x1 = rowInside ? Math.min(area.width, Math.max(0, hx - area.x)) : 0;
    const x2 = rowInside ? Math.max(x1, Math.min(area.width, sw - cols + hx + 1 - area.x)) : 0;
    const fixedRow = integer !== null && sy >= 1 && sy < sh - 1;
    if (x2 > x1) {
      // The fixed-point way, where it is taken, is inside these too (its taps are 3 × 3).
      const taps = fixedRow ? fixedTaps : general;
      const base = (sy - y0) * nw + area.x + x1 - x0;
      for (let k = 0; k < taps.w.length; k++) {
        const w = taps.w[k];
        let i = base + taps.at[k];
        for (let x = x1; x < x2; x++, i++) {
          sr[x] += pr[i] * w;
          sg[x] += pg[i] * w;
          sb[x] += pb[i] * w;
          sa[x] += pa[i] * w;
        }
      }
    }

    for (let x = 0; x < area.width; x++) {
      const sx = area.x + x;
      const fixed = fixedRow && sx >= 1 && sx < sw - 1;
      if (x < x1 || x >= x2) {
        const taps = fixed ? fixedTaps : general;
        for (let k = 0; k < taps.w.length; k++) {
          const i = at(sx + taps.dx[k], sy + taps.dy[k]);
          const w = taps.w[k];
          sr[x] += pr[i] * w;
          sg[x] += pg[i] * w;
          sb[x] += pb[i] * w;
          sa[x] += pa[i] * w;
        }
      }

      let r = sr[x];
      let g = sg[x];
      let b = sb[x];
      let a = sa[x];
      if (fixed) {
        r = Math.floor(r * scale);
        g = Math.floor(g * scale);
        b = Math.floor(b * scale);
        a = Math.floor(a * scale);
      }

      const alpha = preserveAlpha ? pa[at(sx, sy)] : straight(a);
      const by = transparent ? alpha : 255;
      r = straight(r) * by;
      g = straight(g) * by;
      b = straight(b) * by;
      // The fixed-point way premultiplies truncating, the other as the store does.
      result[y * area.width + x] = fixed
        ? ((alpha << 24) |
            (Math.floor(r / 255) << 16) |
            (Math.floor(g / 255) << 8) |
            Math.floor(b / 255)) >>>
          0
        : ((alpha << 24) |
            (((r + 127) / 255) << 16) |
            (((g + 127) / 255) << 8) |
            ((b + 127) / 255)) >>>
          0;
    }
  }

  return result;
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

/**
 * The plane (w × h) read at every pixel moved by (ox, oy), between pixels
 * linearly, with weights in 256ths, truncated, as adl's fixed point has
 * them; `outside` past it. Each column's and row's whole part and weight
 * are computed once.
 */
function shifted(
  plane: Int32Array,
  w: number,
  h: number,
  ox: number,
  oy: number,
  outside: number,
): Int32Array {
  const xs = new Int32Array(w);
  const fxs = new Float64Array(w);
  for (let x = 0; x < w; x++) {
    const at = x + ox;
    xs[x] = Math.floor(at);
    fxs[x] = Math.floor((at - xs[x]) * 256) / 256;
  }

  const out = new Int32Array(w * h);
  const value = (x: number, y: number) =>
    x >= 0 && x < w && y >= 0 && y < h ? plane[y * w + x] : outside;
  for (let y = 0; y < h; y++) {
    const at = y + oy;
    const y0 = Math.floor(at);
    const fy = Math.floor((at - y0) * 256) / 256;
    for (let x = 0; x < w; x++) {
      const x0 = xs[x];
      const fx = fxs[x];
      if (fx === 0 && fy === 0) {
        out[y * w + x] = value(x0, y0);
        continue;
      }

      const top = value(x0, y0) * (1 - fx) + value(x0 + 1, y0) * fx;
      const bottom = value(x0, y0 + 1) * (1 - fx) + value(x0 + 1, y0 + 1) * fx;
      out[y * w + x] = Math.floor(top * (1 - fy) + bottom * fy + 1e-7);
    }
  }

  return out;
}

/**
 * A bevel: the source's alpha blurred, truncated, read from the offset
 * forward and back; their difference, times strength (to 255) and the
 * colour's alpha, rounded, the highlight where forward is more and the
 * shadow where it is less. Inner, it lies atop the source, which keeps its
 * alpha; outer, behind it; full, over it; knocked out, alone, masked to
 * where the source is (inner) or is not (outer). Each over another as the
 * store draws, truncated.
 */
function bevel(
  result: Uint32Array,
  [a, r, g, b]: Int32Array[],
  w: number,
  h: number,
  f: Filter,
): void {
  const blurred = new Int32Array(a);
  blur([blurred], w, h, f);
  const radians = ((f.angle || 0) * Math.PI) / 180;
  // As a shadow's. Off the axes adl reads about a 256th further out, which
  // this does not: within 2 a channel there.
  const ox = (f.distance || 0) * Math.cos(radians);
  const oy = (f.distance || 0) * Math.sin(radians);
  const on = shifted(blurred, w, h, ox, oy, 0);
  const back = shifted(blurred, w, h, -ox, -oy, 0);
  const channels = (c: number) => [(c >> 16) & 0xff, (c >> 8) & 0xff, c & 0xff];
  const [hr, hg, hb] = channels(f.highlightColor);
  const [sr, sg, sb] = channels(f.shadowColor);
  const highlightAlpha = f.highlightAlpha;
  const shadowAlpha = f.shadowAlpha;
  const strength = f.strength;
  const inner = f.type === "inner";
  const outer = f.type === "outer";
  const knockout = f.knockout;
  // One over another, as the store draws: top + bottom × (256 − top's alpha) / 256, truncated.
  const over = (top: number, ta: number, bottom: number) =>
    Math.min(255, top + ((bottom * (256 - ta)) >> 8));
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const d = on[i] - back[i];
      const lit = d > 0;
      // Its alpha rounds, where a glow's truncates.
      const la = Math.round(
        Math.min(255, Math.floor(Math.abs(d) * strength)) * (lit ? highlightAlpha : shadowAlpha),
      );
      // The bevel's colour, premultiplied, masked to where the source is, or,
      // knocked out, is not; an outer one that is not lies behind it whole.
      const sa = a[i];
      const m = inner ? sa : outer && knockout ? 255 - sa : 255;
      const lA = Math.floor((la * m) / 255);
      const lr = Math.floor((Math.floor(((lit ? hr : sr) * la) / 255) * m) / 255);
      const lg = Math.floor((Math.floor(((lit ? hg : sg) * la) / 255) * m) / 255);
      const lb = Math.floor((Math.floor(((lit ? hb : sb) * la) / 255) * m) / 255);
      let oa: number;
      let or: number;
      let og: number;
      let ob: number;
      if (knockout) {
        oa = lA;
        or = lr;
        og = lg;
        ob = lb;
      } else if (outer) {
        oa = over(sa, sa, lA);
        or = over(r[i], sa, lr);
        og = over(g[i], sa, lg);
        ob = over(b[i], sa, lb);
      } else {
        // Inner lies atop the source, full over it: what is left shows through either way.
        const ta = inner ? la : lA;
        oa = over(lA, ta, sa);
        or = over(lr, ta, r[i]);
        og = over(lg, ta, g[i]);
        ob = over(lb, ta, b[i]);
      }

      result[i] =
        ((oa << 24) | (Math.min(or, oa) << 16) | (Math.min(og, oa) << 8) | Math.min(ob, oa)) >>> 0;
    }
  }
}

/**
 * A glow or a shadow: the source's alpha blurred, truncated, times strength
 * (to 255) and alpha, in its colour, from the offset back for a shadow;
 * behind the source, or inside it for an inner one, or alone.
 */
function glow(
  result: Uint32Array,
  [a, r, g, b]: Int32Array[],
  w: number,
  h: number,
  f: Filter,
): void {
  // An inner one blurs what the source leaves, 255 less its alpha, as adl does.
  const blurred = f.inner ? a.map((v) => 255 - v) : new Int32Array(a);
  blur([blurred], w, h, f);
  const radians = ((f.angle || 0) * Math.PI) / 180;
  const shadow = f.kind === "dropShadow";
  // A shadow's offset, which adl samples the blurred alpha at between pixels, linearly.
  const ox = shadow ? (f.distance || 0) * Math.cos(radians) : 0;
  const oy = shadow ? (f.distance || 0) * Math.sin(radians) : 0;
  const moved = shifted(blurred, w, h, -ox, -oy, f.inner ? 255 : 0);
  const cr = (f.color >> 16) & 0xff;
  const cg = (f.color >> 8) & 0xff;
  const cb = f.color & 0xff;
  const hide = shadow && f.hideObject;
  const round = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const blurA = moved[i];
      const sa = a[i];
      let ga = Math.floor(Math.min(255, Math.floor(blurA * f.strength)) * f.alpha);
      if (f.inner) {
        ga = Math.floor((ga * sa) / 255);
      }

      const gr = (cr * ga) / 255;
      const gg = (cg * ga) / 255;
      const gb = (cb * ga) / 255;
      let oa: number;
      let or: number;
      let og: number;
      let ob: number;
      if (f.knockout && !f.inner) {
        oa = (ga * (255 - sa)) / 255;
        or = (gr * (255 - sa)) / 255;
        og = (gg * (255 - sa)) / 255;
        ob = (gb * (255 - sa)) / 255;
      } else if (f.inner && !f.knockout) {
        const keep = (255 - ga) / 255;
        oa = ga + sa * keep;
        or = gr + r[i] * keep;
        og = gg + g[i] * keep;
        ob = gb + b[i] * keep;
      } else if (f.knockout || hide) {
        // Knocked out inside, or a shadow drawn alone: the glow by itself.
        oa = ga;
        or = gr;
        og = gg;
        ob = gb;
      } else {
        const behind = (255 - sa) / 255;
        oa = sa + ga * behind;
        or = r[i] + gr * behind;
        og = g[i] + gg * behind;
        ob = b[i] + gb * behind;
      }

      const ka = round(oa);
      result[i] =
        ((ka << 24) |
          (Math.min(round(or), ka) << 16) |
          (Math.min(round(og), ka) << 8) |
          Math.min(round(ob), ka)) >>>
        0;
    }
  }
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
