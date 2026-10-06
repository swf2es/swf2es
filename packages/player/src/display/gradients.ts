// Gradients as Flash draws them, fitted to adl pixel by pixel: a ramp of
// 256 colours, each channel interpolated straight between the stops and
// truncated, alpha too, then premultiplied as c * (a + 1) >> 8; in linear
// RGB the colours are interpolated in sRGB's linear light and truncated
// back. A pixel takes the ramp's entry floor(256 * t), t its place along
// the gradient at the pixel's top left corner, not its centre: x across
// the gradient square for a linear one, the distance out from the focal
// point to the circle for a radial one, the last stop at a focal point
// off the centre itself. Pad clamps t, repeat wraps it, and reflect mirrors it, as a
// texture's clamp, repeat and mirrored repeat do with a ramp of 256 texels.
import type { GradientStop } from "@swf2es/format";

/** A ramp's stops in order of use: Flash fills the ramp from each stop to the next, skipping any that go back. */
export function ramp(stops: readonly GradientStop[], linearRgb: boolean): Uint32Array {
  const out = new Uint32Array(256);
  if (stops.length === 0) {
    out.fill(0xff000000);
    return out;
  }

  // The first colour up to the first stop, each stop's span after it in
  // order (none for a stop before where the ramp has got to), the last
  // colour on to the end. In linear RGB the ends go through linear light
  // too, which takes 255 to 254 as Flash does.
  let at = 0;
  const first = premultiplied(mix(stops[0].color, stops[0].color, 0, linearRgb));
  for (; at <= stops[0].ratio && at < 256; at++) {
    out[at] = first;
  }

  for (let k = 1; k < stops.length; k++) {
    const from = stops[k - 1];
    const to = stops[k];
    for (; at <= to.ratio && at < 256; at++) {
      const f = (at - from.ratio) / (to.ratio - from.ratio);
      out[at] = premultiplied(mix(from.color, to.color, f, linearRgb));
    }
  }

  const lastStop = stops[stops.length - 1].color;
  const last = premultiplied(mix(lastStop, lastStop, 0, linearRgb));
  for (; at < 256; at++) {
    out[at] = last;
  }

  return out;
}

/** Straight ARGB premultiplied, each channel times alpha + 1 over 256. */
function premultiplied(argb: number): number {
  const a = argb >>> 24;
  const r = (((argb >>> 16) & 0xff) * (a + 1)) >> 8;
  const g = (((argb >>> 8) & 0xff) * (a + 1)) >> 8;
  const b = ((argb & 0xff) * (a + 1)) >> 8;
  return ((a << 24) | (r << 16) | (g << 8) | b) >>> 0;
}

/** a to b by f, each channel truncated; colours in linear light for linear RGB, alpha straight. */
function mix(a: number, b: number, f: number, linearRgb: boolean): number {
  return (
    ((channel(a, b, f, 24, false) << 24) |
      (channel(a, b, f, 16, linearRgb) << 16) |
      (channel(a, b, f, 8, linearRgb) << 8) |
      channel(a, b, f, 0, linearRgb)) >>>
    0
  );
}

/** The channel at `shift` of a to b by f, truncated, through linear light if `light`. */
function channel(a: number, b: number, f: number, shift: number, light: boolean): number {
  const x = (a >>> shift) & 0xff;
  const y = (b >>> shift) & 0xff;
  if (!light) {
    return Math.floor(x + (y - x) * f);
  }

  const l = (1 - f) * toLinear(x / 255) + f * toLinear(y / 255);
  return Math.floor(255 * toSrgb(l));
}

function toLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function toSrgb(l: number): number {
  return l <= 0.0031308 ? 12.92 * l : 1.055 * l ** (1 / 2.4) - 0.055;
}

/** The most texels a radial gradient's texture has a side; a larger region is sampled more coarsely. */
export const RADIAL_MAX = 512;

/** A region of a shape, in its pixels: where a radial gradient's texture covers. */
export interface Region {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * A radial gradient over `region` of the shape, `columns` by `rows` texels,
 * as premultiplied ARGB: each texel the ramp's entry at its top left
 * corner, where Flash samples a pixel, so that a texel of an unscaled
 * shape is its pixel exactly. `m` maps the gradient square to the shape.
 */
export function radialPixels(
  colors: Uint32Array,
  m: { a: number; b: number; c: number; d: number; tx: number; ty: number },
  focal: number,
  spread: number,
  region: Region,
  columns: number,
  rows: number,
): Uint32Array {
  const out = new Uint32Array(columns * rows);
  const f = Math.max(-1, Math.min(1, focal));
  // The inverse, from the shape to the unit circle (the square is 819.2 a half side).
  const det = m.a * m.d - m.b * m.c;
  const ia = m.d / det / 819.2;
  const ib = -m.b / det / 819.2;
  const ic = -m.c / det / 819.2;
  const id = m.a / det / 819.2;
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < columns; i++) {
      const x = region.x + (i * region.width) / columns - m.tx;
      const y = region.y + (j * region.height) / rows - m.ty;
      out[j * columns + i] = colors[index(place(ia * x + ic * y, ib * x + id * y, f), spread)];
    }
  }

  return out;
}

/** Where (px, py) lies from the focal point (f, 0) to the unit circle along the ray through it: 0 at the focus, 1 on the circle. */
function place(px: number, py: number, f: number): number {
  const dx = px - f;
  const dy = py;
  const dd = dx * dx + dy * dy;
  // At a focal point off the centre Flash draws the last stop, as though it
  // were on the circle; at the centre of one centred, the first. Within
  // rounding, as the point comes through the matrix's inverse.
  if (dd < 1e-12) {
    return f !== 0 ? 1 : 0;
  }

  // The ray f + s (p - f) meets the circle where s solves |f + s d|^2 = 1.
  const fd = f * dx;
  const s = (-fd + Math.sqrt(fd * fd - dd * (f * f - 1))) / dd;
  return s > 0 ? 1 / s : 1;
}

/** The ramp's entry for place t, spread: 0 pad, 1 reflect, 2 repeat. */
export function index(t: number, spread: number): number {
  const p = Math.floor(t * 256);
  if (spread === 2) {
    return ((p % 256) + 256) % 256;
  }

  if (spread === 1) {
    const m = ((p % 512) + 512) % 512;
    return m < 256 ? m : 511 - m;
  }

  return Math.max(0, Math.min(255, p));
}
