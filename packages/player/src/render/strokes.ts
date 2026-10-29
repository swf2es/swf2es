// A shape's lines, which unlike its fills depend on the transform they are
// seen through: stroked in that space at Flash's width, and shared by the
// instances that see a layer through the same linear transform.
import type { Line } from "@swf2es/format";
import { type GraphicsContext, Matrix } from "pixi.js";
import { blendLayers, droppedBlends, droppedLayers } from "../display/morph.js";
import type { ShapeLayer } from "../display/shapes.js";
import type { Linear } from "../display/stretch.js";
import { strokePaths, strokeWidth, transformedPath } from "../scene/strokes.js";
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

export {
  evenWidth,
  type Linear,
  sameLinear,
  scalesEvenly,
  settledStretch,
  stretchOf,
  UNIT,
  widestLine,
} from "../display/stretch.js";

function strokeStyle(
  line: Line,
  m: Linear,
  least: number,
): Parameters<GraphicsContext["stroke"]>[0] {
  const caps = ["round", "butt", "square"] as const;
  const joins = ["round", "bevel", "miter"] as const;
  return {
    width: strokeWidth(line, m[0], m[1], m[2], m[3], least),
    color: line.color & 0xffffff,
    alpha: (line.color >>> 24) / 255,
    cap: caps[line.startCap] ?? "round",
    join: joins[line.join] ?? "round",
    miterLimit: line.miterLimit,
    alignment: 0.5,
  };
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
  for (const stroke of layer.strokes) {
    context.beginPath();
    // A path back at its start is closed and joined there (scene/strokes.ts, strokePaths).
    for (const { path, home } of strokePaths(stroke)) {
      trace(context, transformedPath(path, m[0], m[1], m[2], m[3]));
      if (home) {
        context.closePath();
      }
    }

    context.stroke(strokeStyle(stroke.line, by, least));
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
