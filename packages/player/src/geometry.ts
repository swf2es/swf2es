// Affine geometry in pixels, for bounds, hit tests and Transform: the
// format's Matrix is {a, b, c, d, tx, ty}, a point going (a x + c y + tx,
// b x + d y + ty).
import type { Matrix } from "@swf2es/format";

/** An axis-aligned rectangle by its edges. */
export interface Rect {
  xMin: number;
  yMin: number;
  xMax: number;
  yMax: number;
}

/** `m` then `p`: the matrix that applies `m` and then `p`, as a child's in its parent's. */
export function concat(m: Matrix, p: Matrix): Matrix {
  return {
    a: m.a * p.a + m.b * p.c,
    b: m.a * p.b + m.b * p.d,
    c: m.c * p.a + m.d * p.c,
    d: m.c * p.b + m.d * p.d,
    tx: m.tx * p.a + m.ty * p.c + p.tx,
    ty: m.tx * p.b + m.ty * p.d + p.ty,
  };
}

/** The inverse, or null for a matrix that flattens the plane. */
export function invert(m: Matrix): Matrix | null {
  const det = m.a * m.d - m.b * m.c;
  if (det === 0) {
    return null;
  }

  return {
    a: m.d / det,
    b: -m.b / det,
    c: -m.c / det,
    d: m.a / det,
    tx: (m.c * m.ty - m.d * m.tx) / det,
    ty: (m.b * m.tx - m.a * m.ty) / det,
  };
}

export function apply(m: Matrix, x: number, y: number): [number, number] {
  return [m.a * x + m.c * y + m.tx, m.b * x + m.d * y + m.ty];
}

/** The rectangle around `r`'s four corners through `m`. */
export function transformRect(r: Rect, m: Matrix): Rect {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const [x, y] of [
    [r.xMin, r.yMin],
    [r.xMax, r.yMin],
    [r.xMin, r.yMax],
    [r.xMax, r.yMax],
  ]) {
    const [px, py] = apply(m, x, y);
    xs.push(px);
    ys.push(py);
  }

  return {
    xMin: Math.min(...xs),
    yMin: Math.min(...ys),
    xMax: Math.max(...xs),
    yMax: Math.max(...ys),
  };
}

export function union(a: Rect | null, b: Rect | null): Rect | null {
  if (!a || !b) {
    return a ?? b;
  }

  return {
    xMin: Math.min(a.xMin, b.xMin),
    yMin: Math.min(a.yMin, b.yMin),
    xMax: Math.max(a.xMax, b.xMax),
    yMax: Math.max(a.yMax, b.yMax),
  };
}

export function contains(r: Rect, x: number, y: number): boolean {
  return x >= r.xMin && x <= r.xMax && y >= r.yMin && y <= r.yMax;
}

export function overlaps(a: Rect, b: Rect): boolean {
  return a.xMin <= b.xMax && b.xMin <= a.xMax && a.yMin <= b.yMax && b.yMin <= a.yMax;
}

/** `m` after a shift of (-left, -top) of `r`: a scrolled object's, its scroll's corner at its origin. */
export function shifted(m: Matrix, r: Rect): Matrix {
  return {
    ...m,
    tx: m.tx - m.a * r.xMin - m.c * r.yMin,
    ty: m.ty - m.b * r.xMin - m.d * r.yMin,
  };
}
