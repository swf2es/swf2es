// A 3D display object's plane in perspective (docs/architecture.md, "3D
// display objects"): as Flash Player and adl project it, through the
// perspective projection of the nearest container above it that has one
// set, or else of its SWF's root (the stage's, for one put on the stage).
// Its matrix3D, those of the 3D objects above it and the 2D matrices
// between go into one 3D transform to that container's space, which the
// projection then divides: a 3D object inside another is in true 3D, not
// flattened into the other's plane. The plane of each object, 2D or 3D,
// is then a projective map of its space to the container's, and a 3D
// object's in its parent's is the parent's inverse after its own.
import type { DisplayObject, Projection } from "./display.js";
import { apply, concat, invert, type Projective } from "./geometry.js";

/** Each player's stage's size, for the default projection of a root: centred on the stage and as wide. */
const stageSizes = new WeakMap<DisplayObject, { width: number; height: number }>();

export function setStageSize(stage: DisplayObject, width: number, height: number): void {
  stageSizes.set(stage, { width, height });
}

/** The size of the stage `d` is under, or Flash's default stage's where it is under none. */
function stageSizeOf(d: DisplayObject): { width: number; height: number } {
  let top = d;
  while (top.parent) {
    top = top.parent;
  }

  return stageSizes.get(top) ?? { width: 550, height: 400 };
}

/** Flash's default field of view, 55 degrees, in radians. */
const FIELD_OF_VIEW = (55 * Math.PI) / 180;

/** Whether `d` projects what is in it: a projection set on it, a SWF's root, or the stage (no parent). */
function projects(d: DisplayObject): boolean {
  return d.projection !== null || d.loaderInfo !== null || d.parent === null;
}

/** The container whose projection `o` is drawn through: the nearest above it that projects. */
export function projectorOf(o: DisplayObject): DisplayObject | null {
  for (let p = o.parent; p; p = p.parent) {
    if (projects(p)) {
      return p;
    }
  }

  return null;
}

/** The projection `d` projects through: its own, or the default of the stage or a root. */
export function projectionOf(d: DisplayObject): Projection {
  if (d.projection) {
    return d.projection;
  }

  const stage = d.parent === null && d.loaderInfo !== null;
  const size = stageSizeOf(d);
  return {
    fieldOfView: FIELD_OF_VIEW,
    centerX: stage ? 250 : size.width / 2,
    centerY: stage ? 250 : size.height / 2,
  };
}

/**
 * The focal length of a field of view in radians over a width, in float32
 * as Flash's: the stage's projection measures 500 wide, any other object's
 * the stage's width.
 */
export function focalLength(radians: number, d: DisplayObject): number {
  const width = d.parent === null && d.loaderInfo !== null ? 500 : stageSizeOf(d).width;
  return Math.fround((width / 2) * Math.fround(Math.tan((Math.PI - radians) / 2)));
}

/** A column-major 4x4 matrix. */
type M4 = Float64Array;

/** `m`, `d`'s own transform in 3D: its matrix3D, or its 2D matrix with z kept (a 3D object has no scroll). */
function own3D(d: DisplayObject): M4 {
  const m = new Float64Array(16);
  const space = d.space;
  if (space) {
    m.set(space.raw);
  } else {
    const p = d.placed;
    m.set([p.a, p.b, 0, 0, p.c, p.d, 0, 0, 0, 0, 1, 0, p.tx, p.ty, 0, 1]);
  }

  return m;
}

/** `a` after `b`: b's columns through a. */
function multiply(a: M4, b: M4): M4 {
  const out = new Float64Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      out[c * 4 + r] =
        a[r] * b[c * 4] +
        a[4 + r] * b[c * 4 + 1] +
        a[8 + r] * b[c * 4 + 2] +
        a[12 + r] * b[c * 4 + 3];
    }
  }

  return out;
}

/** `d`'s space to `top`'s in 3D, `top` excluded; null where `top` is not above it. */
export function toSpace(d: DisplayObject, top: DisplayObject | null): M4 | null {
  let m = own3D(d);
  for (let p = d.parent; p !== top; p = p.parent) {
    if (!p) {
      return null;
    }

    m = multiply(own3D(p), m);
  }

  return m;
}

/**
 * A point in the projector's 3D space projected into its plane, as
 * homogeneous coordinates: the field of view's focal length f, the centre
 * (cx, cy), and a point at depth z drawn at f / (f + z) of its distance
 * from the centre.
 */
export function project(
  projector: DisplayObject,
  x: number,
  y: number,
  z: number,
): [number, number, number] {
  const p = projectionOf(projector);
  const k = 1 / focalLength(p.fieldOfView, projector);
  return [x + p.centerX * k * z, y + p.centerY * k * z, 1 + k * z];
}

/** The plane z = 0 of a 3D space `m` puts in the projector's, projected: a projective map. */
function planeOf(projector: DisplayObject, m: M4): Projective {
  const p = projectionOf(projector);
  const k = 1 / focalLength(p.fieldOfView, projector);
  const cx = p.centerX * k;
  const cy = p.centerY * k;
  return {
    a: m[0] + cx * m[2],
    b: m[1] + cy * m[2],
    u: k * m[2] + m[3],
    c: m[4] + cx * m[6],
    d: m[5] + cy * m[6],
    v: k * m[6] + m[7],
    tx: m[12] + cx * m[14],
    ty: m[13] + cy * m[14],
    w: k * m[14] + m[15],
  };
}

/**
 * A 3D object's plane in its parent's space, in perspective: through its
 * projector's projection, and back through the parent's plane, which is
 * flat but for a 3D object above it. An object off the list projects
 * through its topmost container's, as a root's.
 */
export function placedInPerspective(o: DisplayObject): Projective {
  const parent = o.parent;
  if (!parent) {
    const m = own3D(o);
    return { a: m[0], b: m[1], c: m[4], d: m[5], tx: m[12], ty: m[13], u: 0, v: 0, w: 1 };
  }

  const projector = projectorOf(o) as DisplayObject;
  const up = parent === projector ? null : toSpace(parent, projector);
  const own = planeOf(projector, up ? multiply(up, own3D(o)) : own3D(o));
  if (!up) {
    return own;
  }

  const back = invert(planeOf(projector, up));
  return (back ? concat(own, back) : own) as Projective;
}

/**
 * A point of `d`'s 3D space on the stage (`stage` itself excluded): into
 * its projector's space, projected there, then through the projector's
 * matrices up to the stage.
 */
export function stagePoint3D(
  d: DisplayObject,
  x: number,
  y: number,
  z: number,
  stage: DisplayObject | null,
): [number, number] {
  const projector = projectorOf(d);
  const m = projector && toSpace(d, projector);
  if (!projector || !m) {
    return apply(d.placed, x, y);
  }

  const [px, py, q] = project(
    projector,
    m[0] * x + m[4] * y + m[8] * z + m[12],
    m[1] * x + m[5] * y + m[9] * z + m[13],
    m[2] * x + m[6] * y + m[10] * z + m[14],
  );
  let at: [number, number] = [px / q, py / q];
  for (let p: DisplayObject | null = projector; p && p !== stage; p = p.parent) {
    at = apply(p.placed, at[0], at[1]);
  }

  return at;
}
