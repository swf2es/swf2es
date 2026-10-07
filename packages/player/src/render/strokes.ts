// A shape's lines, which unlike its fills depend on the transform they are
// seen through: stroked in that space at Flash's width, and shared by the
// instances that see a layer through the same linear transform.
import type { Line } from "@swf2es/format";
import { type GraphicsContext, Matrix } from "pixi.js";
import { blendLayers, droppedLayers } from "../display/morph.js";
import { LINE, type Path, pointsOf, type ShapeLayer } from "../display/shapes.js";
import { IDLE_MOST, IDLE_MS } from "./pools.js";
import { destroyContext, shapeContext, trace } from "./tessellate.js";

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
 * The context a line's Graphics shows until restroke gives it its own: one
 * for all, never given back nor destroyed, where each made one of its own
 * to throw away.
 */
export const NO_LINES = shapeContext();

/**
 * A layer's lines as seen through `m`, drawn in its space so that their
 * width is even; as wide as `by` makes them, which is `m` but for a 9-slice's.
 */
function strokeContext(layer: ShapeLayer, m: Linear, least: number, by = m): GraphicsContext {
  const context = shapeContext();
  for (const { line, paths, closes } of layer.strokes) {
    context.beginPath();
    let next = 0;
    for (const [i, path] of paths.entries()) {
      const close = closes?.[next]?.at === i ? closes[next++] : null;
      // Back to the path's start, a closed path, joined there as Flash joins it.
      const home = close?.x === path[1] && close.y === path[2];
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
 * IDLE_MS or, the oldest first, past IDLE_MOST. Only a character's layers
 * are shared, which never change, and a blend's while its morph keeps it:
 * one it has dropped is never drawn from again, so its lines go at once.
 */
export class StrokeContexts {
  private readonly byLayer = new WeakMap<ShapeLayer, Map<string, GraphicsContext>>();
  private readonly uses = new Map<GraphicsContext, number>();
  private readonly keys = new Map<GraphicsContext, [ShapeLayer, string]>();
  /** Contexts no one holds, oldest first, with the time each went idle. */
  private readonly idle = new Map<GraphicsContext, number>();
  /** The idle ones of blends, which go as soon as their morph drops the blend. */
  private readonly idleBlends = new Set<GraphicsContext>();

  constructor(private readonly counts: { strokeContexts: number; strokeReuses: number }) {}

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
      this.idle.delete(context);
      this.idleBlends.delete(context);
    } else {
      context = linesContext(layer, m, least);
      this.counts.strokeContexts++;
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

    this.idle.set(context, performance.now());
    if (blendLayers.has(layer)) {
      this.idleBlends.add(context);
    }

    if (this.idle.size > IDLE_MOST) {
      this.drop(this.idle.keys().next().value as GraphicsContext);
    }
  }

  /** A frame prepared: the contexts idle too long go, and those of blends their morph dropped. */
  tick(): void {
    for (const context of this.idleBlends) {
      if (droppedLayers.has((this.keys.get(context) as [ShapeLayer, string])[0])) {
        this.drop(context);
      }
    }

    const now = performance.now();
    for (const [context, since] of this.idle) {
      if (now - since < IDLE_MS) {
        break;
      }

      this.drop(context);
    }
  }

  private drop(context: GraphicsContext): void {
    this.idle.delete(context);
    this.idleBlends.delete(context);
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

/** Whether every line of the layer scales both ways, whose width no rotation changes; one scaled one way alone turns with it. */
export function scalesEvenly(layer: ShapeLayer): boolean {
  return layer.strokes.every(({ line }) => !line.noHScale && !line.noVScale);
}

/** A layer's lines seen through `m`, nothing where `m` flattens them. */
export function linesContext(layer: ShapeLayer, m: Linear, least: number, by = m): GraphicsContext {
  // Empty, drawn alone as every shape's are: one batched would get no
  // instruction till its group rebuilt.
  return m[0] * m[3] - m[1] * m[2] === 0 ? shapeContext() : strokeContext(layer, m, least, by);
}
