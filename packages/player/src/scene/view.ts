// The renderer of swf2es's own as the player drives it (docs/renderer.md):
// a view that owns a WebGL 2 canvas, walks the display list into a scene
// list and its rows, and has @swf2es/render plan and draw it. It stands
// beside PixiView behind a switch until it draws everything Pixi draws;
// for now, the solid fills of shapes and drawings.
import type { ColorTransform } from "@swf2es/format";
import { Tessellator } from "@swf2es/native/tessellate";
import {
  Commands,
  Geometries,
  type GeometryHandle,
  NORMAL,
  plan,
  Rows,
  SceneList,
} from "@swf2es/render";
import { WebGLBackend } from "@swf2es/render/webgl";
import type { BitmapStore } from "../bitmap/bitmap.js";
import { concatColor } from "../display/color.js";
import { Container } from "../display/container.js";
import { CLEAN, type DisplayObject } from "../display/displayobject.js";
import { ShapeObject } from "../display/shapeobject.js";
import type { ShapeLayer } from "../display/shapes.js";
import type { Drawer } from "../hosts.js";
import type { FillTessellator } from "./fills.js";
import { layerGeometry } from "./shapes.js";

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

/** What a layer's geometry was made for: its drawing's version, as a drawing changes its layers in place. */
interface Made {
  handle: GeometryHandle | null;
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
  private readonly scene = new SceneList();
  private readonly rows = new Rows();
  private readonly geometries = new Geometries();
  private readonly commands = new Commands();
  private readonly made = new WeakMap<ShapeLayer, Made>();

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
    this.tessellator = options.fillTessellator ?? new Tessellator().tessellate;
    this.resize(this.width, this.height, this.resolution);
  }

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
    this.backend.execute(this.commands, this.scene, this.rows, this.geometries, {
      width: this.canvas.width,
      height: this.canvas.height,
      scale: this.scale * this.resolution,
      x: 0,
      y: 0,
    });
    this.geometries.endFrame();
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
    const own = o.colorTransform;
    const color = own ? (tint ? concatColor(tint, own) : own) : tint;
    // A shape takes a morph's new ratio as it is drawn, which its bounds and hit tests follow.
    const shape = o instanceof ShapeObject ? o.drawn() : null;
    const layers = o.drawing ? o.drawing.layers : (shape?.layers ?? null);
    if (!hidden && layers) {
      const version = o.drawing ? o.drawing.version : 0;
      let row = -1;
      for (let i = 0; i < layers.length; i++) {
        const handle = this.geometryOf(layers[i], version);
        if (handle) {
          if (row < 0) {
            row = this.rows.add(a, b, c, d, tx, ty, color);
          }

          this.geometries.use(handle.id);
          this.scene.draw(handle.id, row, NORMAL);
        }
      }
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

  /** `layer`'s geometry, made if it was not, or was let go of, or its drawing changed since. */
  private geometryOf(layer: ShapeLayer, version: number): GeometryHandle | null {
    const made = this.made.get(layer);
    if (made && made.version === version && (!made.handle || this.geometries.alive(made.handle))) {
      return made.handle;
    }

    if (made?.handle && this.geometries.alive(made.handle)) {
      this.geometries.remove(made.handle.id);
    }

    const data = layerGeometry(layer, this.tessellator);
    const handle = data ? this.geometries.add(data) : null;
    this.made.set(layer, { handle, version });
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

  /** What the view made on its context, let go of. */
  destroy(): void {
    this.backend.destroy();
  }
}
