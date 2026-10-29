// A line's stretch: the part of a transform, without its turn or mirror,
// that a line scaled both ways is as wide through as through the whole,
// settled on a grid, so that lines stroked through it are shared by every
// angle and instance and taken back through its inverse. Both views stroke
// lines so (render/strokes.ts, scene/view.ts).
import type { ShapeLayer } from "./shapes.js";

/** The linear part of a matrix, [a, b, c, d]: all a stroke's width depends on. */
export type Linear = [number, number, number, number];

export const UNIT: Linear = [1, 0, 0, 1];

export function sameLinear(p: Linear, q: Linear): boolean {
  return p[0] === q[0] && p[1] === q[1] && p[2] === q[2] && p[3] === q[3];
}

/**
 * `m`'s stretch, without its turn or mirror: m is a rotation or a mirror
 * times this symmetric stretch, and a line scaled both ways is as wide
 * through either (screenWidth reads |m's columns' sum|, which no rotation
 * changes), so its lines are the same stroked through the stretch alone
 * and then turned. A limb that turns on every frame of a loop, a spinning
 * particle squashed one way, every mirror and every instance alike then
 * share the lines of one context, where each angle was tessellated anew.
 * Rounded, so that one stretch has one key however its turn rounded it;
 * null where m flattens everything, or nearly, where rounding would.
 */
export function stretchOf(m: Linear, out?: Linear): Linear | null {
  const a = m[0];
  const b = m[1];
  const c = m[2];
  const d = m[3];
  // S = sqrt(mᵀm), in closed form for 2 by 2.
  const p = a * a + b * b;
  const q = c * c + d * d;
  const r = a * c + b * d;
  const det = Math.abs(a * d - b * c);
  const t = Math.sqrt(p + q + 2 * det);
  if (det === 0 || t === 0) {
    return null;
  }

  const off = roundStretch(r, t);
  const a2 = roundStretch(p + det, t);
  const d2 = roundStretch(q + det, t);
  // Near collapse, a scale of a few 65536ths rounds away, and the lines with it.
  const rounded = Math.abs(a2 * d2 - off * off);
  if (Math.abs(rounded - det) > 1e-3 * det) {
    return null;
  }

  // Into `out` where given: a turn each frame then makes no array to compare.
  const stretch = out ?? [0, 0, 0, 0];
  stretch[0] = a2;
  stretch[1] = off;
  stretch[2] = off;
  stretch[3] = d2;
  return stretch;
}

const roundStretch = (x: number, t: number) => Math.round((x / t) * 65536) / 65536;

/**
 * How far, in pixels of the screen, a line's edge may stand from where its
 * own stretch puts it when stroked through a nearby one on the grid
 * (settledStretch): a twentieth of a pixel, a twip, for a hairline, whose
 * width the stretch does not change; a wider line's width moves with the
 * stretch as well as its stroke, and its edges up to twice as far. A
 * fiftieth gave a hairline a step of 1/64 of its scale, and a crowded
 * room's hairlines, scaled a little more or less on each frame by their
 * tweens, a stretch of their own on most frames: nine in ten lines stroked
 * anew each frame were such hairlines.
 */
const EDGE_SLACK = 0.05;
/**
 * How far, in pixels of the screen, a line's edge may stand from its own
 * stretch's place when stroked through an even one (settledStretch): two
 * twips, a tenth of a pixel. A part that turns inside a parent scaled a
 * little unevenly, as a limb in a squashed body, has a stretch that turns
 * with it, a new one each frame, and its lines were tessellated each frame;
 * stroked through one even scale, every angle shares them.
 */
const EVEN_SLACK = 0.1;
/** The coarsest step of the stretches' grid, a hairline's: about 6% of a scale. */
const COARSEST_STEP = 1 / 16;
/** The finest: a line wider than this allows is stroked through its own stretch. */
const FINEST_STEP = 1 / 4096;

/**
 * The stretch `s` (stretchOf's, symmetric with a positive determinant)
 * moved to the nearest point of a grid, `widest` the width of its widest
 * line in twips and `least` a pixel of the screen; or `s` itself. A tween
 * that scales a little on every frame, a character that breathes, gave
 * each frame a stretch of its own, and its lines were tessellated again
 * on every frame of every loop, faster than the cache could keep them; the
 * grid gives such a pulse a few. Lines stroked through the grid's stretch
 * and taken back through its inverse (strokeFrame) follow the shape's path
 * exactly; only their width and joins see the small difference between
 * the two stretches, s q⁻¹'s from the identity, which the grid keeps under
 * EDGE_SLACK of a pixel at their edges. The grid is on the stretch's
 * logarithm, a symmetric matrix whose entries measure scale and shear
 * alike, in a step that is a power of two, so that stretches settled alike
 * share their contexts; one it would move further than a step, as it may
 * one that squashes nearly flat, is its own.
 */
export function settledStretch(s: Linear, widest: number, least: number, out?: Linear): Linear {
  // s = mean I + N, N = [[half, off], [off, -half]], N² = r² I: its scales are mean ± r, along
  // the axes P± = (I ± N / r) / 2 project on.
  const mean = (s[0] + s[3]) / 2;
  const half = (s[0] - s[3]) / 2;
  const off = s[1];
  const r = Math.sqrt(half * half + off * off);
  if (!(mean - r > 0)) {
    return s;
  }

  // Nearly even: stroked through the even stretch of the same area, k, which no turn changes,
  // and taken back through its inverse, a line is as wide as k makes it times what s q⁻¹ = s / k
  // stretches each way, between the smaller scale over k and the larger. Through s itself it is
  // one width all along, somewhere in that span as screenWidth reads s at its angle; its edges
  // share the difference, which must stay within the slack at every angle, so that a part
  // turning does not flip between the even stretch and its own. A hairline, a pixel wide however
  // small its scale, stretches with s / k as any line: a part squashed far keeps its own.
  if (r > 0) {
    const k = Math.sqrt((mean + r) * (mean - r));
    const stroked = Math.max(least, (widest / 20) * k);
    if ((stroked * 2 * r) / k <= 2 * EVEN_SLACK * least) {
      const even = out ?? [0, 0, 0, 0];
      even[0] = k;
      even[1] = 0;
      even[2] = 0;
      even[3] = k;
      return settledStretch(even, widest, least, even);
    }
  }

  // Half the widest line's width on the screen, at most as the larger scale makes it, times the
  // step must stay under the slack.
  const width = Math.max(least, (widest / 20) * (mean + r));
  const most = Math.min(COARSEST_STEP, (2 * EDGE_SLACK * least) / width);
  if (!(most >= FINEST_STEP)) {
    return s;
  }

  const step = 2 ** Math.floor(Math.log2(most));
  // Its logarithm, ln(mean + r) P+ + ln(mean - r) P-, is α I + β N; its entries go on the grid.
  const large = Math.log(mean + r);
  const small = Math.log(mean - r);
  const alpha = (large + small) / 2;
  const beta = r === 0 ? 1 / mean : (large - small) / (2 * r);
  const l11 = Math.round((alpha + beta * half) / step) * step;
  const l22 = Math.round((alpha - beta * half) / step) * step;
  const l12 = Math.round((beta * off) / step) * step;
  // And back: the grid's α' I + N', N'² = ρ² I, is e^(α' + ρ) P'+ + e^(α' - ρ) P'-.
  const h = (l11 - l22) / 2;
  const rho = Math.sqrt(h * h + l12 * l12);
  const up = Math.exp((l11 + l22) / 2 + rho);
  const down = Math.exp((l11 + l22) / 2 - rho);
  const across = rho === 0 ? 0 : (up - down) / (2 * rho);
  const q0 = (up + down) / 2 + across * h;
  const q1 = across * l12;
  const q3 = (up + down) / 2 - across * h;
  // s q⁻¹ near the identity, within a step by its norm, the most it stretches any direction: the
  // edges, half the widest line from the path, within the slack of their place. (Each entry
  // within a step alone let an edge stray to nearly twice that, 0.036 of a pixel measured.)
  const qDet = q0 * q3 - q1 * q1;
  const e0 = (s[0] * q3 - s[2] * q1) / qDet;
  const e1 = (s[1] * q3 - s[3] * q1) / qDet;
  const e2 = (s[2] * q0 - s[0] * q1) / qDet;
  const e3 = (s[3] * q0 - s[1] * q1) / qDet;
  // The spectral norm of D = s q⁻¹ - I: the root of the larger eigenvalue of DᵀD.
  const d0 = e0 - 1;
  const d3 = e3 - 1;
  const frobenius = d0 * d0 + e1 * e1 + e2 * e2 + d3 * d3;
  const det = d0 * d3 - e1 * e2;
  const norm = Math.sqrt(
    (frobenius + Math.sqrt(Math.max(0, frobenius * frobenius - 4 * det * det))) / 2,
  );
  if (!(norm <= step)) {
    return s;
  }

  // Into `out` where given, which may be `s`, as stretchOf's: a move each frame then makes no
  // array to compare.
  const q = out ?? [0, 0, 0, 0];
  q[0] = q0;
  q[1] = q1;
  q[2] = q1;
  q[3] = q3;
  return q;
}

/** The width of the layer's widest line, in twips. */
export function widestLine(layer: ShapeLayer): number {
  let widest = 0;
  for (const { line } of layer.strokes) {
    widest = Math.max(widest, line.width);
  }

  return widest;
}

/** Whether every line of the layer scales both ways, whose width no rotation changes; one scaled one way alone turns with it. */
export function scalesEvenly(layer: ShapeLayer): boolean {
  return layer.strokes.every(({ line }) => !line.noHScale && !line.noVScale);
}
