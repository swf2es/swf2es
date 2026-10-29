// What a display object itself draws, under any children (render/view.ts):
// a shape's or a drawing's fills and lines, a bitmap's sprite, a text's
// glyphs and drawTriangles' meshes, built into its node's art as its
// content changes, and its lines stroked again as its transform does.
import {
  type GraphicsContext,
  Matrix,
  type Container as PixiContainer,
  type Renderer,
  RendererType,
  Sprite,
  type Texture,
} from "pixi.js";
import { BitmapStore } from "../bitmap/bitmap.js";
import {
  BitmapObject,
  CONTENT,
  cached,
  type DisplayObject,
  ShapeObject,
  StaticTextObject,
  TextObject,
} from "../display/display.js";
import { type Slice, sliceLayers } from "../display/scale9.js";
import { facing, type ShapeLayer, type TriangleMesh } from "../display/shapes.js";
import type { ShapeCharacter } from "../display/timeline.js";
import { characterStore, gpuBitmaps } from "./bitmaps.js";
import type { Node } from "./node.js";
import { SPARE_GRAPHICS_MOST, SPARE_MESHES_MOST } from "./pools.js";
import { SaffronView } from "./saffron.js";
import { SharedGraphics } from "./shared.js";
import {
  type Linear,
  linesContext,
  NO_LINES,
  StrokeContexts,
  sameLinear,
  scalesEvenly,
  settledStretch,
  stretchOf,
  strokeFrame,
  widestLine,
} from "./strokes.js";
import {
  destroyContext,
  type FillTessellator,
  fillContext,
  type Painter,
  paint,
  remakeable,
  resolveFills,
  SharedFills,
} from "./tessellate.js";
import { type Advanced, drawStaticText, drawText } from "./text.js";
import { TriangleView } from "./triangles.js";

/**
 * The slice that reshapes what an object itself draws, and the matrix from
 * its space to the owner's, null for the owner (Art.slicing).
 */
export type Slicing = { slice: Slice; m: DisplayObject["matrix"] | null };

/**
 * What the art asks of its view: the thinnest line, the target's pixels a
 * side of Flash's, and whether it draws into a 3D object's bitmap.
 */
export interface ArtView {
  readonly leastWidth: number;
  readonly flashPixel: number;
  readonly inPlane: boolean;
}

/** No transform, for a Graphics kept to be taken again (recycle). */
const IDENTITY = new Matrix();

/** What an emptied node has drawn, shared by all: replaced as it draws, never added to. */
const NO_LAYERS: ShapeLayer[] = [];
const NO_FILLS: GraphicsContext[] = [];

/** What a node's art child draws: a layer's fills, its lines, or textured triangles. */
const FILL = 0;
const LINE = 1;
const MESH = 2;

/**
 * Whether every one of `art` is a SharedGraphics or a TriangleView, which
 * a redraw keeps for its new content.
 */
function allKept(art: readonly PixiContainer[]): boolean {
  for (let i = 0; i < art.length; i++) {
    if (!(art[i] instanceof SharedGraphics || art[i] instanceof TriangleView)) {
      return false;
    }
  }

  return true;
}

/**
 * Whether art of the `kinds` lays out `layers` alike: a fill's for each
 * layer, a mesh for each of its triangles' that has a texture in
 * `textures` (in order; null where no layer has any), then its lines'
 * if it has any.
 */
function laidOutAs(
  kinds: readonly number[],
  layers: readonly ShapeLayer[],
  textures: readonly (Texture | null)[] | null,
): boolean {
  let k = 0;
  let t = 0;
  for (let i = 0; i < layers.length; i++) {
    const layer = layers[i];
    if (kinds[k++] !== FILL) {
      return false;
    }

    const meshes = layer.meshes;
    if (meshes && textures) {
      for (let m = 0; m < meshes.length; m++) {
        if (textures[t++] && kinds[k++] !== MESH) {
          return false;
        }
      }
    }

    if (layer.strokes.length > 0 && kinds[k++] !== LINE) {
      return false;
    }
  }

  return k === kinds.length;
}

/** Whether any of the layers has drawTriangles' textured triangles. */
function meshed(layers: readonly ShapeLayer[]): boolean {
  for (let i = 0; i < layers.length; i++) {
    if (layers[i].meshes) {
      return true;
    }
  }

  return false;
}

/** The objects' own drawing, for one view. */
export class Art {
  /** Graphics of children taken off, kept for the next content to take (SPARE_GRAPHICS_MOST). */
  private readonly spareGraphics: SharedGraphics[] = [];
  /**
   * Meshes of textured triangles taken off, oldest first, and when each
   * was, kept for the next content to take with their buffers, vertex
   * arrays and shaders (SPARE_MESHES_MOST, dropMeshes).
   */
  private readonly spareMeshes: TriangleView[] = [];
  private readonly sparedAt: number[] = [];
  /** The textures of a redraw's meshes, in order, null for one not drawn (draw). */
  private readonly meshTextures: (Texture | null)[] = [];
  /** What the nodes cleared give back once their new content is drawn (clear, giveBack). */
  private readonly giving = {
    fills: [] as GraphicsContext[],
    lines: [] as GraphicsContext[],
    shapes: [] as ShapeCharacter[],
  };
  /** The lines' contexts, shared by the instances that see them through the same transform. */
  readonly lines: StrokeContexts;
  /** A fresh view's fills of the shapes it built them for, shared by their instances; it destroys them with itself. */
  private readonly fills = new Map<ShapeCharacter, GraphicsContext[]>();
  /** The shapes' fills, shared by their instances and counted (tessellate.ts). */
  readonly shared = new SharedFills();
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
  /** What a fresh view built itself, which it destroys; what it borrowed from `source` stays. */
  private readonly built = new Set<GraphicsContext>();
  /** What a fresh view borrowed from its source's caches, which it neither gives back nor destroys. */
  private readonly borrowed = new WeakSet<GraphicsContext>();
  /** Its drawings' textured triangles drawn, which the view tells of a new pixel or smoothing. */
  readonly meshes = new Set<TriangleView>();
  /** What its advanced texts share, which the view tells of the world's scale to Flash's pixels. */
  readonly saffron: SaffronView;

  constructor(
    private readonly renderer: Renderer,
    /** Whether the view draws once (PixiView's `fresh`): it builds its own, and keeps nothing. */
    private readonly fresh: boolean,
    private readonly view: ArtView,
    /** The view's nodes by their objects. */
    private readonly nodes: WeakMap<DisplayObject, Node>,
    /** The stage's view's art, whose geometry a fresh view's borrows where it is current. */
    private readonly source: Art | null,
    /** The view's counts of lines' contexts made and reused. */
    private readonly counts: { strokeContexts: number; strokeReuses: number },
    private readonly tessellator?: FillTessellator,
  ) {
    this.lines = new StrokeContexts(counts);
    this.saffron = new SaffronView(renderer, !fresh);
    if (!fresh) {
      // Their GPU copies went with the context: made again as drawn, they are no better than new.
      renderer.runners?.contextChange?.add({ contextChange: () => this.dropMeshes() });
    }
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

  /** Destroy the contexts a fresh view built; what it borrowed stays its owner's. */
  destroyBuilt(): void {
    for (const context of this.built) {
      destroyContext(context);
    }
  }

  /**
   * The slice that reshapes what `o` itself draws, and the matrix from its
   * space to the owner's, null for the owner: as display/scale9.ts's
   * sliceFor, from the slices this view keeps, which its syncs made.
   */
  slicing(o: DisplayObject, node: Node): Slicing | null {
    if (node.masking) {
      return null;
    }

    if (node.slice) {
      return { slice: node.slice, m: null };
    }

    const parent = o.parent;
    // A filtered Shape adl draws as a bitmap of it, stretched whole (display/scale9.ts, sliceFor).
    const slice =
      o instanceof ShapeObject && parent?.scale9Grid && o.filters.length === 0
        ? this.nodes.get(parent)?.slice
        : null;
    return slice ? { slice, m: o.placed } : null;
  }

  /**
   * What `o` itself draws, built anew: a shape's layers, whose fills are
   * shared by every instance of the character, or its drawing's, which are
   * its own and change.
   */
  redraw(o: DisplayObject, node: Node): void {
    this.clear(node, true);
    // Given back after the new ones are made, so that a texture or a blend they share is kept, not
    // made again.
    try {
      this.draw(o, node);
    } finally {
      this.giveBack();
      // Drawn, the new content has taken or dropped them all; one that threw has not.
      this.dropSpare(node);
    }
  }

  /**
   * Empty the node of what it drew, listing for giveBack what gives back
   * its fills and lines: a drawing's fills, a blend's, and every node's
   * lines; a Graphics frees only a context it made.
   */
  clear(node: Node, keep = false): void {
    // A Bitmap's texture is its store's: only the sprite goes.
    node.bitmap?.destroy();
    node.bitmap = null;
    // Listed in the view's own lists, not in arrays of their own: an object is emptied and drawn
    // anew each time its content changes, hundreds of times a frame in an animated crowd.
    const giving = this.giving;
    if (node.ownFills && !this.fresh) {
      for (let i = 0; i < node.fills.length; i++) {
        giving.fills.push(node.fills[i]);
      }
    }

    if (!this.fresh) {
      for (let i = 0; i < node.strokes.length; i++) {
        const context = node.strokes[i]?.shared;
        if (context) {
          giving.lines.push(context);
        }
      }
    }

    if (node.sharedFills) {
      giving.shapes.push(node.sharedFills);
    }

    // A shape's Graphics stay where they are, for the content drawn next to take in place: taken
    // off and put on, they changed the structure of its render group, which Pixi then rebuilt
    // whole, an animated character's every frame its timeline swapped a shape.
    const art = node.art.children;
    if (keep && art.length > 0 && allKept(art)) {
      const lines = node.lines;
      node.spare ??= { art: [], kinds: [] };
      const spare = node.spare;
      spare.art.length = 0;
      spare.kinds.length = 0;
      for (let i = 0; i < art.length; i++) {
        const child = art[i] as SharedGraphics | TriangleView;
        spare.art.push(child);
        spare.kinds.push(
          child instanceof TriangleView
            ? MESH
            : lines.includes(child as SharedGraphics)
              ? LINE
              : FILL,
        );
      }

      node.spared = true;
    } else {
      // A text's characters are in a container of their own; their shared
      // glyph fills stay, not being theirs. A shape's Graphics and meshes
      // are kept for the next content to take.
      for (const child of node.art.removeChildren()) {
        if (child instanceof SharedGraphics && !this.fresh) {
          this.recycle(child);
        } else if (child instanceof TriangleView && !this.fresh) {
          this.recycleMesh(child);
        } else if (!child.destroyed) {
          child.destroy({ children: true });
        }
      }
    }

    node.layers = NO_LAYERS;
    node.fills = NO_FILLS;
    node.ownFills = false;
    node.sharedFills = null;
    node.strokes.length = 0;
    node.lines.length = 0;
  }

  /** Give back what the nodes cleared since listed (clear): their fills, lines and shapes' fills. */
  giveBack(): void {
    const { fills, lines, shapes } = this.giving;
    try {
      for (let i = 0; i < fills.length; i++) {
        if (fills[i] !== NO_LINES) {
          destroyContext(fills[i]);
        }
      }

      for (let i = 0; i < lines.length; i++) {
        this.lines.give(lines[i]);
      }

      for (let i = 0; i < shapes.length; i++) {
        this.shared.give(shapes[i]);
      }
    } finally {
      fills.length = 0;
      lines.length = 0;
      shapes.length = 0;
    }
  }

  /**
   * The shape a Shape draws: the one Flash's stale bitmap cache shows,
   * while it stands on the stage at the scale it was drawn at; a mask
   * clips by the shape it is.
   */
  private shapeOf(o: ShapeObject, node: Node): ShapeCharacter | null {
    const cache = o.stale;
    if (!cache || node.masking) {
      return o.drawn();
    }

    if (node.stale?.cache !== cache) {
      // A first frame with its cache off already draws it as it is.
      node.stale = { cache, world: [...node.world], spent: !cached(o) };
    }

    return node.stale.spent ? o.drawn() : cache.shape;
  }

  /**
   * How a text draws its advanced glyphs (render/saffron.ts): not at all, as
   * normal text, where the renderer cannot, or in a 3D object's bitmap,
   * whose pixels are not the stage's.
   */
  private advanced(o: DisplayObject, node: Node): Advanced | null {
    if (!this.saffron.enabled || this.view.inPlane) {
      return null;
    }

    const w = node.world;
    return {
      view: this.saffron,
      scale: Math.sqrt(Math.abs(w[0] * w[3] - w[1] * w[2])),
      again: () => o.invalidate(CONTENT),
    };
  }

  /** What `o` itself draws, into its node emptied of what it drew before. */
  private draw(o: DisplayObject, node: Node): void {
    const current = this.current(o);
    // A bitmap or a text draws no Graphics the last content's could stand for.
    if (o instanceof BitmapObject || o instanceof TextObject || o instanceof StaticTextObject) {
      this.dropSpare(node);
    }

    if (o instanceof BitmapObject) {
      this.drawBitmap(o, node);
      return;
    }

    if (o instanceof TextObject) {
      drawText(o, node.art, this.advanced(o, node), node.textResolution);
      return;
    }

    if (o instanceof StaticTextObject) {
      drawStaticText(o, node.art, this.advanced(o, node));
      return;
    }

    const shape = o instanceof ShapeObject ? this.shapeOf(o, node) : null;
    // adl culls drawTriangles' triangles as they turn on the screen, or in a BitmapData's draw.
    const w = node.world;
    node.mirrored = w[0] * w[3] - w[1] * w[2] < 0;
    node.layers = o.drawing
      ? facing(o.drawing.layers, node.mirrored, o.drawing.version)
      : (shape?.layers ?? []);
    const slicing = this.slicing(o, node);
    if (slicing) {
      node.layers = sliceLayers(node.layers, slicing.slice, slicing.m, o.drawing?.version);
    }

    let fills: GraphicsContext[];
    node.ownFills = false;
    const build = node.masking && o.drawing ? this.buildMaskFills : this.buildFills;
    if (
      current &&
      current.masking === node.masking &&
      current.layers === node.layers &&
      current.fills.length === node.layers.length
    ) {
      fills = current.fills;
    } else if (shape && !o.drawing && !slicing && !this.fresh) {
      // A shape's, or a morph's blend's, shared and counted: they go once nothing draws them.
      fills = this.shared.take(shape, node.layers, build);
      node.sharedFills = shape;
    } else if (shape && !o.drawing && !slicing) {
      // A fresh view borrows the stage's, which its object, off the list, may no longer hold;
      // else builds its own, shared by its instances, which it destroys with the rest.
      fills = this.source?.shared.peek(shape) ?? this.fills.get(shape) ?? build(node.layers);
      this.fills.set(shape, fills);
    } else {
      fills = this.buildFills(node.layers, build === this.buildMaskFills, true);
      node.ownFills = true;
    }

    node.fills = fills;
    // A blend's layers never change, so its lines are shared as a shape's: instances in step stroke
    // once.
    node.sharedLines = !o.drawing && shape !== null && !slicing;
    const lines =
      current &&
      !slicing &&
      sameLinear(current.world, node.world) &&
      current.strokedAt === this.view.leastWidth &&
      this.source?.view.leastWidth === this.view.leastWidth
        ? current.strokes
        : null;
    // The textures of the meshes first, which decide the meshes drawn.
    const textures = meshed(node.layers) ? this.texturesOf(node.layers) : null;
    // The Graphics and meshes the last content left, taken in place where it laid out its fills,
    // meshes and lines alike.
    const spare =
      node.spared && node.spare && laidOutAs(node.spare.kinds, node.layers, textures)
        ? node.spare.art
        : null;
    if (!spare) {
      this.dropSpare(node);
    }

    node.spared = false;
    // A loop, not forEach with closures: a crowd's shapes are drawn again hundreds of times a frame.
    let next = 0;
    let t = 0;
    node.widest = 0;
    const layers = node.layers;
    for (let i = 0; i < layers.length; i++) {
      const layer = layers[i];
      if (layer.strokes.length > 0 && scalesEvenly(layer)) {
        node.widest = Math.max(node.widest, widestLine(layer));
      }

      this.graphic(node, spare, next++, fills[i]);
      const meshes = layer.meshes;
      if (meshes && textures) {
        for (let k = 0; k < meshes.length; k++) {
          const texture = textures[t++];
          if (texture) {
            this.drawMesh(node, spare, next++, meshes[k], texture);
          }
        }
      }

      const borrowed = lines?.[i];
      const strokes = layer.strokes.length
        ? this.graphic(node, spare, next++, borrowed?.shared)
        : null;
      if (strokes) {
        if (borrowed) {
          strokes.setFromMatrix(borrowed.localTransform);
        }

        node.lines.push(strokes);
      }

      node.strokes.push(borrowed ? null : strokes);
    }

    this.restroke(node);
  }

  /**
   * The texture each of the layers' meshes is drawn with, in order: null
   * for one of no triangles, or where the renderer is not WebGL's.
   */
  private texturesOf(layers: readonly ShapeLayer[]): (Texture | null)[] {
    const textures = this.meshTextures;
    textures.length = 0;
    const bitmaps = gpuBitmaps(this.renderer);
    const gl = this.renderer.type === RendererType.WEBGL;
    for (let i = 0; i < layers.length; i++) {
      const meshes = layers[i].meshes;
      if (meshes) {
        for (let k = 0; k < meshes.length; k++) {
          const mesh = meshes[k];
          textures.push(gl && mesh.positions.length ? bitmaps.texture(mesh.image) : null);
        }
      }
    }

    return textures;
  }

  /**
   * Textured triangles, after what the node draws so far: the `k`th mesh
   * the last content left, in place, or one kept or made, put on.
   */
  private drawMesh(
    node: Node,
    spare: (SharedGraphics | TriangleView)[] | null,
    k: number,
    mesh: TriangleMesh,
    texture: Texture,
  ): void {
    const pixel = this.view.flashPixel;
    let view: TriangleView;
    if (spare) {
      view = spare[k] as TriangleView;
      view.draw(mesh, texture, pixel);
    } else {
      const kept = this.spareMeshes.pop();
      this.sparedAt.pop();
      if (kept) {
        kept.draw(mesh, texture, pixel);
        view = kept;
      } else {
        view = new TriangleView(mesh, texture, pixel, this.meshes);
      }

      node.art.addChild(view);
    }

    view.smoothing = gpuBitmaps(this.renderer).smoothing;
  }

  /** The fills of `layers` for a mask, built as buildFills builds them. */
  private readonly buildMaskFills = (layers: readonly ShapeLayer[]): GraphicsContext[] =>
    this.buildFills(layers, true);

  /**
   * The fills of `layers`, built: a fresh view's to destroy with the rest.
   * A node's `own`, which it gives back as it is drawn again, show NO_LINES
   * for a layer of no fills, as drawTriangles' textured triangles leave
   * one a call, which a 3D engine makes hundreds of every frame.
   */
  private readonly buildFills = (
    layers: readonly ShapeLayer[],
    masking = false,
    own = false,
  ): GraphicsContext[] => {
    const fills: GraphicsContext[] = [];
    for (let i = 0; i < layers.length; i++) {
      const layer = layers[i];
      if (own && layer.fills.length === 0) {
        fills.push(NO_LINES);
        continue;
      }

      const resolved = this.tessellator
        ? resolveFills(layer, masking, this.tessellator)
        : undefined;
      const make = () => fillContext(layer, this.painter, masking, resolved);
      const context = remakeable(make(), make);
      if (this.fresh) {
        this.built.add(context);
      }

      fills.push(context);
    }

    return fills;
  };

  /**
   * The Graphics the `k`th of a node's new content draws `context` with:
   * the `k`th the last content left, in place, or one kept or made, put on.
   */
  private graphic(
    node: Node,
    spare: (SharedGraphics | TriangleView)[] | null,
    k: number,
    context: GraphicsContext | undefined,
  ): SharedGraphics {
    if (!spare) {
      const made = this.spareGraphics.pop() ?? new SharedGraphics(NO_LINES);
      made.swap(context ?? NO_LINES);
      node.art.addChild(made);
      return made;
    }

    const kept = spare[k] as SharedGraphics;
    // A line's shows none till restroke gives it its own, and gives back the old.
    kept.swap(context ?? NO_LINES);
    return kept;
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

  /** Keep the Graphics a redraw kept for its new content that it did not take, or destroy them in a fresh view. */
  private dropSpare(node: Node): void {
    const spare = node.spare;
    if (!node.spared || !spare) {
      return;
    }

    node.spared = false;
    for (let i = 0; i < spare.art.length; i++) {
      const leaf = spare.art[i];
      leaf.parent?.removeChild(leaf);
      if (this.fresh) {
        leaf.destroy();
      } else if (leaf instanceof TriangleView) {
        this.recycleMesh(leaf);
      } else {
        this.recycle(leaf);
      }
    }

    spare.art.length = 0;
    spare.kinds.length = 0;
  }

  /** Keep a mesh taken off for the next content to take, or destroy it past the most kept. */
  private recycleMesh(view: TriangleView): void {
    if (view.destroyed) {
      return;
    }

    if (this.spareMeshes.length >= SPARE_MESHES_MOST) {
      view.destroy();
      return;
    }

    view.park();
    this.spareMeshes.push(view);
    this.sparedAt.push(performance.now());
  }

  /**
   * Destroy the meshes kept that no content took since `before`, or all:
   * as the renderer's context is lost, which took their GPU copies, or the
   * view goes.
   */
  dropMeshes(before = Number.POSITIVE_INFINITY): void {
    const spare = this.spareMeshes;
    let n = 0;
    while (n < spare.length && this.sparedAt[n] < before) {
      spare[n++].destroy();
    }

    if (n > 0) {
      spare.splice(0, n);
      this.sparedAt.splice(0, n);
    }
  }

  /**
   * Keep a Graphics of a child taken off for the next content to take, as
   * a new one would be: showing nothing, untransformed, uncoloured, shown
   * and drawn alone, its GPU data let go of as destroying it did; or
   * destroy it past the most kept.
   */
  private recycle(graphic: SharedGraphics): void {
    if (graphic.destroyed) {
      return;
    }

    if (this.spareGraphics.length >= SPARE_GRAPHICS_MOST) {
      graphic.destroy();
      return;
    }

    graphic.unload();
    graphic.settled = false;
    graphic.flashColor = null;
    graphic.swap(NO_LINES);
    graphic.setFromMatrix(IDENTITY);
    graphic.visible = true;
    this.spareGraphics.push(graphic);
  }

  /**
   * Draw the lines again for the object's transform on the stage: in the
   * stage's axes, under the inverse of that transform's linear part, or
   * for a layer whose lines scale both ways, through its stretch alone,
   * under the stretch's inverse (stretchOf).
   */
  restroke(node: Node, moved = false): void {
    // Keep syncing hidden branches, but build their lines only when they can be drawn.
    // NaN also prevents a BitmapData draw from borrowing lines at an obsolete transform.
    if (node.hidden && !this.fresh) {
      node.strokedAt = Number.NaN;
      return;
    }

    const m = node.world;
    const least = this.view.leastWidth;
    // Turned or mirrored, or stretched within one settled stretch: the lines and the inverse they
    // are under stay, as a limb's that only turns on every frame.
    // Settled once, for the test and the lines alike.
    let settled: Linear | null | undefined;
    if (moved && node.stretched && node.strokedAt === least) {
      const stretch = stretchOf(m);
      settled = stretch && settledStretch(stretch, node.widest, least, stretch);
      if (settled && sameLinear(settled, node.stretched)) {
        return;
      }
    }

    node.strokedAt = least;
    const by = node.lineSpace;
    // One key and one inverse for all its layers of each kind, made as one first needs them.
    let exact: ReturnType<typeof strokeFrame> | null = null;
    let scaled: ReturnType<typeof strokeFrame> | null | undefined;
    // A loop, not forEach with closures: every shape that moves on a frame is stroked again.
    const layers = node.layers;
    for (let i = 0; i < layers.length; i++) {
      const strokes = node.strokes[i];
      if (!strokes) {
        continue;
      }

      const layer = layers[i];
      const even = scalesEvenly(layer);
      if (scaled === undefined && !by && even) {
        if (settled === undefined) {
          const stretch = stretchOf(m);
          settled = stretch && settledStretch(stretch, node.widest, least, stretch);
        }

        scaled = settled && strokeFrame(settled, least);
      }

      let frame: ReturnType<typeof strokeFrame>;
      if (scaled && even) {
        frame = scaled;
      } else {
        exact ??= strokeFrame(m, least);
        frame = exact;
      }

      const { m: seen, key, inverse } = frame;
      // The new context goes in before the old one goes back, as it may be the same.
      const previous = strokes.shared;
      // A fresh view borrows the stage's lines where it draws them alike.
      const kept =
        this.fresh && node.sharedLines && this.source?.view.leastWidth === least
          ? this.source.lines.peek(layer, key)
          : null;
      if (kept) {
        strokes.swap(kept);
        this.borrowed.add(kept);
      } else if (node.sharedLines && !this.fresh) {
        strokes.swap(this.lines.take(layer, seen, least, key));
      } else {
        strokes.swap(linesContext(layer, seen, least, by ?? seen));
        this.counts.strokeContexts++;
        if (this.fresh) {
          this.built.add(strokes.shared);
        }
      }

      if (!this.borrowed.has(previous) && !this.built.has(previous)) {
        this.lines.give(previous);
      }
      if (inverse) {
        strokes.setFromMatrix(inverse);
      }
    }

    node.stretched = scaled && !exact ? scaled.m : null;
  }
}
