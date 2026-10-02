// Draws the display list with PixiJS. Pixi only mirrors it: one container
// for each display object, kept from frame to frame and updated where the
// display object says it changed. A shape's fills are immutable
// GraphicsContexts shared by all its instances; its lines are drawn for
// each instance, as their width depends on its transform. Flash fills
// even-odd; a fill of several contours is drawn from their containment
// tree, holes cut, as Pixi's own grouping of holes misses nested islands.
import type { Fill, Line } from "@swf2es/format";
import {
  BufferImageSource,
  Graphics,
  GraphicsContext,
  Matrix,
  Container as PixiContainer,
  type Renderer,
  RenderTexture,
  Sprite,
  Texture,
} from "pixi.js";
import { unmultiply } from "./bitmap.js";
import {
  BitmapObject,
  CHILDREN,
  CLEAN,
  CONTENT,
  Container,
  type DisplayObject,
  PIXELS,
  ShapeObject,
  TRANSFORM,
} from "./display.js";
import {
  CUBIC,
  flatten,
  inside,
  LINE,
  MOVE,
  orientation,
  type Path,
  pointsOf,
  type ShapeLayer,
} from "./shapes.js";
import type { ShapeCharacter } from "./timeline.js";

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
 * A layer's fills, which are the same for every instance of the shape.
 * Each contour's region is inside or not by the fill's rule, by its depth
 * in the containment for even-odd, by the sum of orientations around it
 * for non-zero: a region inside where its parent is not is filled, with
 * the first regions below it that are not cut out as holes, and so on in.
 */
function fillContext(layer: ShapeLayer): GraphicsContext {
  const context = new GraphicsContext();
  for (const { fill, contours, winding } of layer.fills) {
    const style = paint(fill);
    const inside = (depth: number, sum: number) =>
      winding === "nonZero" ? sum !== 0 : depth % 2 === 0;
    const fillRegion = (region: Region, depth: number, sum: number) => {
      context.beginPath();
      trace(context, region.path);
      context.closePath().fill(style);
      holes(region, depth, sum);
    };
    const holes = (region: Region, depth: number, sum: number) => {
      for (const child of region.children) {
        const s = sum + orientation(child.points);
        if (inside(depth + 1, s)) {
          holes(child, depth + 1, s);
        } else {
          context.beginPath();
          trace(context, child.path);
          context.closePath().cut();
          islands(child, depth + 1, s);
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
  /** What the object itself draws, a shape's or a drawing's layers, under any children. */
  art: PixiContainer;
  /** The layers drawn, a shape's or a drawing's, as of the last redraw. */
  layers: ShapeLayer[];
  /** The lines, a Graphics for each layer that has any; null where one has none. */
  strokes: (Graphics | null)[];
  /** A Bitmap's sprite and the version of its store it was uploaded from; null for any other object. */
  bitmap: { sprite: Sprite; source: BufferImageSource; version: number } | null;
}

export class PixiView {
  readonly stage = new PixiContainer();
  private readonly nodes = new WeakMap<DisplayObject, Node>();
  private readonly fills = new Map<ShapeCharacter, GraphicsContext[]>();

  /**
   * `fresh` makes a view that draws every object as new and leaves the
   * objects' dirty flags as they were, for a one-off render such as
   * BitmapData.draw's, so the stage's own view still sees each change.
   */
  constructor(
    readonly renderer: Renderer,
    private readonly fresh = false,
  ) {}

  private node(o: DisplayObject): Node {
    let node = this.nodes.get(o);
    if (!node) {
      const art = new PixiContainer();
      node = {
        container: new PixiContainer(),
        world: [0, 0, 0, 0],
        art,
        layers: [],
        strokes: [],
        bitmap: null,
      };
      node.container.addChild(art);
      this.nodes.set(o, node);
    }

    return node;
  }

  /**
   * What `o` itself draws, built anew: a shape's layers, whose fills are
   * shared by every instance of the character, or its drawing's, which are
   * its own and change.
   */
  private redraw(o: DisplayObject, node: Node): void {
    // A Bitmap's texture and its source are its own: they go with the sprite.
    node.bitmap?.sprite.destroy({ texture: true, textureSource: true });
    for (const child of node.art.removeChildren()) {
      if (!child.destroyed) {
        child.destroy();
      }
    }

    node.strokes = [];
    node.bitmap = null;
    if (o instanceof BitmapObject) {
      this.drawBitmap(o, node);
      return;
    }

    const shape = o instanceof ShapeObject ? o.shape : null;
    node.layers = o.drawing?.layers ?? shape?.layers ?? [];
    let fills: GraphicsContext[];
    if (shape && !o.drawing) {
      fills = this.fills.get(shape) ?? node.layers.map(fillContext);
      this.fills.set(shape, fills);
    } else {
      fills = node.layers.map(fillContext);
    }

    node.layers.forEach((layer, i) => {
      node.art.addChild(new Graphics(fills[i]));
      const strokes = layer.strokes.length ? new Graphics() : null;
      if (strokes) {
        node.art.addChild(strokes);
      }

      node.strokes.push(strokes);
    });
    this.restroke(node);
  }

  /**
   * A Bitmap as a sprite over a texture uploaded from its store's pixels,
   * nearest-neighbour unless it smooths; nothing for no store or one
   * disposed. The store counts its changes, and `sync` uploads again when
   * the count moves.
   */
  private drawBitmap(o: BitmapObject, node: Node): void {
    const store = o.store;
    if (!store || store.disposed) {
      return;
    }

    const source = new BufferImageSource({
      resource: rgba(store.pixels),
      width: store.width,
      height: store.height,
      alphaMode: "premultiply-alpha-on-upload",
      scaleMode: o.smoothing ? "linear" : "nearest",
    });
    const sprite = new Sprite(new Texture({ source }));
    node.art.addChild(sprite);
    node.bitmap = { sprite, source, version: store.version };
  }

  /**
   * Draw the lines again for the object's transform on the stage: in the
   * stage's axes, under the inverse of that transform's linear part.
   */
  private restroke(node: Node): void {
    const m = node.world;
    const det = m[0] * m[3] - m[1] * m[2];
    node.layers.forEach((layer, i) => {
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
    const dirty = this.fresh ? TRANSFORM | CHILDREN | CONTENT : o.dirty;
    if (dirty & TRANSFORM) {
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

    if (moved || dirty & TRANSFORM) {
      const m = o.matrix;
      const world: Linear = [
        parent[0] * m.a + parent[2] * m.b,
        parent[1] * m.a + parent[3] * m.b,
        parent[0] * m.c + parent[2] * m.d,
        parent[1] * m.c + parent[3] * m.d,
      ];
      moved = !sameLinear(world, node.world);
      node.world = world;
    }

    if (dirty & CONTENT) {
      this.redraw(o, node);
    } else if (moved && node.strokes.some((g) => g)) {
      this.restroke(node);
    } else if (dirty & PIXELS && node.bitmap && o instanceof BitmapObject && o.store) {
      // Pixels set since the upload: the same texture, uploaded again.
      if (o.store.version !== node.bitmap.version) {
        node.bitmap.source.resource = rgba(o.store.pixels);
        node.bitmap.source.update();
        node.bitmap.version = o.store.version;
      }
    }

    if (o instanceof Container) {
      if (dirty & CHILDREN) {
        container.removeChildren();
        container.addChild(node.art);
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

      if (!this.fresh) {
        o.descendantsDirty = false;
      }
    }

    if (!this.fresh) {
      o.dirty = CLEAN;
    }

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

  /**
   * `o` drawn alone, as BitmapData.draw takes a display object: through `m`
   * in place of its own transform, into a w x h texture, read back as
   * premultiplied ARGB. A fresh view does it, so the stage's is untouched.
   */
  snapshot(
    o: DisplayObject,
    m: { a: number; b: number; c: number; d: number; tx: number; ty: number },
    width: number,
    height: number,
    samples = 4,
  ): Uint32Array {
    // Rendered at samples x samples a pixel and averaged, as Flash covers edges: 4 at its high quality.
    const n = samples;
    const view = new PixiView(this.renderer, true);
    const node = view.sync(o, [m.a * n, m.b * n, m.c * n, m.d * n], true);
    node.setFromMatrix(new Matrix(m.a * n, m.b * n, m.c * n, m.d * n, m.tx * n, m.ty * n));
    const target = RenderTexture.create({ width: width * n, height: height * n });
    this.renderer.render({ container: node, target, clear: true });
    const { pixels } = this.renderer.extract.pixels(target);
    node.destroy({ children: true, texture: true, textureSource: true });
    target.destroy(true);
    const out = new Uint32Array(width * height);
    const row = width * n;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        let a = 0;
        let r = 0;
        let g = 0;
        let b = 0;
        for (let sy = 0; sy < n; sy++) {
          for (let sx = 0; sx < n; sx++) {
            const i = ((y * n + sy) * row + x * n + sx) * 4;
            r += pixels[i];
            g += pixels[i + 1];
            b += pixels[i + 2];
            a += pixels[i + 3];
          }
        }

        const k = n * n;
        out[y * width + x] =
          ((Math.round(a / k) << 24) |
            (Math.round(r / k) << 16) |
            (Math.round(g / k) << 8) |
            Math.round(b / k)) >>>
          0;
      }
    }

    return out;
  }

  /** Draw `root`'s display list, synced first. */
  render(root: DisplayObject): void {
    this.prepare(root);
    this.renderer.render(this.stage);
  }
}

/** A store's premultiplied ARGB pixels as the straight RGBA bytes a texture upload takes. */
function rgba(pixels: Uint32Array): Uint8Array {
  const out = new Uint8Array(pixels.length * 4);
  for (let i = 0; i < pixels.length; i++) {
    const p = unmultiply(pixels[i]);
    out[i * 4] = (p >>> 16) & 0xff;
    out[i * 4 + 1] = (p >>> 8) & 0xff;
    out[i * 4 + 2] = p & 0xff;
    out[i * 4 + 3] = p >>> 24;
  }

  return out;
}
