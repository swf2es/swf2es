// The renderer of swf2es's own as the player drives it (docs/renderer.md):
// a view that owns a WebGL 2 canvas, walks the display list into a scene
// list and its rows, and has @swf2es/render plan and draw it. It stands
// beside PixiView behind a switch until it draws everything Pixi draws;
// for now, the fills of shapes and drawings, solid, bitmap and gradient,
// their lines, bitmaps, and text.
import type { ColorTransform, Glyph } from "@swf2es/format";
import { Tessellator } from "@swf2es/native/tessellate";
import {
  CLAMP,
  Commands,
  Geometries,
  type GeometryHandle,
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
import { type Region as Area, radialPixels, ramp } from "../display/gradients.js";
import { ShapeObject } from "../display/shapeobject.js";
import {
  type GradientFill,
  type ImageFill,
  type ShapeLayer,
  shapeLayers,
} from "../display/shapes.js";
import { StaticTextObject, TextObject } from "../display/textobjects.js";
import type { Drawer } from "../hosts.js";
import type { FillTessellator } from "./fills.js";
import { bitmapQuad, layerParts, type Part, radialTexels, unsupported } from "./shapes.js";
import { layerStrokes } from "./strokes.js";
import {
  type DeviceItem,
  deviceTextResolution,
  fieldItems,
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
  /** Device text rasterized, by its text, font, colour, spacing and resolution. */
  private readonly runs = new Map<
    string,
    { handle: TextureHandle; width: number; height: number }
  >();
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
    this.backend.execute(this.commands, this.scene, this.rows, this.geometries, this.textures, {
      width: this.canvas.width,
      height: this.canvas.height,
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
    const color = own ? (tint ? concatColor(tint, own) : own) : tint;
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
      const omitted: TextOmissions = { advanced: false, clipped: false };
      const items = o instanceof TextObject ? fieldItems(o, omitted) : staticItems(o, omitted);
      if (omitted.advanced) {
        unsupported.advancedTexts++;
      }

      if (omitted.clipped) {
        unsupported.textClips++;
      }

      // Device text as sharp as the text is shown: canvas pixels a stage pixel, at its stretch.
      const resolution =
        o instanceof TextObject && !o.embedFonts
          ? deviceTextResolution([a, b, c, d], this.scale * this.resolution)
          : 1;
      for (const item of items) {
        this.drawTextItem(item, a, b, c, d, tx, ty, color, resolution);
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
      const children = o.children;
      for (let i = 0; i < children.length; i++) {
        this.walk(children[i], a, b, c, d, tx, ty, color, hidden);
      }

      o.descendantsDirty = false;
    }

    o.dirty = CLEAN;
  }

  /** `layer`'s parts, made if they were not, or one was let go of, or its drawing changed since. */
  private partsOf(layer: ShapeLayer, version: number): Made["parts"] {
    const made = this.made.get(layer);
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

    const parts = layerParts(layer, this.tessellator).map((part) => ({
      part,
      handle: this.geometries.add(part.geometry),
    }));
    this.made.set(layer, { parts, version });
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
    if (item.kind === "device") {
      const run = this.deviceRun(item, resolution);
      if (!run) {
        return;
      }

      const k = 1 / resolution;
      const row = this.rows.add(
        a * k,
        b * k,
        c * k,
        d * k,
        a * item.x + c * item.top + tx,
        b * item.x + d * item.top + ty,
        color,
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
    const row = this.rows.add(
      a * m.a + c * m.b,
      b * m.a + d * m.b,
      a * m.c + c * m.d,
      b * m.c + d * m.d,
      a * m.tx + c * m.ty + tx,
      b * m.tx + d * m.ty + ty,
      color ? concatColor(color, own) : own,
    );
    this.geometries.use(geometry.id);
    this.scene.draw(geometry.id, row, NORMAL);
  }

  /** A glyph's outline as a white fill, in the font's units over 20, as shapeLayers takes twips. */
  private glyphGeometry(glyph: Glyph): GeometryHandle | null {
    const known = this.glyphs.get(glyph);
    if (known === null || (known && this.geometries.alive(known))) {
      return known;
    }

    const layers = shapeLayers({
      id: 0,
      bounds: { xMin: 0, xMax: 0, yMin: 0, yMax: 0 },
      edgeBounds: null,
      fills: [{ type: "solid", color: 0xffffffff }],
      lines: [],
      records: glyph.records,
      truncated: false,
    });
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
   * A run of device text rasterized at `resolution` canvas pixels a stage
   * pixel, in its colour, its top at the ascent above the baseline, as
   * premultiplied pixels; kept while drawn. Null for nothing to draw.
   */
  private deviceRun(
    item: DeviceItem,
    resolution: number,
  ): { handle: TextureHandle; width: number; height: number } | null {
    const key = `${item.font}|${item.color}|${item.letterSpacing}|${resolution}|${item.text}`;
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
    const font = item.font.replace(`${item.size}px`, `${item.size * resolution}px`);
    const spacing = item.letterSpacing * resolution;
    context.font = font;
    const width = Math.ceil(context.measureText(item.text).width + spacing * item.text.length) + 2;
    const height = Math.ceil((item.ascent + item.descent) * resolution) + 2;
    if (width <= 2 || height <= 2) {
      return null;
    }

    canvas.width = width;
    canvas.height = height;
    context.font = font;
    context.letterSpacing = `${spacing}px`;
    const c = item.color;
    context.fillStyle = `rgba(${(c >>> 16) & 0xff}, ${(c >>> 8) & 0xff}, ${c & 0xff}, ${(c >>> 24) / 255})`;
    context.textBaseline = "alphabetic";
    context.fillText(item.text, 0, item.ascent * resolution);
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

    const run = { handle: this.textures.add(width, height, pixels), width, height };
    this.runs.set(key, run);
    return run;
  }

  /** A bitmap's quad of its size, made once for every bitmap of that size. */
  private quad(width: number, height: number): GeometryHandle {
    const key = `${width}x${height}`;
    const known = this.quads.get(key);
    if (known && this.geometries.alive(known)) {
      return known;
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
  if (o.mask || o.clipDepth > 0) {
    unsupported.masks++;
  }

  if (o.scroll) {
    unsupported.scrollRects++;
  }

  if (o.scale9Grid) {
    unsupported.scale9Grids++;
  }

  if (o.filters.length > 0) {
    unsupported.filters++;
  }

  if (o.blendMode !== "normal") {
    unsupported.blendModes++;
  }
}
