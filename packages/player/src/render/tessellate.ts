// A shape's fills as Pixi GraphicsContexts: its contours traced, curves
// flattened finely enough for Flash's, and filled even-odd or non-zero from
// their containment tree; and the cache that shares them between instances.
import type { Fill } from "@swf2es/format";
import { type FillInput, GraphicsContext } from "pixi.js";
import type { Region as Area } from "../display/gradients.js";
import { blendLayers, droppedLayers } from "../display/morph.js";
import {
  CUBIC,
  flatten,
  inside,
  LINE,
  MOVE,
  orientation,
  type Paint,
  type Path,
  type ShapeLayer,
} from "../display/shapes.js";
import type { ShapeCharacter } from "../display/timeline.js";
import { dropBatchedCopy } from "./color.js";
import { IDLE_MS } from "./pools.js";

/** A contour flattened to a polygon, for telling which contours hold which. */
interface Region {
  path: Path;
  points: number[];
  parent: Region | null;
  children: Region[];
  area: number;
}

/** The contours as a tree, each under the smallest one that holds it. */
function containment(paths: Path[]): Region[] {
  const regions: Region[] = paths.map((path) => {
    const points = flatten(path);
    let area = 0;
    for (let i = 0, j = points.length - 2; i < points.length; j = i, i += 2) {
      area += points[j] * points[i + 1] - points[i] * points[j + 1];
    }

    return { path, points, parent: null, children: [], area: Math.abs(area) / 2 };
  });
  for (const inner of regions) {
    for (const outer of regions) {
      if (
        outer !== inner &&
        outer.area > inner.area &&
        encloses(outer.points, inner.points) &&
        (!inner.parent || outer.area < inner.parent.area)
      ) {
        inner.parent = outer;
      }
    }
  }

  for (const r of regions) {
    r.parent?.children.push(r);
  }

  return regions.filter((r) => !r.parent);
}

/**
 * Whether the polygon `outer` holds `inner`, two contours that do not
 * cross, by a point of `inner` off `outer`'s outline: a pixel font's
 * contours touch, and a corner they share is inside one and out of the
 * other as the parity rule rounds it. Its corners, else its edges'
 * middles; a contour lying wholly along the other's outline goes by its first.
 */
function encloses(outer: number[], inner: number[]): boolean {
  for (const middles of [false, true]) {
    for (let i = 0, j = inner.length - 2; i < inner.length; j = i, i += 2) {
      const x = middles ? (inner[i] + inner[j]) / 2 : inner[i];
      const y = middles ? (inner[i + 1] + inner[j + 1]) / 2 : inner[i + 1];
      if (!onOutline(outer, x, y)) {
        return inside(outer, x, y);
      }
    }
  }

  return inside(outer, inner[0], inner[1]);
}

/** Whether (px, py) lies on one of the polygon's edges, to within a millionth of a pixel. */
function onOutline(points: number[], px: number, py: number): boolean {
  const near = 1e-6;
  for (let i = 0, j = points.length - 2; i < points.length; j = i, i += 2) {
    // Four reads, not an array destructured: this runs for every edge of every fill built.
    const x0 = points[j];
    const y0 = points[j + 1];
    const x1 = points[i];
    const y1 = points[i + 1];
    if (
      px >= Math.min(x0, x1) - near &&
      px <= Math.max(x0, x1) + near &&
      py >= Math.min(y0, y1) - near &&
      py <= Math.max(y0, y1) + near &&
      Math.abs((x1 - x0) * (py - y0) - (y1 - y0) * (px - x0)) <=
        near * Math.max(1, Math.hypot(x1 - x0, y1 - y0))
    ) {
      return true;
    }
  }

  return false;
}

/**
 * How far, in pixels, a flattened curve may stray from the curve. Pixi's
 * own flattening allows a fraction of the curve's length, which leaves
 * Flash's long curves visibly polygonal; this holds up to a few times scale.
 */
const FLATNESS = 0.02;

export function trace(context: GraphicsContext, path: Path): void {
  let x = 0;
  let y = 0;
  for (let i = 0; i < path.length; ) {
    const command = path[i];
    if (command === MOVE || command === LINE) {
      x = path[i + 1];
      y = path[i + 2];
      if (command === MOVE) {
        context.moveTo(x, y);
      } else {
        context.lineTo(x, y);
      }

      i += 3;
      continue;
    }

    if (command === CUBIC) {
      // A cubic's chords stray at most 3|Δ²| / 4n² for the larger of its two second differences.
      const [c1x, c1y, c2x, c2y, ax, ay] = path.slice(i + 1, i + 7);
      const bend = Math.max(
        Math.hypot(x - 2 * c1x + c2x, y - 2 * c1y + c2y),
        Math.hypot(c1x - 2 * c2x + ax, c1y - 2 * c2y + ay),
      );
      const n = Math.min(256, Math.max(1, Math.ceil(Math.sqrt((3 * bend) / (4 * FLATNESS)))));
      for (let k = 1; k < n; k++) {
        const t = k / n;
        const u = 1 - t;
        context.lineTo(
          u * u * u * x + 3 * u * u * t * c1x + 3 * u * t * t * c2x + t * t * t * ax,
          u * u * u * y + 3 * u * u * t * c1y + 3 * u * t * t * c2y + t * t * t * ay,
        );
      }

      context.lineTo(ax, ay);
      x = ax;
      y = ay;
      i += 7;
      continue;
    }

    // A quadratic's chords of parameter step 1/n stray at most |p0 - 2c + p2| / 4n².
    const cx = path[i + 1];
    const cy = path[i + 2];
    const ax = path[i + 3];
    const ay = path[i + 4];
    const bend = Math.hypot(x - 2 * cx + ax, y - 2 * cy + ay);
    const n = Math.min(256, Math.max(1, Math.ceil(Math.sqrt(bend / (4 * FLATNESS)))));
    for (let k = 1; k < n; k++) {
      const t = k / n;
      const u = 1 - t;
      context.lineTo(
        u * u * x + 2 * u * t * cx + t * t * ax,
        u * u * y + 2 * u * t * cy + t * t * ay,
      );
    }

    context.lineTo(ax, ay);
    x = ax;
    y = ay;
    i += 5;
  }
}

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
  dropBatchedCopy(context);
  context.destroy();
}

/** The bounds of a fill's contours, whole pixels out. */
function regionOf(contours: Path[]): Area {
  let x0 = Number.POSITIVE_INFINITY;
  let y0 = Number.POSITIVE_INFINITY;
  let x1 = Number.NEGATIVE_INFINITY;
  let y1 = Number.NEGATIVE_INFINITY;
  for (const path of contours) {
    const points = flatten(path);
    for (let i = 0; i < points.length; i += 2) {
      x0 = Math.min(x0, points[i]);
      x1 = Math.max(x1, points[i]);
      y0 = Math.min(y0, points[i + 1]);
      y1 = Math.max(y1, points[i + 1]);
    }
  }

  if (!(x1 >= x0 && y1 >= y0)) {
    return { x: 0, y: 0, width: 1, height: 1 };
  }

  const x = Math.floor(x0);
  const y = Math.floor(y0);
  return { x, y, width: Math.max(1, Math.ceil(x1) - x), height: Math.max(1, Math.ceil(y1) - y) };
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
 * A layer's fills, which are the same for every instance of the shape.
 * Each contour's region is inside or not by the fill's rule, by its depth
 * in the containment for even-odd, by the sum of orientations around it
 * for non-zero: a region inside where its parent is not is filled, with
 * the first regions below it that are not cut out as holes, and so on in.
 */
export function fillContext(layer: ShapeLayer, painter: Painter): GraphicsContext {
  const context = shapeContext();
  const held: (() => void)[] = [];
  holds.set(context, held);
  for (const { fill, contours, winding } of layer.fills) {
    // The region is a radial gradient's alone to need: flattening the contours is not free.
    const style = painter(
      fill,
      () => regionOf(contours),
      (release) => held.push(release),
    );
    const inside = (depth: number, sum: number) =>
      winding === "nonZero" ? sum !== 0 : depth % 2 === 0;
    // A region's holes are cut together, then the islands in them filled.
    // Pixi's cut() goes to the fill before the last too once the last has a
    // hole, so a second cut, or one after an island, would land a hole in
    // another region, which then fills across to it.
    const fillRegion = (region: Region, depth: number, sum: number) => {
      context.beginPath();
      trace(context, region.path);
      context.closePath().fill(style);

      const cut: [Region, number, number][] = [];
      holes(region, depth, sum, cut);
      if (cut.length === 0) {
        return;
      }

      context.beginPath();
      for (const [hole] of cut) {
        trace(context, hole.path);
        context.closePath();
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
    for (const root of containment(contours)) {
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
 * A shape's fills, or a morph's blend's, shared by every instance drawn
 * alike: a crowd in step, a pool's objects, and a timeline that places a
 * shape or a morph at a ratio again tessellate each once. Counted as nodes
 * take and give them back; one no one holds goes after IDLE_MS, or a
 * blend as its morph drops it, which is then never drawn from again. Kept
 * for as long as a shape lived, every shape a long session had shown held
 * its fills, their geometry and their coloured copies: hundreds of MB.
 */
export class SharedFills {
  private readonly held = new Map<ShapeCharacter, { fills: GraphicsContext[]; uses: number }>();
  /** The shapes no one holds, in the order they went idle, with the time each did. */
  private readonly idle = new Map<ShapeCharacter, number>();
  /** The idle ones that are blends, which go as soon as their morph drops them. */
  private readonly idleBlends = new Set<ShapeCharacter>();

  /** The shape's fills if they are kept, not taken: for a view drawn once to borrow. */
  peek(shape: ShapeCharacter): GraphicsContext[] | null {
    return this.held.get(shape)?.fills ?? null;
  }

  /** The shape's fills, taken: found, or built by `build`. */
  take(shape: ShapeCharacter, build: () => GraphicsContext[]): GraphicsContext[] {
    let entry = this.held.get(shape);
    if (!entry) {
      entry = { fills: build(), uses: 0 };
      this.held.set(shape, entry);
    }

    entry.uses++;
    this.idle.delete(shape);
    this.idleBlends.delete(shape);
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

    this.idle.set(shape, performance.now());
    if (shape.layers.some((layer) => blendLayers.has(layer))) {
      this.idleBlends.add(shape);
    }
  }

  /** A frame prepared: the idle blends their morph dropped go, and those idle too long, oldest first. */
  tick(): void {
    for (const shape of this.idleBlends) {
      if (shape.layers.some((layer) => droppedLayers.has(layer))) {
        this.drop(shape);
      }
    }

    const now = performance.now();
    for (const [shape, since] of this.idle) {
      if (now - since < IDLE_MS) {
        break;
      }

      this.drop(shape);
    }
  }

  private drop(shape: ShapeCharacter): void {
    this.idle.delete(shape);
    this.idleBlends.delete(shape);
    for (const context of this.held.get(shape)?.fills ?? []) {
      destroyContext(context);
    }

    this.held.delete(shape);
  }
}
