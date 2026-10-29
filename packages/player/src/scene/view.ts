// The renderer of swf2es's own as the player drives it (docs/renderer.md):
// a view that owns a WebGL 2 canvas, walks the display list into a scene
// list and its rows, and has @swf2es/render plan and draw it. It stands
// beside PixiView behind a switch until it draws everything Pixi draws;
// for now, the fills of shapes and drawings, solid, bitmap and gradient,
// their lines, bitmaps and text, under masks, scroll clips, blend modes and
// filters.
import { type ColorTransform, type Glyph, IDENTITY, type Matrix } from "@swf2es/format";
import { Tessellator } from "@swf2es/native/tessellate";
import {
  BLEND_NAMES,
  CLAMP,
  Commands,
  drawnArea,
  Filters,
  filteredRect,
  Geometries,
  type GeometryHandle,
  type KeepHandle,
  Keeps,
  LAYER,
  MASK_BEGIN,
  MASK_POP,
  MASK_USE,
  MIRROR,
  measureLayers,
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
import { argbOf, BitmapStore, characterStore, rgbaOf } from "../bitmap/bitmap.js";
import { BitmapObject } from "../display/bitmapobject.js";
import { concatColor } from "../display/color.js";
import { Container } from "../display/container.js";
import { CLEAN, type DisplayObject, TRANSFORM } from "../display/displayobject.js";
import {
  type Filter as FilterRecord,
  filterRoom,
  paddingCap,
  sameFilterRecords,
} from "../display/filters.js";
import { concat, invert, shifted } from "../display/geometry.js";
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
import type { Player } from "../player.js";
import { cssFont } from "../text/fonts.js";
import type { FillTessellator } from "./fills.js";
import { type FilterPlan, planFilters, undrawnFilter } from "./filters.js";
import { bindCanvasPointer } from "./pointer.js";
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
  /** Samples a pixel the stage and its layers are multisampled with (`samples`); 1, none, if left out. */
  samples?: number;
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

/**
 * A filtered object's output as last made: whether it was kept, as which
 * kept output, for which plan and generation; its scale and turn on the
 * stage and its place there in target pixels; its area as measured and
 * its rectangle; and how many frames in a row it changed. `reused` and
 * `keeping` say what this frame does with it.
 */
interface KeptOutput {
  handle: KeepHandle | null;
  plan: FilterPlan;
  generation: number;
  /** The stage's frame it was last drawn on, whether it scrolled then, and whether it was measured. */
  seenAt: number;
  scrolled: boolean;
  measured: boolean;
  kept: boolean;
  reused: boolean;
  keeping: boolean;
  changing: number;
  linear: number[];
  x: number;
  y: number;
  pad: number;
  area: Float64Array;
  rect: Int32Array;
}

/**
 * A filtered object's filters worked out for its records at its units,
 * and cut to the last cap its padding needed, if any.
 */
interface KeptPlan {
  records: readonly FilterRecord[];
  units: number;
  plan: FilterPlan | null;
  cap: number;
  capped: FilterPlan | null;
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
  private readonly filters = new Filters();
  /** Each filtered object's filters worked out, for the records, units and room they were for. */
  private readonly filterPlans = new WeakMap<DisplayObject, KeptPlan>();
  /** The largest texture side the context makes, which a filtered layer's padding must fit. */
  private textureLimit = 4096;
  /** A filtered object's drawn area, measured where its padding may not fit (fitFilters). */
  private readonly drawn: number[] = [];
  /** The outputs kept for filtered objects, and what they were kept for. */
  private readonly keeps = new Keeps();
  private readonly outputs = new WeakMap<DisplayObject, KeptOutput>();
  /** The filtered layers drawn this frame, each its output's record and its layer number. */
  private readonly ran: (KeptOutput | number)[] = [];
  /** Moves on as what every kept output was made at changes: the scale, the stage's quality. */
  private keptGeneration = 0;
  private keptScale = 0;
  private keptQuality = "";
  private keptScreen: number | null = null;
  /** The stage's frames drawn. */
  private frames = 0;
  private readonly movedArea = new Float64Array(4);
  private readonly keptRect = new Int32Array(4);
  /** Where a frame is drawn, filled in as it is. */
  private target = { width: 0, height: 0, scale: 1, x: 0, y: 0, resolution: 1 };
  /**
   * What BitmapData.draw draws alone, while it is drawn (snapshot), and the
   * matrix it is drawn through, after its scroll's shift.
   */
  private drawRoot: DisplayObject | null = null;
  private drawMatrix: Matrix = IDENTITY;
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
    this.samples = options.samples ?? 1;
    this.textureLimit = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
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
    this.keeps.lost();
  };

  /**
   * Whether bitmaps that ask to be are smoothed: not at the stage's low
   * quality, nor in a draw for BitmapData at a sample a pixel, as the Pixi
   * view's snapshot has it.
   */
  private get smoothing(): boolean {
    return this.drawRoot ? this.scale > 1 : this.stageQuality !== "LOW";
  }

  /**
   * Samples a pixel the stage and its blend and filter layers are
   * multisampled with, as the GPU allows, 1 for none: Flash's anti-aliasing,
   * which its host sets by the stage's quality (none at low). A
   * BitmapData's draw supersamples instead, as Flash's does.
   */
  get samples(): number {
    return this.backend.samples;
  }

  set samples(samples: number) {
    this.backend.samples = Math.max(1, Math.floor(samples) || 1);
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
    this.filters.reset();
    // The drawing buffer, which a browser may hold smaller than the canvas asks for.
    const target = this.target;
    target.width = this.gl.drawingBufferWidth;
    target.height = this.gl.drawingBufferHeight;
    target.scale = this.scale * this.resolution;
    target.resolution = this.resolution;
    // Outputs kept at another scale, with bitmaps smoothed otherwise or hairlines at another
    // width, are drawn again.
    if (
      target.scale !== this.keptScale ||
      this.stageQuality !== this.keptQuality ||
      this.screenScale !== this.keptScreen
    ) {
      this.keptScale = target.scale;
      this.keptQuality = this.stageQuality;
      this.keptScreen = this.screenScale;
      this.keptGeneration++;
    }

    this.walk(root, 1, 0, 0, 1, 0, 0, null, false);
    measureLayers(this.scene, this.rows, this.geometries, target);
    this.noteKept();
    this.frames++;
    plan(this.scene, this.transparent ? 0 : (0xff000000 | this.background) >>> 0, this.commands);
    this.backend.execute(
      this.commands,
      this.scene,
      this.rows,
      this.geometries,
      this.textures,
      this.filters,
      this.keeps,
      target,
    );
    this.geometries.endFrame();
    this.textures.endFrame();
    this.keeps.endFrame();
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
    const root = o === this.drawRoot;
    const m = root ? this.drawMatrix : o.flatPlaced;
    const a = pa * m.a + pc * m.b;
    const b = pb * m.a + pd * m.b;
    const c = pa * m.c + pc * m.d;
    const d = pb * m.c + pd * m.d;
    const tx = pa * m.tx + pc * m.ty + ptx;
    const ty = pb * m.tx + pd * m.ty + pty;
    if (!hidden && o.visible) {
      noteUnsupported(o);
    }

    // What BitmapData.draw takes is drawn though hidden, or a mask.
    hidden ||= !root && (!o.visible || o.maskOf !== null || o.clipDepth > 0);

    // BitmapData.draw takes its object without its own colour transform, as adl draws it.
    const own = root ? null : o.colorTransform;
    let color = own ? (tint ? concatColor(tint, own) : own) : tint;
    // Its mask, drawn where it stands on the stage, then its scroll's rectangle, clip all it draws;
    // a 3D mask, or one inside what it masks, masks nothing in Flash.
    let clipped = false;
    if (!hidden && o.mask) {
      const mask = !o.maskOf && !o.mask.encloses(o) && !o.mask.space ? o.mask : null;
      if (mask) {
        const w = this.placedMask(mask);
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
    // BitmapData.draw takes its object with no blend mode, as with no transform or colour.
    const named = root ? NORMAL : BLEND_NAMES.indexOf(o.blendMode);
    if (named < 0 && !hidden) {
      unsupported.blendModes++;
    }

    const childful = o instanceof Container && o.children.length > 0;
    const mode = hidden || named < 0 || (named === LAYER && !childful) ? NORMAL : named;
    // Its filters draw it as a layer too, which they run over before its blend: adl filters the
    // object, then blends what they make, in its colour from the stage down, as a bitmap of it.
    const filtering = hidden || o.filters.length === 0 ? null : this.filterPlan(o);
    let layerRow = -1;
    let layer = -1;
    let drawnFrom = 0;
    let output: KeptOutput | null = null;
    if (mode !== NORMAL || filtering) {
      if (mode === LAYER || filtering) {
        layerRow = color ? this.rows.add(1, 0, 0, 1, 0, 0, color) : -1;
        color = null;
      }

      // What its filters made last, where nothing they ran on changed: composited again where it
      // moved to, and all in it walked hidden, as Flash draws a filtered object's bitmap again.
      output =
        filtering && !this.drawRoot ? this.keptOutput(o, filtering, a, b, c, d, tx, ty) : null;
      if (output?.reused) {
        const k = output.handle as KeepHandle;
        const rect = this.keptRect;
        this.scene.keptLayer(k.id, mode, layerRow, rect[0], rect[1], rect[2], rect[3]);
        this.keeps.use(k.id);
        hidden = true;
      } else {
        // Over the rectangle of what is drawn in it, which measureLayers finds; its padding is set
        // once its filters are fitted to that.
        drawnFrom = this.scene.length;
        const keep = output?.keeping ? (output.handle as KeepHandle).id : -1;
        layer = this.scene.layerBegin(filtering ? 0 : -1, keep);
      }
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
      const smooth = (o as BitmapObject).smoothing && this.smoothing;
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

      if (!this.drawRoot) {
        o.descendantsDirty = false;
      }
    }

    if (r) {
      this.popMask();
    }

    if (output?.reused) {
      // Composited again already.
    } else if (filtering) {
      const fitted = this.fitFilters(o, filtering, drawnFrom);
      this.scene.padLayer(layer, fitted.padding);
      this.scene.layerEnd(mode, layerRow, this.chainOf(fitted));
      if (output) {
        output.pad = fitted.padding;
        this.ran.push(output, layer);
      }
    } else if (mode !== NORMAL) {
      this.scene.layerEnd(mode, layerRow);
    }

    if (clipped) {
      this.popMask();
    }

    // A draw for BitmapData leaves them for the stage's.
    if (!this.drawRoot) {
      o.dirty = CLEAN;
    }
  }

  /**
   * Whether `o`'s filters' output kept last can be drawn again, its rectangle
   * then in keptRect; else whether to keep what they make now. Kept while
   * nothing they ran on changed but where it is on the stage, as the Pixi
   * view's FilterChain keeps it: not past a change in `o` but a move, in
   * what is in it, in its scale or turn on the stage (a b c d), a move of
   * what it scrolls, its filters, or the screen's scale; and drawn again
   * only while its rectangle moved with it, its size the same and its
   * corner within a pixel. One that changes frame after frame is not kept,
   * as keeping it would cost a target for nothing.
   */
  private keptOutput(
    o: DisplayObject,
    plan: FilterPlan,
    a: number,
    b: number,
    c: number,
    d: number,
    tx: number,
    ty: number,
  ): KeptOutput {
    let k = this.outputs.get(o);
    if (!k) {
      k = {
        handle: null,
        plan,
        generation: this.keptGeneration,
        seenAt: -1,
        scrolled: false,
        measured: false,
        kept: false,
        reused: false,
        keeping: false,
        changing: 0,
        linear: [a, b, c, d],
        x: 0,
        y: 0,
        pad: 0,
        area: new Float64Array(4),
        rect: new Int32Array(4),
      };
      this.outputs.set(o, k);
    }

    const target = this.target;
    const x = tx * target.scale;
    const y = ty * target.scale;
    const l = k.linear;
    // One not drawn on the frame before was hidden, or off the list, where a walk cleared its flags
    // and its children's without it hearing of a change.
    const changed =
      k.seenAt !== this.frames - 1 ||
      k.plan !== plan ||
      k.generation !== this.keptGeneration ||
      (o.dirty & ~TRANSFORM) !== 0 ||
      (o.dirty & TRANSFORM && (o.scroll !== null || k.scrolled)) ||
      (o instanceof Container && o.descendantsDirty) ||
      l[0] !== a ||
      l[1] !== b ||
      l[2] !== c ||
      l[3] !== d;
    k.seenAt = this.frames;
    k.scrolled = o.scroll !== null;
    let same = false;
    if (!changed && k.measured) {
      // Its area as measured, moved as it moved, measured into a rectangle again.
      const moved = this.movedArea;
      moved[0] = k.area[0] + x - k.x;
      moved[1] = k.area[1] + y - k.y;
      moved[2] = k.area[2] + x - k.x;
      moved[3] = k.area[3] + y - k.y;
      const rect = this.keptRect;
      filteredRect(moved, 0, k.pad, target, rect, 0);
      same =
        rect[2] === k.rect[2] &&
        rect[3] === k.rect[3] &&
        Math.abs(rect[0] - x - (k.rect[0] - k.x)) <= 1 &&
        Math.abs(rect[1] - y - (k.rect[1] - k.y)) <= 1;
    }

    k.reused = !changed && same && k.kept && k.handle !== null && this.keeps.alive(k.handle);
    if (k.reused) {
      k.changing = 0;
      return k;
    }

    // Unchanged but not kept, as after it was filtered without keeping: kept now.
    k.changing = changed || !same ? k.changing + 1 : 0;
    k.keeping = k.changing <= 1;
    k.kept = false;
    k.plan = plan;
    k.generation = this.keptGeneration;
    l[0] = a;
    l[1] = b;
    l[2] = c;
    l[3] = d;
    k.x = x;
    k.y = y;
    if (k.keeping && (!k.handle || !this.keeps.alive(k.handle))) {
      k.handle = this.keeps.add();
    }

    if (k.keeping) {
      this.keeps.use((k.handle as KeepHandle).id);
    }

    return k;
  }

  /** What the filtered layers drawn this frame measured, for their outputs kept to be drawn again. */
  private noteKept(): void {
    const ran = this.ran;
    const scene = this.scene;
    for (let i = 0; i < ran.length; i += 2) {
      const k = ran[i] as KeptOutput;
      const layer = ran[i + 1] as number;
      for (let j = 0; j < 4; j++) {
        k.area[j] = scene.areas[layer * 4 + j];
        k.rect[j] = scene.layers[layer * 4 + j];
      }

      // Kept where its output was: a layer of no size draws nothing, and keeps nothing, nor does one
      // in a layer of no size, which the planner leaves out with all in it.
      k.measured = k.rect[2] > 0 && k.rect[3] > 0;
      k.kept = k.keeping && k.measured && drawnWithin(scene, layer);
    }

    ran.length = 0;
  }

  /**
   * `o`'s filters worked out for the units they are drawn at and the room a
   * texture has, again only as one of those or their values change: null
   * where it has none drawn.
   */
  private filterPlan(o: DisplayObject): FilterPlan | null {
    const records = o.filters;
    // A stage scaled to nothing filters at a unit a pixel rather than not at all.
    const units = Number.isFinite(this.scale) && this.scale > 0 ? this.scale : 1;
    const kept = this.filterPlans.get(o);
    // A draw for BitmapData plans at its own units, leaving the stage's plans be.
    if (this.drawRoot) {
      return kept?.units === units
        ? kept.plan
        : planFilters(records, units, Number.POSITIVE_INFINITY, kept?.plan ?? null);
    }

    if (kept && kept.units === units) {
      if (kept.records === records) {
        return kept.plan;
      }

      // Set again with the same values, as a tween writes them on each frame.
      if (sameFilterRecords(records, kept.records)) {
        kept.records = records;
        return kept.plan;
      }
    }

    const plan = planFilters(records, units, Number.POSITIVE_INFINITY, kept?.plan ?? null);
    this.filterPlans.set(o, { records, units, plan, cap: Number.POSITIVE_INFINITY, capped: null });
    return plan;
  }

  /**
   * `plan`, `o`'s, with its padding cut where it would not fit a texture
   * round what `o` drew, the scene's entries from `from` on: its area cut
   * to the target, as Pixi's filter system measured it (render/filters.ts,
   * fitPadding). Only a padding past what fits round the whole target asks
   * for the area.
   */
  private fitFilters(o: DisplayObject, plan: FilterPlan, from: number): FilterPlan {
    const res = this.resolution;
    const width = this.target.width / res;
    const height = this.target.height / res;
    if (plan.padding <= filterRoom(this.textureLimit, res, width, height)) {
      return plan;
    }

    const area = this.drawn;
    drawnArea(this.scene, this.rows, this.geometries, from, this.scale * res, area);
    const room = filterRoom(
      this.textureLimit,
      res,
      Math.min(area[2] / res, width) - Math.max(area[0] / res, 0),
      Math.min(area[3] / res, height) - Math.max(area[1] / res, 0),
    );
    const cap = paddingCap(plan.wanted, room);
    const kept = this.filterPlans.get(o);
    if (cap === Number.POSITIVE_INFINITY || !kept) {
      return plan;
    }

    if (this.drawRoot) {
      return planFilters(kept.records, kept.units, cap, plan) ?? plan;
    }

    if (kept.cap !== cap || !kept.capped) {
      kept.cap = cap;
      kept.capped = planFilters(kept.records, kept.units, cap, kept.capped ?? plan) ?? plan;
    }

    return kept.capped;
  }

  /** `plan`'s passes added to the frame's filters as a chain, their gradients' textures uploaded: its number. */
  private chainOf(plan: FilterPlan): number {
    for (const pass of plan.passes) {
      let texture = -1;
      if (pass.colors) {
        if (!pass.texture || !this.textures.alive(pass.texture)) {
          // A copy, as the backend lets the pixels it uploads go.
          pass.texture = this.textures.add(256, 1, pass.colors.slice(), GRADIENT_IDLE_FRAMES);
        }

        texture = pass.texture.id;
        this.textures.use(texture);
      } else if (pass.map) {
        // Its map as it is now, a texture of its pixels kept as a bitmap's is.
        if (pass.map.disposed) {
          continue;
        }

        // A map set anew is a copy anew, as a tween writing the filters takes one each frame:
        // its texture goes soon once the next one takes its place.
        texture = this.storeTexture(pass.map, GRADIENT_IDLE_FRAMES).id;
        this.textures.use(texture);
      }

      this.filters.add(pass.kind, pass.values, texture);
    }

    return this.filters.close();
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

      if (!this.drawRoot) {
        o.descendantsDirty = false;
      }
    }

    // A draw for BitmapData leaves them for the stage's.
    if (!this.drawRoot) {
      o.dirty = CLEAN;
    }
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
      return (paint.smooth && this.smoothing ? SMOOTH : 0) | (paint.repeat ? REPEAT : CLAMP);
    }

    if (paint.radial) {
      return SMOOTH | CLAMP;
    }

    return paint.spread === 1 ? MIRROR : paint.spread === 2 ? REPEAT : CLAMP;
  }

  /** `store`'s texture, its pixels uploaded again if they changed since. */
  private storeTexture(store: BitmapStore, idle?: number): TextureHandle {
    const kept = this.stores.get(store);
    if (kept && this.textures.alive(kept.handle)) {
      if (kept.version !== store.version) {
        kept.version = store.version;
        this.textures.set(kept.handle.id, store.width, store.height, rgbaOf(store.readable));
      }

      return kept.handle;
    }

    const handle = this.textures.add(store.width, store.height, rgbaOf(store.readable), idle);
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

  /**
   * `o` drawn alone, as BitmapData.draw takes a display object, through `m`
   * into a `width` by `height` bitmap, read back as premultiplied ARGB: at
   * `samples` a side and averaged, as Flash covers edges (4 at its high
   * quality), as the Pixi view's snapshot draws it. Built at the draw's own
   * scale, a hairline a pixel of the bitmap, then drawn `samples` times
   * larger, filters and device text at that many units a pixel; no flag of
   * any object is cleared, nor an output kept, which are the stage's.
   */
  snapshot(
    o: DisplayObject,
    m: { a: number; b: number; c: number; d: number; tx: number; ty: number },
    width: number,
    height: number,
    samples = 4,
  ): Uint32Array {
    // As many samples as a texture holds, halved as BitmapData.draw's are.
    let n = Math.max(1, samples);
    while (n > 1 && Math.max(width, height) * n > this.textureLimit) {
      n /= 2;
    }

    if (width <= 0 || height <= 0 || Math.max(width, height) > this.textureLimit) {
      return new Uint32Array(Math.max(0, width * height));
    }

    const stage = {
      target: this.target,
      scale: this.scale,
      resolution: this.resolution,
      screenScale: this.screenScale,
    };
    this.target = { width: width * n, height: height * n, scale: n, x: 0, y: 0, resolution: 1 };
    this.scale = n;
    this.resolution = 1;
    this.screenScale = 1;
    this.drawRoot = o;
    this.drawMatrix = o.scroll ? shifted(m, o.scroll) : m;
    try {
      this.scene.reset();
      this.rows.reset();
      this.filters.reset();
      this.walk(o, 1, 0, 0, 1, 0, 0, null, false);
      measureLayers(this.scene, this.rows, this.geometries, this.target);
      plan(this.scene, 0, this.commands);
      const bytes = this.backend.snapshot(
        this.commands,
        this.scene,
        this.rows,
        this.geometries,
        this.textures,
        this.filters,
        this.keeps,
        this.target,
        width,
        height,
        n,
      );
      return argbOf(bytes);
    } finally {
      this.target = stage.target;
      this.scale = stage.scale;
      this.resolution = stage.resolution;
      this.screenScale = stage.screenScale;
      this.drawRoot = null;
      this.drawMatrix = IDENTITY;
    }
  }

  /**
   * Where a mask is drawn: on the stage, or, in a draw for BitmapData, in
   * the bitmap, where it stands to what is drawn as it stands on the stage.
   */
  private placedMask(mask: DisplayObject): Matrix {
    const onStage = toStageFlat(mask);
    const root = this.drawRoot;
    if (!root) {
      return onStage;
    }

    // One drawn through no inverse, scaled to nothing on the stage, has no place to measure the mask
    // from: it masks as it stands on the stage.
    const rootInverse = invert(toStageFlat(root));
    return rootInverse ? concat(concat(onStage, rootInverse), this.drawMatrix) : onStage;
  }

  /** The mouse, touches and wheel on the canvas to `player`'s stage (pointer.ts); what undoes it. */
  bindPointer(player: Player): () => void {
    return bindCanvasPointer(this.canvas, player);
  }

  /**
   * Drawn on the GPU into a store, which this renderer does not keep there:
   * BitmapData.draw takes a snapshot.
   */
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

/** Whether every layer `layer` is in has a size, as the planner draws only such. */
function drawnWithin(scene: SceneList, layer: number): boolean {
  const r = scene.layers;
  for (let p = scene.parents[layer]; p >= 0; p = scene.parents[p]) {
    if (r[p * 4 + 2] <= 0 || r[p * 4 + 3] <= 0) {
      return false;
    }
  }

  return true;
}

/** Count what `o` asks of the renderer that it does not draw yet (shapes.ts, unsupported). */
function noteUnsupported(o: DisplayObject): void {
  if (o.scale9Grid) {
    unsupported.scale9Grids++;
  }

  if (undrawnFilter(o.filters)) {
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
