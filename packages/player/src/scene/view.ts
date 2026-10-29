// The renderer of swf2es's own as the player drives it (docs/renderer.md):
// a view that owns a WebGL 2 canvas, walks the display list into a scene
// list and its rows, and has @swf2es/render plan and draw it. It stands
// beside PixiView behind a switch until it draws everything Pixi draws;
// for now, the fills of shapes and drawings, solid, bitmap and gradient,
// their lines, bitmaps, and text.
import { type ColorTransform, type Glyph, IDENTITY, type Matrix } from "@swf2es/format";
import { Tessellator } from "@swf2es/native/tessellate";
import {
  BLEND_NAMES,
  CLAMP,
  Commands,
  Geometries,
  type GeometryHandle,
  LAYER,
  LAYER_BEGIN,
  LAYER_END,
  MASK_BEGIN,
  MASK_POP,
  MASK_USE,
  MIRROR,
  NORMAL,
  plan,
  REPEAT,
  Rows,
  SceneList,
  SMOOTH,
  type TextureHandle,
  Textures,
} from "@swf2es/render";
import { WebGLBackend } from "@swf2es/render/webgl";
import { BitmapStore, characterStore, rgbaOf } from "../bitmap/bitmap.js";
import { BitmapObject } from "../display/bitmapobject.js";
import { concatColor } from "../display/color.js";
import { Container } from "../display/container.js";
import { CLEAN, type DisplayObject } from "../display/displayobject.js";
import { concat } from "../display/geometry.js";
import { type Region as Area, radialPixels, ramp } from "../display/gradients.js";
import { ShapeObject } from "../display/shapeobject.js";
import {
  type GradientFill,
  type ImageFill,
  type ShapeLayer,
  shapeLayers,
} from "../display/shapes.js";
import { StaticTextObject, TextObject } from "../display/textobjects.js";
import { Clips } from "../display/walk.js";
import type { Drawer } from "../hosts.js";
import { cssFont } from "../text/fonts.js";
import type { FillTessellator } from "./fills.js";
import { bitmapQuad, layerParts, type Part, radialTexels, unsupported } from "./shapes.js";
import { layerStrokes } from "./strokes.js";
import {
  type DeviceItem,
  deviceTextResolution,
  fieldItems,
  glyphShape,
  staticItems,
  type TextItem,
  type TextOmissions,
} from "./text.js";

export interface RenderViewOptions {
  /** The stage's size in pixels, and the canvas' pixels a stage pixel. */
  width: number;
  height: number;
  resolution?: number;
  /** The canvas to draw on; one is made if left out. */
  canvas?: HTMLCanvasElement;
  /** The stage's colour, 0xRRGGBB, and whether the canvas is left clear instead. */
  background?: number;
  transparent?: boolean;
  /** Keep what was drawn after it is shown, for a page to read it back. */
  preserveDrawingBuffer?: boolean;
  /** The fills' tessellator: @swf2es/native's, made here, if left out. */
  fillTessellator?: FillTessellator;
}

/**
 * How many frames a gradient's texture may go undrawn: a morph tweening a
 * gradient makes a new one for each ratio, up to a megabyte each, which
 * the usual idle frames would hold hundreds of.
 */
const GRADIENT_IDLE_FRAMES = 30;

/** The most transforms a layer's lines are kept for: its instances in step, and a loop's turns. */
const LINE_KEYS = 64;

/** Device text runs kept by key past which those let go of are forgotten. */
const RUN_KEYS = 512;

/**
 * How many frames a run of device text may go undrawn: a counter or a field
 * typed into makes a new one each frame, which the usual idle frames would
 * hold hundreds of.
 */
const TEXT_IDLE_FRAMES = 30;

/** The most texels a run of device text has a side, under every WebGL 2's least texture size. */
const TEXT_MOST = 4096;

/** A run of device text rasterized: its texture and size, its origin `left` texels in, and its canvas pixels a stage pixel. */
interface DeviceRun {
  handle: TextureHandle;
  width: number;
  height: number;
  left: number;
  resolution: number;
}

/** A layer's parts as made, for its drawing's version, as a drawing changes its layers in place. */
interface Made {
  parts: { part: Part; handle: GeometryHandle }[];
  version: number;
}

/** A texture made of pixels that change: a store's, kept as of its version. */
interface Kept {
  handle: TextureHandle;
  version: number;
}

/**
 * Draws the player's display list on a canvas of its own. Each render
 * walks the whole list, writing a row for each object drawn and an entry
 * for each of its layers' geometries, each geometry made once and kept
 * while drawn; then plans the frame and has the backend draw it.
 */
export class RenderView implements Drawer {
  readonly canvas: HTMLCanvasElement;
  readonly gl: WebGL2RenderingContext;
  /** View pixels a stage pixel, before the resolution: a host showing the stage larger. */
  scale = 1;
  /** Screen pixels a stage pixel, which hairlines will be drawn a pixel of; the scale's if null. */
  screenScale: number | null = null;
  background: number;
  transparent: boolean;
  private resolution: number;
  private width: number;
  private height: number;
  private stageQuality = "HIGH";
  private readonly backend: WebGLBackend;
  private readonly tessellator: FillTessellator;
  /** Whether the view made its canvas, whose context it then loses with itself. */
  private readonly ownCanvas: boolean;
  /** The tessellator the view made, which it disposes of with itself; none if it was given one. */
  private readonly ownTessellator: Tessellator | null = null;
  private readonly scene = new SceneList();
  private readonly rows = new Rows();
  private readonly geometries = new Geometries();
  private readonly textures = new Textures();
  private readonly commands = new Commands();
  private readonly made = new WeakMap<ShapeLayer, Made>();
  private readonly maskMade = new WeakMap<ShapeLayer, Made>();
  /** The masks pushed and not yet popped, as each one's first draw and count. */
  private readonly masks: number[] = [];
  /**
   * Each layer's lines by what they were stroked for: the linear transform
   * on the stage and the least width, a pixel of the screen, as a key; and
   * the drawing's version.
   */
  private readonly lines = new WeakMap<
    ShapeLayer,
    Map<string, { handle: GeometryHandle | null; version: number }>
  >();
  private readonly quads = new Map<string, GeometryHandle>();
  /** Each glyph's fill, made once for every text drawn in it; null for an empty glyph. */
  private readonly glyphs = new WeakMap<Glyph, GeometryHandle | null>();
  /** Device text rasterized, by its text, font, spacing and resolution. */
  private readonly runs = new Map<string, DeviceRun>();
  /** The canvas device text is rasterized on, made as first needed. */
  private textCanvas: { canvas: HTMLCanvasElement; context: CanvasRenderingContext2D } | null =
    null;
  private readonly stores = new WeakMap<BitmapStore, Kept>();
  /** Each gradient's textures, by the region a radial one covers ("" for a linear one). */
  private readonly gradients = new WeakMap<GradientFill, Map<string, TextureHandle>>();

  constructor(options: RenderViewOptions) {
    this.width = options.width;
    this.height = options.height;
    this.resolution = options.resolution ?? 1;
    this.background = options.background ?? 0xffffff;
    this.transparent = options.transparent ?? false;
    this.ownCanvas = !options.canvas;
    this.canvas = options.canvas ?? document.createElement("canvas");
    const gl = this.canvas.getContext("webgl2", {
      alpha: this.transparent,
      antialias: false,
      depth: false,
      premultipliedAlpha: true,
      preserveDrawingBuffer: options.preserveDrawingBuffer ?? false,
      stencil: true,
    });
    if (!gl) {
      throw new Error("the renderer needs WebGL 2");
    }

    this.gl = gl;
    this.backend = new WebGLBackend(gl);
    if (options.fillTessellator) {
      this.tessellator = options.fillTessellator;
    } else {
      this.ownTessellator = new Tessellator();
      this.tessellator = this.ownTessellator.tessellate;
    }

    this.canvas.addEventListener("webglcontextlost", this.lost);
    this.canvas.addEventListener("webglcontextrestored", this.restored);
    this.resize(this.width, this.height, this.resolution);
  }

  /** A lost context is asked back, as Flash's player would have it, by preventing the default. */
  private readonly lost = (event: Event) => {
    event.preventDefault();
  };

  /** The context came back: the backend made again, and every texture added again as it is drawn. */
  private readonly restored = () => {
    this.backend.restore(this.geometries);
    this.textures.lost();
  };

  /** The stage's quality, "LOW" to "BEST", which will decide bitmaps' smoothing. */
  get quality(): string {
    return this.stageQuality;
  }

  set quality(quality: string) {
    this.stageQuality = quality;
  }

  /** The canvas made `width` by `height` stage pixels at `resolution` canvas pixels each. */
  resize(width: number, height: number, resolution = this.resolution): void {
    this.width = width;
    this.height = height;
    this.resolution = resolution;
    this.canvas.width = Math.max(1, Math.round(width * resolution));
    this.canvas.height = Math.max(1, Math.round(height * resolution));
  }

  /** Draw `root`'s display list. */
  render(root: DisplayObject): void {
    this.scene.reset();
    this.rows.reset();
    this.walk(root, 1, 0, 0, 1, 0, 0, null, false);
    plan(this.scene, this.transparent ? 0 : (0xff000000 | this.background) >>> 0, this.commands);
    // The drawing buffer, which a browser may hold smaller than the canvas asks for.
    this.backend.execute(this.commands, this.scene, this.rows, this.geometries, this.textures, {
      width: this.gl.drawingBufferWidth,
      height: this.gl.drawingBufferHeight,
      scale: this.scale * this.resolution,
      x: 0,
      y: 0,
    });
    this.geometries.endFrame();
    this.textures.endFrame();
  }

  /**
   * `o` and what is in it, under its parent's transform on the stage (a b
   * c d tx ty) and colour transform. Masks are walked but not drawn, nor
   * what is hidden; every object's flags are cleared, as the player
   * expects of a renderer.
   */
  private walk(
    o: DisplayObject,
    pa: number,
    pb: number,
    pc: number,
    pd: number,
    ptx: number,
    pty: number,
    tint: ColorTransform | null,
    hidden: boolean,
  ): void {
    const m = o.flatPlaced;
    const a = pa * m.a + pc * m.b;
    const b = pb * m.a + pd * m.b;
    const c = pa * m.c + pc * m.d;
    const d = pb * m.c + pd * m.d;
    const tx = pa * m.tx + pc * m.ty + ptx;
    const ty = pb * m.tx + pd * m.ty + pty;
    if (!hidden && o.visible) {
      noteUnsupported(o);
    }

    hidden ||= !o.visible || o.maskOf !== null || o.clipDepth > 0;

    const own = o.colorTransform;
    let color = own ? (tint ? concatColor(tint, own) : own) : tint;
    // Its mask, drawn where it stands on the stage, then its scroll's rectangle, clip all it draws;
    // a 3D mask, or one inside what it masks, masks nothing in Flash.
    let clipped = false;
    if (!hidden && o.mask) {
      const mask = !o.maskOf && !o.mask.encloses(o) && !o.mask.space ? o.mask : null;
      if (mask) {
        const w = toStageFlat(mask);
        this.pushMask(() => this.walkMask(mask, w.a, w.b, w.c, w.d, w.tx, w.ty, true));
        clipped = true;
      } else {
        unsupported.masks++;
      }
    }

    // A blend mode draws it as a layer, composited onto what is below in its mode. An explicit
    // layer with children colours their combined pixels, its own fills with them, which then take
    // no colour of their own; without children, it colours each fill (render/view.ts, rooted).
    // A layer of no children is its fills, drawn as normal; a mode it has no blend for (a Pixel
    // Bender shader's) is drawn as normal, and counted.
    const named = BLEND_NAMES.indexOf(o.blendMode);
    if (named < 0 && !hidden) {
      unsupported.blendModes++;
    }

    const childful = o instanceof Container && o.children.length > 0;
    const mode = hidden || named < 0 || (named === LAYER && !childful) ? NORMAL : named;
    let layerRow = -1;
    if (mode !== NORMAL) {
      if (mode === LAYER) {
        layerRow = color ? this.rows.add(1, 0, 0, 1, 0, 0, color) : -1;
        color = null;
      }

      this.scene.marker(LAYER_BEGIN);
    }

    // Its scroll's rectangle clips what it draws, inside its layer.
    const r = hidden ? null : o.scroll;
    if (r) {
      // A rectangle of no size clips everything, as an empty one does.
      const width = Math.max(0, r.xMax - r.xMin);
      const height = Math.max(0, r.yMax - r.yMin);
      this.pushMask(() => this.rectMask(a, b, c, d, tx, ty, r.xMin, r.yMin, width, height));
    }

    // A shape takes a morph's new ratio as it is drawn, which its bounds and hit tests follow.
    const shape = o instanceof ShapeObject ? o.drawn() : null;
    const layers = o.drawing ? o.drawing.layers : (shape?.layers ?? null);
    let row = -1;
    let lineRow = -1;
    if (!hidden && layers) {
      const version = o.drawing ? o.drawing.version : 0;
      // A pixel of the screen, in the stage's pixels: the least a line is wide.
      const least = 1 / (this.screenScale ?? this.scale * this.resolution);
      for (let i = 0; i < layers.length; i++) {
        for (const { part, handle } of this.partsOf(layers[i], version)) {
          // Kept while drawn, even with no texture yet: a layer let go of is tessellated again whole.
          this.geometries.use(handle.id);
          const texture = part.paint ? this.paintTexture(part) : null;
          if (part.paint && !texture) {
            continue;
          }

          if (row < 0) {
            row = this.rows.add(a, b, c, d, tx, ty, color);
          }

          if (texture) {
            this.textures.use(texture.id);
          }

          this.scene.draw(
            handle.id,
            row,
            NORMAL,
            texture?.id ?? -1,
            texture ? this.paintSampler(part.paint as ImageFill | GradientFill) : 0,
          );
        }

        // The layer's lines after its fills, stroked in the stage's axes: placed by the translation alone.
        const lines =
          layers[i].strokes.length > 0 ? this.linesOf(layers[i], version, a, b, c, d, least) : null;
        if (lines) {
          if (lineRow < 0) {
            lineRow = this.rows.add(1, 0, 0, 1, tx, ty, color);
          }

          this.geometries.use(lines.id);
          this.scene.draw(lines.id, lineRow, NORMAL);
        }
      }
    }

    if (!hidden && (o instanceof TextObject || o instanceof StaticTextObject)) {
      const omitted: TextOmissions = { advanced: false, clip: null, clipFrom: 0, clipTo: 0 };
      const items = o instanceof TextObject ? fieldItems(o, omitted) : staticItems(o, omitted);
      if (omitted.advanced) {
        unsupported.advancedTexts++;
      }

      // Device text as sharp as the text is shown: canvas pixels a stage pixel, at its stretch.
      const resolution =
        o instanceof TextObject && !o.embedFonts
          ? deviceTextResolution([a, b, c, d], this.scale * this.resolution)
          : 1;
      // Its text, where it runs over, clipped inside the gutter; its box and caret are not.
      const clip = omitted.clip;

      for (let k = 0; k < items.length; k++) {
        if (clip && k === omitted.clipFrom) {
          this.pushMask(() =>
            this.rectMask(a, b, c, d, tx, ty, clip.x, clip.y, clip.width, clip.height),
          );
        }

        this.drawTextItem(items[k], a, b, c, d, tx, ty, color, resolution);
        if (clip && k === omitted.clipTo - 1) {
          this.popMask();
        }
      }
    }

    const store = o instanceof BitmapObject && !hidden ? o.store : null;
    if (store && !store.disposed && store.width > 0 && store.height > 0) {
      const quad = this.quad(store.width, store.height);
      const texture = this.storeTexture(store);
      if (row < 0) {
        row = this.rows.add(a, b, c, d, tx, ty, color);
      }

      this.geometries.use(quad.id);
      this.textures.use(texture.id);
      const smooth = (o as BitmapObject).smoothing && this.stageQuality !== "LOW";
      this.scene.draw(quad.id, row, NORMAL, texture.id, (smooth ? SMOOTH : 0) | CLAMP);
    }

    if (o instanceof Container) {
      // A timeline's clip layer clips the children after it, up to its clip depth: kept track of
      // only where a child is one, as most containers have none.
      const children = o.children;
      let clips: Clips | null = null;
      let open = 0;

      for (let i = 0; i < children.length; i++) {
        const child = children[i];
        if (!clips && child.clipDepth > 0) {
          clips = new Clips();
        }

        if (clips) {
          const n = clips.enter(child);
          for (; open > n; open--) {
            this.popMask();
          }
        }

        if (child.clipDepth > 0 && !hidden) {
          this.pushMask(() => this.walkMask(child, a, b, c, d, tx, ty, false));
          open++;
          continue;
        }

        this.walk(child, a, b, c, d, tx, ty, color, hidden);
      }

      for (; open > 0; open--) {
        this.popMask();
      }

      o.descendantsDirty = false;
    }

    if (r) {
      this.popMask();
    }

    if (mode !== NORMAL) {
      this.scene.marker(LAYER_END, mode, layerRow);
    }

    if (clipped) {
      this.popMask();
    }

    o.dirty = CLEAN;
  }

  /** A mask's draws, which `emit` writes, between its markers, kept on the stack of masks open for its pop. */
  private pushMask(emit: () => void): void {
    this.scene.marker(MASK_BEGIN);
    const first = this.scene.length;
    emit();
    const count = this.scene.length - first;
    this.scene.marker(MASK_USE, first, count);
    this.masks.push(first, count);
  }

  /** The mask pushed last taken out: its draws named again. */
  private popMask(): void {
    const count = this.masks.pop() as number;
    const first = this.masks.pop() as number;
    this.scene.marker(MASK_POP, first, count);
  }

  /** A rectangle of `o`'s space, x y width height, under its transform (a b c d tx ty), as a mask's draw. */
  private rectMask(
    a: number,
    b: number,
    c: number,
    d: number,
    tx: number,
    ty: number,
    x: number,
    y: number,
    width: number,
    height: number,
  ): void {
    const quad = this.unitQuad();
    const row = this.placedRow(
      a,
      b,
      c,
      d,
      tx,
      ty,
      { a: width, b: 0, c: 0, d: height, tx: x, ty: y },
      null,
    );
    this.geometries.use(quad.id);
    this.scene.draw(quad.id, row, NORMAL);
  }

  /**
   * `o` and all in it drawn as a mask, under its parent's transform: fills
   * alone, a drawing's non-zero, glyphs and bitmaps' rectangles, whatever
   * their visibility, as Flash masks by them. `own` says (a b c d tx ty) is
   * already `o`'s own place, as a mask elsewhere on the list is found; else
   * its own matrix is applied. Flags are cleared as the walk clears them.
   */
  private walkMask(
    o: DisplayObject,
    pa: number,
    pb: number,
    pc: number,
    pd: number,
    ptx: number,
    pty: number,
    own: boolean,
  ): void {
    const m = own ? IDENTITY : o.flatPlaced;
    // What would clip a mask's own coverage needs a stencil within the stencil: drawn whole, and counted.
    if (o.mask || o.scroll || o.clipDepth > 0) {
      unsupported.masks++;
    }

    const a = pa * m.a + pc * m.b;
    const b = pb * m.a + pd * m.b;
    const c = pa * m.c + pc * m.d;
    const d = pb * m.c + pd * m.d;
    const tx = pa * m.tx + pc * m.ty + ptx;
    const ty = pb * m.tx + pd * m.ty + pty;
    const shape = o instanceof ShapeObject ? o.drawn() : null;
    const layers = o.drawing ? o.drawing.layers : (shape?.layers ?? null);
    let row = -1;
    const at = () => {
      if (row < 0) {
        row = this.rows.add(a, b, c, d, tx, ty, null);
      }

      return row;
    };

    if (layers) {
      const version = o.drawing ? o.drawing.version : 0;
      for (let i = 0; i < layers.length; i++) {
        for (const { handle } of this.partsOf(layers[i], version, o.drawing !== null)) {
          this.geometries.use(handle.id);
          this.scene.draw(handle.id, at(), NORMAL);
        }
      }
    }

    if (o instanceof TextObject || o instanceof StaticTextObject) {
      const omitted: TextOmissions = { advanced: false, clip: null, clipFrom: 0, clipTo: 0 };
      for (const item of o instanceof TextObject
        ? fieldItems(o, omitted)
        : staticItems(o, omitted)) {
        const geometry = item.kind === "glyph" ? this.glyphGeometry(item.glyph) : null;
        if (item.kind === "glyph" && geometry) {
          const g = item.m;
          const glyphRow = this.rows.add(
            a * g.a + c * g.b,
            b * g.a + d * g.b,
            a * g.c + c * g.d,
            b * g.c + d * g.d,
            a * g.tx + c * g.ty + tx,
            b * g.tx + d * g.ty + ty,
            null,
          );
          this.geometries.use(geometry.id);
          this.scene.draw(geometry.id, glyphRow, NORMAL);
        }
      }
    }

    const store = o instanceof BitmapObject ? o.store : null;
    if (store && !store.disposed && store.width > 0 && store.height > 0) {
      const quad = this.quad(store.width, store.height);
      this.geometries.use(quad.id);
      this.scene.draw(quad.id, at(), NORMAL);
    }

    if (o instanceof Container) {
      for (const child of o.children) {
        this.walkMask(child, a, b, c, d, tx, ty, false);
      }

      o.descendantsDirty = false;
    }

    o.dirty = CLEAN;
  }

  /**
   * `layer`'s parts, made if they were not, or one was let go of, or its
   * drawing changed since; a drawing used as a mask's apart, filled non-zero.
   */
  private partsOf(layer: ShapeLayer, version: number, masking = false): Made["parts"] {
    const cache = masking ? this.maskMade : this.made;
    const made = cache.get(layer);
    if (
      made &&
      made.version === version &&
      made.parts.every(({ handle }) => this.geometries.alive(handle))
    ) {
      return made.parts;
    }

    for (const { handle } of made?.parts ?? []) {
      if (this.geometries.alive(handle)) {
        this.geometries.remove(handle.id);
      }
    }

    const parts = layerParts(layer, this.tessellator, masking).map((part) => ({
      part,
      handle: this.geometries.add(part.geometry),
    }));
    cache.set(layer, { parts, version });
    return parts;
  }

  /**
   * `layer`'s lines through the linear transform (a b c d), at least `least`
   * wide: stroked again for another transform, screen or version of its
   * drawing, the old ones kept while drawn as the geometries keep them.
   */
  private linesOf(
    layer: ShapeLayer,
    version: number,
    a: number,
    b: number,
    c: number,
    d: number,
    least: number,
  ): GeometryHandle | null {
    let byKey = this.lines.get(layer);
    if (!byKey) {
      byKey = new Map();
      this.lines.set(layer, byKey);
    }

    const key = `${a} ${b} ${c} ${d} ${least}`;
    const known = byKey.get(key);
    if (
      known &&
      known.version === version &&
      (!known.handle || this.geometries.alive(known.handle))
    ) {
      return known.handle;
    }

    if (known?.handle && this.geometries.alive(known.handle)) {
      this.geometries.remove(known.handle.id);
    }

    // Those let go of are forgotten, and the oldest past LINE_KEYS, so that a layer seen through
    // ever new transforms keeps no more keys than that.
    for (const [old, kept] of byKey) {
      if (kept.handle && !this.geometries.alive(kept.handle)) {
        byKey.delete(old);
      }
    }

    for (const [old, kept] of byKey) {
      if (byKey.size < LINE_KEYS) {
        break;
      }

      byKey.delete(old);
      if (kept.handle && this.geometries.alive(kept.handle)) {
        this.geometries.remove(kept.handle.id);
      }
    }

    const data = layerStrokes(layer, a, b, c, d, least, this.tessellator);
    const handle = data ? this.geometries.add(data) : null;
    byKey.set(key, { handle, version });
    return handle;
  }

  /**
   * A text's item under the object's transform (a b c d tx ty) and colour
   * transform: a glyph its fill, a rectangle the unit quad, each placed by
   * its row and coloured by its colour as a multiplier before the object's;
   * a device run its rasterized texture, a texel a canvas pixel.
   */
  private drawTextItem(
    item: TextItem,
    a: number,
    b: number,
    c: number,
    d: number,
    tx: number,
    ty: number,
    color: ColorTransform | null,
    resolution: number,
  ): void {
    const tint = item.color;
    const own: ColorTransform = {
      rMul: ((tint >>> 16) & 0xff) / 255,
      gMul: ((tint >>> 8) & 0xff) / 255,
      bMul: (tint & 0xff) / 255,
      aMul: (tint >>> 24) / 255,
      rAdd: 0,
      gAdd: 0,
      bAdd: 0,
      aAdd: 0,
    };
    const colored = color ? concatColor(color, own) : own;
    if (item.kind === "device") {
      const run = this.deviceRun(item, resolution);
      if (!run) {
        return;
      }

      // A texel a canvas pixel, the run's origin `left` texels in, past its overhang.
      const k = 1 / run.resolution;
      const x = item.x - run.left * k;
      const row = this.rows.add(
        a * k,
        b * k,
        c * k,
        d * k,
        a * x + c * item.top + tx,
        b * x + d * item.top + ty,
        colored,
      );
      const quad = this.quad(run.width, run.height);
      this.geometries.use(quad.id);
      this.textures.use(run.handle.id);
      this.scene.draw(quad.id, row, NORMAL, run.handle.id, SMOOTH | CLAMP);
      return;
    }

    const geometry = item.kind === "glyph" ? this.glyphGeometry(item.glyph) : this.unitQuad();
    if (!geometry) {
      return;
    }

    const m =
      item.kind === "glyph"
        ? item.m
        : { a: item.width, b: 0, c: 0, d: item.height, tx: item.x, ty: item.y };
    this.geometries.use(geometry.id);
    this.scene.draw(geometry.id, this.placedRow(a, b, c, d, tx, ty, m, colored), NORMAL);
  }

  /** A row for what `m` places within an object under the transform (a b c d tx ty). */
  private placedRow(
    a: number,
    b: number,
    c: number,
    d: number,
    tx: number,
    ty: number,
    m: { a: number; b: number; c: number; d: number; tx: number; ty: number },
    color: ColorTransform | null,
  ): number {
    return this.rows.add(
      a * m.a + c * m.b,
      b * m.a + d * m.b,
      a * m.c + c * m.d,
      b * m.c + d * m.d,
      a * m.tx + c * m.ty + tx,
      b * m.tx + d * m.ty + ty,
      color,
    );
  }

  /** A glyph's outline as a white fill, in the font's units over 20, as shapeLayers takes twips. */
  private glyphGeometry(glyph: Glyph): GeometryHandle | null {
    const known = this.glyphs.get(glyph);
    if (known === null || (known && this.geometries.alive(known))) {
      return known;
    }

    const layers = shapeLayers(glyphShape(glyph));
    const part = layers.length > 0 ? layerParts(layers[0], this.tessellator)[0] : undefined;
    const handle = part ? this.geometries.add(part.geometry) : null;
    this.glyphs.set(glyph, handle);
    return handle;
  }

  /** A white square of a pixel, for a row to scale to a rectangle. */
  private unitQuad(): GeometryHandle {
    const known = this.quads.get("unit");
    if (known && this.geometries.alive(known)) {
      return known;
    }

    const handle = this.geometries.add(bitmapQuad(1, 1));
    this.quads.set("unit", handle);
    return handle;
  }

  /**
   * A run of device text rasterized white at `resolution` canvas pixels a
   * stage pixel, or less where that would pass TEXT_MOST texels a side: its
   * ink whole, the overhang left of its origin and past its advance too, its
   * top at the ascent above the baseline; premultiplied, and kept while
   * drawn, for every colour it is drawn in. Null for nothing to draw.
   */
  private deviceRun(item: DeviceItem, resolution: number): DeviceRun | null {
    const key = `${item.family}|${item.size}|${item.bold}|${item.italic}|${item.letterSpacing}|${resolution}|${item.text}`;
    const known = this.runs.get(key);
    if (known && this.textures.alive(known.handle)) {
      return known;
    }

    if (!this.textCanvas) {
      const canvas = document.createElement("canvas");
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context) {
        return null;
      }

      this.textCanvas = { canvas, context };
    }

    const { canvas, context } = this.textCanvas;
    let scale = resolution;
    let size = { left: 0, width: 0, height: 0 };
    for (let tries = 0; tries < 2; tries++) {
      size = this.measureRun(context, item, scale);
      const most = Math.max(size.width, size.height);
      if (most <= TEXT_MOST) {
        break;
      }

      scale *= TEXT_MOST / most;
    }

    const { left, width, height } = size;
    if (item.size <= 0 || width <= 2 || height <= 2 || width > TEXT_MOST || height > TEXT_MOST) {
      return null;
    }

    canvas.width = width;
    canvas.height = height;
    this.fontAt(context, item, scale);
    context.fillStyle = "#ffffff";
    context.textBaseline = "alphabetic";
    context.fillText(item.text, left, item.ascent * scale + 1);
    const pixels = new Uint8Array(context.getImageData(0, 0, width, height).data.buffer);

    // The canvas gives straight colour; textures hold it premultiplied.
    for (let i = 0; i < pixels.length; i += 4) {
      const alpha = pixels[i + 3];
      pixels[i] = Math.round((pixels[i] * alpha) / 255);
      pixels[i + 1] = Math.round((pixels[i + 1] * alpha) / 255);
      pixels[i + 2] = Math.round((pixels[i + 2] * alpha) / 255);
    }

    // Those let go of are forgotten, so that text typed and scrolled keeps no keys for them.
    if (this.runs.size > RUN_KEYS) {
      for (const [old, run] of this.runs) {
        if (!this.textures.alive(run.handle)) {
          this.runs.delete(old);
        }
      }
    }

    const run: DeviceRun = {
      handle: this.textures.add(width, height, pixels, TEXT_IDLE_FRAMES),
      width,
      height,
      left,
      resolution: scale,
    };
    this.runs.set(key, run);
    return run;
  }

  /** The run's font and spacing set on the canvas at `scale` canvas pixels a stage pixel. */
  private fontAt(context: CanvasRenderingContext2D, item: DeviceItem, scale: number): void {
    context.font = cssFont(item.family, item.size * scale, item.bold, item.italic);
    context.letterSpacing = `${item.letterSpacing * scale}px`;
  }

  /** The texels a run takes at `scale`: its ink left of its origin, and its whole width and height, a texel spare round. */
  private measureRun(
    context: CanvasRenderingContext2D,
    item: DeviceItem,
    scale: number,
  ): { left: number; width: number; height: number } {
    this.fontAt(context, item, scale);
    const m = context.measureText(item.text);
    const left = Math.max(0, Math.ceil(m.actualBoundingBoxLeft)) + 1;
    const right = Math.max(m.width, Math.ceil(m.actualBoundingBoxRight));
    return {
      left,
      width: Math.ceil(left + right) + 1,
      height: Math.ceil((item.ascent + item.descent) * scale) + 2,
    };
  }

  /** A bitmap's quad of its size, made once for every bitmap of that size. */
  private quad(width: number, height: number): GeometryHandle {
    const key = `${width}x${height}`;
    const known = this.quads.get(key);
    if (known && this.geometries.alive(known)) {
      return known;
    }

    // Device text makes quads of many sizes: those let go of are forgotten.
    if (this.quads.size > RUN_KEYS) {
      for (const [old, handle] of this.quads) {
        if (!this.geometries.alive(handle)) {
          this.quads.delete(old);
        }
      }
    }

    const handle = this.geometries.add(bitmapQuad(width, height));
    this.quads.set(key, handle);
    return handle;
  }

  /** The texture a part's paint samples: its bitmap's, else null till it is decoded, or its gradient's. */
  private paintTexture(part: Part): TextureHandle | null {
    const paint = part.paint as ImageFill | GradientFill;
    if (paint.type === "image") {
      const store = paint.image instanceof BitmapStore ? paint.image : characterStore(paint.image);
      return store && !store.disposed ? this.storeTexture(store) : null;
    }

    return this.gradientTexture(paint, part.region);
  }

  /**
   * How a paint is sampled. A bitmap fill: smoothed if it asks and the
   * quality is not low, repeated or clamped. A linear gradient's ramp:
   * texel by texel, spread as it wraps; a radial one's, smoothed.
   */
  private paintSampler(paint: ImageFill | GradientFill): number {
    if (paint.type === "image") {
      return (
        (paint.smooth && this.stageQuality !== "LOW" ? SMOOTH : 0) | (paint.repeat ? REPEAT : CLAMP)
      );
    }

    if (paint.radial) {
      return SMOOTH | CLAMP;
    }

    return paint.spread === 1 ? MIRROR : paint.spread === 2 ? REPEAT : CLAMP;
  }

  /** `store`'s texture, its pixels uploaded again if they changed since. */
  private storeTexture(store: BitmapStore): TextureHandle {
    const kept = this.stores.get(store);
    if (kept && this.textures.alive(kept.handle)) {
      if (kept.version !== store.version) {
        kept.version = store.version;
        this.textures.set(kept.handle.id, store.width, store.height, rgbaOf(store.readable));
      }

      return kept.handle;
    }

    const handle = this.textures.add(store.width, store.height, rgbaOf(store.readable));
    this.stores.set(store, { handle, version: store.version });
    return handle;
  }

  /**
   * A gradient's texture: a linear one's ramp of 256 colours, a radial one
   * computed over its region, a texel a pixel up to 512 a side, as the
   * Pixi view computes them (display/gradients.ts).
   */
  private gradientTexture(fill: GradientFill, region: Area | null): TextureHandle {
    let made = this.gradients.get(fill);
    if (!made) {
      made = new Map();
      this.gradients.set(fill, made);
    }

    const key = region ? `${region.x} ${region.y} ${region.width} ${region.height}` : "";
    const known = made.get(key);
    if (known && this.textures.alive(known)) {
      return known;
    }

    const colors = ramp(fill.stops, fill.linearRgb);
    let handle: TextureHandle;
    if (fill.radial && region) {
      const columns = radialTexels(region.width);
      const rows = radialTexels(region.height);
      const pixels = radialPixels(
        colors,
        fill.matrix,
        fill.focal,
        fill.spread,
        region,
        columns,
        rows,
      );
      handle = this.textures.add(columns, rows, rgbaOf(pixels), GRADIENT_IDLE_FRAMES);
    } else {
      handle = this.textures.add(colors.length, 1, rgbaOf(colors), GRADIENT_IDLE_FRAMES);
    }

    made.set(key, handle);
    return handle;
  }

  /** BitmapData.draw of a display object: not drawn by this renderer yet. */
  snapshot(): Uint32Array {
    throw new Error("BitmapData.draw of a display object is not drawn by the own renderer yet");
  }

  drawInto(
    _store: BitmapStore,
    _o: DisplayObject,
    _m: unknown,
    _x: number,
    _y: number,
    _width: number,
    _height: number,
    _samples: number,
  ): boolean {
    return false;
  }

  /** What the view made on its context let go of, the context with it if the canvas is its own, and its tessellator. */
  destroy(): void {
    this.canvas.removeEventListener("webglcontextlost", this.lost);
    this.canvas.removeEventListener("webglcontextrestored", this.restored);
    this.backend.destroy();
    this.ownTessellator?.dispose();
    if (this.ownCanvas) {
      this.gl.getExtension("WEBGL_lose_context")?.loseContext();
    }
  }
}

/** Count what `o` asks of the renderer that it does not draw yet (shapes.ts, unsupported). */
function noteUnsupported(o: DisplayObject): void {
  if (o.scale9Grid) {
    unsupported.scale9Grids++;
  }

  if (o.filters.length > 0) {
    unsupported.filters++;
  }
}

/** Where `o` stands on the stage, its matrices as the walk takes them, after their scroll's shift. */
function toStageFlat(o: DisplayObject): Matrix {
  let m = o.flatPlaced;
  for (let p = o.parent; p; p = p.parent) {
    m = concat(m, p.flatPlaced);
  }

  return m;
}
