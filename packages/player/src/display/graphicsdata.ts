// What Graphics.readGraphicsData gives back of a drawing, in the form adl
// gives it (the read-graphics-data case): Flash keeps no commands, only the
// shape it built from them in twips, and reads that back. Each fill of each
// layer comes as its fill, one path of its contours and an end; each line
// as the outline Flash strokes it into, a fill of the line's colour with a
// nonZero path. Cubics come back as quadratics, a quadratic whose control
// point is its chord's middle as a line, and a contour that starts where
// the last ended without a move. Colours go through Flash's premultiplied
// storage and back, and a bitmap's or a gradient's matrix through its
// fixed point. Ruffle reads back nothing (graphics.rs's read_graphics_data
// is a stub returning an empty Vector). Where this parts from adl: the
// outlines of lines under about five pixels wide, of curves, and of a path
// that runs on through its own start stray from adl's by a twip or in
// their order; and a line's gradient or bitmap, which the player does not
// draw, reads back as its colour.
import type { Line, Matrix } from "@swf2es/format";
import type { BitmapStore } from "../bitmap/bitmap.js";
import { apply, concat } from "./geometry.js";
import {
  CUBIC,
  CURVE,
  LINE,
  type Paint,
  type Path,
  type ShapeLayer,
  type Winding,
} from "./shapes.js";
import type { BitmapCharacter } from "./timeline.js";

export type GraphicsDatum =
  | { type: "solid"; color: number; alpha: number }
  | {
      type: "gradient";
      radial: boolean;
      colors: number[];
      alphas: number[];
      ratios: number[];
      matrix: Matrix;
      spread: "pad" | "reflect" | "repeat";
      linearRgb: boolean;
      focal: number;
    }
  | { type: "bitmap"; image: BitmapStore | BitmapCharacter | null; matrix: Matrix }
  | { type: "path"; winding: Winding; commands: number[]; data: number[] }
  | { type: "end" };

const TWIPS = 20;
const IDENTITY_MATRIX: Matrix = { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 };

/** The matrix adl reads back for a gradient begun with none: a 200-pixel square about the origin. */
const DEFAULT_GRADIENT: Matrix = {
  a: 100 / 819.2,
  b: 0,
  c: 0,
  d: 100 / 819.2,
  tx: 0,
  ty: 0,
};

/** What a cubic may stray from the quadratics that stand for it, in twips, before it is split again. */
const CUBIC_TOLERANCE = 50;

/** A 0xAARRGGBB colour back from Flash's premultiplied store: the alpha a byte, each channel through it and back. */
export function storedColor(argb: number): { color: number; alpha: number } {
  const a = argb >>> 24;
  if (a === 0) {
    return { color: 0, alpha: 0 };
  }

  // Fitted to all 256 levels of a channel at nine alphas in adl.
  const back = Math.floor(65280 / a);
  let color = 0;
  for (const shift of [16, 8, 0]) {
    const premultiplied = (((argb >>> shift) & 0xff) * (a + 1)) >> 8;
    color |= Math.min(255, (premultiplied * back + 127) >> 8) << shift;
  }

  return { color, alpha: a / 255 };
}

function datumOf(paint: Paint, m: Matrix, defaults: WeakSet<Paint>): GraphicsDatum {
  switch (paint.type) {
    case "solid":
      return { type: "solid", ...storedColor(paint.color) };
    case "gradient": {
      const g = concat(defaults.has(paint) ? DEFAULT_GRADIENT : paint.matrix, m);
      // The linear part in single floats and the offset in whole pixels, toward zero.
      return {
        type: "gradient",
        radial: paint.radial,
        colors: paint.stops.map((s) => s.color >>> 0),
        alphas: paint.stops.map((s) => (s.color >>> 24) / 255),
        ratios: paint.stops.map((s) => s.ratio),
        matrix: {
          a: Math.fround(g.a),
          b: Math.fround(g.b),
          c: Math.fround(g.c),
          d: Math.fround(g.d),
          tx: Math.trunc(g.tx),
          ty: Math.trunc(g.ty),
        },
        spread: paint.spread === 1 ? "reflect" : paint.spread === 2 ? "repeat" : "pad",
        linearRgb: paint.linearRgb,
        focal: paint.radial ? Math.round(Math.max(-1, Math.min(1, paint.focal)) * 255) / 255 : 0,
      };
    }
    case "image": {
      // A bitmap's matrix comes back 4095/4096 of itself, its offset in whole pixels.
      const b = concat(paint.matrix, m);
      const k = 4095 / 4096;
      return {
        type: "bitmap",
        image: paint.image,
        matrix: {
          a: Math.fround(b.a * k),
          b: Math.fround(b.b * k),
          c: Math.fround(b.c * k),
          d: Math.fround(b.d * k),
          tx: Math.round(b.tx * k),
          ty: Math.round(b.ty * k),
        },
      };
    }
    default:
      return { type: "bitmap", image: null, matrix: IDENTITY_MATRIX };
  }
}

/** A path as Flash writes it out, in twips: a move to where the pen is goes, and a curve along its chord is a line. */
class Writer {
  readonly commands: number[] = [];
  readonly data: number[] = [];
  x = Number.NaN;
  y = Number.NaN;

  move(x: number, y: number): void {
    if (x !== this.x || y !== this.y) {
      this.commands.push(1);
      this.to(x, y);
    }
  }

  line(x: number, y: number): void {
    this.commands.push(2);
    this.to(x, y);
  }

  curve(cx: number, cy: number, x: number, y: number): void {
    if (Math.abs(2 * cx - this.x - x) <= 1 && Math.abs(2 * cy - this.y - y) <= 1) {
      this.line(x, y);
      return;
    }

    this.commands.push(3);
    this.data.push(cx / TWIPS, cy / TWIPS);
    this.to(x, y);
  }

  private to(x: number, y: number): void {
    this.data.push(x / TWIPS, y / TWIPS);
    this.x = x;
    this.y = y;
  }
}

/** A line or a quadratic (with its control point), in whole twips. */
interface Segment {
  x0: number;
  y0: number;
  curve: boolean;
  cx: number;
  cy: number;
  x1: number;
  y1: number;
}

/**
 * A cubic as Flash keeps it: split in halves until a quadratic for each
 * part strays under the tolerance, the error going down eightfold with
 * each halving, and each part the quadratic of its cubic's middle.
 */
function cubicSegments(
  out: Segment[],
  p0: [number, number],
  c1: [number, number],
  c2: [number, number],
  p3: [number, number],
): void {
  const ex = p3[0] - 3 * c2[0] + 3 * c1[0] - p0[0];
  const ey = p3[1] - 3 * c2[1] + 3 * c1[1] - p0[1];
  const error = Math.hypot(ex, ey);
  let n = 1;
  while (error / n ** 3 > CUBIC_TOLERANCE && n < 1024) {
    n *= 2;
  }

  const at = (t: number, k: number) => {
    const u = 1 - t;
    return u * u * u * p0[k] + 3 * u * u * t * c1[k] + 3 * u * t * t * c2[k] + t * t * t * p3[k];
  };
  const slope = (t: number, k: number) => {
    const u = 1 - t;
    return 3 * (u * u * (c1[k] - p0[k]) + 2 * u * t * (c2[k] - c1[k]) + t * t * (p3[k] - c2[k]));
  };
  let x = Math.round(p0[0]);
  let y = Math.round(p0[1]);
  for (let i = 0; i < n; i++) {
    const t0 = i / n;
    const t1 = (i + 1) / n;
    const third = 1 / (3 * n);
    const control = [0, 1].map((k) => {
      const a = at(t0, k);
      const d = at(t1, k);
      return (3 * (a + slope(t0, k) * third + d - slope(t1, k) * third) - (a + d)) / 4;
    });
    const x1 = Math.round(at(t1, 0));
    const y1 = Math.round(at(t1, 1));
    out.push({
      x0: x,
      y0: y,
      curve: true,
      cx: Math.round(control[0]),
      cy: Math.round(control[1]),
      x1,
      y1,
    });
    x = x1;
    y = y1;
  }
}

/** A path's segments through `m`, in whole twips. */
function segmentsOf(path: Path, m: Matrix): Segment[] {
  const out: Segment[] = [];
  const point = (i: number): [number, number] => {
    const [x, y] = apply(m, path[i], path[i + 1]);
    return [x * TWIPS, y * TWIPS];
  };
  let [x, y] = point(1);
  for (let i = 3; i < path.length; ) {
    const command = path[i];
    if (command === LINE) {
      const [x1, y1] = point(i + 1);
      out.push({ x0: Math.round(x), y0: Math.round(y), curve: false, cx: 0, cy: 0, x1, y1 });
      [x, y] = [x1, y1];
      i += 3;
    } else if (command === CURVE) {
      const [cx, cy] = point(i + 1);
      const [x1, y1] = point(i + 3);
      out.push({ x0: Math.round(x), y0: Math.round(y), curve: true, cx, cy, x1, y1 });
      [x, y] = [x1, y1];
      i += 5;
    } else if (command === CUBIC) {
      const p3 = point(i + 5);
      cubicSegments(out, [x, y], point(i + 1), point(i + 3), p3);
      [x, y] = p3;
      i += 7;
    } else {
      break;
    }
  }

  for (const s of out) {
    s.cx = Math.round(s.cx);
    s.cy = Math.round(s.cy);
    s.x1 = Math.round(s.x1);
    s.y1 = Math.round(s.y1);
  }

  return out;
}

function writeSegment(w: Writer, s: Segment): void {
  if (s.curve) {
    w.curve(s.cx, s.cy, s.x1, s.y1);
  } else {
    w.line(s.x1, s.y1);
  }
}

/**
 * A fill's contours in the order Flash links its edges back up: one that
 * starts where the last ended follows it, before the rest in their order.
 */
function writeContours(w: Writer, contours: readonly Path[], m: Matrix): void {
  const left = contours.map((c) => segmentsOf(c, m)).filter((c) => c.length);
  while (left.length) {
    let next = left.findIndex((c) => c[0].x0 === w.x && c[0].y0 === w.y);
    if (next < 0) {
      next = 0;
    }

    writeContour(w, left.splice(next, 1)[0]);
  }
}

/**
 * A fill's contour, as Flash keeps it: one left open along a line, which
 * encloses nothing, is dropped; one left open otherwise is closed with a
 * line.
 */
function writeContour(w: Writer, segments: Segment[]): void {
  const first = segments[0];
  const last = segments[segments.length - 1];
  const closed = last.x1 === first.x0 && last.y1 === first.y0;
  if (!closed && !bent(segments)) {
    return;
  }

  w.move(first.x0, first.y0);
  for (const s of segments) {
    writeSegment(w, s);
  }

  if (!closed) {
    w.line(first.x0, first.y0);
  }
}

/** Whether a contour's points, control points too, leave the line through its first two. */
function bent(segments: Segment[]): boolean {
  const x0 = segments[0].x0;
  const y0 = segments[0].y0;
  let dx = 0;
  let dy = 0;
  for (const s of segments) {
    for (const [x, y] of s.curve
      ? [
          [s.cx, s.cy],
          [s.x1, s.y1],
        ]
      : [[s.x1, s.y1]]) {
      if (!dx && !dy) {
        [dx, dy] = [x - x0, y - y0];
      } else if (dx * (y - y0) !== dy * (x - x0)) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Lines thinner than a pixel and a half are a whole pixel or a hairline:
 * adl strokes every line at its width rounded to a whole pixel, half to
 * even, and a line that scales neither way a fifth as wide.
 */
function halfWidth(line: Line): number {
  const pixels = line.width / TWIPS;
  let whole = Math.round(pixels);
  if (Math.abs(pixels % 1) === 0.5 && whole % 2) {
    whole--;
  }

  return line.noHScale && line.noVScale ? whole * 2 : whole * 10;
}

interface Stroked {
  segment: Segment;
  /** The unit directions it leaves its start along and arrives at its end along. */
  t0: [number, number];
  t1: [number, number];
  /** Its sides, offset from it: +n, the normal (ty, -tx) out, and -n. */
  plus: Segment;
  minus: Segment;
}

const unit = (x: number, y: number): [number, number] => {
  const l = Math.hypot(x, y);
  return l ? [x / l, y / l] : [0, 0];
};

/**
 * The outline of a line's path, as Flash builds it to fill: from the end
 * of the first segment's +n side back along it, around the start cap, out
 * along every -n side to the end cap, and back along the +n sides; a path
 * that ends where it starts is two contours instead, its +n sides and its
 * -n sides, joined all around. Joins are drawn on the outer side of a
 * turn, the inner side going straight across; round ones, and round caps,
 * are arcs of at most 45° a quadratic, whose on-curve points lie halfway
 * between their control points in whole twips.
 */
function writeStroke(w: Writer, segments: Segment[], line: Line): void {
  const h = halfWidth(line);
  const hairline = h === 0;
  const parts: Stroked[] = [];
  for (const s of segments) {
    if (s.x0 === s.x1 && s.y0 === s.y1 && (!s.curve || (s.cx === s.x0 && s.cy === s.y0))) {
      continue;
    }

    const t0 =
      s.curve && (s.cx !== s.x0 || s.cy !== s.y0)
        ? unit(s.cx - s.x0, s.cy - s.y0)
        : unit(s.x1 - s.x0, s.y1 - s.y0);
    const t1 =
      s.curve && (s.cx !== s.x1 || s.cy !== s.y1)
        ? unit(s.x1 - s.cx, s.y1 - s.cy)
        : unit(s.x1 - s.x0, s.y1 - s.y0);
    parts.push({
      segment: s,
      t0,
      t1,
      plus: offset(s, t0, t1, h, 1, hairline),
      minus: offset(s, t0, t1, h, -1, hairline),
    });
  }

  if (!parts.length) {
    return;
  }

  const first = parts[0];
  const last = parts[parts.length - 1];
  const closed =
    parts.length > 1 &&
    last.segment.x1 === first.segment.x0 &&
    last.segment.y1 === first.segment.y0;
  const cap = hairline ? 1 : line.startCap;
  const join = hairline ? 1 : line.join;
  const limit = Math.max(1, line.miterLimit);
  // The inner side's joins that go nowhere, which Flash leaves to the end as contours of their own.
  const stray: [number, number][] = [];
  const joinTo = (a: Stroked, b: Stroked, side: 1 | -1, forward: boolean) => {
    const s = a.segment;
    const cross = a.t1[0] * b.t0[1] - a.t1[1] * b.t0[0];
    const from = forward ? (side > 0 ? a.plus : a.minus) : side > 0 ? b.plus : b.minus;
    const to = forward ? (side > 0 ? b.plus : b.minus) : side > 0 ? a.plus : a.minus;
    const [fx, fy] = forward ? [from.x1, from.y1] : [from.x0, from.y0];
    const [tx, ty] = forward ? [to.x0, to.y0] : [to.x1, to.y1];
    const outer = (cross >= 0 ? 1 : -1) === side;
    if (!outer || join === 1) {
      if (!outer && tx === fx && ty === fy) {
        stray.push([tx, ty]);
      } else {
        w.line(tx, ty);
      }

      return;
    }

    // The turn, from a's normal on this side to b's.
    const na: [number, number] = [a.t1[1] * side, -a.t1[0] * side];
    const nb: [number, number] = [b.t0[1] * side, -b.t0[0] * side];
    const turn = Math.atan2(na[0] * nb[1] - na[1] * nb[0], na[0] * nb[0] + na[1] * nb[1]);
    if (join === 0) {
      arc(w, s.x1, s.y1, h, forward ? turn : -turn, tx, ty);
      return;
    }

    const points = miter(s.x1, s.y1, h, a, b, na, nb, Math.abs(turn), limit);
    for (const [x, y] of forward ? points : points.reverse()) {
      w.line(x, y);
    }

    w.line(tx, ty);
  };
  const capAt = (part: Stroked, start: boolean) => {
    const s = part.segment;
    const [x, y] = start ? [s.x0, s.y0] : [s.x1, s.y1];
    const t = start ? part.t0 : part.t1;
    const from = start ? part.plus : part.minus;
    const to = start ? part.minus : part.plus;
    const [fx, fy] = start ? [from.x0, from.y0] : [from.x1, from.y1];
    const [tx, ty] = start ? [to.x0, to.y0] : [to.x1, to.y1];
    if (cap === 0) {
      arc(w, x, y, h, -Math.PI, tx, ty);
    } else if (cap === 2) {
      // The rounded sides moved on by the rounded half width.
      const sign = start ? -1 : 1;
      const dx = Math.round(t[0] * h) * sign;
      const dy = Math.round(t[1] * h) * sign;
      w.line(fx + dx, fy + dy);
      w.line(tx + dx, ty + dy);
      w.line(tx, ty);
    } else {
      w.line(tx, ty);
    }
  };
  const back = (side: Segment) => {
    if (side.curve) {
      w.curve(side.cx, side.cy, side.x0, side.y0);
    } else {
      w.line(side.x0, side.y0);
    }
  };
  const on = (side: Segment) => {
    if (side.curve) {
      w.curve(side.cx, side.cy, side.x1, side.y1);
    } else {
      w.line(side.x1, side.y1);
    }
  };

  w.move(first.plus.x1, first.plus.y1);
  back(first.plus);
  if (closed) {
    joinTo(last, first, 1, false);
  } else {
    capAt(first, true);
    for (let i = 0; i < parts.length; i++) {
      on(parts[i].minus);
      if (i + 1 < parts.length) {
        joinTo(parts[i], parts[i + 1], -1, true);
      }
    }

    capAt(last, false);
  }

  for (let i = parts.length - 1; i > 0; i--) {
    back(parts[i].plus);
    joinTo(parts[i - 1], parts[i], 1, false);
  }

  if (closed) {
    w.move(first.minus.x0, first.minus.y0);
    for (let i = 0; i < parts.length; i++) {
      on(parts[i].minus);
      joinTo(parts[i], parts[(i + 1) % parts.length], -1, true);
    }
  }

  for (const [x, y] of stray) {
    w.move(x, y);
    w.line(x, y);
  }
}

/**
 * A segment's side `sign` (+1 for +n), `h` twips out: its ends moved
 * along their normals rounded to whole twips, a curve's control point
 * where the moved tangents meet. A hairline's sides are the segment and
 * the segment a twip across its run, right or down.
 */
function offset(
  s: Segment,
  t0: [number, number],
  t1: [number, number],
  h: number,
  sign: number,
  hairline: boolean,
): Segment {
  if (hairline) {
    const [ox, oy] = Math.abs(s.x1 - s.x0) >= Math.abs(s.y1 - s.y0) ? [0, 1] : [1, 0];
    const normal = ox * t0[1] - oy * t0[0];
    const k = normal * sign > 0 ? 1 : 0;
    return {
      x0: s.x0 + ox * k,
      y0: s.y0 + oy * k,
      curve: s.curve,
      cx: s.cx + ox * k,
      cy: s.cy + oy * k,
      x1: s.x1 + ox * k,
      y1: s.y1 + oy * k,
    };
  }

  const n0x = Math.round(t0[1] * h) * sign;
  const n0y = Math.round(-t0[0] * h) * sign;
  const n1x = Math.round(t1[1] * h) * sign;
  const n1y = Math.round(-t1[0] * h) * sign;
  const side: Segment = {
    x0: s.x0 + n0x,
    y0: s.y0 + n0y,
    curve: s.curve,
    cx: 0,
    cy: 0,
    x1: s.x1 + n1x,
    y1: s.y1 + n1y,
  };
  if (s.curve) {
    const cross = t0[0] * t1[1] - t0[1] * t1[0];
    if (Math.abs(cross) < 1e-9) {
      side.cx = s.cx + n0x;
      side.cy = s.cy + n0y;
    } else {
      const u = ((side.x1 - side.x0) * t1[1] - (side.y1 - side.y0) * t1[0]) / cross;
      side.cx = Math.round(side.x0 + t0[0] * u);
      side.cy = Math.round(side.y0 + t0[1] * u);
    }
  }

  return side;
}

/**
 * An arc about (`x`, `y`) of radius `r` from the pen, turning `sweep`, to
 * the end (`ex`, `ey`), in quadratics of at most 45° each: control points
 * where the tangents meet, rounded, and the on-curve points between them
 * halfway, in whole twips down. The arc starts toward the pen as rounded,
 * which comes nearer adl's than the exact angle does, but adl's control
 * points still differ from these by a twip at some angles.
 */
function arc(
  w: Writer,
  x: number,
  y: number,
  r: number,
  sweep: number,
  ex: number,
  ey: number,
): void {
  const angle = Math.atan2(w.y - y, w.x - x);
  const pieces = Math.ceil(Math.abs(sweep) / (Math.PI / 4) - 1e-9);
  if (pieces === 0) {
    w.line(ex, ey);
    return;
  }

  const step = sweep / pieces;
  const reach = r / Math.cos(step / 2);
  const controls: [number, number][] = [];
  for (let i = 0; i < pieces; i++) {
    const a = angle + step * (i + 0.5);
    controls.push([Math.round(x + reach * Math.cos(a)), Math.round(y + reach * Math.sin(a))]);
  }

  for (let i = 0; i < pieces; i++) {
    const [cx, cy] = controls[i];
    const next = controls[i + 1];
    if (next) {
      w.curve(cx, cy, Math.floor((cx + next[0]) / 2), Math.floor((cy + next[1]) / 2));
    } else {
      w.curve(cx, cy, ex, ey);
    }
  }
}

/**
 * The points a miter join goes through between its sides: its tip, or
 * where the limit, `limit` half widths out along the bisector, cuts it.
 */
function miter(
  x: number,
  y: number,
  h: number,
  a: Stroked,
  b: Stroked,
  na: [number, number],
  nb: [number, number],
  turn: number,
  limit: number,
): [number, number][] {
  let [bx, by] = unit(na[0] + nb[0], na[1] + nb[1]);
  if (!bx && !by) {
    [bx, by] = unit(a.t1[0] - b.t0[0], a.t1[1] - b.t0[1]);
  }

  const ratio = 1 / Math.cos(turn / 2);
  if (ratio <= limit) {
    return [[Math.round(x + bx * h * ratio), Math.round(y + by * h * ratio)]];
  }

  const reach = limit * h;
  const cut = (px: number, py: number, dx: number, dy: number): [number, number] => {
    const along = dx * bx + dy * by;
    const t = along ? (reach - (px * bx + py * by)) / along : 0;
    return [Math.round(x + px + dx * t), Math.round(y + py + dy * t)];
  };
  return [
    cut(na[0] * h, na[1] * h, a.t1[0], a.t1[1]),
    cut(nb[0] * h, nb[1] * h, -b.t0[0], -b.t0[1]),
  ];
}

/** A stroke's path `at` and the lines closing fills that go on from its end. */
function strokeSegments(
  path: Path,
  closes: { at: number; x: number; y: number }[],
  at: number,
  m: Matrix,
): Segment[] {
  const segments = segmentsOf(path, m);
  for (const close of closes) {
    if (close.at !== at) {
      continue;
    }

    const end = segments.length
      ? [segments[segments.length - 1].x1, segments[segments.length - 1].y1]
      : (() => {
          const [x, y] = apply(m, path[1], path[2]);
          return [Math.round(x * TWIPS), Math.round(y * TWIPS)];
        })();
    const [x, y] = apply(m, close.x, close.y);
    segments.push({
      x0: end[0],
      y0: end[1],
      curve: false,
      cx: 0,
      cy: 0,
      x1: Math.round(x * TWIPS),
      y1: Math.round(y * TWIPS),
    });
  }

  return segments;
}

/**
 * The layers' data, as seen through `m`, onto `out`. `defaults` holds the
 * gradients beginGradientFill was given no matrix for.
 */
export function graphicsData(
  layers: readonly ShapeLayer[],
  m: Matrix,
  defaults: WeakSet<Paint>,
  out: GraphicsDatum[],
): void {
  for (const layer of layers) {
    for (const fill of layer.fills) {
      const w = new Writer();
      writeContours(w, fill.contours, m);

      if (w.commands.length) {
        out.push(datumOf(fill.fill, m, defaults));
        out.push({ type: "path", winding: fill.winding, commands: w.commands, data: w.data });
        out.push({ type: "end" });
      }
    }

    for (const stroke of layer.strokes) {
      for (const [i, path] of stroke.paths.entries()) {
        const w = new Writer();
        writeStroke(w, strokeSegments(path, stroke.closes ?? [], i, m), stroke.line);
        if (w.commands.length) {
          out.push({ type: "solid", ...storedColor(stroke.line.color) });
          out.push({ type: "path", winding: "nonZero", commands: w.commands, data: w.data });
          out.push({ type: "end" });
        }
      }
    }
  }
}
