// A shape's fills as Pixi GraphicsContexts: its contours traced, curves
// flattened finely enough for Flash's, and filled even-odd or non-zero from
// their containment tree or crossing spans (scene/fills.ts); and the cache
// sharing instances.
import type { Fill } from "@swf2es/format";
import { type FillInput, GraphicsContext } from "pixi.js";
import type { Region as Area } from "../display/gradients.js";
import { blendLayers, droppedBlends, droppedLayers } from "../display/morph.js";
import { orientation, type Paint, type ShapeLayer } from "../display/shapes.js";
import type { ShapeCharacter } from "../display/timeline.js";
import {
  containment,
  type FillTessellator,
  polygonsOf,
  type Region,
  type ResolvedFill,
  regionOf,
  resolveFills,
  trace,
} from "../scene/fills.js";
import { takeBatchedCopy, weigh } from "./color.js";
import { crossingFill } from "./fill-polygons.js";
import {
  type DeviceMemory,
  deviceMemory,
  FILLS_IDLE_MOST,
  FILLS_IDLE_MS,
  FILLS_IDLE_VERTICES,
  IdleBudget,
  linesCeiling,
} from "./pools.js";

export { type FillTessellator, type ResolvedFill, resolveFills, trace };

/**
 * A fill's paint, but a resolved bitmap's, which the view gives: a solid
 * colour; a gradient as its first colour, for now; and a bitmap fill of a
 * bitmap the SWF lacks red, as Flash draws one.
 */
export function paint(fill: Fill): { color: number; alpha: number } {
  const argb =
    fill.type === "solid"
      ? fill.color
      : fill.type === "bitmap"
        ? 0xffff0000
        : (fill.gradient.stops[0]?.color ?? 0xff000000);
  return { color: argb & 0xffffff, alpha: (argb >>> 24) / 255 };
}

/** How a view paints a fill over a region of the shape: a resolved bitmap's or gradient's through its renderer's textures. */
export type Painter = (
  fill: Paint,
  region: () => Area,
  hold: (release: () => void) => void,
) => FillInput;

/** What each fill context holds of the textures its gradients use, given back as it is destroyed. */
const holds = new WeakMap<GraphicsContext, (() => void)[]>();

/** A context destroyed, the textures it held given back first: a fill's, or lines', which hold none. */
export function destroyContext(context: GraphicsContext): void {
  for (const release of holds.get(context) ?? []) {
    release();
  }

  holds.delete(context);
  const copy = takeBatchedCopy(context);
  if (copy) {
    destroyContext(copy);
  }

  context.destroy();
}

/**
 * A context for a shape's fills or lines, drawn on its own, not batched.
 * A batch holds its vertices on the stage, so Pixi repacks and uploads
 * them all again whenever anything in the render group changes structure,
 * as a timeline does on most frames; and between batches and the large
 * shapes Pixi draws alone anyway it switches programs. Alone, a shape's
 * geometry is uploaded once and only its transform changes. A render
 * group that settles draws batched copies instead (settle).
 */
export function shapeContext(): GraphicsContext {
  const context = new GraphicsContext();
  context.batchMode = "no-batch";
  return context;
}

/**
 * How to make again each context of a view's whose paths go once Pixi has
 * built it (remakeable), for what needs them after: its batched copy.
 */
const makers = new WeakMap<GraphicsContext, () => GraphicsContext>();

/**
 * Have `context`'s paths go altogether once Pixi has built it, `make`
 * making it anew for a copy (copyContext): a view's fills and lines, which
 * that view's renderer alone builds, from layers their shape keeps anyway.
 * Pixi's collection of what went unused for a minute is kept off it, as
 * it would build the context again from its paths: its tessellation stays
 * while it lives, which the view destroys once idle. A glyph's fill, which
 * every view shares, keeps its paths for each renderer to build.
 */
export function remakeable(context: GraphicsContext, make: () => GraphicsContext): GraphicsContext {
  context.autoGarbageCollect = false;
  makers.set(context, make);
  return context;
}

/** A context to draw as `context` does: made anew if its paths may be gone, as remakeable's are, else a clone. */
export function copyContext(context: GraphicsContext): GraphicsContext {
  const make = makers.get(context);
  return make ? remakeable(make(), make) : context.clone();
}

/**
 * Let go of what a context's paths hold once Pixi has built it
 * (render/hooks.ts). A remakeable context's go whole, its bounds measured
 * and its vertices weighed first (render/color.ts), as nothing reads them
 * again: Pixi draws it from its tessellation, and a copy is made anew. In
 * a crowd of 200 characters (bench.ts --town 200), their flattened points
 * held some 8 MB. Any other's keep the shapes they were flattened to,
 * which is all Pixi reads of them again: to build the context again, as a
 * lost context or Pixi's collection of what went unused for a minute has
 * it, to measure its bounds, and to hit test it; their commands go, which
 * a crowded room's contexts kept some 120 MB of, an object and an array
 * for each segment. Every context of the player is made whole before it
 * is first built, and none is changed after.
 */
export function forgetCommands(context: GraphicsContext): void {
  if (makers.has(context)) {
    weigh(context);
    context.releasePaths();
    return;
  }

  for (const instruction of context.instructions) {
    if (instruction.action !== "texture" && instruction.action !== "geometry") {
      instruction.data.path.releaseInstructions();
      instruction.data.hole?.releaseInstructions();
    }
  }
}

/**
 * A layer's fills, which are the same for every instance of the shape.
 * Each contour's region is inside or not by the fill's rule, by its depth
 * in the containment for even-odd, by the sum of orientations around it
 * for non-zero: a region inside where its parent is not is filled, with
 * the first regions below it that are not cut out as holes, and so on in.
 */
export function fillContext(
  layer: ShapeLayer,
  painter: Painter,
  masking = false,
  resolved?: readonly ResolvedFill[],
): GraphicsContext {
  const context = shapeContext();
  const held: (() => void)[] = [];
  holds.set(context, held);
  for (let i = 0; i < layer.fills.length; i++) {
    const { fill, contours, winding } = layer.fills[i];
    const plan = resolved?.[i];
    // The region is a radial gradient's alone to need: flattening the contours is not free.
    const style = painter(
      fill,
      () => regionOf(contours),
      (release) => held.push(release),
    );
    if (plan?.geometry) {
      context.fillGeometry(plan.geometry, style);
      continue;
    }

    const polygons = plan ? [] : polygonsOf(contours);
    // A Graphics drawing used as a mask uses non-zero even when drawPath asked for even-odd.
    const nonZero = masking || winding === "nonZero";
    const crossing = plan ? plan.crossing : crossingFill(polygons, nonZero);
    if (crossing) {
      context.beginPath();
      for (const points of crossing) {
        context.poly(points, true);
      }

      context.fill(style);
      continue;
    }

    const inside = (depth: number, sum: number) => (nonZero ? sum !== 0 : depth % 2 === 0);
    // A region's holes are cut together, then the islands in them filled.
    // Pixi's cut() goes to the fill before the last too once the last has a
    // hole, so a second cut, or one after an island, would land a hole in
    // another region, which then fills across to it.
    const fillRegion = (region: Region, depth: number, sum: number) => {
      context.beginPath();
      context.poly(region.points, true).fill(style);

      const cut: [Region, number, number][] = [];
      holes(region, depth, sum, cut);
      if (cut.length === 0) {
        return;
      }

      context.beginPath();
      for (const [hole] of cut) {
        context.poly(hole.points, true);
      }

      context.cut();

      for (const [hole, d, s] of cut) {
        islands(hole, d, s);
      }
    };
    const holes = (region: Region, depth: number, sum: number, cut: [Region, number, number][]) => {
      for (const child of region.children) {
        const s = sum + orientation(child.points);
        if (inside(depth + 1, s)) {
          holes(child, depth + 1, s, cut);
        } else {
          cut.push([child, depth + 1, s]);
        }
      }
    };
    const islands = (region: Region, depth: number, sum: number) => {
      for (const child of region.children) {
        const s = sum + orientation(child.points);
        if (inside(depth + 1, s)) {
          fillRegion(child, depth + 1, s);
        } else {
          islands(child, depth + 1, s);
        }
      }
    };
    for (const root of plan ? plan.roots : containment(polygons)) {
      const s = orientation(root.points);
      if (inside(0, s)) {
        fillRegion(root, 0, s);
      } else {
        islands(root, 0, s);
      }
    }
  }

  return context;
}

/**
 * The vertices Pixi tessellated a context into, for each renderer that drew
 * it: what keeping it costs.
 */
export function verticesOf(context: GraphicsContext): number {
  const data = context._gpuData;
  let vertices = 0;
  for (const uid in data) {
    vertices += (data[uid]?.geometryData?.vertices.length ?? 0) / 2;
  }

  return vertices;
}

/**
 * A shape's fills, or a morph's blend's, shared by every instance drawn
 * alike: a crowd in step, a pool's objects, and a timeline that places a
 * shape or a morph at a ratio again tessellate each once. Counted as nodes
 * take and give them back; one no one holds goes after FILLS_IDLE_MS, or
 * sooner, oldest first, past the idle's budget of vertices (IdleBudget),
 * or a blend as its morph drops it, which is then never drawn from again.
 * Kept for as long as a shape lived, every shape a long session had shown
 * held its fills, their geometry and their coloured copies: hundreds of MB.
 */
export class SharedFills {
  private readonly held = new Map<ShapeCharacter, { fills: GraphicsContext[]; uses: number }>();
  /** The shapes no one holds, in the order they went idle, with the time each did. */
  private readonly idle = new Map<ShapeCharacter, number>();
  /** The idle ones' vertices as they went idle, and their sum. */
  private readonly idleSizes = new Map<ShapeCharacter, number>();
  private idleVertices = 0;
  /** The idle ones that are blends, which go as soon as their morph drops them. */
  private readonly idleBlends = new Set<ShapeCharacter>();
  /** droppedBlends() when the idle blends were last looked at. */
  private blendsDropped = droppedBlends();
  /** How many vertices the idle may hold, grown as content comes back to what went for room. */
  readonly budget: IdleBudget;
  /** Each shape's number, for the budget's keys, which must hold no shape. */
  private readonly shapeIds = new WeakMap<ShapeCharacter, number>();
  private shapeCount = 0;

  constructor(
    private readonly now: () => number = () => performance.now(),
    device: DeviceMemory = deviceMemory(),
  ) {
    this.budget = new IdleBudget(
      FILLS_IDLE_VERTICES,
      linesCeiling(device),
      FILLS_IDLE_MS,
      4 * FILLS_IDLE_MOST,
    );
  }

  /** The shape's fills if they are kept, not taken: for a view drawn once to borrow. */
  peek(shape: ShapeCharacter): GraphicsContext[] | null {
    return this.held.get(shape)?.fills ?? null;
  }

  /** The shape's fills, taken: found, or built of `layers` by `build`. */
  take<L>(
    shape: ShapeCharacter,
    layers: L,
    build: (layers: L) => GraphicsContext[],
  ): GraphicsContext[] {
    let entry = this.held.get(shape);
    if (!entry) {
      entry = { fills: build(layers), uses: 0 };
      if (this.budget.remembered > 0) {
        this.budget.missed(this.ghostKey(shape), this.now());
      }

      this.held.set(shape, entry);
    }

    entry.uses++;
    this.wake(shape);
    return entry.fills;
  }

  give(shape: ShapeCharacter): void {
    const entry = this.held.get(shape);
    if (!entry) {
      return;
    }

    entry.uses--;
    if (entry.uses > 0) {
      return;
    }

    if (shape.layers.some((layer) => droppedLayers.has(layer))) {
      this.drop(shape);
      return;
    }

    let vertices = 0;
    for (let i = 0; i < entry.fills.length; i++) {
      vertices += verticesOf(entry.fills[i]);
    }

    this.idle.set(shape, this.now());
    this.idleSizes.set(shape, vertices);
    this.idleVertices += vertices;
    if (shape.layers.some((layer) => blendLayers.has(layer))) {
      this.idleBlends.add(shape);
    }

    this.trim();
  }

  /** A frame prepared: the idle blends their morph dropped go, and those idle too long, oldest first. */
  tick(): void {
    const dropped = droppedBlends();
    if (dropped !== this.blendsDropped) {
      this.blendsDropped = dropped;
      for (const shape of this.idleBlends) {
        if (shape.layers.some((layer) => droppedLayers.has(layer))) {
          this.drop(shape);
        }
      }
    }

    const now = this.now();
    for (const [shape, since] of this.idle) {
      if (now - since < FILLS_IDLE_MS) {
        break;
      }

      this.drop(shape);
    }

    this.budget.tick(now);
    this.trim();
  }

  /** The oldest idle let go, their keys remembered, till the rest are within the budget. */
  private trim(): void {
    const budget = this.budget.size;
    const most = (FILLS_IDLE_MOST * budget) / FILLS_IDLE_VERTICES;
    while (this.idle.size > most || this.idleVertices > budget) {
      const [shape, since] = this.idle.entries().next().value as [ShapeCharacter, number];
      // At least a shape's share of the least budget: one let go for their count grows it too.
      const size = Math.max(this.idleSizes.get(shape) ?? 0, FILLS_IDLE_VERTICES / FILLS_IDLE_MOST);
      this.budget.evicted(this.ghostKey(shape), since, size);
      this.drop(shape);
    }
  }

  private ghostKey(shape: ShapeCharacter): string {
    let id = this.shapeIds.get(shape);
    if (id === undefined) {
      id = this.shapeCount++;
      this.shapeIds.set(shape, id);
    }

    return String(id);
  }

  /** No longer idle, if it was. */
  private wake(shape: ShapeCharacter): void {
    this.idleVertices -= this.idleSizes.get(shape) ?? 0;
    this.idleSizes.delete(shape);
    this.idle.delete(shape);
    this.idleBlends.delete(shape);
  }

  private drop(shape: ShapeCharacter): void {
    this.wake(shape);
    for (const context of this.held.get(shape)?.fills ?? []) {
      destroyContext(context);
    }

    this.held.delete(shape);
  }
}
