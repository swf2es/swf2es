// BitmapData.applyFilter and generateFilterRect, on the CPU, as adl
// computes them (docs/architecture.md, "Filters"): the filter's rect of the
// source, what lies outside the source rect transparent, written whole into
// the destination; a blur's runs truncated to 8 bits each, a glow's alpha
// from the blur so truncated times strength, a colour matrix of straight
// colour, rounded.
import type { BitmapStore, PixelRect } from "./bitmap.js";
import type { Filter } from "./filters.js";

/** How far a filter reaches past what it filters, each way: [x, y], whole pixels. */
function reach(f: Filter): [number, number] {
  if (f.kind === "blur" || f.kind === "glow" || f.kind === "dropShadow") {
    const quality = Math.max(0, f.quality);
    return [Math.ceil(((f.blurX || 0) * quality) / 2), Math.ceil(((f.blurY || 0) * quality) / 2)];
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
  if (!["blur", "glow", "dropShadow", "colorMatrix"].includes(f.kind)) {
    return false;
  }

  const out = filterRect(rect, f);
  const w = out.width;
  const h = out.height;
  if (w <= 0 || h <= 0) {
    return true;
  }

  // The source's premultiplied channels over the filter's rect, transparent past `rect`.
  const pixels = source.pixels;
  const a = new Float64Array(w * h);
  const r = new Float64Array(w * h);
  const g = new Float64Array(w * h);
  const b = new Float64Array(w * h);
  for (let y = 0; y < h; y++) {
    const sy = out.y + y;
    if (sy < rect.y || sy >= rect.y + rect.height || sy < 0 || sy >= source.height) {
      continue;
    }

    for (let x = 0; x < w; x++) {
      const sx = out.x + x;
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
    colorMatrix(dest, result, [a, r, g, b], w, h, f.matrix);
  } else {
    glow(result, [a, r, g, b], w, h, f);
  }

  write(dest, result, out, dx - rect.x, dy - rect.y);
  return true;
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
  w: number,
  h: number,
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

  // What the source has: the bounds of its pixels that are not transparent, and one more each way.
  let x0 = w;
  let y0 = h;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (a[y * w + x] > 0) {
        x0 = Math.min(x0, x);
        y0 = Math.min(y0, y);
        x1 = Math.max(x1, x);
        y1 = Math.max(y1, y);
      }
    }
  }

  for (let y = Math.max(0, y0 - 1); y <= Math.min(h - 1, y1 + 1); y++) {
    for (let x = Math.max(0, x0 - 1); x <= Math.min(w - 1, x1 + 1); x++) {
      const i = y * w + x;
      const s = a[i] > 0 ? 255 / a[i] : 0;
      const [nr, ng, nb, na] = map([r[i] * s, g[i] * s, b[i] * s, a[i]]);
      const p = (c: number) => Math.floor((c * na) / 255);
      result[i] = ((na << 24) | (p(nr) << 16) | (p(ng) << 8) | p(nb)) >>> 0;
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
