// The pixels a flash.geom.Rectangle's numbers cover, as Flash rounds and
// clamps a rect's edges for every BitmapData operation that takes one.

export interface PixelRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The nearest integer, a half to the even one, as C's rint rounds and Flash's pixel coordinates do. */
export function nearest(v: number): number {
  const f = Math.floor(v);
  const d = v - f;
  if (d !== 0.5) {
    return d > 0.5 ? f + 1 : f;
  }

  return f % 2 === 0 ? f : f + 1;
}

/** How far a rect's edge reaches either way, as adl clamps it: 2^30 - 1. */
export const EDGE_LIMIT = 0x3fffffff;

/** The edge NaN makes, which lies off every bitmap: int's least. */
export const NAN_EDGE = -0x80000000;

/**
 * A rect's edge as a pixel: rounded to the nearest, a half to the even
 * one, then clamped to EDGE_LIMIT, so that Infinity and 1e20 lie past
 * every bitmap as a huge finite edge does; NaN, which the clamp lets
 * through, is int's least, as adl converts it (a copy's point moved by a
 * clamped edge lands where 2^30 - 1 puts it).
 */
export function pixelEdge(v: number): number {
  if (Number.isNaN(v)) {
    return NAN_EDGE;
  }

  return Math.max(-EDGE_LIMIT, Math.min(EDGE_LIMIT, nearest(v))) + 0;
}

/**
 * A flash.geom.Rectangle's numbers as the pixels Flash takes it to cover:
 * each edge, x and x + width, as pixelEdge makes it, so a rect from 1.6 of
 * 1.8 covers the pixel at 2 alone, and one from 3.5 of 1 covers none
 * (Ruffle's bitmapdata_rectangle_rounding; under adl the same for every
 * operation taking a rect). A width of Infinity reaches the bitmap's edge,
 * one of NaN covers nothing, and an x of NaN or Infinity nothing either.
 */
export function pixelRect(x: number, y: number, width: number, height: number): PixelRect {
  const x0 = pixelEdge(x);
  const y0 = pixelEdge(y);
  return { x: x0, y: y0, width: pixelEdge(x + width) - x0, height: pixelEdge(y + height) - y0 };
}

/**
 * pixelRect of the rect as merge, copyChannel, paletteMap, threshold and
 * pixelDissolve take it under adl: a negative width or height spans back
 * from x to x + width, turned round on the numbers before their edges are
 * made, so that 5 of -1e20 is a rect from -1e20 of 1e20, which the double
 * rounds to end at 0, not one reaching from the clamped edge to 5.
 */
export function spanRect(x: number, y: number, width: number, height: number): PixelRect {
  if (width < 0) {
    x += width;
    width = -width;
  }

  if (height < 0) {
    y += height;
    height = -height;
  }

  return pixelRect(x, y, width, height);
}
