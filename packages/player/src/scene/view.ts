// The renderer of swf2es's own as the player drives it (docs/renderer.md):
// a view that owns a WebGL 2 canvas, walks the display list into a scene
// list and its rows, and has @swf2es/render plan and draw it. It stands
// beside PixiView behind a switch until it draws everything Pixi draws;
// for now, the fills of shapes and drawings, solid, bitmap and gradient,
// their lines, and bitmaps.
import type { ColorTransform } from "@swf2es/format";
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
import { BitmapStore, characterStore } from "../bitmap/bitmap.js";
import { BitmapObject } from "../display/bitmapobject.js";
import { concatColor } from "../display/color.js";
import { Container } from "../display/container.js";
import { CLEAN, type DisplayObject } from "../display/displayobject.js";
import { type Region as Area, radialPixels, ramp } from "../display/gradients.js";
import { ShapeObject } from "../display/shapeobject.js";
import type { GradientFill, ImageFill, ShapeLayer } from "../display/shapes.js";
import { StaticTextObject, TextObject } from "../display/textobjects.js";
import type { Drawer } from "../hosts.js";
import type { FillTessellator } from "./fills.js";
import { bitmapQuad, layerParts, type Part, radialTexels, unsupported } from "./shapes.js";
import { layerStrokes } from "./strokes.js";

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
  private readonly stores = new WeakMap<BitmapStore, Kept>();
  /** Each gradient's textures, by the region a radial one covers ("" for a linear one). */
  private readonly gradients = new WeakMap<GradientFill, Map<string, TextureHandle>>();

  constructor(options: RenderViewOptions) {
    this.width = options.width;
    this.height = options.height;
    this.resolution = options.resolution ?? 1;
    this.background = options.background ?? 0xffffff;
    this.transparent = options.transparent ?? false;
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
    hidden ||= !o.visible || o.maskOf !== null || o.clipDepth > 0;
    if (!hidden) {
      noteUnsupported(o);
    }

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
      const least = 1 / (this.screenScale ?? this.scale);
      for (let i = 0; i < layers.length; i++) {
        for (const { part, handle } of this.partsOf(layers[i], version)) {
          const texture = part.paint ? this.paintTexture(part) : null;
          if (part.paint && !texture) {
            continue;
          }

          if (row < 0) {
            row = this.rows.add(a, b, c, d, tx, ty, color);
          }

          this.geometries.use(handle.id);
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

    // Those let go of are forgotten, so that a layer seen through many transforms keeps no keys for them.
    for (const [old, kept] of byKey) {
      if (kept.handle && !this.geometries.alive(kept.handle)) {
        byKey.delete(old);
      }
    }

    const data = layerStrokes(layer, a, b, c, d, least, this.tessellator);
    const handle = data ? this.geometries.add(data) : null;
    byKey.set(key, { handle, version });
    return handle;
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
        this.textures.set(kept.handle.id, store.width, store.height, rgba(store.readable));
      }

      return kept.handle;
    }

    const handle = this.textures.add(store.width, store.height, rgba(store.readable));
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
      handle = this.textures.add(columns, rows, rgba(pixels));
    } else {
      handle = this.textures.add(colors.length, 1, rgba(colors));
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

  /** What the view made on its context let go of, the context with it, and its tessellator. */
  destroy(): void {
    this.canvas.removeEventListener("webglcontextlost", this.lost);
    this.canvas.removeEventListener("webglcontextrestored", this.restored);
    this.backend.destroy();
    this.ownTessellator?.dispose();
    this.gl.getExtension("WEBGL_lose_context")?.loseContext();
  }
}

/** Premultiplied ARGB, as stores and gradients hold it, as the RGBA bytes a texture takes. */
function rgba(argb: Uint32Array): Uint8Array {
  const out = new Uint8Array(argb.length * 4);
  for (let i = 0; i < argb.length; i++) {
    const p = argb[i];
    const j = i * 4;
    out[j] = (p >>> 16) & 0xff;
    out[j + 1] = (p >>> 8) & 0xff;
    out[j + 2] = p & 0xff;
    out[j + 3] = p >>> 24;
  }

  return out;
}

/** Count what `o` asks of the renderer that it does not draw yet (shapes.ts, unsupported). */
function noteUnsupported(o: DisplayObject): void {
  if (o instanceof TextObject || o instanceof StaticTextObject) {
    unsupported.texts++;
  }

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
