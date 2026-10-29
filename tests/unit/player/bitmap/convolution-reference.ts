// The convolution the player computed in JS before the render module's
// (convolve.zig) became its only one, kept as the kernel's reference: what
// adl computes, quirks and all, which native-bitmap.test.ts holds the
// kernel to, bit for bit.
import type { BitmapStore, PixelRect } from "../../../../packages/player/dist/bitmap/bitmap.js";
import { unmultiply } from "../../../../packages/player/dist/bitmap/bitmap.js";
import { integerKernel } from "../../../../packages/player/dist/bitmap/filters.js";
import type { Filter } from "../../../../packages/player/dist/display/filters.js";

/**
 * A convolution over `area` of the source, as adl computes it: each tap
 * reads the source's straight colour, past the rect too, and past the
 * bitmap the nearest edge's or the filter's colour; the sum divided (0
 * counting as 1), the bias added, clamped and truncated, the alpha the
 * source's where the filter keeps it; the colour premultiplied by that alpha,
 * or kept straight for an opaque destination.
 */
export function convolveReference(
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
