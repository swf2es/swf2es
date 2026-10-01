// Draws the display list with PixiJS. Pixi only mirrors it: one container
// for each display object, kept from frame to frame and updated where the
// display object says it changed. A shape's fills are immutable
// GraphicsContexts shared by all its instances; its lines are drawn for
// each instance, as their width depends on its transform. Flash fills
// even-odd; a fill of several contours is drawn from their containment
// tree, holes cut, as Pixi's own grouping of holes misses nested islands.
import type { Fill, Line } from "@swf2es/format";
import {
  Graphics,
  GraphicsContext,
  Matrix,
  Container as PixiContainer,
  type Renderer,
} from "pixi.js";
import {
  CHILDREN,
  CLEAN,
  Container,
  type DisplayObject,
  ShapeObject,
  TRANSFORM,
} from "./display.js";
import { CURVE, LINE, MOVE, type Path, type ShapeLayer } from "./shapes.js";
import type { ShapeCharacter } from "./timeline.js";

/** A contour flattened to a polygon, for telling which contours hold which. */
function polygon(path: Path): number[] {
  const points: number[] = [];
  let x = 0;
  let y = 0;
  for (let i = 0; i < path.length; ) {
    const command = path[i];
    if (command === CURVE) {
      const [cx, cy, ax, ay] = path.slice(i + 1, i + 5);
      for (let k = 1; k <= 8; k++) {
        const t = k / 8;
        const u = 1 - t;
        points.push(
          u * u * x + 2 * u * t * cx + t * t * ax,
          u * u * y + 2 * u * t * cy + t * t * ay,
        );
      }

      x = ax;
      y = ay;
      i += 5;
    } else {
      x = path[i + 1];
      y = path[i + 2];
      points.push(x, y);
      i += 3;
    }
  }

  return points;
}

function inside(points: number[], px: number, py: number): boolean {
  let hit = false;
  for (let i = 0, j = points.length - 2; i < points.length; j = i, i += 2) {
    const xi = points[i];
    const yi = points[i + 1];
    const xj = points[j];
    const yj = points[j + 1];
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) {
      hit = !hit;
    }
  }

  return hit;
}

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
    const points = polygon(path);
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
        inside(outer.points, inner.points[0], inner.points[1]) &&
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
 * How far, in pixels, a flattened curve may stray from the curve. Pixi's
 * own flattening allows a fraction of the curve's length, which leaves
 * Flash's long curves visibly polygonal; this holds up to a few times scale.
 */
const FLATNESS = 0.02;

function trace(context: GraphicsContext, path: Path): void {
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

/** A fill's paint: a solid colour for now; gradients and bitmaps as their first colour. */
function paint(fill: Fill): { color: number; alpha: number } {
  const argb =
    fill.type === "solid"
      ? fill.color
      : fill.type === "bitmap"
        ? 0xff000000
        : (fill.gradient.stops[0]?.color ?? 0xff000000);
  return { color: argb & 0xffffff, alpha: (argb >>> 24) / 255 };
}

/** The linear part of a matrix, [a, b, c, d]: all a stroke's width depends on. */
type Linear = [number, number, number, number];

const UNIT: Linear = [1, 0, 0, 1];

function sameLinear(p: Linear, q: Linear): boolean {
  return p[0] === q[0] && p[1] === q[1] && p[2] === q[2] && p[3] === q[3];
}

/**
 * A line's width on screen. Flash strokes a transformed shape with one
 * width all along, not the local width stretched by the transform: the
 * width scaled by the transform's (a + c, b + d) as a line's scale mode
 * allows, never under a pixel, which is also how wide a hairline is.
 */
function screenWidth(line: Line, m: Linear): number {
  const sx = Math.abs(m[0] + m[2]);
  const sy = Math.abs(m[1] + m[3]);
  const scale = line.noHScale
    ? line.noVScale
      ? 1
      : sy
    : line.noVScale
      ? sx
      : Math.sqrt((sx * sx + sy * sy) / 2);
  return Math.max(1, (line.width / 20) * scale);
}

function stroke(line: Line, m: Linear): Parameters<GraphicsContext["stroke"]>[0] {
  const caps = ["round", "butt", "square"] as const;
  const joins = ["round", "bevel", "miter"] as const;
  return {
    width: screenWidth(line, m),
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
    const points = out[i] === CURVE ? 2 : 1;
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

/** A layer's fills, which are the same for every instance of the shape. */
function fillContext(layer: ShapeLayer): GraphicsContext {
  const context = new GraphicsContext();
  for (const { fill, contours } of layer.fills) {
    const style = paint(fill);
    const draw = (region: Region) => {
      context.beginPath();
      trace(context, region.path);
      context.closePath().fill(style);
      for (const hole of region.children) {
        context.beginPath();
        trace(context, hole.path);
        context.closePath().cut();
      }

      for (const hole of region.children) {
        for (const island of hole.children) {
          draw(island);
        }
      }
    };
    for (const root of containment(contours)) {
      draw(root);
    }
  }

  return context;
}

/** A layer's lines as seen through `m`, drawn in its space so that their width is even. */
function strokeContext(layer: ShapeLayer, m: Linear): GraphicsContext {
  const context = new GraphicsContext();
  for (const { line, paths } of layer.strokes) {
    context.beginPath();
    for (const path of paths) {
      trace(context, transformPath(path, m));
    }

    context.stroke(stroke(line, m));
  }

  return context;
}

/** What the view keeps for a display object. */
interface Node {
  container: PixiContainer;
  /** The linear part of the object's transform on the stage. */
  world: Linear;
  /** A shape's lines, a Graphics for each layer that has any; null where one has none. */
  strokes: (Graphics | null)[];
}

export class PixiView {
  readonly stage = new PixiContainer();
  private readonly nodes = new WeakMap<DisplayObject, Node>();
  private readonly fills = new Map<ShapeCharacter, GraphicsContext[]>();

  constructor(readonly renderer: Renderer) {}

  private node(o: DisplayObject): Node {
    let node = this.nodes.get(o);
    if (!node) {
      node = { container: new PixiContainer(), world: [0, 0, 0, 0], strokes: [] };
      if (o instanceof ShapeObject) {
        let fills = this.fills.get(o.shape);
        if (!fills) {
          fills = o.shape.layers.map(fillContext);
          this.fills.set(o.shape, fills);
        }

        o.shape.layers.forEach((layer, i) => {
          node?.container.addChild(new Graphics(fills[i]));
          const strokes = layer.strokes.length ? new Graphics() : null;
          if (strokes) {
            node?.container.addChild(strokes);
          }

          node?.strokes.push(strokes);
        });
      }

      this.nodes.set(o, node);
    }

    return node;
  }

  /**
   * Draw a shape's lines again for its transform on the stage: in the
   * stage's axes, under the inverse of that transform's linear part.
   */
  private restroke(o: ShapeObject, node: Node): void {
    const m = node.world;
    const det = m[0] * m[3] - m[1] * m[2];
    o.shape.layers.forEach((layer, i) => {
      const strokes = node.strokes[i];
      if (!strokes) {
        return;
      }

      // The new context goes in before the old one goes: the Graphics listens on the one it holds.
      const previous = strokes.context;
      strokes.context = det === 0 ? new GraphicsContext() : strokeContext(layer, m);
      previous.destroy();
      if (det !== 0) {
        strokes.setFromMatrix(new Matrix(m[3] / det, -m[1] / det, -m[2] / det, m[0] / det, 0, 0));
      }
    });
  }

  /**
   * Bring `o`'s mirror up to date where it changed, and return it. `parent`
   * is the linear part of its parent's transform on the stage, and `moved`
   * whether that changed, which changes the lines of every shape below.
   */
  private sync(o: DisplayObject, parent: Linear, moved: boolean): PixiContainer {
    const node = this.node(o);
    const { container } = node;
    if (o.dirty & TRANSFORM) {
      const m = o.matrix;
      container.setFromMatrix(new Matrix(m.a, m.b, m.c, m.d, m.tx, m.ty));
      container.visible = o.visible;
      const ct = o.colorTransform;
      // Multipliers as tint and alpha; offsets need a filter, not yet.
      container.alpha = ct ? Math.max(0, Math.min(1, ct.aMul)) : 1;
      container.tint = ct
        ? (Math.round(Math.max(0, Math.min(1, ct.rMul)) * 255) << 16) |
          (Math.round(Math.max(0, Math.min(1, ct.gMul)) * 255) << 8) |
          Math.round(Math.max(0, Math.min(1, ct.bMul)) * 255)
        : 0xffffff;
    }

    if (moved || o.dirty & TRANSFORM) {
      const m = o.matrix;
      const world: Linear = [
        parent[0] * m.a + parent[2] * m.b,
        parent[1] * m.a + parent[3] * m.b,
        parent[0] * m.c + parent[2] * m.d,
        parent[1] * m.c + parent[3] * m.d,
      ];
      moved = !sameLinear(world, node.world);
      node.world = world;
      if (moved && o instanceof ShapeObject) {
        this.restroke(o, node);
      }
    }

    if (o instanceof Container) {
      if (o.dirty & CHILDREN) {
        container.removeChildren();
        for (const child of o.children) {
          container.addChild(this.sync(child, node.world, moved));
        }
      } else if (moved || o.descendantsDirty) {
        for (const child of o.children) {
          if (
            moved ||
            child.dirty !== CLEAN ||
            (child instanceof Container && child.descendantsDirty)
          ) {
            this.sync(child, node.world, moved);
          }
        }
      }

      o.descendantsDirty = false;
    }

    o.dirty = CLEAN;
    return container;
  }

  /** Bring the stage up to date with `root`'s display list, without drawing. */
  prepare(root: DisplayObject): void {
    const node = this.sync(root, UNIT, false);
    if (node.parent !== this.stage) {
      this.stage.removeChildren();
      this.stage.addChild(node);
    }
  }

  /** Draw `root`'s display list, synced first. */
  render(root: DisplayObject): void {
    this.prepare(root);
    this.renderer.render(this.stage);
  }
}
