// BitmapData.applyFilter and generateFilterRect, on the CPU, as adl
// computes them (docs/architecture.md, "Filters"): the filter's rect of the
// source, what lies outside the source rect transparent, written whole into
// the destination; a blur's runs truncated to 8 bits each, a glow's alpha
// from the blur so truncated times strength, a colour matrix of straight
// colour, rounded, a convolution of straight colour, truncated.
import { type BitmapStore, over, type PixelRect, unmultiply } from "./bitmap.js";
import type { Filter } from "./filters.js";

/** The filters this filters: the others' rects and pixels are still to come. */
export const filtersDrawn: ReadonlySet<string> = new Set([
  "blur",
  "glow",
  "dropShadow",
  "colorMatrix",
  "convolution",
]);

/** How far a filter reaches past what it filters, each way: [x, y], whole pixels. */
function reach(f: Filter): [number, number] {
  if (f.kind === "blur" || f.kind === "glow" || f.kind === "dropShadow") {
    const quality = Math.max(0, f.quality);
    return [Math.ceil(((f.blurX || 0) * quality) / 2), Math.ceil(((f.blurY || 0) * quality) / 2)];
  }

  if (f.kind === "convolution") {
    return [f.matrixX >> 1, f.matrixY >> 1];
  }

  return [0, 0];
}

/** The rect a filter makes of `rect`, as generateFilterRect gives it: grown by its reach, and by a shadow's offset where it moves out. */
export function filterRect(rect: PixelRect, f: Filter): PixelRect {
  const [rx, ry] = reach(f);
  let x0 = rect.x - rx;
  let y0 = rect.y - ry;
  let x1 = rect.x + rect.width + rx;
  let y1 = rect.y + rect.height + ry;
  if (f.kind === "dropShadow" && !f.inner) {
    const radians = ((f.angle || 0) * Math.PI) / 180;
    const ox = (f.distance || 0) * Math.cos(radians);
    const oy = (f.distance || 0) * Math.sin(radians);
    x0 = Math.min(x0, Math.floor(rect.x - rx + ox));
    y0 = Math.min(y0, Math.floor(rect.y - ry + oy));
    x1 = Math.max(x1, Math.ceil(rect.x + rect.width + rx + ox));
    y1 = Math.max(y1, Math.ceil(rect.y + rect.height + ry + oy));
  }

  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/** A box `width` pixels wide: each tap's weight, from -reach to reach, its end taps weighted by their part. */
function box(width: number): number[] {
  const half = width / 2;
  const reach = Math.ceil(half);
  const taps: number[] = [];
  for (let k = -reach; k <= reach; k++) {
    taps.push(Math.max(0, Math.min(k + 0.5, half) - Math.max(k - 0.5, -half)) / width);
  }

  return taps;
}

/** One run of a box over `channels` (planes of w × h), along x or y, each value truncated to 8 bits. */
function run(planes: Float64Array[], w: number, h: number, width: number, alongX: boolean): void {
  if (width <= 1) {
    return;
  }

  const taps = box(width);
  const reach = (taps.length - 1) / 2;
  const line = new Float64Array(alongX ? w : h);
  for (const plane of planes) {
    for (let j = 0; j < (alongX ? h : w); j++) {
      const n = line.length;
      for (let i = 0; i < n; i++) {
        line[i] = plane[alongX ? j * w + i : i * w + j];
      }

      for (let i = 0; i < n; i++) {
        let sum = 0;
        for (let k = -reach; k <= reach; k++) {
          const at = i + k;
          if (at >= 0 && at < n) {
            sum += line[at] * taps[k + reach];
          }
        }

        // A hair over, so that a value the sum hits exactly stays.
        plane[alongX ? j * w + i : i * w + j] = Math.floor(sum + 1e-7);
      }
    }
  }
}

/** The blur's runs: each quality's run along x, then along y. */
function blur(planes: Float64Array[], w: number, h: number, f: Filter): void {
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
    write(dest, convolve(source, shown, f, dest.transparent), shown, mx, my);
    return true;
  }

  const [hx, hy] = halo(f);
  const work = intersect(out, {
    x: shown.x - hx,
    y: shown.y - hy,
    width: shown.width + 2 * hx,
    height: shown.height + 2 * hy,
  }) as PixelRect;
  const w = work.width;
  const h = work.height;

  // The source's premultiplied channels over the work, transparent past `rect`.
  const pixels = source.pixels;
  const a = new Float64Array(w * h);
  const r = new Float64Array(w * h);
  const g = new Float64Array(w * h);
  const b = new Float64Array(w * h);
  for (let y = 0; y < h; y++) {
    const sy = work.y + y;
    if (sy < rect.y || sy >= rect.y + rect.height || sy < 0 || sy >= source.height) {
      continue;
    }

    for (let x = 0; x < w; x++) {
      const sx = work.x + x;
      if (sx < rect.x || sx >= rect.x + rect.width || sx < 0 || sx >= source.width) {
        continue;
      }

      const p = pixels[sy * source.width + sx];
      const i = y * w + x;
      a[i] = p >>> 24;
      r[i] = (p >>> 16) & 0xff;
      g[i] = (p >>> 8) & 0xff;
      b[i] = p & 0xff;
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
  } else {
    glow(result, [a, r, g, b], w, h, f);
  }

  write(dest, result, work, mx, my);
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
  if (f.kind === "dropShadow") {
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
  [a, r, g, b]: Float64Array[],
  work: PixelRect,
  content: PixelRect | null,
  m: number[],
): void {
  const map = (c: number[]) =>
    [0, 1, 2, 3].map((row) => {
      const v =
        m[row * 5] * c[0] +
        m[row * 5 + 1] * c[1] +
        m[row * 5 + 2] * c[2] +
        m[row * 5 + 3] * c[3] +
        m[row * 5 + 4];
      return Math.max(0, Math.min(255, Math.round(Number.isNaN(v) ? 0 : v)));
    });
  const empty = map([0, 0, 0, 0]);
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
      const [nr, ng, nb, na] = map([r[i] * s, g[i] * s, b[i] * s, a[i]]);
      const p = (c: number) => Math.floor((c * na) / 255);
      result[i] = ((na << 24) | (p(nr) << 16) | (p(ng) << 8) | p(nb)) >>> 0;
    }
  }
}

/**
 * What adl makes of a convolution with no taps: a copy, of as much of the
 * source as the filter's rect is big (the other size of the matrix still
 * grows it) from the source rect's corner, to that rect's corner; over
 * what an opaque destination has, into a transparent one as it is; what
 * lies past the source left as it was. `shown` is what the destination
 * shows of `out`, and (mx, my) moves both there.
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
  for (let y = shown.y; y < shown.y + shown.height; y++) {
    const sy = rect.y + y - out.y;
    if (sy < 0 || sy >= source.height) {
      continue;
    }

    for (let x = shown.x; x < shown.x + shown.width; x++) {
      const sx = rect.x + x - out.x;
      if (sx >= 0 && sx < source.width) {
        const p = source.pixels[sy * source.width + sx];
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

  // The straight colour of the pixels the taps reach, clamped to the bitmap,
  // and after them the filter's colour.
  const clampX = (x: number) => Math.max(0, Math.min(sw - 1, x));
  const clampY = (y: number) => Math.max(0, Math.min(sh - 1, y));
  const x0 = clampX(area.x - hx);
  const y0 = clampY(area.y - hy);
  const nw = clampX(area.x + area.width + cols - hx - 2) - x0 + 1;
  const nh = clampY(area.y + area.height + rows - hy - 2) - y0 + 1;
  const near = new Float64Array(nw * nh * 4 + 4);
  for (let y = 0; y < nh; y++) {
    for (let x = 0; x < nw; x++) {
      const p = unmultiply(source.pixels[(y0 + y) * sw + x0 + x]);
      const i = (y * nw + x) * 4;
      near[i] = (p >>> 16) & 0xff;
      near[i + 1] = (p >>> 8) & 0xff;
      near[i + 2] = p & 0xff;
      near[i + 3] = source.transparent ? p >>> 24 : 255;
    }
  }

  const colour = nw * nh * 4;
  near.set(
    [(f.color >> 16) & 0xff, (f.color >> 8) & 0xff, f.color & 0xff, Math.floor(f.alpha * 255)],
    colour,
  );
  const at = (x: number, y: number) =>
    !f.clamp && (x < 0 || x >= sw || y < 0 || y >= sh)
      ? colour
      : ((clampY(y) - y0) * nw + clampX(x) - x0) * 4;
  // The taps that weigh anything: where each reads from the pixel, and its
  // place in `near` from the pixel's where it lies in the bitmap.
  const tapsOf = (ws: number[], centreLast: boolean) => {
    const taps = { dx: [] as number[], dy: [] as number[], w: [] as number[], at: [] as number[] };
    for (let k = 0; k < ws.length; k++) {
      if (ws[k] !== 0) {
        const last = centreLast && k === ws.length - 1;
        const dx = last ? 0 : (k % cols) - hx;
        const dy = last ? 0 : Math.floor(k / cols) - hy;
        taps.dx.push(dx);
        taps.dy.push(dy);
        taps.w.push(ws[k]);
        taps.at.push((dy * nw + dx) * 4);
      }
    }

    return taps;
  };
  const general = tapsOf(weights, false);
  const fixedTaps = tapsOf(matrix, true);
  const value = (v: number) => Math.max(0, Math.min(255, v + f.bias)) || 0;
  // A channel's sum premultiplied by `by`: truncating the fixed-point way, the other as the store does.
  const channel = (v: number, by: number, fixed: boolean) => {
    // A hair over, so that a value the sum hits exactly stays.
    const straight = Math.floor(value(v) + 1e-7);
    return fixed ? Math.floor((straight * by) / 255) : ((straight * by + 127) / 255) | 0;
  };

  const result = new Uint32Array(area.width * area.height);
  for (let y = 0; y < area.height; y++) {
    const sy = area.y + y;
    for (let x = 0; x < area.width; x++) {
      const sx = area.x + x;
      const fixed = integer !== null && sx >= 1 && sx < sw - 1 && sy >= 1 && sy < sh - 1;
      const taps = fixed ? fixedTaps : general;
      const inside = sx >= hx && sx <= sw - cols + hx && sy >= hy && sy <= sh - rows + hy;
      const base = ((sy - y0) * nw + sx - x0) * 4;
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let k = 0; k < taps.w.length; k++) {
        const i = inside ? base + taps.at[k] : at(sx + taps.dx[k], sy + taps.dy[k]);
        const w = taps.w[k];
        r += near[i] * w;
        g += near[i + 1] * w;
        b += near[i + 2] * w;
        a += near[i + 3] * w;
      }

      if (fixed) {
        r = Math.floor((r * (integer as number)) / 65536);
        g = Math.floor((g * (integer as number)) / 65536);
        b = Math.floor((b * (integer as number)) / 65536);
        a = Math.floor((a * (integer as number)) / 65536);
      }

      const alpha = Math.floor((f.preserveAlpha ? near[at(sx, sy) + 3] : value(a)) + 1e-7);
      const by = transparent ? alpha : 255;
      result[y * area.width + x] =
        ((alpha << 24) |
          (channel(r, by, fixed) << 16) |
          (channel(g, by, fixed) << 8) |
          channel(b, by, fixed)) >>>
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
 * A glow or a shadow: the source's alpha blurred, truncated, times strength
 * (to 255) and alpha, in its colour, from the offset back for a shadow;
 * behind the source, or inside it for an inner one, or alone.
 */
function glow(
  result: Uint32Array,
  [a, r, g, b]: Float64Array[],
  w: number,
  h: number,
  f: Filter,
): void {
  // An inner one blurs what the source leaves, 255 less its alpha, as adl does.
  const blurred = f.inner ? a.map((v) => 255 - v) : new Float64Array(a);
  blur([blurred], w, h, f);
  const radians = ((f.angle || 0) * Math.PI) / 180;
  const shadow = f.kind === "dropShadow";
  // A shadow's offset, which adl samples the blurred alpha at between pixels, linearly.
  const ox = shadow ? (f.distance || 0) * Math.cos(radians) : 0;
  const oy = shadow ? (f.distance || 0) * Math.sin(radians) : 0;
  const outside = f.inner ? 255 : 0;
  const at = (x: number, y: number) =>
    x >= 0 && x < w && y >= 0 && y < h ? blurred[y * w + x] : outside;
  const sample = (x: number, y: number) => {
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    // Weights in 256ths, truncated, as adl's fixed point has them.
    const fx = Math.floor((x - x0) * 256) / 256;
    const fy = Math.floor((y - y0) * 256) / 256;
    if (fx === 0 && fy === 0) {
      return at(x0, y0);
    }

    const top = at(x0, y0) * (1 - fx) + at(x0 + 1, y0) * fx;
    const bottom = at(x0, y0 + 1) * (1 - fx) + at(x0 + 1, y0 + 1) * fx;
    return Math.floor(top * (1 - fy) + bottom * fy + 1e-7);
  };
  const cr = (f.color >> 16) & 0xff;
  const cg = (f.color >> 8) & 0xff;
  const cb = f.color & 0xff;
  const hide = shadow && f.hideObject;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const blurA = sample(x - ox, y - oy);
      const sa = a[i];
      let ga: number;
      if (f.inner) {
        ga = Math.floor(Math.min(255, Math.floor(blurA * f.strength)) * f.alpha);
        ga = Math.floor((ga * sa) / 255);
      } else {
        ga = Math.floor(Math.min(255, Math.floor(blurA * f.strength)) * f.alpha);
      }

      const glowC = [cr, cg, cb].map((c) => (c * ga) / 255);
      let out: number[];
      if (f.knockout) {
        out = f.inner ? [ga, ...glowC] : [ga, ...glowC].map((v) => (v * (255 - sa)) / 255);
      } else if (f.inner) {
        const keep = (255 - ga) / 255;
        out = [
          ga + sa * keep,
          glowC[0] + r[i] * keep,
          glowC[1] + g[i] * keep,
          glowC[2] + b[i] * keep,
        ];
      } else if (hide) {
        out = [ga, ...glowC];
      } else {
        const behind = (255 - sa) / 255;
        out = [
          sa + ga * behind,
          r[i] + glowC[0] * behind,
          g[i] + glowC[1] * behind,
          b[i] + glowC[2] * behind,
        ];
      }

      const [oa, or, og, ob] = out.map((v) => Math.max(0, Math.min(255, Math.round(v))));
      result[i] =
        ((oa << 24) | (Math.min(or, oa) << 16) | (Math.min(og, oa) << 8) | Math.min(ob, oa)) >>> 0;
    }
  }
}

/** `pixels` over `rect` into `dest`, moved by (mx, my), clipped; an opaque store keeps its alpha. */
function write(
  dest: BitmapStore,
  pixels: Uint32Array,
  rect: PixelRect,
  mx: number,
  my: number,
): void {
  const target = dest.pixels;
  for (let y = 0; y < rect.height; y++) {
    const ty = rect.y + y + my;
    if (ty < 0 || ty >= dest.height) {
      continue;
    }

    for (let x = 0; x < rect.width; x++) {
      const tx = rect.x + x + mx;
      if (tx < 0 || tx >= dest.width) {
        continue;
      }

      const p = pixels[y * rect.width + x];
      target[ty * dest.width + tx] = dest.transparent ? p : (p | 0xff000000) >>> 0;
    }
  }

  dest.changed();
}
