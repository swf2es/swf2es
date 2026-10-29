// The blur family the player computed in JS before the render module's
// (blur.zig) took it, kept as the kernels' reference: applyFilter for a
// blur, a glow, a drop shadow, a bevel and a gradient glow or bevel, as adl
// computes them, which native-blur.test.ts holds the kernels to, bit for
// bit. What it shares with the player (the filter's rect, its offset's
// rect, the gradient's colours) it takes from there.
import {
  type BitmapStore,
  type PixelRect,
  premultiply,
  unmultiply,
} from "../../../../packages/player/dist/bitmap/bitmap.js";
import {
  filterRect,
  gradientTable,
  isInner,
} from "../../../../packages/player/dist/bitmap/filters.js";
import type { Filter } from "../../../../packages/player/dist/display/filters.js";

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

export function applyBlurFamily(
  dest: BitmapStore,
  source: BitmapStore,
  rect: PixelRect,
  dx: number,
  dy: number,
  f: Filter,
): boolean {
  if (!["blur", "glow", "dropShadow", "bevel", "gradientGlow", "gradientBevel"].includes(f.kind)) {
    return false;
  }

  const out = filterRect(rect, f);
  // What the destination shows of the filter's rect, in the filter's
  // coordinates, and the work: that and as far round it as the filter
  // reaches into it, so that a rect far past the destination costs nothing.
  let mx = dx - rect.x;
  let my = dy - rect.y;
  let written = out;
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

  if (f.kind === "blur") {
    // The work: what is shown and as far round it as the blur reaches into
    // it, which may be past the rect, whose edge cuts what is written alone.
    const [hx, hy] = blurHalo(f);
    const work = {
      x: shown.x - hx,
      y: shown.y - hy,
      width: shown.width + 2 * hx,
      height: shown.height + 2 * hy,
    };
    const planes = channelsOf(source, work);
    const [a, r, g, b] = planes;
    blur(planes, work.width, work.height, f);
    const result = new Uint32Array(work.width * work.height);
    for (let i = 0; i < result.length; i++) {
      result[i] = ((a[i] << 24) | (r[i] << 16) | (g[i] << 8) | b[i]) >>> 0;
    }

    write(dest, result, work, shown, mx, my);
    return true;
  }

  // The source's pixels where they are shown, and its alpha blurred and read
  // from the offset, each over what is shown alone: however far the offset
  // reaches, the work is the destination's size.
  const w = shown.width;
  const h = shown.height;
  const planes = channelsOf(source, shown);
  const [ox, oy] = f.kind === "glow" ? [0, 0] : shadowOffset(f);
  const result = new Uint32Array(w * h);
  // An outer shadow cast as far as an offset goes adl writes empty, the
  // source's own pixels too.
  const outer = (f.kind === "dropShadow" || f.kind === "gradientGlow") && !isInner(f);
  if (outer && (ox === FAR || oy === FAR)) {
    write(dest, result, shown, shown, mx, my);
    return true;
  }

  switch (f.kind) {
    case "bevel":
    case "gradientBevel": {
      const [on, back] = alphasFrom(source, shown, f, [
        [ox, oy],
        [-ox, -oy],
      ]);
      (f.kind === "bevel" ? bevel : gradientBevel)(result, planes, on, back, f);
      break;
    }
    case "gradientGlow":
      gradientGlow(result, planes, alphasFrom(source, shown, f, [[-ox, -oy]])[0], f);
      break;
    default:
      glow(result, planes, alphasFrom(source, shown, f, [[-ox, -oy]], f.inner)[0], f);
  }

  write(dest, result, shown, shown, mx, my);
  return true;
}

/** The source's premultiplied channels over `area`, past `rect` too, as far as the bitmap goes; 0 past it. */
function channelsOf(source: BitmapStore, area: PixelRect): Int32Array[] {
  const w = area.width;
  const n = w * area.height;
  const a = new Int32Array(n);
  const r = new Int32Array(n);
  const g = new Int32Array(n);
  const b = new Int32Array(n);
  const pixels = source.pixels;
  const sw = source.width;
  const from = intersect(area, { x: 0, y: 0, width: sw, height: source.height });
  if (from) {
    for (let sy = from.y; sy < from.y + from.height; sy++) {
      let i = (sy - area.y) * w + from.x - area.x;
      for (let sx = from.x; sx < from.x + from.width; sx++, i++) {
        const p = pixels[sy * sw + sx];
        a[i] = p >>> 24;
        r[i] = (p >>> 16) & 0xff;
        g[i] = (p >>> 8) & 0xff;
        b[i] = p & 0xff;
      }
    }
  }

  return [a, r, g, b];
}

/** The source's alpha over `area`, as far as the bitmap goes; 0 past it. */
function alphaOf(source: BitmapStore, area: PixelRect): Int32Array {
  const w = area.width;
  const a = new Int32Array(w * area.height);
  const pixels = source.pixels;
  const sw = source.width;
  const from = intersect(area, { x: 0, y: 0, width: sw, height: source.height });
  if (from) {
    for (let sy = from.y; sy < from.y + from.height; sy++) {
      let i = (sy - area.y) * w + from.x - area.x;
      for (let sx = from.x; sx < from.x + from.width; sx++, i++) {
        a[i] = pixels[sy * sw + sx] >>> 24;
      }
    }
  }

  return a;
}

/**
 * The source's alpha, blurred as `f` blurs it and truncated, read at each
 * pixel of `area` moved by each of `moves`, between pixels as `shifted`
 * reads; with `invert`, of 255 less the alpha, as an inner glow blurs what
 * the source leaves. Blurred once over where they all read and as far
 * round it as the blur reaches, as a bevel reads on and back; reads
 * further apart than `area` is wide or high, each over its own, so the
 * work is `area`'s size wherever the offset takes it.
 */
function alphasFrom(
  source: BitmapStore,
  area: PixelRect,
  f: Filter,
  moves: readonly (readonly [number, number])[],
  invert = false,
): Int32Array[] {
  const kxs = moves.map(([dx]) => Math.floor(dx));
  const kys = moves.map(([, dy]) => Math.floor(dy));
  const x0 = Math.min(...kxs);
  const y0 = Math.min(...kys);
  const spanX = Math.max(...kxs) - x0;
  const spanY = Math.max(...kys) - y0;
  if (moves.length > 1 && (spanX > area.width || spanY > area.height)) {
    return moves.map((move) => alphasFrom(source, area, f, [move], invert)[0]);
  }

  const [hx, hy] = blurHalo(f);
  const read = {
    x: area.x + x0 - hx,
    y: area.y + y0 - hy,
    width: area.width + 1 + spanX + 2 * hx,
    height: area.height + 1 + spanY + 2 * hy,
  };
  const plane = alphaOf(source, read);
  if (invert) {
    for (let i = 0; i < plane.length; i++) {
      plane[i] = 255 - plane[i];
    }
  }

  blur([plane], read.width, read.height, f);
  return moves.map(([dx, dy], i) =>
    shifted(
      plane,
      read.width,
      read.height,
      hx + (kxs[i] - x0) + (dx - kxs[i]),
      hy + (kys[i] - y0) + (dy - kys[i]),
      invert ? 255 : 0,
      area.width,
      area.height,
    ),
  );
}

function intersect(p: PixelRect, q: PixelRect): PixelRect | null {
  const x0 = Math.max(p.x, q.x);
  const y0 = Math.max(p.y, q.y);
  const x1 = Math.min(p.x + p.width, q.x + q.width);
  const y1 = Math.min(p.y + p.height, q.y + q.height);
  return x1 > x0 && y1 > y0 ? { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } : null;
}

/** How far a blur reaches for the source, each way: each of `quality` runs half its box, whole taps. */
function blurHalo(f: Filter): [number, number] {
  return [f.quality * Math.ceil((f.blurX || 0) / 2), f.quality * Math.ceil((f.blurY || 0) / 2)];
}

/**
 * The plane (w × h) read at each pixel of its first `ow` × `oh` moved by
 * (ox, oy), between pixels linearly, with weights in 256ths, truncated, as
 * adl's fixed point has them; `outside` past it. Each column's and row's
 * whole part and weight are computed once.
 */
function shifted(
  plane: Int32Array,
  w: number,
  h: number,
  ox: number,
  oy: number,
  outside: number,
  ow = w,
  oh = h,
): Int32Array {
  const xs = new Int32Array(ow);
  const fxs = new Float64Array(ow);
  for (let x = 0; x < ow; x++) {
    const at = x + ox;
    xs[x] = Math.floor(at);
    fxs[x] = Math.floor((at - xs[x]) * 256) / 256;
  }

  const out = new Int32Array(ow * oh);
  const value = (x: number, y: number) =>
    x >= 0 && x < w && y >= 0 && y < h ? plane[y * w + x] : outside;
  for (let y = 0; y < oh; y++) {
    const at = y + oy;
    const y0 = Math.floor(at);
    const fy = Math.floor((at - y0) * 256) / 256;
    for (let x = 0; x < ow; x++) {
      const x0 = xs[x];
      const fx = fxs[x];
      if (fx === 0 && fy === 0) {
        out[y * ow + x] = value(x0, y0);
        continue;
      }

      const top = value(x0, y0) * (1 - fx) + value(x0 + 1, y0) * fx;
      const bottom = value(x0, y0 + 1) * (1 - fx) + value(x0 + 1, y0 + 1) * fx;
      out[y * ow + x] = Math.floor(top * (1 - fy) + bottom * fy + 1e-7);
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
  on: Int32Array,
  back: Int32Array,
  f: Filter,
): void {
  // Read as a shadow's. Off the axes adl reads about a 256th further out,
  // which this does not: within 2 a channel there.
  const channels = (c: number) => [(c >> 16) & 0xff, (c >> 8) & 0xff, c & 0xff];
  const [hr, hg, hb] = channels(f.highlightColor);
  const [sr, sg, sb] = channels(f.shadowColor);
  const highlightAlpha = f.highlightAlpha;
  const shadowAlpha = f.shadowAlpha;
  const strength = f.strength;
  const place = placer(f);
  for (let i = 0; i < result.length; i++) {
    const d = on[i] - back[i];
    const lit = d > 0;
    // Its alpha rounds, where a glow's truncates.
    const la = Math.round(
      Math.min(255, Math.floor(Math.abs(d) * strength)) * (lit ? highlightAlpha : shadowAlpha),
    );
    result[i] = place(
      a[i],
      r[i],
      g[i],
      b[i],
      la,
      Math.floor(((lit ? hr : sr) * la) / 255),
      Math.floor(((lit ? hg : sg) * la) / 255),
      Math.floor(((lit ? hb : sb) * la) / 255),
    );
  }
}

/**
 * How a bevel or a gradient filter places its layer (premultiplied, alpha
 * la) on the source's pixel: masked, rounding, to where the source is
 * (inner) or, knocked out, is not (outer); inner atop the source, which keeps its
 * alpha, on its straight colour as an inner glow lies; outer behind it, full over it,
 * knocked out alone; each over another as the store draws, top + bottom × (256 − top's
 * alpha) / 256, truncated.
 */
function placer(
  f: Filter,
): (
  sa: number,
  sr: number,
  sg: number,
  sb: number,
  la: number,
  lr: number,
  lg: number,
  lb: number,
) => number {
  const inner = f.type === "inner";
  const outer = f.type === "outer";
  const knockout = f.knockout;
  const over = (top: number, ta: number, bottom: number) =>
    Math.min(255, top + ((bottom * (256 - ta)) >> 8));
  return (sa, sr, sg, sb, la, lr, lg, lb) => {
    const m = inner ? sa : outer && knockout ? 255 - sa : 255;
    const mA = Math.floor((la * m + 127) / 255);
    const mr = Math.floor((lr * m + 127) / 255);
    const mg = Math.floor((lg * m + 127) / 255);
    const mb = Math.floor((lb * m + 127) / 255);
    let oa: number;
    let or: number;
    let og: number;
    let ob: number;
    if (knockout) {
      oa = mA;
      or = mr;
      og = mg;
      ob = mb;
    } else if (outer) {
      oa = over(sa, sa, mA);
      or = over(sr, sa, mr);
      og = over(sg, sa, mg);
      ob = over(sb, sa, mb);
    } else if (inner) {
      // Atop the source's straight colour by the layer's own alpha, as an inner glow lies (glow),
      // the source keeping its alpha.
      const p = unmultiply(((sa << 24) | (sr << 16) | (sg << 8) | sb) >>> 0);
      const mix = (c: number, shift: number) =>
        Math.min(255, Math.floor(c + (((p >>> shift) & 0xff) * (256 - la)) / 256));
      return premultiply(((sa << 24) | (mix(lr, 16) << 16) | (mix(lg, 8) << 8) | mix(lb, 0)) >>> 0);
    } else {
      // What is left shows through, by its masked alpha over.
      const ta = mA;
      oa = over(mA, ta, sa);
      or = over(mr, ta, sr);
      og = over(mg, ta, sg);
      ob = over(mb, ta, sb);
    }

    return (
      ((oa << 24) | (Math.min(or, oa) << 16) | (Math.min(og, oa) << 8) | Math.min(ob, oa)) >>> 0
    );
  };
}

/**
 * A gradient glow: the source's alpha blurred, truncated, from its offset
 * back as a shadow's, times strength to 255, picking its colour and alpha
 * from the gradient; placed as a bevel's layer is.
 */
function gradientGlow(
  result: Uint32Array,
  [a, r, g, b]: Int32Array[],
  moved: Int32Array,
  f: Filter,
): void {
  const table = gradientTable(f);
  const place = placer(f);
  for (let i = 0; i < result.length; i++) {
    const c = table[Math.min(255, Math.floor(moved[i] * f.strength))];
    result[i] = place(
      a[i],
      r[i],
      g[i],
      b[i],
      c >>> 24,
      (c >>> 16) & 0xff,
      (c >>> 8) & 0xff,
      c & 0xff,
    );
  }
}

/**
 * A gradient bevel: a bevel's difference, the source's alpha blurred and
 * read on and back by its offset, picking its colour and alpha from the
 * gradient, the middle where they agree; placed as a bevel's layer is.
 */
function gradientBevel(
  result: Uint32Array,
  [a, r, g, b]: Int32Array[],
  on: Int32Array,
  back: Int32Array,
  f: Filter,
): void {
  const table = gradientTable(f);
  const place = placer(f);
  for (let i = 0; i < result.length; i++) {
    const d = Math.max(-255, Math.min(255, Math.floor((on[i] - back[i]) * f.strength)));
    const c = table[Math.floor((d + 256) / 2)];
    result[i] = place(
      a[i],
      r[i],
      g[i],
      b[i],
      c >>> 24,
      (c >>> 16) & 0xff,
      (c >>> 8) & 0xff,
      c & 0xff,
    );
  }
}

/**
 * A glow or a shadow: the source's alpha blurred, truncated, times strength
 * (to 255) and alpha, in its colour, from the offset back for a shadow;
 * behind the source, or inside it for an inner one, or alone.
 */
function glow(result: Uint32Array, [a, r, g, b]: Int32Array[], moved: Int32Array, f: Filter): void {
  const shadow = f.kind === "dropShadow";
  const cr = (f.color >> 16) & 0xff;
  const cg = (f.color >> 8) & 0xff;
  const cb = f.color & 0xff;
  const hide = shadow && f.hideObject;
  const round = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
  for (let i = 0; i < result.length; i++) {
    const blurA = moved[i];
    const sa = a[i];
    const raw = Math.floor(Math.min(255, Math.floor(blurA * f.strength)) * f.alpha);
    const ga = f.inner ? Math.round((raw * sa) / 255) : raw;

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
      // Over the source's straight colour by the glow's own alpha, the glow's in 255ths and the
      // source's in 256ths, truncated; the source keeps its alpha, which then multiplies the
      // colour back in (apply-filter-inner, fitted to adl's pixels).
      const keep = 256 - raw;
      const p = unmultiply(((sa << 24) | (r[i] << 16) | (g[i] << 8) | b[i]) >>> 0);
      const mix = (c: number, shift: number) =>
        Math.floor((c * raw) / 255 + (((p >>> shift) & 0xff) * keep) / 256);
      result[i] = premultiply(
        ((sa << 24) | (mix(cr, 16) << 16) | (mix(cg, 8) << 8) | mix(cb, 0)) >>> 0,
      );
      continue;
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
