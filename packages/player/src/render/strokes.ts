// A shape's lines, which unlike its fills depend on the transform they are
// seen through: stroked in that space at Flash's width, and shared by the
// instances that see a layer through the same linear transform.
import type { Line } from "@swf2es/format";
import { type GraphicsContext, Matrix } from "pixi.js";
import { blendLayers, droppedBlends, droppedLayers } from "../display/morph.js";
import { LINE, type Path, pointsOf, type ShapeLayer } from "../display/shapes.js";
import {
  type DeviceMemory,
  deviceMemory,
  IdleBudget,
  LINES_IDLE_MOST,
  LINES_IDLE_MS,
  LINES_IDLE_VERTICES,
  linesCeiling,
} from "./pools.js";
import { destroyContext, remakeable, shapeContext, trace, verticesOf } from "./tessellate.js";

/** The linear part of a matrix, [a, b, c, d]: all a stroke's width depends on. */
export type Linear = [number, number, number, number];

export const UNIT: Linear = [1, 0, 0, 1];

export function sameLinear(p: Linear, q: Linear): boolean {
  return p[0] === q[0] && p[1] === q[1] && p[2] === q[2] && p[3] === q[3];
}

/**
 * A line's width on the stage. Flash strokes a transformed shape with one
 * width all along, not the local width stretched by the transform: the
 * width scaled by the transform's (a + c, b + d) as a line's scale mode
 * allows, never under `least`, a pixel of the screen it is shown on, which
 * is also how wide a hairline is.
 */
function screenWidth(line: Line, m: Linear, least: number): number {
  const sx = Math.abs(m[0] + m[2]);
  const sy = Math.abs(m[1] + m[3]);
  const scale = line.noHScale
    ? line.noVScale
      ? 1
      : sy
    : line.noVScale
      ? sx
      : Math.sqrt((sx * sx + sy * sy) / 2);
  return Math.max(least, (line.width / 20) * scale);
}

function stroke(line: Line, m: Linear, least: number): Parameters<GraphicsContext["stroke"]>[0] {
  const caps = ["round", "butt", "square"] as const;
  const joins = ["round", "bevel", "miter"] as const;
  return {
    width: screenWidth(line, m, least),
    color: line.color & 0xffffff,
    alpha: (line.color >>> 24) / 255,
    cap: caps[line.startCap] ?? "round",
    join: joins[line.join] ?? "round",
    miterLimit: line.miterLimit,
    alignment: 0.5,
  };
}

function transformPath(path: Path, m: Linear): Path {
  const out = path.slice();
  for (let i = 0; i < out.length; ) {
    const points = pointsOf(out[i]);
    for (let k = 0; k < points; k++) {
      const x = out[i + 1 + 2 * k];
      const y = out[i + 2 + 2 * k];
      out[i + 1 + 2 * k] = m[0] * x + m[2] * y;
      out[i + 2 + 2 * k] = m[1] * x + m[3] * y;
    }

    i += 1 + 2 * points;
  }

  return out;
}

/**
 * The context a line's Graphics shows until restroke gives it its own, and
 * a drawing's layer of no fills: one for all, never given back nor
 * destroyed, where each made one of its own to throw away.
 */
export const NO_LINES = shapeContext();

/**
 * A layer's lines as seen through `m`, drawn in its space so that their
 * width is even; as wide as `by` makes them, which is `m` but for a 9-slice's.
 */
function strokeContext(layer: ShapeLayer, m: Linear, least: number, by = m): GraphicsContext {
  const context = shapeContext();
  for (const { line, paths, closes, triangles } of layer.strokes) {
    context.beginPath();
    let next = 0;
    for (const [i, path] of paths.entries()) {
      const close = closes?.[next]?.at === i ? closes[next++] : null;
      // Back to the path's start, a closed path, joined there as Flash joins it; a triangle's
      // outline is, its last point its first, which Pixi drops.
      const home = triangles || (close?.x === path[1] && close.y === path[2]);
      trace(context, transformPath(close && !home ? [...path, LINE, close.x, close.y] : path, m));
      if (home) {
        context.closePath();
      }
    }

    context.stroke(stroke(line, by, least));
  }

  return context;
}

/**
 * Lines' contexts by shape layer and the linear transform they are seen
 * through, shared by every instance that sees a character's layer alike:
 * instances of one creature in step, or one instance on its loop's next
 * turn. Contexts are counted as they are taken and given back, a removed
 * object's too; one no longer taken waits among the idle, destroyed after
 * LINES_IDLE_MS or, the oldest first, past the budget of their vertices,
 * which grows from LINES_IDLE_VERTICES as content comes back to what it
 * let go (IdleBudget), or past as many of them, LINES_IDLE_MOST for that
 * budget's least and more for more. Only a character's layers
 * are shared, which never change, and a blend's while its morph keeps it:
 * one it has dropped is never drawn from again, so its lines go at once.
 */
export class StrokeContexts {
  private readonly byLayer = new WeakMap<ShapeLayer, Map<string, GraphicsContext>>();
  private readonly uses = new Map<GraphicsContext, number>();
  private readonly keys = new Map<GraphicsContext, [ShapeLayer, string]>();
  /** Contexts no one holds, oldest first, with the time each went idle. */
  private readonly idle = new Map<GraphicsContext, number>();
  /** The idle ones' vertices as they went idle, and their sum. */
  private readonly idleSizes = new Map<GraphicsContext, number>();
  private idleVertices = 0;
  /** How many vertices the idle may hold, grown as content comes back to what went for room. */
  readonly budget: IdleBudget;
  /** Each layer's number, for the budget's keys, which must hold no layer. */
  private readonly layerIds = new WeakMap<ShapeLayer, number>();
  private layerCount = 0;
  /** The idle ones of blends, which go as soon as their morph drops the blend. */
  private readonly idleBlends = new Set<GraphicsContext>();
  /** droppedBlends() when the idle blends were last looked at. */
  private blendsDropped = droppedBlends();

  constructor(
    private readonly counts: { strokeContexts: number; strokeReuses: number },
    device: DeviceMemory = deviceMemory(),
  ) {
    this.budget = new IdleBudget(
      LINES_IDLE_VERTICES,
      linesCeiling(device),
      LINES_IDLE_MS,
      4 * LINES_IDLE_MOST,
    );
  }

  /** Content unloaded: the budget back to its floor, the unloaded content's idle lines going on the next tick. */
  unloaded(): void {
    this.budget.reset();
  }

  /** The layer's lines under `key` if they are kept, not taken: for a view drawn once to borrow. */
  peek(layer: ShapeLayer, key: string): GraphicsContext | null {
    return this.byLayer.get(layer)?.get(key) ?? null;
  }

  /** The layer's lines seen through `m`, taken: made or found. */
  take(layer: ShapeLayer, m: Linear, least: number, key = linesKey(m, least)): GraphicsContext {
    let contexts = this.byLayer.get(layer);
    if (!contexts) {
      contexts = new Map();
      this.byLayer.set(layer, contexts);
    }

    let context = contexts.get(key);
    if (context) {
      this.counts.strokeReuses++;
      this.wake(context);
    } else {
      context = linesContext(layer, m, least);
      this.counts.strokeContexts++;
      if (this.budget.remembered > 0) {
        this.budget.missed(this.ghostKey(layer, key), performance.now());
      }

      contexts.set(key, context);
      this.keys.set(context, [layer, key]);
    }

    this.uses.set(context, (this.uses.get(context) ?? 0) + 1);
    return context;
  }

  /** Give a context back: one of these goes idle when no one holds it; any other is destroyed. */
  give(context: GraphicsContext): void {
    if (context === NO_LINES) {
      return;
    }

    const uses = this.uses.get(context);
    if (uses === undefined) {
      destroyContext(context);
      return;
    }

    if (uses > 1) {
      this.uses.set(context, uses - 1);
      return;
    }

    this.uses.delete(context);
    const layer = (this.keys.get(context) as [ShapeLayer, string])[0];
    if (droppedLayers.has(layer)) {
      this.drop(context);
      return;
    }

    const vertices = verticesOf(context);
    this.idle.set(context, performance.now());
    this.idleSizes.set(context, vertices);
    this.idleVertices += vertices;
    if (blendLayers.has(layer)) {
      this.idleBlends.add(context);
    }

    this.trim();
  }

  /** A frame prepared: the contexts idle too long go, and those of blends their morph dropped. */
  tick(): void {
    const dropped = droppedBlends();
    if (dropped !== this.blendsDropped) {
      this.blendsDropped = dropped;
      for (const context of this.idleBlends) {
        if (droppedLayers.has((this.keys.get(context) as [ShapeLayer, string])[0])) {
          this.drop(context);
        }
      }
    }

    const now = performance.now();
    for (const [context, since] of this.idle) {
      if (now - since < LINES_IDLE_MS) {
        break;
      }

      this.drop(context);
    }

    this.budget.tick(now);
    this.trim();
  }

  /** The oldest idle let go, their keys remembered, till the rest are within the budget. */
  private trim(): void {
    const budget = this.budget.size;
    const most = (LINES_IDLE_MOST * budget) / LINES_IDLE_VERTICES;
    while (this.idle.size > most || this.idleVertices > budget) {
      const [context, since] = this.idle.entries().next().value as [GraphicsContext, number];
      const [layer, key] = this.keys.get(context) as [ShapeLayer, string];
      // At least a context's share of the least budget: one let go for their count grows it too.
      const size = Math.max(
        this.idleSizes.get(context) ?? 0,
        LINES_IDLE_VERTICES / LINES_IDLE_MOST,
      );
      this.budget.evicted(this.ghostKey(layer, key), since, size);
      this.drop(context);
    }
  }

  private ghostKey(layer: ShapeLayer, key: string): string {
    let id = this.layerIds.get(layer);
    if (id === undefined) {
      id = this.layerCount++;
      this.layerIds.set(layer, id);
    }

    return `${id}:${key}`;
  }

  /** Take a context off the idle, if it is there. */
  private wake(context: GraphicsContext): void {
    this.idleVertices -= this.idleSizes.get(context) ?? 0;
    this.idleSizes.delete(context);
    this.idle.delete(context);
    this.idleBlends.delete(context);
  }

  private drop(context: GraphicsContext): void {
    this.wake(context);
    const [layer, key] = this.keys.get(context) as [ShapeLayer, string];
    this.keys.delete(context);
    this.byLayer.get(layer)?.delete(key);
    destroyContext(context);
  }
}

/** The key a layer's lines seen through `m`, at least `least` wide, are kept by. */
function linesKey(m: Linear, least: number): string {
  return `${m[0]},${m[1]},${m[2]},${m[3]},${least}`;
}

/** Lines stroked through `m`: the key they are kept by, and the inverse that takes them back to the object's axes. */
export function strokeFrame(
  m: Linear,
  least: number,
): { m: Linear; key: string; inverse: Matrix | null } {
  const det = m[0] * m[3] - m[1] * m[2];
  return {
    m,
    key: linesKey(m, least),
    inverse: det === 0 ? null : new Matrix(m[3] / det, -m[1] / det, -m[2] / det, m[0] / det, 0, 0),
  };
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

/** A layer's lines seen through `m`, nothing where `m` flattens them. */
export function linesContext(layer: ShapeLayer, m: Linear, least: number, by = m): GraphicsContext {
  // Empty, drawn alone as every shape's are: one batched would get no
  // instruction till its group rebuilt.
  if (m[0] * m[3] - m[1] * m[2] === 0) {
    return shapeContext();
  }

  // A view's alone, whose renderer builds it once: its paths go then. The
  // transforms copied, as a caller may reuse its arrays.
  const seen: Linear = [m[0], m[1], m[2], m[3]];
  const width: Linear = [by[0], by[1], by[2], by[3]];
  const make = () => strokeContext(layer, seen, least, width);
  return remakeable(make(), make);
}
