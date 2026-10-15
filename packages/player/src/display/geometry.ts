// Affine geometry in pixels, for bounds, hit tests and Transform: the
// format's Matrix is {a, b, c, d, tx, ty}, a point going (a x + c y + tx,
// b x + d y + ty). A 3D object's plane in its parent's, in perspective,
// is a Projective one, which divides by (u x + v y + w); the functions
// here take either, and the affine ones pay one test.
import type { Matrix } from "@swf2es/format";

/** A matrix with a projective row: a point goes to ((a x + c y + tx) / q, (b x + d y + ty) / q), q = u x + v y + w. */
export interface Projective extends Matrix {
  u: number;
  v: number;
  w: number;
}

export function isProjective(m: Matrix): m is Projective {
  return (m as Projective).w !== undefined;
}

/**
 * What a 3D object behind the eye, or crossing its plane, is placed by:
 * Flash draws none of it, hits none of it, and counts it in no bounds.
 */
export const CULLED: Projective = { a: 0, b: 0, c: 0, d: 0, tx: 0, ty: 0, u: 0, v: 0, w: 0 };

/** `m` then `p`, either projective. */
function concatProjective(m: Matrix, p: Matrix): Projective {
  const [mu, mv, mw] = isProjective(m) ? [m.u, m.v, m.w] : [0, 0, 1];
  const [pu, pv, pw] = isProjective(p) ? [p.u, p.v, p.w] : [0, 0, 1];
  return {
    a: p.a * m.a + p.c * m.b + p.tx * mu,
    b: p.b * m.a + p.d * m.b + p.ty * mu,
    c: p.a * m.c + p.c * m.d + p.tx * mv,
    d: p.b * m.c + p.d * m.d + p.ty * mv,
    tx: p.a * m.tx + p.c * m.ty + p.tx * mw,
    ty: p.b * m.tx + p.d * m.ty + p.ty * mw,
    u: pu * m.a + pv * m.b + pw * mu,
    v: pu * m.c + pv * m.d + pw * mv,
    w: pu * m.tx + pv * m.ty + pw * mw,
  };
}

/** The inverse of a projective matrix, by its adjugate, or null for one that flattens the plane. */
function invertProjective(m: Projective): Projective | null {
  const { a, b, c, d, tx, ty, u, v, w } = m;
  const A = d * w - ty * v;
  const B = -(b * w - ty * u);
  const C = b * v - d * u;
  const det = a * A + c * B + tx * C;
  if (det === 0 || !Number.isFinite(det)) {
    return null;
  }

  return {
    a: A / det,
    b: B / det,
    u: C / det,
    c: -(c * w - tx * v) / det,
    d: (a * w - tx * u) / det,
    v: -(a * v - c * u) / det,
    tx: (c * ty - tx * d) / det,
    ty: -(a * ty - tx * b) / det,
    w: (a * d - c * b) / det,
  };
}

/** An axis-aligned rectangle by its edges. */
export interface Rect {
  xMin: number;
  yMin: number;
  xMax: number;
  yMax: number;
}

/** `m` then `p`: the matrix that applies `m` and then `p`, as a child's in its parent's. */
export function concat(m: Matrix, p: Matrix): Matrix {
  if (isProjective(m) || isProjective(p)) {
    return concatProjective(m, p);
  }

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
  if (isProjective(m)) {
    return invertProjective(m);
  }

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
  if (isProjective(m)) {
    const q = m.u * x + m.v * y + m.w;
    return [(m.a * x + m.c * y + m.tx) / q, (m.b * x + m.d * y + m.ty) / q];
  }

  return [m.a * x + m.c * y + m.tx, m.b * x + m.d * y + m.ty];
}

/**
 * The rectangle around `r`'s four corners through `m`. Through a
 * projective one, out to whole pixels, as Flash reports a 3D object's;
 * and a point at the origin where a corner is behind the eye, where Flash
 * draws nothing.
 */
export function transformRect(r: Rect, m: Matrix): Rect {
  if (isProjective(m)) {
    return projectRect(r, m);
  }

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

/** How far past a whole pixel a projected edge may go and still be bounded by it. */
const SLACK = 0.125;

function projectRect(r: Rect, m: Projective): Rect {
  let xMin = Number.POSITIVE_INFINITY;
  let yMin = Number.POSITIVE_INFINITY;
  let xMax = Number.NEGATIVE_INFINITY;
  let yMax = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < 4; i++) {
    const x = i & 1 ? r.xMax : r.xMin;
    const y = i & 2 ? r.yMax : r.yMin;
    const q = m.u * x + m.v * y + m.w;
    if (!(q > 0)) {
      return { xMin: 0, yMin: 0, xMax: 0, yMax: 0 };
    }

    const px = (m.a * x + m.c * y + m.tx) / q;
    const py = (m.b * x + m.d * y + m.ty) / q;
    xMin = Math.min(xMin, px);
    yMin = Math.min(yMin, py);
    xMax = Math.max(xMax, px);
    yMax = Math.max(yMax, py);
  }

  // Out to whole pixels, but for an eighth of one: an edge that passes a pixel by less is not
  // counted to the next, as adl reports (the `three-d-bounds` case).
  return {
    xMin: Math.floor(xMin + SLACK),
    yMin: Math.floor(yMin + SLACK),
    xMax: Math.ceil(xMax - SLACK),
    yMax: Math.ceil(yMax - SLACK),
  };
}

/** The rectangle around `r`'s four corners through `m`, each divided where `m` is projective: not out to whole pixels. */
export function boxThrough(r: Rect, m: Matrix): Rect {
  let xMin = Number.POSITIVE_INFINITY;
  let yMin = Number.POSITIVE_INFINITY;
  let xMax = Number.NEGATIVE_INFINITY;
  let yMax = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < 4; i++) {
    const [x, y] = apply(m, i & 1 ? r.xMax : r.xMin, i & 2 ? r.yMax : r.yMin);
    xMin = Math.min(xMin, x);
    yMin = Math.min(yMin, y);
    xMax = Math.max(xMax, x);
    yMax = Math.max(yMax, y);
  }

  return { xMin, yMin, xMax, yMax };
}

/** Whether a corner of `r` goes behind the eye through `m`, or `m` is CULLED: Flash then draws none of it. */
export function behindEye(r: Rect, m: Matrix): boolean {
  if (!isProjective(m)) {
    return false;
  }

  for (let i = 0; i < 4; i++) {
    const q = m.u * (i & 1 ? r.xMax : r.xMin) + m.v * (i & 2 ? r.yMax : r.yMin) + m.w;
    if (!(q > 0)) {
      return true;
    }
  }

  return false;
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
