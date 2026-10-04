// Draws the display list with PixiJS. Pixi only mirrors it: one container
// for each display object, kept from frame to frame and updated where the
// display object says it changed. A shape's fills are immutable
// GraphicsContexts shared by all its instances; its lines depend on its
// transform, as their width does, and are shared by the instances that see
// them through the same one (StrokeContexts). Flash fills
// even-odd; a fill of several contours is drawn from their containment
// tree, holes cut, as Pixi's own grouping of holes misses nested islands.
import type { ColorTransform, Fill, Glyph, Line } from "@swf2es/format";
import {
  BufferImageSource,
  CanvasTextMetrics,
  type FederatedPointerEvent,
  type FillInput,
  type Filter,
  fontStringFromTextStyle,
  Graphics,
  GraphicsContext,
  Matrix,
  Container as PixiContainer,
  Rectangle,
  type Renderer,
  RendererType,
  RenderTexture,
  Sprite,
  Text,
  Texture,
} from "pixi.js";
import { BitmapStore, type GpuCopy } from "./bitmap.js";
import { toStage } from "./bounds.js";
import { concatColor, multipliesOnly, sameColor } from "./color.js";
import {
  BitmapObject,
  CHILDREN,
  CLEAN,
  Clips,
  CONTENT,
  Container,
  type DisplayObject,
  PIXELS,
  ShapeObject,
  StaticTextObject,
  TextObject,
  TRANSFORM,
} from "./display.js";
import type { Filter as FilterRecord } from "./filters.js";
import { deviceMetrics, fontFamily } from "./fonts.js";
import { shifted } from "./geometry.js";
import { type Region as Area, RADIAL_MAX, radialPixels, ramp } from "./gradients.js";
import type { PointerState } from "./input.js";
import { blendLayers, droppedLayers } from "./morph.js";
import { blendFilters } from "./pixi-blend.js";
import { dropBatchedCopy, setFlashColor, showFor } from "./pixi-color.js";
import { displayFilters, FilterChain, rgbaOf } from "./pixi-filters.js";
import type { Player } from "./player.js";
import {
  CUBIC,
  flatten,
  type GradientFill,
  inside,
  LINE,
  MOVE,
  orientation,
  type Paint,
  type Path,
  pointsOf,
  type ShapeLayer,
  shapeLayers,
} from "./shapes.js";
import { GUTTER, type LaidChar, shownLines } from "./text-layout.js";
import type { BitmapCharacter, ShapeCharacter } from "./timeline.js";

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

/**
 * A fill's paint, but a resolved bitmap's, which the view gives: a solid
 * colour; a gradient as its first colour, for now; and a bitmap fill of a
 * bitmap the SWF lacks red, as Flash draws one.
 */
function paint(fill: Fill): { color: number; alpha: number } {
  const argb =
    fill.type === "solid"
      ? fill.color
      : fill.type === "bitmap"
        ? 0xffff0000
        : (fill.gradient.stops[0]?.color ?? 0xff000000);
  return { color: argb & 0xffffff, alpha: (argb >>> 24) / 255 };
}

/**
 * Make a texture source report "clamp" for addressMode: Pixi turns a
 * fill's texture that says clamp-to-edge to repeating, while WebGL reads
 * each axis's mode, which stays clamped.
 */
function keepClamped(source: { style: object }): void {
  Object.defineProperty(source.style, "addressMode", { get: () => "clamp", set: () => {} });
}

/** How a view paints a fill over a region of the shape: a resolved bitmap's or gradient's through its renderer's textures. */
type Painter = (fill: Paint, region: () => Area, hold: (release: () => void) => void) => FillInput;

/** What each fill context holds of the textures its gradients use, given back as it is destroyed. */
const holds = new WeakMap<GraphicsContext, (() => void)[]>();

/** A context destroyed, the textures it held given back first: a fill's, or lines', which hold none. */
function destroyContext(context: GraphicsContext): void {
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

/** The store a SWF bitmap's fills draw from, one for all its shapes; null until its image is decoded. */
function characterStore(character: BitmapCharacter): BitmapStore | null {
  if (!character.pixels) {
    return null;
  }

  character.store ??= BitmapStore.of(character.pixels);
  return character.store;
}

/** The linear part of a matrix, [a, b, c, d]: all a stroke's width depends on. */
type Linear = [number, number, number, number];

const UNIT: Linear = [1, 0, 0, 1];

function sameLinear(p: Linear, q: Linear): boolean {
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
 * A context for a shape's fills or lines, drawn on its own, never batched.
 * A batch holds its vertices on the stage, so Pixi repacks and uploads
 * them all again whenever anything in the render group changes structure,
 * as a timeline does on most frames; and between batches and the large
 * shapes Pixi draws alone anyway it switches programs. Alone, a shape's
 * geometry is uploaded once and only its transform changes.
 */
function shapeContext(): GraphicsContext {
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
function fillContext(layer: ShapeLayer, painter: Painter): GraphicsContext {
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

/** A layer's lines as seen through `m`, drawn in its space so that their width is even. */
function strokeContext(layer: ShapeLayer, m: Linear, least: number): GraphicsContext {
  const context = shapeContext();
  for (const { line, paths } of layer.strokes) {
    context.beginPath();
    for (const path of paths) {
      trace(context, transformPath(path, m));
    }

    context.stroke(stroke(line, m, least));
  }

  return context;
}

/**
 * How long, in milliseconds, lines' contexts no instance uses are kept for
 * one to come back to, as a loop does, and how many at most. By age, not
 * count: a loop longer than a count would find each context gone just
 * before it came round to it; and by time, not renders, which a host may
 * make many of between a SWF's frames.
 */
const IDLE_MS = 5000;
const IDLE_MOST = 4096;

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
class StrokeContexts {
  private readonly byLayer = new WeakMap<ShapeLayer, Map<string, GraphicsContext>>();
  private readonly uses = new Map<GraphicsContext, number>();
  private readonly keys = new Map<GraphicsContext, [ShapeLayer, string]>();
  /** Contexts no one holds, oldest first, with the time each went idle. */
  private readonly idle = new Map<GraphicsContext, number>();
  /** The idle ones of blends, which go as soon as their morph drops the blend. */
  private readonly idleBlends = new Set<GraphicsContext>();

  constructor(private readonly counts: { strokeContexts: number; strokeReuses: number }) {}

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

/**
 * A morph's blends' fills, shared as a shape's are by every instance drawn
 * at that blend: a crowd in step, and a timeline that places the morph
 * again at a ratio it has drawn, tessellate each blend once. Counted as
 * nodes take and give them back; one no one holds goes as its morph drops
 * the blend, which is then never drawn from again, or after IDLE_MS.
 */
class BlendFills {
  private readonly held = new Map<ShapeCharacter, { fills: GraphicsContext[]; uses: number }>();
  /** The blends no one holds, oldest first, with the time each went idle. */
  private readonly idle = new Map<ShapeCharacter, number>();

  /** The blend's fills, taken: found, or built by `build`. */
  take(blend: ShapeCharacter, build: () => GraphicsContext[]): GraphicsContext[] {
    let entry = this.held.get(blend);
    if (!entry) {
      entry = { fills: build(), uses: 0 };
      this.held.set(blend, entry);
    }

    entry.uses++;
    this.idle.delete(blend);
    return entry.fills;
  }

  give(blend: ShapeCharacter): void {
    const entry = this.held.get(blend);
    if (!entry) {
      return;
    }

    entry.uses--;
    if (entry.uses > 0) {
      return;
    }

    if (blend.layers.some((layer) => droppedLayers.has(layer))) {
      this.drop(blend);
      return;
    }

    this.idle.set(blend, performance.now());
  }

  /** A frame prepared: the idle blends their morph dropped go, and those idle too long. */
  tick(): void {
    const now = performance.now();
    for (const [blend, since] of this.idle) {
      if (now - since >= IDLE_MS || blend.layers.some((layer) => droppedLayers.has(layer))) {
        this.drop(blend);
      }
    }
  }

  private drop(blend: ShapeCharacter): void {
    this.idle.delete(blend);
    for (const context of this.held.get(blend)?.fills ?? []) {
      destroyContext(context);
    }

    this.held.delete(blend);
  }
}

/** The key a layer's lines seen through `m`, at least `least` wide, are kept by. */
function linesKey(m: Linear, least: number): string {
  return `${m[0]},${m[1]},${m[2]},${m[3]},${least}`;
}

/**
 * A Graphics of an object's lines, whose context is swapped for the
 * transform's as the object turns: without Pixi's listening on it, as a
 * line context never changes once built and is destroyed only once no one
 * holds it, and a shared one's listeners, one an instance, made each swap
 * search them all.
 */
class LinesGraphics extends Graphics {
  /** The context it stands for, which the cache counts: what it draws, or that drawn as a batched copy (showFor). */
  shared: GraphicsContext;
  declare flashColor?: ColorTransform | null;

  constructor(context?: GraphicsContext) {
    super(context);
    this.shared = this.context;
    this.context.off("update", this.onViewUpdate, this);
    this.context.off("unload", this.unload, this);
  }

  /** Stand for `context` instead, drawn as its colour transform needs. */
  swap(context: GraphicsContext): void {
    this.shared = context;
    showFor(this, this.flashColor ?? null);
  }

  /** Draw `context` without listening on it: a shared context would gather a listener for every instance. */
  show(context: GraphicsContext): void {
    if (context !== this.context) {
      (this as unknown as { _context: GraphicsContext })._context = context;
      this.onViewUpdate();
    }
  }
}

/** A layer's lines seen through `m`, nothing where `m` flattens them. */
function linesContext(layer: ShapeLayer, m: Linear, least: number): GraphicsContext {
  return m[0] * m[3] - m[1] * m[2] === 0 ? new GraphicsContext() : strokeContext(layer, m, least);
}

const NO_RECORDS: readonly FilterRecord[] = [];

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
  /**
   * Whether the fills are this node's own, a drawing's, not its character's or blend's, which
   * instances share.
   */
  ownFills: boolean;
  /** The morph's blend whose shared fills it holds, given back as it draws another or leaves. */
  blended: ShapeCharacter | null;
  /** The lines, a Graphics for each layer that has any; null where one has none. */
  strokes: (LinesGraphics | null)[];
  /** Whether the layers are a character's or a blend's, whose lines' contexts instances share. */
  sharedLines: boolean;
  /** The children as of the last arrangement, to know those that left. */
  kids: readonly DisplayObject[];
  /** Whether its lines were given back as it left the list: drawn again for its transform if it comes back. */
  released: boolean;
  /** A Bitmap's sprite, over its store's texture, which Bitmaps share; null for any other object. */
  bitmap: Sprite | null;
  /** Every line drawn, its own or borrowed: hidden while the object is a mask or in one. */
  lines: LinesGraphics[];
  /** Whether the object is a mask or in one, as of the last sync. */
  masking: boolean;
  /** The containers of the children a timeline's mask clips, each masked by it. */
  groups: PixiContainer[];
  /** Its scroll's clip: a rectangle in its space, and the container it masks, of the art and children. */
  scroll: { clip: Graphics; content: PixiContainer } | null;
  /** Whether it has a mask or a scroll's clip, to be taken off when the object's go. */
  clipped: boolean;
  /** Its colour transform from the stage down, null for none, and its parent's that it was made from. */
  color: ColorTransform | null;
  inherited: ColorTransform | null;
  /** The blend mode its filters composite it in. */
  blend: string;
  /** Its filters' records as of the last sync, and the Pixi filters made of them, its own. */
  filterRecords: readonly FilterRecord[];
  filters: Filter[];
}

export class PixiView {
  readonly stage = new PixiContainer();
  /** What the view has built since it was made, for measuring: lines' contexts made and reused. */
  readonly counts = { strokeContexts: 0, strokeReuses: 0 };
  private readonly lines = new StrokeContexts(this.counts);
  private readonly nodes = new WeakMap<DisplayObject, Node>();
  private readonly fills = new Map<ShapeCharacter, GraphicsContext[]>();
  private readonly blends = new BlendFills();
  /**
   * A fill painted: a bitmap's from its store's texture sampled as the fill
   * samples, in global texture space so that its matrix maps the bitmap's
   * pixels to the shape's; nothing for a bitmap that has no texture.
   */
  private readonly painter: Painter = (fill, region, hold) => {
    if (fill.type === "gradient") {
      const m = fill.matrix;
      if (m.a * m.d - m.b * m.c === 0) {
        return { color: 0, alpha: 0 };
      }

      const held = gpuBitmaps(this.renderer).gradientTexture(fill, fill.radial ? region() : null);
      hold(held.release);
      return { texture: held.texture, matrix: held.matrix, textureSpace: "global" };
    }

    if (fill.type !== "image") {
      return paint(fill);
    }

    const store = fill.image instanceof BitmapStore ? fill.image : characterStore(fill.image);
    const texture = store && gpuBitmaps(this.renderer).fillTexture(store, fill.repeat, fill.smooth);
    if (!texture) {
      return { color: 0, alpha: 0 };
    }

    const m = fill.matrix;
    return { texture, matrix: new Matrix(m.a, m.b, m.c, m.d, m.tx, m.ty), textureSpace: "global" };
  };
  /** Whether the renderer was found to lack the back buffer that blend modes read, and the host told. */
  private backBufferChecked = false;

  /**
   * A blend mode reads what is below from Pixi's back buffer, which a WebGL
   * renderer has only when made with `useBackBuffer: true`; without it the
   * modes draw as normal, so the host is told, once.
   */
  private checkBackBuffer(): void {
    if (this.backBufferChecked) {
      return;
    }

    this.backBufferChecked = true;
    const gl = this.renderer as unknown as { backBuffer?: { useBackBuffer: boolean } };
    if (gl.backBuffer && !gl.backBuffer.useBackBuffer) {
      console.warn(
        "swf2es: a blend mode draws as normal: make the Pixi renderer with useBackBuffer: true",
      );
    }
  }

  /** What a fresh view built itself, which it destroys; what it borrowed from `source` stays. */
  private readonly built: GraphicsContext[] = [];
  /** The filters a fresh view made, which it destroys with the rest. */
  private readonly builtFilters: Filter[] = [];
  /** The objects `mask` was found set on, for the masks to be placed that are not under the root. */
  private readonly maskees = new Set<WeakRef<DisplayObject>>();
  /** Where those masks are placed, beside the root. */
  private readonly offList = new PixiContainer();

  /**
   * `fresh` makes a view that draws every object as new and leaves the
   * objects' dirty flags as they were, for a one-off render such as
   * BitmapData.draw's, so the stage's own view still sees each change.
   */
  /**
   * How many screen pixels a stage pixel covers, for the thinnest line,
   * which Flash draws a pixel of the screen wide however far the stage is
   * zoomed. The renderer's resolution unless set: a host that renders
   * finer than the screen to average down, as the test page does, sets it
   * to what the screen shows. A fresh view draws a BitmapData's pixels,
   * which are the stage's, so its thinnest line is a pixel.
   */
  screenScale: number | null = null;
  /** The thinnest line it last drew the stage's lines with; a change draws them all again. */
  private strokedAt = 0;
  /** Whether this prepare draws every line again, the screen's scale having changed. */
  private rescaled = false;

  constructor(
    readonly renderer: Renderer,
    private readonly fresh = false,
    /** The stage's view, whose geometry and textures a fresh view borrows where they are current. */
    private readonly source: PixiView | null = null,
  ) {}

  /**
   * Where a pointer event is on the SWF's stage. CSS `object-fit` shows the
   * canvas's pixels in a box of their own within its content box, letterboxed
   * by `contain`, cropped by `cover`: Pixi maps a point over the whole element
   * as `fill` would, so the point is taken within that box instead, centred
   * as the default `object-position` puts it, and then from the canvas's
   * pixels to Pixi's screen and the stage. `style` is the canvas's live
   * computed style, null where there is no DOM.
   */
  private stagePoint(
    player: Player,
    e: FederatedPointerEvent,
    style: CSSStyleDeclaration | null,
  ): [number, number] {
    const screen = this.renderer.screen;
    const toStage = (x: number, y: number): [number, number] => [
      (x * player.width) / screen.width,
      (y * player.height) / screen.height,
    ];
    const canvas = this.renderer.canvas as HTMLCanvasElement | undefined;
    if (!canvas?.getBoundingClientRect || !style) {
      return toStage(e.global.x, e.global.y);
    }

    // The content box: the element's rectangle within its borders and padding.
    const px = (v: string | undefined) => Number.parseFloat(v ?? "") || 0;
    const rect = canvas.getBoundingClientRect();
    let left = rect.left + px(style.borderLeftWidth) + px(style.paddingLeft);
    let top = rect.top + px(style.borderTopWidth) + px(style.paddingTop);
    const width =
      rect.width -
      px(style.borderLeftWidth) -
      px(style.paddingLeft) -
      px(style.borderRightWidth) -
      px(style.paddingRight);
    const height =
      rect.height -
      px(style.borderTopWidth) -
      px(style.paddingTop) -
      px(style.borderBottomWidth) -
      px(style.paddingBottom);

    let sx = width / canvas.width;
    let sy = height / canvas.height;
    const fit = style.objectFit;
    if (fit === "contain" || fit === "scale-down" || fit === "cover" || fit === "none") {
      let scale = fit === "cover" ? Math.max(sx, sy) : fit === "none" ? 1 : Math.min(sx, sy);
      if (fit === "scale-down") {
        scale = Math.min(scale, 1);
      }

      left += (width - canvas.width * scale) / 2;
      top += (height - canvas.height * scale) / 2;
      sx = scale;
      sy = scale;
    }

    const resolution = this.renderer.resolution || 1;
    return toStage((e.clientX - left) / sx / resolution, (e.clientY - top) / sy / resolution);
  }

  /** Let Pixi normalize browser coordinates; Flash's display list chooses the target. */
  bindPointer(player: Player): () => void {
    this.stage.eventMode = "static";
    this.stage.hitArea = new Rectangle(
      0,
      0,
      this.renderer.screen.width,
      this.renderer.screen.height,
    );
    // A move is posted, handled when the player next advances or before the
    // next press, release, leave or key; a frame callback of its own handles
    // it where the host does not advance (a paused player, say).
    let frame = 0;
    const canvas = this.renderer.canvas as HTMLCanvasElement | undefined;
    // Live: read once, it follows the element's style as the page changes it.
    const style =
      canvas?.getBoundingClientRect && typeof getComputedStyle === "function"
        ? getComputedStyle(canvas)
        : null;
    const send = (type: "move" | "down" | "up" | "leave") => (e: FederatedPointerEvent) => {
      const [x, y] = this.stagePoint(player, e, style);
      const p: PointerState = {
        x,
        y,
        button: e.button,
        buttons: e.buttons,
        altKey: e.altKey,
        ctrlKey: e.ctrlKey,
        shiftKey: e.shiftKey,
        time: e.timeStamp,
      };
      if (type === "move" && player.pointer && typeof requestAnimationFrame === "function") {
        player.pointer.post(p);
        frame ||= requestAnimationFrame(() => {
          frame = 0;
          player.pointer?.flush();
        });
        return;
      }

      player.pointer?.handle(type, p);
    };
    const move = send("move");
    const down = send("down");
    const up = send("up");
    const leave = send("leave");
    this.stage.on("pointermove", move);
    this.stage.on("pointerdown", down);
    this.stage.on("pointerup", up);
    this.stage.on("pointerupoutside", up);
    this.stage.on("pointerleave", leave);
    // Pixi sets the canvas's cursor on every move, from its target's, which
    // is this stage: the player's cursor goes there, and through Pixi's own
    // setter now, which keeps Pixi's record of it right.
    const events = (this.renderer as { events?: { setCursor(mode: string | null): void } }).events;
    const show = (cursor: string) => {
      this.stage.cursor = cursor;
      if (events) {
        events.setCursor(cursor);
      } else if (canvas?.style) {
        canvas.style.cursor = cursor;
      }
    };
    const pointer = player.pointer;
    if (pointer) {
      pointer.onCursor = show;
      show(pointer.cursor());
    }

    return () => {
      if (pointer) {
        pointer.onCursor = null;
        show("default");
      }

      if (frame) {
        cancelAnimationFrame(frame);
        frame = 0;
      }

      player.pointer?.flush();
      this.stage.off("pointermove", move);
      this.stage.off("pointerdown", down);
      this.stage.off("pointerup", up);
      this.stage.off("pointerupoutside", up);
      this.stage.off("pointerleave", leave);
      this.stage.eventMode = "passive";
      this.stage.hitArea = null;
    };
  }

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
      destroyContext(context);
    }

    // A container destroyed lets go of its filters without destroying them.
    for (const filter of this.builtFilters) {
      filter.destroy();
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
        blended: null,
        strokes: [],
        sharedLines: false,
        kids: [],
        released: false,
        bitmap: null,
        lines: [],
        masking: false,
        groups: [],
        scroll: null,
        clipped: false,
        color: null,
        inherited: null,
        blend: "normal",
        filterRecords: NO_RECORDS,
        filters: [],
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
    const done = this.clear(node);
    // Given back after the new ones are made, so that a texture or a blend they share is kept, not
    // made again.
    try {
      this.draw(o, node);
    } finally {
      done();
    }
  }

  /**
   * Empty the node of what it drew, and return what gives back its fills
   * and lines: a drawing's fills, a blend's, and every node's lines; a
   * Graphics frees only a context it made.
   */
  private clear(node: Node): () => void {
    // A Bitmap's texture is its store's: only the sprite goes.
    node.bitmap?.destroy();
    node.bitmap = null;
    const old = node.ownFills && !this.fresh ? node.fills : [];
    const oldLines = this.fresh ? [] : node.strokes.map((g) => g?.shared);
    const blend = node.blended;
    // A text's characters are in a container of their own; their shared glyph fills stay, not being theirs.
    for (const child of node.art.removeChildren()) {
      if (!child.destroyed) {
        child.destroy({ children: true });
      }
    }

    node.layers = [];
    node.fills = [];
    node.ownFills = false;
    node.blended = null;
    node.strokes = [];
    node.lines = [];
    return () => {
      for (const context of old) {
        destroyContext(context);
      }

      for (const context of oldLines) {
        if (context) {
          this.lines.give(context);
        }
      }

      if (blend) {
        this.blends.give(blend);
      }
    };
  }

  /** What `o` itself draws, into its node emptied of what it drew before. */
  private draw(o: DisplayObject, node: Node): void {
    const current = this.current(o);
    if (o instanceof BitmapObject) {
      this.drawBitmap(o, node);
      return;
    }

    if (o instanceof TextObject) {
      drawText(o, node.art);
      return;
    }

    if (o instanceof StaticTextObject) {
      drawStaticText(o, node.art);
      return;
    }

    const shape = o instanceof ShapeObject ? o.drawn() : null;
    node.layers = o.drawing?.layers ?? shape?.layers ?? [];
    const build = (layer: ShapeLayer) => {
      const context = fillContext(layer, this.painter);
      if (this.fresh) {
        this.built.push(context);
      }

      return context;
    };
    let fills: GraphicsContext[];
    node.ownFills = false;
    if (current && current.layers === node.layers && current.fills.length === node.layers.length) {
      fills = current.fills;
    } else if (shape && !o.drawing && !(o instanceof ShapeObject && o.morph)) {
      fills = this.fills.get(shape) ?? node.layers.map(build);
      this.fills.set(shape, fills);
    } else if (shape && !o.drawing && !this.fresh) {
      // A morph's blend, one of as many as its ratios: not with the shapes', which the view keeps.
      fills = this.blends.take(shape, () => node.layers.map(build));
      node.blended = shape;
    } else {
      fills = node.layers.map(build);
      node.ownFills = true;
    }

    node.fills = fills;
    // A blend's layers never change, so its lines are shared as a shape's: instances in step stroke
    // once.
    node.sharedLines = !this.fresh && !o.drawing && shape !== null;
    const lines =
      current &&
      sameLinear(current.world, node.world) &&
      this.source?.leastWidth === this.leastWidth
        ? current.strokes
        : null;
    node.layers.forEach((layer, i) => {
      node.art.addChild(new Graphics(fills[i]));
      const borrowed = lines?.[i];
      const strokes = layer.strokes.length
        ? borrowed
          ? new LinesGraphics(borrowed.shared)
          : new LinesGraphics()
        : null;
      if (strokes) {
        if (borrowed) {
          strokes.setFromMatrix(borrowed.localTransform);
        }

        node.art.addChild(strokes);
        node.lines.push(strokes);
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
   * An object off the list, and all below it: their lines given back, so
   * that the cache can let them go, and drawn again if they come back.
   */
  private release(o: DisplayObject): void {
    const node = this.nodes.get(o);
    if (!node || node.released) {
      return;
    }

    node.released = true;
    const chain = node.filters[0];
    if (chain instanceof FilterChain) {
      chain.forget();
    }

    // What it drew goes too: Pixi keeps a Graphics it has drawn, with its
    // geometry, for a minute after it was last drawn, which a timeline that
    // makes its children anew on every frame turns into gigabytes.
    this.clear(node)();

    // Those it last drew, which may since have left it too, and any it has now.
    const kids = new Set(node.kids);
    if (o instanceof Container) {
      for (const child of o.children) {
        kids.add(child);
      }
    }

    for (const kid of kids) {
      this.release(kid);
    }
  }

  /**
   * Draw the lines again for the object's transform on the stage: in the
   * stage's axes, under the inverse of that transform's linear part.
   */
  private restroke(node: Node): void {
    const m = node.world;
    const det = m[0] * m[3] - m[1] * m[2];
    const least = this.leastWidth;
    // One key and one inverse for all its layers.
    const key = linesKey(m, least);
    const inverse =
      det === 0 ? null : new Matrix(m[3] / det, -m[1] / det, -m[2] / det, m[0] / det, 0, 0);
    node.layers.forEach((layer, i) => {
      const strokes = node.strokes[i];
      if (!strokes) {
        return;
      }

      // The new context goes in before the old one goes back, as it may be the same.
      const previous = strokes.shared;
      if (node.sharedLines) {
        strokes.swap(this.lines.take(layer, m, least, key));
      } else {
        strokes.swap(linesContext(layer, m, least));
        this.counts.strokeContexts++;
        if (this.fresh) {
          this.built.push(strokes.shared);
        }
      }

      this.lines.give(previous);
      if (inverse) {
        strokes.setFromMatrix(inverse);
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
    own: DisplayObject["matrix"] = o.placed,
    inMask = false,
    tint: ColorTransform | null = null,
  ): PixiContainer {
    const node = this.node(o);
    const { container } = node;
    let dirty = this.fresh ? TRANSFORM | CHILDREN | CONTENT : o.dirty;
    if (node.released) {
      // Back from off the list: drawn again, its transform as if unknown, so that it and all below
      // draw their lines again.
      node.released = false;
      node.world = [Number.NaN, Number.NaN, Number.NaN, Number.NaN];
      dirty |= TRANSFORM | CONTENT;
    }

    // A mask is drawn, whatever its visibility, alpha and colour, by its fills alone.
    const masking = inMask || o.maskOf !== null || o.clipDepth > 0;
    const remask = masking !== node.masking;
    node.masking = masking;
    if (remask) {
      dirty |= TRANSFORM;
    }

    if (dirty & TRANSFORM) {
      const m = own;
      container.setFromMatrix(new Matrix(m.a, m.b, m.c, m.d, m.tx, m.ty));
      container.visible = o.visible || masking;
      // A blend mode composites the object as a layer (pixi-blend.ts); a mask is its fills alone.
      // Its filters, then its blend: adl filters the object, then blends what they make.
      const blend = masking ? "normal" : o.blendMode;
      const records = masking ? NO_RECORDS : o.filters;
      if (blend !== node.blend || records !== node.filterRecords) {
        node.blend = blend;
        node.filterRecords = records;
        for (const f of node.filters) {
          f.destroy();
        }

        // Flash's filters are WebGL's alone; Pixi skips a chain with one it
        // cannot run, so under WebGPU they are left out and the blend kept.
        const chain =
          this.renderer.type === RendererType.WEBGPU
            ? []
            : displayFilters(records, (map) => {
                // A displacement map's map: its store's texture, brought up to date as it is read.
                const store = (map as { $store?: BitmapStore }).$store;
                return store && !store.disposed
                  ? gpuBitmaps(this.renderer).texture(store, false)
                  : null;
              });
        // A view drawn once keeps no output.
        node.filters = chain.length > 0 ? [new FilterChain(chain, container, !this.fresh)] : [];
        if (this.fresh) {
          this.builtFilters.push(...node.filters);
        }

        const blending = blendFilters(blend);
        container.filters =
          node.filters.length > 0 || blending ? [...node.filters, ...(blending ?? [])] : null;
        if (blend !== "normal" && blend !== "layer") {
          this.checkBackBuffer();
        }
      }

      // Most objects have neither: they pay one test.
      if (o.mask || o.scroll || node.clipped) {
        if (this.clip(o, node) && o instanceof Container) {
          dirty |= CHILDREN;
        }
      }
    }

    // The colour transform from the stage down. One that only multiplies is
    // Pixi's tint and alpha, which Pixi composes down the tree itself; any
    // other is what is drawn's own (pixi-color.ts), and the tint stays white.
    let recolor = false;
    if (dirty & TRANSFORM || tint !== node.inherited) {
      node.inherited = tint;
      const ct = o.colorTransform;
      const color = masking ? null : ct ? (tint ? concatColor(tint, ct) : ct) : tint;
      if (!sameColor(color, node.color)) {
        node.color = color;
        recolor = true;
      }
    }

    const flash = node.color && !multipliesOnly(node.color) ? node.color : null;
    if (dirty & TRANSFORM || recolor) {
      const ct = flash || masking ? null : o.colorTransform;
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
    } else if ((moved || this.rescaled) && node.strokes.some((g) => g)) {
      this.restroke(node);
    }

    if (dirty & CONTENT || remask) {
      for (const lines of node.lines) {
        lines.visible = !masking;
      }
    }

    if (dirty & CONTENT || recolor) {
      for (const leaf of node.art.children) {
        setFlashColor(leaf, flash);
      }
    }

    if (dirty & PIXELS && !(dirty & CONTENT)) {
      // Pixels set since: the textures brought up to date, uploaded where the CPU changed them.
      const bitmaps = gpuBitmaps(this.renderer);
      if (node.bitmap && o instanceof BitmapObject && o.store) {
        bitmaps.texture(o.store, o.smoothing);
      }

      for (const layer of node.layers) {
        for (const { fill } of layer.fills) {
          if (fill.type === "image" && fill.image instanceof BitmapStore) {
            bitmaps.fillTexture(fill.image, fill.repeat, fill.smooth);
          }
        }
      }
    }

    // What its filters' kept output was drawn from changed, but for a move.
    // (A mask from outside it does not count: adl keeps the output, clipped as it was.)
    const chain = node.filters[0];
    if (
      chain instanceof FilterChain &&
      (dirty & ~TRANSFORM ||
        moved ||
        remask ||
        recolor ||
        this.rescaled ||
        // A scroll moves what is drawn within the input; any move of a scrolled object counts.
        (dirty & TRANSFORM && (o.scroll || node.scroll)) ||
        (o instanceof Container && o.descendantsDirty))
    ) {
      chain.changed();
    }

    if (o instanceof Container) {
      if (dirty & CHILDREN) {
        this.arrange(o, node, moved, masking);
      } else if (moved || remask || recolor || this.rescaled || o.descendantsDirty) {
        for (const child of o.children) {
          if (
            moved ||
            remask ||
            this.rescaled ||
            recolor ||
            child.dirty !== CLEAN ||
            (child instanceof Container && child.descendantsDirty)
          ) {
            this.sync(child, node.world, moved, child.placed, masking, node.color);
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

  /**
   * The children's containers in render order, under the object's art,
   * those a timeline's mask clips in a container the mask masks, nested as
   * the masks are; the masks themselves among them, where their place in
   * the tree puts them, though not drawn.
   */
  private arrange(o: Container, node: Node, moved: boolean, masking: boolean): void {
    const content = node.scroll?.content ?? node.container;
    for (const group of node.groups) {
      group.mask = null;
      group.destroy();
    }

    node.groups = [];
    content.removeChildren();
    content.addChild(node.art);
    // Those that left the list give their lines back, all the way down; one
    // moved to another parent is drawn there, perhaps already this frame.
    if (!this.fresh) {
      for (const kid of node.kids) {
        if (kid.parent === null) {
          this.release(kid);
        }
      }

      node.kids = [...o.children];
    }

    const clips = new Clips();
    const open: PixiContainer[] = [];
    for (const child of o.children) {
      open.length = clips.enter(child);
      const into = open.length > 0 ? open[open.length - 1] : content;
      const container = this.sync(child, node.world, moved, child.placed, masking, node.color);
      into.addChild(container);
      if (child.clipDepth > 0) {
        const group = new PixiContainer();
        group.mask = container;
        into.addChild(group);
        open.push(group);
        node.groups.push(group);
      }
    }
  }

  /**
   * The object's mask, and its scroll: true where the scroll's clip came
   * or went, which moves the children. A mask's own mask, or one that is
   * the object or above it, Pixi could not draw: it is left out.
   */
  private clip(o: DisplayObject, node: Node): boolean {
    const mask = o.mask && !o.maskOf && !o.mask.encloses(o) ? o.mask : null;
    node.container.mask = mask ? this.node(mask).container : null;
    if (mask) {
      this.maskees.add(o.ref);
    }

    const moved = this.scrollClip(o, node);
    node.clipped = mask !== null || node.scroll !== null;
    return moved;
  }

  /**
   * The object's scroll, as a clip of its art and children to the
   * rectangle, which its matrix's shift has moved to its place; true where
   * the clip came or went, which moves the children.
   */
  private scrollClip(o: DisplayObject, node: Node): boolean {
    const r = o.scroll;
    const scroll = node.scroll;
    if (!r) {
      if (!scroll) {
        return false;
      }

      scroll.content.mask = null;
      node.container.addChild(...scroll.content.removeChildren());
      scroll.clip.destroy();
      scroll.content.destroy();
      node.scroll = null;
      return true;
    }

    const clip = scroll?.clip ?? new Graphics();
    clip
      .clear()
      .rect(r.xMin, r.yMin, r.xMax - r.xMin, r.yMax - r.yMin)
      .fill(0xffffff);
    if (scroll) {
      return false;
    }

    const content = new PixiContainer();
    const children = node.container.removeChildren();
    if (children.length > 0) {
      content.addChild(...children);
    }

    content.mask = clip;
    node.container.addChild(clip, content);
    node.scroll = { clip, content };
    return true;
  }

  /**
   * The masks `mask` set that are not under `root`, off the display list
   * or elsewhere on it, each in `holder` at its place in the stage's space
   * (the space a draw draws into, for a draw's), as Flash places such a
   * mask; the objects they mask synced already.
   */
  private placeMasks(root: DisplayObject, holder: PixiContainer): void {
    holder.removeChildren();
    for (const ref of this.maskees) {
      const o = ref.deref();
      const mask = o?.mask;
      if (!o || !mask) {
        this.maskees.delete(ref);
        continue;
      }

      if (root.encloses(o) && !root.encloses(mask)) {
        holder.addChild(this.sync(mask, UNIT, false, toStage(mask, null), true));
      }
    }
  }

  /** Bring the stage up to date with `root`'s display list, without drawing. */
  /** The thinnest line, in stage pixels: a pixel of the screen. */
  private get leastWidth(): number {
    return this.fresh ? 1 : 1 / (this.screenScale ?? this.renderer.resolution ?? 1);
  }

  prepare(root: DisplayObject): void {
    this.lines.tick();
    this.blends.tick();
    this.rescaled = this.leastWidth !== this.strokedAt;
    this.strokedAt = this.leastWidth;
    const node = this.sync(root, UNIT, false);
    this.rescaled = false;
    if (node.parent !== this.stage) {
      this.stage.removeChildren();
      this.stage.addChild(node, this.offList);
    }

    this.placeMasks(root, this.offList);
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
    const node = view.sync(o, [1, 0, 0, 1], true, o.scroll ? shifted(m, o.scroll) : m);
    const scaled = new PixiContainer();
    const masks = new PixiContainer();
    scaled.addChild(node, masks);
    view.placeMasks(o, masks);
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

/**
 * Whether text laid out at (x, y), `width` by `height`, reaches outside its
 * field, which then clips it: where it lies, as a margin or an indent puts
 * it, not its size alone.
 */
export function overruns(
  field: { left: number; top: number; width: number; height: number },
  x: number,
  y: number,
  width: number,
  height: number,
): boolean {
  return (
    x < field.left ||
    y < field.top ||
    x + width > field.left + field.width ||
    y + height > field.top + field.height
  );
}

/** Glyphs' fills, made once and shared by every character drawn in them; null for an empty glyph. */
const glyphFills = new WeakMap<Glyph, GraphicsContext | null>();

/** A glyph's outline as a shape's fill, white for a tint to colour, in the font's units over 20, as shapeLayers takes twips. */
function glyphFill(glyph: Glyph): GraphicsContext | null {
  let context = glyphFills.get(glyph);
  if (context === undefined) {
    const shape = {
      id: 0,
      bounds: { xMin: 0, xMax: 0, yMin: 0, yMax: 0 },
      edgeBounds: null,
      fills: [{ type: "solid" as const, color: 0xffffffff }],
      lines: [],
      records: glyph.records,
      truncated: false,
    };
    const layers = shapeLayers(shape);
    context = layers.length > 0 ? fillContext(layers[0], (fill) => paint(fill as Fill)) : null;
    glyphFills.set(glyph, context);
  }

  return context;
}

/**
 * A TextField drawn from its layout (text-layout.ts): its background and
 * border, then each line from the first scrolled to, a character of an
 * embedded font as its glyph's shape, a run of a device font as one Pixi
 * Text on the line's baseline, each in its own colour, clipped to the
 * field where the text runs over it.
 */
function drawText(o: TextObject, art: PixiContainer): void {
  if (o.background || o.border) {
    const box = new Graphics();
    if (o.background) {
      box.rect(o.left, o.top, o.width, o.height).fill({ color: o.backgroundColor & 0xffffff });
    }

    // A border covers the pixels at both edges, x and x + width, as adl draws it.
    if (o.border) {
      box
        .rect(o.left + 0.5, o.top + 0.5, o.width, o.height)
        .stroke({ color: o.borderColor & 0xffffff, width: 1 });
    }

    art.addChild(box);
  }

  if (!o.model.text) {
    drawCaret(o, art);
    return;
  }

  const layout = o.layout;
  const first = Math.min(Math.max(0, o.scrollV - 1), layout.lines.length - 1);
  // The lines that fit the field from there, one at least: adl draws no line part of the way.
  const last = first + shownLines(o, first) - 1;
  const dx = o.left * 20 - o.scrollH * 20;
  const dy = o.top * 20 - (layout.lines[first].y - GUTTER);
  const text = new PixiContainer();
  let bottom = 0;
  let right = 0;
  let left = Number.POSITIVE_INFINITY;
  for (let l = first; l <= last; l++) {
    const line = layout.lines[l];
    const baseline = (dy + line.y + line.ascent) / 20;
    let run: LaidChar[] = [];
    const flush = () => {
      if (run.length > 0) {
        text.addChild(deviceRun(o, run, dx, baseline));
        run = [];
      }
    };
    for (const c of line.chars) {
      if (!c.shown) {
        continue;
      }

      if (c.font) {
        flush();
        const fill = c.glyph && glyphFill(c.glyph);
        if (fill) {
          const g = new Graphics(fill);
          const scale = (Math.max(0, c.format.size) * 20) / c.font.em;
          g.scale.set(scale);
          g.position.set((dx + c.x + c.kern) / 20, baseline);
          g.tint = c.format.color & 0xffffff;
          text.addChild(g);
        }
      } else if (run.length > 0 && run[0].format !== c.format) {
        flush();
        run.push(c);
      } else {
        run.push(c);
      }
    }

    flush();
    bottom = Math.max(bottom, dy + line.y + line.ascent + line.descent);
    right = Math.max(right, dx + line.x + line.width);
    left = Math.min(left, dx + line.x);
  }

  art.addChild(text);
  // Clipped inside the gutter, as adl clips it: 2 pixels in from each edge.
  const inner = {
    left: o.left + GUTTER / 20,
    top: o.top + GUTTER / 20,
    width: o.width - (2 * GUTTER) / 20,
    height: o.height - (2 * GUTTER) / 20,
  };
  // Where the text lies, scrolled: a scroll left of the gutter clips as one past the right does.
  const top = (dy + layout.lines[first].y) / 20;
  if (overruns(inner, left / 20, top, (right - left) / 20, bottom / 20 - top)) {
    const clip = new Graphics()
      .rect(inner.left, inner.top, Math.max(0, inner.width), Math.max(0, inner.height))
      .fill({ color: 0xffffff });
    art.addChild(clip);
    text.mask = clip;
  }

  drawCaret(o, art);
}

/** Static text: each glyph's shared fill, at its height and in its colour, under the text's matrix. */
function drawStaticText(o: StaticTextObject, art: PixiContainer): void {
  const m = o.definition.definition.matrix;
  const text = new PixiContainer();
  text.setFromMatrix(new Matrix(m.a, m.b, m.c, m.d, m.tx / 20, m.ty / 20));
  for (const placed of o.glyphs.glyphs) {
    const fill = glyphFill(placed.glyph);
    if (!fill) {
      continue;
    }

    // The fill is in the font's units over 20: a height in twips over the em puts it in pixels.
    const g = new Graphics(fill);
    g.scale.set(placed.height / placed.font.em);
    g.position.set(placed.x / 20, placed.y / 20);
    g.tint = placed.color & 0xffffff;
    g.alpha = (placed.color >>> 24) / 255;
    text.addChild(g);
  }

  art.addChild(text);
}

/**
 * A focused input field's caret, a pixel wide and its line's height, in
 * the colour of the text before it, and its selection shaded under it.
 */
function drawCaret(o: TextObject, art: PixiContainer): void {
  if (!o.focused || !(o.type === "input" || o.selectable)) {
    return;
  }

  const layout = o.layout;
  const lines = layout.lines;
  if (lines.length === 0) {
    return;
  }

  const first = Math.min(Math.max(0, o.scrollV - 1), lines.length - 1);
  const last = first + shownLines(o, first) - 1;
  const dx = o.left * 20 - o.scrollH * 20;
  const dy = o.top * 20 - (lines[first].y - GUTTER);
  // Inside the gutter, as the text is clipped: a caret scrolled out of view is not drawn.
  const inner = {
    left: o.left + GUTTER / 20,
    right: o.left + o.width - GUTTER / 20,
  };
  // Where index i is drawn: its line, and its x, the line's end past its last character.
  const place = (i: number) => {
    const line = lines.find((l) => i < l.end) ?? lines[lines.length - 1];
    const c = line.chars[i - line.start];
    const shown = line.chars.filter((ch) => ch.shown);
    const last = shown[shown.length - 1];
    const x = c ? c.x : last ? last.x + last.advance : line.x;
    return { line, x: (dx + x) / 20 };
  };
  const g = new Graphics();
  const [begin, end] = o.selection;
  if (begin < end) {
    const from = place(begin);
    const to = place(end);
    const a = lines.indexOf(from.line);
    const b = lines.indexOf(to.line);
    // Each shown line the selection covers, from its start or to its end where it goes on.
    for (let i = Math.max(a, first); i <= Math.min(b, last); i++) {
      const line = lines[i];
      const left = i === a ? from.x : (dx + line.x) / 20;
      const shown = line.chars.filter((ch) => ch.shown);
      const end = shown.length > 0 ? shown[shown.length - 1] : null;
      const right = i === b ? to.x : (dx + (end ? end.x + end.advance : line.x)) / 20;
      // Within the gutter, as the text is: a line wider than the field is clipped there.
      const l = Math.max(left, inner.left);
      const r = Math.min(right, inner.right);
      const top = (dy + line.y) / 20;
      const height = (line.ascent + line.descent) / 20;
      g.rect(l, top, Math.max(0, r - l), height).fill({ color: 0x3399ff, alpha: 0.4 });
    }
  }

  const at = place(o.caret);
  const index = lines.indexOf(at.line);
  if (
    o.type === "input" &&
    index >= first &&
    index <= last &&
    at.x >= inner.left &&
    at.x <= inner.right
  ) {
    const format = o.model.formats[Math.max(0, o.caret - 1)] ?? o.model.defaultFormat;
    const top = (dy + at.line.y) / 20;
    const height = Math.max(1, (at.line.ascent + at.line.descent) / 20);
    g.rect(at.x, top, 1, height).fill({ color: format.color & 0xffffff });
  }

  art.addChild(g);
}

/** A run of a device font's characters in one format, as Pixi Text from where the layout put its first, on the baseline. */
function deviceRun(o: TextObject, run: LaidChar[], dx: number, baseline: number): Text {
  const f = run[0].format;
  const chars = run.map((c) => (o.displayAsPassword ? "*" : o.model.text[c.index])).join("");
  const style = {
    fontFamily: fontFamily(f.font),
    fontSize: f.size,
    fill: f.color & 0xffffff,
    fontWeight: f.bold ? ("bold" as const) : ("normal" as const),
    fontStyle: f.italic ? ("italic" as const) : ("normal" as const),
    letterSpacing: f.letterSpacing,
  };
  const t = new Text({ text: chars, style });
  // Pixi's Text puts its top at its font's ascent above the baseline; without a DOM (node) there is no font to measure.
  const ascent =
    typeof document === "undefined"
      ? deviceMetrics(f.font, f.size, f.bold, f.italic).ascent
      : CanvasTextMetrics.measureFont(fontStringFromTextStyle(t.style)).ascent;
  t.position.set((dx + run[0].x) / 20, baseline - ascent);
  return t;
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
  /**
   * The same pixels sampled otherwise, copied on the GPU as the texture
   * changes: linearly for a smoothed Bitmap, and repeating or clamped,
   * either way, for bitmap fills; by "linear repeat".
   */
  private readonly variants = new Map<string, { texture: RenderTexture; version: number }>();

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

  /**
   * The texture sampled linearly or not, repeating or clamped: a
   * texture's sampling is its source's in Pixi, so each way is a copy.
   */
  sampled(linear: boolean, repeat: boolean): Texture {
    const key = `${linear} ${repeat}`;
    let variant = this.variants.get(key);
    if (!variant) {
      const texture = RenderTexture.create({
        width: this.source.width,
        height: this.source.height,
        scaleMode: linear ? "linear" : "nearest",
        addressMode: repeat ? "repeat" : "clamp-to-edge",
        autoGarbageCollect: false,
      });
      if (!repeat) {
        keepClamped(texture.source);
      }

      variant = { texture, version: -1 };
      this.variants.set(key, variant);
    }

    if (variant.version !== this.version) {
      const sprite = new Sprite(this.texture);
      this.renderer.render({ container: sprite, target: variant.texture, clear: true });
      sprite.destroy();
      variant.version = this.version;
    }

    return variant.texture;
  }

  destroy(): void {
    this.bitmaps.forget(this);
    this.texture.destroy(true);
    for (const { texture } of this.variants.values()) {
      texture.destroy(true);
    }
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

    return smoothing ? copy.sampled(true, false) : copy.texture;
  }

  /** The store's texture for a bitmap fill: repeating or clamped, smoothed or not, up to date. */
  fillTexture(store: BitmapStore, repeat: boolean, smooth: boolean): Texture | null {
    if (!this.texture(store)) {
      return null;
    }

    return (this.copies.get(store) as StoreTexture).sampled(smooth, repeat);
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

  /**
   * Each gradient's textures by region: one for a linear gradient, one for
   * each region a radial one fills, which `drawPath` and `copyFrom` can make
   * several of, each held by the contexts that draw with it.
   */
  private readonly gradients = new WeakMap<GradientFill, Map<string, GradientTexture>>();
  private readonly gradientsCollected = new FinalizationRegistry<Texture>((t) => t.destroy(true));

  /**
   * A gradient's texture and the matrix from its texels to the shape, made
   * once for each region and held: given back with `release` by each
   * context that took it, and freed when the last does, or when the fill is
   * collected. A linear one is its ramp of 256 colours, sampled nearest and
   * spread as the texture wraps, moved half a pixel so that a pixel's
   * centre reads what Flash reads at its corner. A radial one is computed
   * over the region it fills, a texel a pixel (up to RADIAL_MAX a side),
   * sampled linearly.
   */
  gradientTexture(fill: GradientFill, area: Area | null): GradientTexture {
    const region = area ?? { x: 0, y: 0, width: 1, height: 1 };
    const key = area ? `${area.x} ${area.y} ${area.width} ${area.height}` : "";
    let made = this.gradients.get(fill);
    if (!made) {
      made = new Map();
      this.gradients.set(fill, made);
    }

    const known = made.get(key);
    if (known) {
      known.uses++;
      return known;
    }

    const colors = ramp(fill.stops, fill.linearRgb);
    const m = fill.matrix;
    const columns = Math.min(RADIAL_MAX, region.width);
    const rows = Math.min(RADIAL_MAX, region.height);
    const clamped = fill.radial || fill.spread === 0;
    const source = new BufferImageSource({
      resource: rgbaOf(
        fill.radial
          ? radialPixels(colors, m, fill.focal, fill.spread, region, columns, rows)
          : colors,
      ),
      width: fill.radial ? columns : 256,
      height: fill.radial ? rows : 1,
      alphaMode: "premultiplied-alpha",
      scaleMode: fill.radial ? "linear" : "nearest",
      addressMode: clamped ? "clamp-to-edge" : fill.spread === 1 ? "mirror-repeat" : "repeat",
      autoGarbageCollect: false,
    });
    if (clamped) {
      keepClamped(source);
    }

    const texture = new Texture({ source });
    const matrix = fill.radial
      ? new Matrix(region.width / columns, 0, 0, region.height / rows, region.x, region.y)
      : new Matrix(1, 0, 0, 1, 0.5, 0.5)
          .append(new Matrix(m.a, m.b, m.c, m.d, m.tx, m.ty))
          // Texels to the gradient square, -819.2 to 819.2 a side.
          .append(new Matrix(1638.4 / 256, 0, 0, 1638.4, -819.2, -819.2));
    const byRegion = made;
    const entry: GradientTexture = {
      texture,
      matrix,
      uses: 1,
      release: () => {
        if (--entry.uses === 0) {
          byRegion.delete(key);
          this.gradientsCollected.unregister(entry);
          texture.destroy(true);
        }
      },
    };
    made.set(key, entry);
    this.gradientsCollected.register(fill, texture, entry);
    return entry;
  }
}

/** A gradient's texture for a region, and how many contexts hold it. */
interface GradientTexture {
  texture: Texture;
  matrix: Matrix;
  uses: number;
  release: () => void;
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
