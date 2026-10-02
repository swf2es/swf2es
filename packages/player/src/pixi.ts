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
import type { BitmapStore, GpuCopy } from "./bitmap.js";
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
  /** Their fills, one context a layer. */
  fills: GraphicsContext[];
  /** Whether the fills are this node's own, a drawing's, rather than its character's, which instances share. */
  ownFills: boolean;
  /** The lines, a Graphics for each layer that has any; null where one has none. */
  strokes: (Graphics | null)[];
  /** A Bitmap's sprite, over its store's texture, which Bitmaps share; null for any other object. */
  bitmap: Sprite | null;
}

export class PixiView {
  readonly stage = new PixiContainer();
  private readonly nodes = new WeakMap<DisplayObject, Node>();
  private readonly fills = new Map<ShapeCharacter, GraphicsContext[]>();
  /** What a fresh view built itself, which it destroys; what it borrowed from `source` stays. */
  private readonly built: GraphicsContext[] = [];

  /**
   * `fresh` makes a view that draws every object as new and leaves the
   * objects' dirty flags as they were, for a one-off render such as
   * BitmapData.draw's, so the stage's own view still sees each change.
   */
  constructor(
    readonly renderer: Renderer,
    private readonly fresh = false,
    /** The stage's view, whose geometry and textures a fresh view borrows where they are current. */
    private readonly source: PixiView | null = null,
  ) {}

  /**
   * The source view's node for `o`, if what it drew is still `o`'s: built
   * since the content last changed. Its lines are current for its own
   * `world` alone.
   */
  private current(o: DisplayObject): Node | null {
    const node = this.source?.nodes.get(o);
    return node && !(o.dirty & CONTENT) ? node : null;
  }

  /** Destroy what this fresh view built, and its containers; what it borrowed stays its owner's. */
  dispose(root: PixiContainer): void {
    root.destroy({ children: true });
    for (const context of this.built) {
      context.destroy();
    }
  }

  private node(o: DisplayObject): Node {
    let node = this.nodes.get(o);
    if (!node) {
      const art = new PixiContainer();
      node = {
        container: new PixiContainer(),
        world: [0, 0, 0, 0],
        art,
        layers: [],
        fills: [],
        ownFills: false,
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
    // A Bitmap's texture is its store's: only the sprite goes.
    node.bitmap?.destroy();
    // A drawing's fills and every node's lines; a Graphics frees only a context it made.
    const old = [
      ...(node.ownFills && !this.fresh ? node.fills : []),
      ...(this.fresh ? [] : node.strokes.map((g) => g?.context)),
    ];
    for (const child of node.art.removeChildren()) {
      if (!child.destroyed) {
        child.destroy();
      }
    }

    for (const context of old) {
      context?.destroy();
    }

    node.strokes = [];
    node.bitmap = null;
    const current = this.current(o);
    if (o instanceof BitmapObject) {
      this.drawBitmap(o, node);
      return;
    }

    const shape = o instanceof ShapeObject ? o.shape : null;
    node.layers = o.drawing?.layers ?? shape?.layers ?? [];
    const build = (layer: ShapeLayer) => {
      const context = fillContext(layer);
      if (this.fresh) {
        this.built.push(context);
      }

      return context;
    };
    let fills: GraphicsContext[];
    node.ownFills = false;
    if (current && current.layers === node.layers && current.fills.length === node.layers.length) {
      fills = current.fills;
    } else if (shape && !o.drawing) {
      fills = this.fills.get(shape) ?? node.layers.map(build);
      this.fills.set(shape, fills);
    } else {
      fills = node.layers.map(build);
      node.ownFills = true;
    }

    node.fills = fills;
    const lines = current && sameLinear(current.world, node.world) ? current.strokes : null;
    node.layers.forEach((layer, i) => {
      node.art.addChild(new Graphics(fills[i]));
      const borrowed = lines?.[i];
      const strokes = layer.strokes.length
        ? borrowed
          ? new Graphics(borrowed.context)
          : new Graphics()
        : null;
      if (strokes) {
        if (borrowed) {
          strokes.setFromMatrix(borrowed.localTransform);
        }

        node.art.addChild(strokes);
      }

      node.strokes.push(borrowed ? null : strokes);
    });
    this.restroke(node);
  }

  /**
   * A Bitmap as a sprite over its store's texture, which every Bitmap of
   * the store shares; nothing for no store, one disposed, one of 0 by 0
   * that Flash could not read, or one too large for a texture.
   */
  private drawBitmap(o: BitmapObject, node: Node): void {
    const texture = o.store && gpuBitmaps(this.renderer).texture(o.store, o.smoothing);
    if (!texture) {
      return;
    }

    node.bitmap = new Sprite(texture);
    node.art.addChild(node.bitmap);
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
      if (this.fresh) {
        this.built.push(strokes.context);
      }

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
   * `own` stands in for `o`'s own matrix, as a draw's matrix does.
   */
  private sync(
    o: DisplayObject,
    parent: Linear,
    moved: boolean,
    own: DisplayObject["matrix"] = o.matrix,
  ): PixiContainer {
    const node = this.node(o);
    const { container } = node;
    const dirty = this.fresh ? TRANSFORM | CHILDREN | CONTENT : o.dirty;
    if (dirty & TRANSFORM) {
      const m = own;
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
      const m = own;
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
      // Pixels set since: the texture brought up to date, uploaded where the CPU changed them.
      gpuBitmaps(this.renderer).texture(o.store, o.smoothing);
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
   * into a w x h texture, rendered at `samples` a side and averaged on the
   * GPU, as Flash covers edges (4 at its high quality). A fresh view does
   * it, borrowing the stage's current geometry, so the stage's is untouched.
   */
  private sampled(
    o: DisplayObject,
    m: { a: number; b: number; c: number; d: number; tx: number; ty: number },
    width: number,
    height: number,
    samples: number,
  ): RenderTexture {
    const n = samples;
    const view = new PixiView(this.renderer, true, this);
    // Built at the draw's own scale, lines included, as the stage's are,
    // then rendered n times larger: the curves are no finer than on the
    // stage, and widths and hairlines scale with the samples.
    const node = view.sync(o, [1, 0, 0, 1], true, m);
    const scaled = new PixiContainer();
    scaled.addChild(node);
    scaled.scale.set(n);
    let target = RenderTexture.create({ width: width * n, height: height * n });
    this.renderer.render({ container: scaled, target, clear: true });
    view.dispose(scaled);
    // Halved until a sample a pixel: a linear sample at the corner four texels share is their mean.
    for (let k = n; k > 1; k /= 2) {
      const half = RenderTexture.create({ width: (width * k) / 2, height: (height * k) / 2 });
      target.source.scaleMode = "linear";
      const sprite = new Sprite(target);
      sprite.scale.set(0.5);
      this.renderer.render({ container: sprite, target: half, clear: true });
      sprite.destroy();
      target.destroy(true);
      target = half;
    }

    return target;
  }

  /** `o` drawn alone, as `sampled`, read back as premultiplied ARGB. */
  snapshot(
    o: DisplayObject,
    m: { a: number; b: number; c: number; d: number; tx: number; ty: number },
    width: number,
    height: number,
    samples = 4,
  ): Uint32Array {
    const target = this.sampled(o, m, width, height, samples);
    const pixels = argbOf(this.renderer.extract.pixels(target).pixels);
    target.destroy(true);
    return pixels;
  }

  /**
   * `o` drawn into `store` on the GPU, as `sampled`, source over at (x, y)
   * with nothing read back: the store is then newer on the GPU. False,
   * having done nothing, where the store can have no texture.
   */
  drawInto(
    store: BitmapStore,
    o: DisplayObject,
    m: { a: number; b: number; c: number; d: number; tx: number; ty: number },
    x: number,
    y: number,
    width: number,
    height: number,
    samples = 4,
  ): boolean {
    const bitmaps = gpuBitmaps(this.renderer);
    const texture = bitmaps.texture(store);
    if (!texture) {
      return false;
    }

    // Into a texture of its own first: the object may show the store itself.
    const drawn = this.sampled(o, m, width, height, samples);
    const sprite = new Sprite(drawn);
    sprite.position.set(x, y);
    this.renderer.render({ container: sprite, target: texture, clear: false });
    sprite.destroy();
    drawn.destroy(true);
    bitmaps.drawn(store);
    return true;
  }

  /** Draw `root`'s display list, synced first. */
  render(root: DisplayObject): void {
    this.prepare(root);
    this.renderer.render(this.stage);
  }
}

/** Premultiplied ARGB as the RGBA bytes a texture holds, still premultiplied. */
function rgbaOf(pixels: Uint32Array): Uint8Array {
  const out = new Uint8Array(pixels.length * 4);
  for (let i = 0; i < pixels.length; i++) {
    const p = pixels[i];
    const j = i * 4;
    out[j] = (p >>> 16) & 0xff;
    out[j + 1] = (p >>> 8) & 0xff;
    out[j + 2] = p & 0xff;
    out[j + 3] = p >>> 24;
  }

  return out;
}

/** RGBA bytes read from a texture as premultiplied ARGB. */
function argbOf(bytes: Uint8Array | Uint8ClampedArray): Uint32Array {
  const out = new Uint32Array(bytes.length / 4);
  for (let i = 0; i < out.length; i++) {
    const j = i * 4;
    out[i] = ((bytes[j + 3] << 24) | (bytes[j] << 16) | (bytes[j + 1] << 8) | bytes[j + 2]) >>> 0;
  }

  return out;
}

/**
 * A store's texture: its premultiplied ARGB exactly, uploaded as it is and
 * rendered into by draws. Pixi's collector never unloads it, as content a
 * draw left there could not be uploaded again.
 */
class StoreTexture implements GpuCopy {
  readonly source: BufferImageSource;
  readonly texture: Texture;
  /** The store's version the texture holds. */
  version = -1;
  /** The same pixels sampled linearly, for a smoothed Bitmap, copied on the GPU as the texture changes. */
  private smooth: { texture: RenderTexture; version: number } | null = null;

  constructor(
    private readonly renderer: Renderer,
    private readonly bitmaps: GpuBitmaps,
    width: number,
    height: number,
  ) {
    this.source = new BufferImageSource({
      // Bytes decide the format, 8 bits a channel; none allocate a float buffer.
      resource: new Uint8Array(0),
      width,
      height,
      alphaMode: "premultiplied-alpha",
      scaleMode: "nearest",
      autoGarbageCollect: false,
    });
    // No bytes until the CPU's are uploaded: the first use allocates the
    // texture without an upload, and a store of one colour is cleared to it.
    this.source.resource = null as unknown as Uint8Array;
    this.texture = new Texture({ source: this.source });
  }

  read(): Uint32Array {
    return argbOf(this.renderer.extract.pixels(this.texture).pixels);
  }

  /** The store's pixels on the GPU: cleared to their colour where they are all one, as a new bitmap's are, else uploaded. */
  upload(pixels: Uint32Array): void {
    const first = pixels[0];
    let uniform = true;
    for (let i = 1; i < pixels.length; i++) {
      if (pixels[i] !== first) {
        uniform = false;
        break;
      }
    }

    if (!uniform) {
      this.source.resource = rgbaOf(pixels);
      this.source.update();
      return;
    }

    // Already premultiplied, as the texture holds them; a byte divided by 255 comes back exactly.
    this.renderer.render({
      container: EMPTY,
      target: this.texture,
      clear: true,
      clearColor: [
        ((first >>> 16) & 0xff) / 255,
        ((first >>> 8) & 0xff) / 255,
        (first & 0xff) / 255,
        (first >>> 24) / 255,
      ],
    });
  }

  /** The texture sampled linearly: a texture's sampling is its source's, which Bitmaps share. */
  smoothed(): Texture {
    if (!this.smooth) {
      this.smooth = {
        texture: RenderTexture.create({
          width: this.source.width,
          height: this.source.height,
          scaleMode: "linear",
          autoGarbageCollect: false,
        }),
        version: -1,
      };
    }

    if (this.smooth.version !== this.version) {
      const sprite = new Sprite(this.texture);
      this.renderer.render({ container: sprite, target: this.smooth.texture, clear: true });
      sprite.destroy();
      this.smooth.version = this.version;
    }

    return this.smooth.texture;
  }

  destroy(): void {
    this.bitmaps.forget(this);
    this.texture.destroy(true);
    this.smooth?.texture.destroy(true);
  }
}

/**
 * The textures of a renderer's stores, one a store, made as a Bitmap shows
 * one or a draw renders into it. Each renderer keeps its own: a store
 * shown by two has a copy in each, and one a draw wrote is read back
 * through the renderer that drew it before another uploads it.
 */
class GpuBitmaps {
  private readonly limit: number;
  private readonly copies = new WeakMap<BitmapStore, StoreTexture>();
  private readonly collected = new FinalizationRegistry<StoreTexture>((copy) => copy.destroy());

  constructor(private readonly renderer: Renderer) {
    const gl = (renderer as unknown as { gl?: WebGL2RenderingContext }).gl;
    this.limit = gl ? gl.getParameter(gl.MAX_TEXTURE_SIZE) : 8192;
  }

  /**
   * The store's texture, made if it has none and uploaded if the CPU
   * changed the store since; null for one disposed, of 0 by 0, or larger
   * than a texture may be. Smoothed, it is a linearly sampled copy.
   */
  texture(store: BitmapStore, smoothing?: boolean): Texture | null {
    if (
      store.disposed ||
      store.width === 0 ||
      store.width > this.limit ||
      store.height > this.limit
    ) {
      return null;
    }

    let copy = this.copies.get(store);
    if (!copy) {
      copy = new StoreTexture(this.renderer, this, store.width, store.height);
      this.copies.set(store, copy);
      store.copies.add(copy);
      // Unregistered by the copy itself, on dispose.
      this.collected.register(store, copy, copy);
    }

    // Behind the store: its pixels, read back first if another renderer's draw wrote them.
    if (copy.version !== store.version) {
      copy.upload(store.pixels);
      copy.version = store.version;
    }

    return smoothing ? copy.smoothed() : copy.texture;
  }

  /** A draw rendered into this renderer's copy of the store, which now holds the store as it is. */
  drawn(store: BitmapStore): void {
    const copy = this.copies.get(store);
    if (copy) {
      store.drawnOnGpu(copy);
      copy.version = store.version;
    }
  }

  forget(copy: StoreTexture): void {
    this.collected.unregister(copy);
  }
}

const gpuBitmapsOf = new WeakMap<Renderer, GpuBitmaps>();
/** Nothing, rendered to clear a texture. */
const EMPTY = new PixiContainer();

function gpuBitmaps(renderer: Renderer): GpuBitmaps {
  let bitmaps = gpuBitmapsOf.get(renderer);
  if (!bitmaps) {
    bitmaps = new GpuBitmaps(renderer);
    gpuBitmapsOf.set(renderer, bitmaps);
  }

  return bitmaps;
}
