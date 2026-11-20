// The renderer as the player drives it (docs/renderer.md): a view that
// owns a WebGL 2 canvas, walks the display list into a scene list and its
// rows, and has @swf2es/render plan and draw it.
import { type ColorTransform, IDENTITY, type Matrix } from "@swf2es/format";
import { Tessellator } from "@swf2es/native/render";
import {
  ALPHA_MASK,
  BLEND,
  BLEND_NAMES,
  blendsDirect,
  CLAMP,
  Commands,
  FILL_SHADER,
  Filters,
  Geometries,
  KERNEL,
  type KeepHandle,
  Keeps,
  LAYER,
  measureLayers,
  NO_WHOLE,
  NORMAL,
  PLANE,
  plan,
  Rows,
  SceneList,
  SHADED,
  SMOOTH,
  spanDifference,
  Textures,
  WHOLE_ALIASED,
  WHOLE_SMOOTH,
} from "@swf2es/render";
import { WebGLBackend } from "@swf2es/render/webgl";
import { argbOf, type BitmapStore } from "../bitmap/bitmap.js";
import { BitmapObject } from "../display/bitmapobject.js";
import { concatColor, concatColorInto, IDENTITY_COLOR, sameColor } from "../display/color.js";
import { Container } from "../display/container.js";
import { CLEAN, type DisplayObject } from "../display/displayobject.js";
import { concat, invert, shifted } from "../display/geometry.js";
import { bitmapScale, drawnRect, outsideMaskMap, placeQuad } from "../display/plane.js";
import { type Slice, sliceDrawn, sliceLayers } from "../display/scale9.js";
import { cached, framePassed, ShapeObject } from "../display/shapeobject.js";
import { facing } from "../display/shapes.js";
import { type Linear, settledStretch, stretchOf } from "../display/stretch.js";
import { StaticTextObject, settleFits, TextObject } from "../display/textobjects.js";
import { VideoObject } from "../display/videoobject.js";
import { Clips } from "../display/walk.js";
import type { Drawer } from "../hosts.js";
import type { FocusHighlight } from "../input/focus-highlight.js";
import type { Player } from "../player.js";
import {
  allowResets,
  holdSegments,
  MOST,
  resetSegments,
  store as saffronStore,
} from "../text/saffron.js";
import { AdvancedTexts } from "./advanced.js";
import type { FillTessellator } from "./fills.js";
import { FilterLayers, type KeptOutput } from "./filter-layers.js";
import { undrawnFilter } from "./filters.js";
import { syncHidden } from "./hidden.js";
import { LineCache } from "./lines.js";
import { Masks } from "./masks.js";
import { Paints, paintSampler } from "./paints.js";
import { Parts } from "./parts.js";
import { Planes, planeUnchanged } from "./planes.js";
import { bindCanvasPointer } from "./pointer.js";
import { unsupported } from "./shapes.js";
import { clean, Spans } from "./spans.js";
import { StaleShapes } from "./stale-shapes.js";
import { deviceTextResolution, fieldItems, staticItems, type TextOmissions } from "./text.js";
import { placedRow, TextItems } from "./text-items.js";
import { Videos } from "./videos.js";

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
  /**
   * The fills' and lines' tessellator, as @swf2es/native's Tessellator gives
   * it; left out, the view makes one of its own, which it disposes of with
   * itself. Either way the render module must compile: where a page does
   * not let it (no WebAssembly or SIMD, or a CSP without
   * 'wasm-unsafe-eval'), the view throws.
   */
  fillTessellator?: FillTessellator;
  /** Samples a pixel the stage and its layers are multisampled with (`samples`); 1, none, if left out. */
  samples?: number;
  /**
   * Whether each object's span of the scene list (Spans) is checked: walked
   * in full, as a frame with no spans would walk it, where a span kept from
   * the frame before would stand for it, the two compared entry for entry
   * and row for row, and an error thrown where they differ, naming the
   * object and where. For tests (`pnpm test:checked`); RenderView.checkSpans
   * if left out.
   */
  checked?: boolean;
}

/** No transform, where a walk starts. */
const UNIT_PLACE = [1, 0, 0, 1, 0, 0];

/** The numbers a render draws from besides its root and quality (RenderView.inputsInto). */
const INPUTS = 18;

/** The focus's rectangle's width in screen pixels, inside its object's bounds, and its colour. */
const HIGHLIGHT_WIDTH = 3;
const HIGHLIGHT_COLOR = { rMul: 1, gMul: 1, bMul: 0, aMul: 1, rAdd: 0, gAdd: 0, bAdd: 0, aAdd: 0 };

/** What a pass of its own swaps out of the walk (RenderView.passState). */
interface PassState {
  scene: SceneList;
  rows: Rows;
  filters: Filters;
  commands: Commands;
  target: RenderView["target"];
  scale: number;
  filterUnits: number | null;
  resolution: number;
  screenScale: number | null;
  drawRoot: DisplayObject | null;
  drawMatrix: Matrix;
  snapshotting: boolean;
  walkDepth: number;
  sliceOwner: DisplayObject | null;
  ownerSlice: Slice | null;
}

/**
 * Draws the player's display list on a canvas of its own. Each render
 * walks the whole list, writing a row for each object drawn and an entry
 * for each of its layers' geometries, each geometry made once and kept
 * while drawn; then plans the frame and has the backend draw it.
 */
export class RenderView implements Drawer {
  /** Whether views made from here on check their spans where not told (RenderViewOptions' `checked`). */
  static checkSpans = false;
  readonly canvas: HTMLCanvasElement;
  readonly gl: WebGL2RenderingContext;
  /** View pixels a stage pixel, before the resolution: a host showing the stage larger. */
  scale = 1;
  /** Screen pixels a stage pixel, which hairlines will be drawn a pixel of; the scale's if null. */
  screenScale: number | null = null;
  /**
   * The focus's yellow rectangle, drawn over everything (Player.focusHighlight);
   * a host sets it before each render, null where none shows.
   */
  highlight: FocusHighlight | null = null;
  background: number;
  transparent: boolean;
  /** Lines stroked anew and lines found stroked already (LineCache.counts). */
  readonly counts: LineCache["counts"];
  private resolution: number;
  private width: number;
  private height: number;
  private stageQuality = "HIGH";
  private readonly backend: WebGLBackend;
  private readonly tessellator: FillTessellator;
  /** Whether the view made its canvas, whose context it then loses with itself. */
  private readonly ownCanvas: boolean;
  /** The tessellator the view made, which it disposes of with itself; none if it was given one. */
  private readonly ownTessellator: Tessellator | null;
  private scene = new SceneList();
  private rows = new Rows();
  private readonly geometries = new Geometries();
  private readonly textures = new Textures();
  private readonly videos = new Videos(this.textures);
  private commands = new Commands();
  private filters = new Filters();
  private readonly lineCache: LineCache;
  private readonly parts: Parts;
  private readonly paints = new Paints(this.textures, {
    read: (id, width, height) => this.backend.readTexture(id, width, height),
    fill: (id, r, pixel) =>
      this.backend.fillTexture(this.textures, id, r.x, r.y, r.width, r.height, pixel),
    copy: (from, r, to, dx, dy) =>
      this.backend.copyTexture(this.textures, from, r.x, r.y, r.width, r.height, to, dx, dy),
  });
  private readonly staleShapes = new StaleShapes();
  private readonly textItems: TextItems;
  private readonly advancedTexts: AdvancedTexts;
  private readonly masks: Masks;
  private readonly filterLayers: FilterLayers;
  private readonly planes: Planes;
  /** The largest texture side the context makes, which a filtered layer's padding must fit. */
  private textureLimit: number;
  /** The outlines' store kept while the view is (text/saffron.ts, holdSegments), let go of with it. */
  private readonly releaseOutlines = holdSegments();
  /** The walk's depth, and a colour transform a depth, which a concatenation there is made in. */
  private walkDepth = 0;
  /** Each depth's transform on the stage, a b c d tx ty, which its children are placed under. */
  private places = new Float64Array(6 * 64);
  /** A Bitmap's placement moved onto whole pixels (wholePixels). */
  private moved = new Float64Array(6);
  private readonly colorSlots: ColorTransform[] = [];
  /** The sliced owner whose children are walked now, its slice, and its parent's linear transform. */
  private sliceOwner: DisplayObject | null = null;
  private ownerSlice: Slice | null = null;
  private ownerParent: number[] = [1, 0, 0, 1];
  /**
   * The object the blend layer being walked holds alone, at the end of its
   * chain of only children (soleChild): a part of several fills it draws
   * may be drawn without the layer, as if the blend were its own.
   */
  private soleBlended: DisplayObject | null = null;
  /** The outputs kept: filtered objects' (FilterLayers) and 3D objects' bitmaps (Planes). */
  private readonly keeps = new Keeps();
  /** Moves on as what every kept output was made at changes: the scale, the stage's quality. */
  private keptGeneration = 0;
  private keptScale = 0;
  private keptQuality = "";
  private keptScreen: number | null = null;
  /** The stage's frames drawn. */
  private frames = 0;
  /** Where a frame is drawn, filled in as it is. */
  private target = { width: 0, height: 0, scale: 1, x: 0, y: 0, resolution: 1, pixel: 1 };
  /**
   * What BitmapData.draw draws alone, while it is drawn (snapshot), and the
   * matrix it is drawn through, after its scroll's shift.
   */
  private drawRoot: DisplayObject | null = null;
  /**
   * Whether the walk is BitmapData.draw's, which leaves the objects' flags
   * for the stage's frame; a 3D object's pass in the frame clears them, as
   * the frame's walk would.
   */
  private snapshotting = false;
  /** Target pixels a pixel of what filters run on, where not the scale: in a 3D object's bitmap. */
  private filterUnits: number | null = null;
  private drawMatrix: Matrix = IDENTITY;
  /**
   * The alpha mask drawn for what it masks (drawAlphaMask), which the walk
   * places where it stands on the stage and draws though it is a mask.
   */
  private placedAlphaMask: DisplayObject | null = null;
  /**
   * Whether an alpha mask's objects are walked, whose flags their own place
   * on the list may have cleared first: their filters run anew, keeping no
   * output, as nothing would say when one changed.
   */
  private inAlphaMask = false;
  /** An object's transform's linear part, made its stretch in place (stretchOf). */
  private readonly stretchScratch: Linear = [0, 0, 0, 0];
  /**
   * What the last render drew from, which `unchanged` compares: its root,
   * null before one and once the context came back; its quality; and its
   * other inputs, with room to read them again.
   */
  private drawnRoot: DisplayObject | null = null;
  private drawnQuality = "";
  private readonly drawnInputs = new Float64Array(INPUTS);
  private readonly nowInputs = new Float64Array(INPUTS);
  /** The stage's objects' spans of the scene list, kept where they are checked (`checked`), else none. */
  private readonly spans: Spans | null;
  /**
   * What the walk met that a span does not follow, counted as it is met: an
   * object's span stands for it only where its walk counted none (plain).
   */
  private unkept = 0;
  /** The spans being checked, a walk of each under way (checkSpan). */
  private checking = 0;

  constructor(options: RenderViewOptions) {
    // First, so that a page that cannot run the render module throws before a context is made.
    this.ownTessellator = options.fillTessellator ? null : new Tessellator();
    this.tessellator = options.fillTessellator ?? (this.ownTessellator as Tessellator).tessellate;
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
    this.spans = (options.checked ?? RenderView.checkSpans) ? new Spans() : null;
    // None of a context made lost, till it is restored.
    this.textureLimit = (gl.getParameter(gl.MAX_TEXTURE_SIZE) as number | null) ?? 0;

    this.lineCache = new LineCache(this.geometries, this.tessellator);
    this.counts = this.lineCache.counts;
    this.parts = new Parts(this.geometries, this.tessellator, this.lineCache);
    this.textItems = new TextItems(this.geometries, this.textures, this.parts);
    this.advancedTexts = new AdvancedTexts(this.geometries);
    this.masks = new Masks(this.geometries, this.parts);
    this.filterLayers = new FilterLayers(this.geometries, this.textures, this.keeps, this.paints);
    this.planes = new Planes(this.geometries);

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
    this.drawnRoot = null;
    this.spans?.drop();
    this.backend.restore(this.geometries);
    this.textures.lost();
    this.keeps.lost();
    this.textureLimit ||= (this.gl.getParameter(this.gl.MAX_TEXTURE_SIZE) as number | null) ?? 0;
  };

  /**
   * Whether bitmaps that ask to be are smoothed: not at the stage's low
   * quality, nor in a draw for BitmapData at a sample a pixel.
   */
  private get smoothing(): boolean {
    return this.snapshotting ? this.scale > 1 : this.stageQuality !== "LOW";
  }

  /**
   * Samples a pixel the stage and its blend and filter layers are
   * multisampled with, as the GPU allows, 1 for none: Flash's anti-aliasing,
   * which its host sets by the stage's quality, none at low whatever is set.
   * A BitmapData's draw supersamples instead, as Flash's does.
   */
  get samples(): number {
    return this.wantedSamples;
  }

  set samples(samples: number) {
    this.wantedSamples = Math.max(1, Math.floor(samples) || 1);
    this.backend.samples = this.stageQuality === "LOW" ? 1 : this.wantedSamples;
  }

  /** The samples the host asked for, which the stage's low quality sets aside (`samples`). */
  private wantedSamples = 1;

  /** The stage's quality, "LOW" to "BEST", which will decide bitmaps' smoothing. */
  get quality(): string {
    return this.stageQuality;
  }

  set quality(quality: string) {
    this.stageQuality = quality;
    // Flash draws edges aliased at low, whatever samples the host asked for.
    this.samples = this.wantedSamples;
  }

  /**
   * The rectangle of the stage, from (x, y), the canvas shows: its size
   * the canvas's (resize), in stage
   * pixels, where a host's margins or alignment show more of the stage or
   * less than its own.
   */
  setViewport(x: number, y: number, _width: number, _height: number): void {
    this.viewX = x;
    this.viewY = y;
  }

  /** The stage's point the canvas's corner shows (setViewport). */
  private viewX = 0;
  private viewY = 0;

  /** Canvas pixels a stage pixel (resize). */
  get canvasResolution(): number {
    return this.resolution;
  }

  /** How many geometries it keeps, which a page may check. */
  get geometryCount(): number {
    return this.geometries.count;
  }

  /** How many device texts' runs it keeps drawn (rasterized device text), which a page may check. */
  get textRuns(): number {
    return this.textItems.runCount;
  }

  /** How many glyphs and runs of device text it has rasterized, which a page may check for churn. */
  get textRasterized(): number {
    return this.textItems.rasterized;
  }

  /** The canvas made `width` by `height` stage pixels at `resolution` canvas pixels each. */
  resize(width: number, height: number, resolution = this.resolution): void {
    this.width = width;
    this.height = height;
    this.resolution = resolution;
    this.canvas.width = Math.max(1, Math.round(width * resolution));
    this.canvas.height = Math.max(1, Math.round(height * resolution));
  }

  /**
   * Whether rendering `root` now would draw what the canvas shows: the root
   * the last render drew, nothing in it invalidated since (its flags, which
   * every change a render syncs sets up to the root, a BitmapData's pixels
   * shown by a Bitmap or a fill too, and which the render cleared), nothing
   * waiting to upload, and the view's size, scale, quality, samples,
   * background and viewport as they were. A host may then leave the canvas
   * be, which gives the browser no frame to composite, as Flash repaints no
   * region of a stage where nothing changed.
   */
  unchanged(root: DisplayObject): boolean {
    if (
      root !== this.drawnRoot ||
      root.dirty !== CLEAN ||
      (root instanceof Container && root.descendantsDirty) ||
      this.stageQuality !== this.drawnQuality
    ) {
      return false;
    }

    const now = this.inputsInto(this.nowInputs);
    const drawn = this.drawnInputs;
    for (let i = 0; i < INPUTS; i++) {
      if (now[i] !== drawn[i]) {
        return false;
      }
    }

    return !this.gl.isContextLost() && !this.backend.stale;
  }

  /** The numbers a render draws from, besides its root and its quality, in `to`. */
  private inputsInto(to: Float64Array): Float64Array {
    const gl = this.gl;
    to[0] = this.scale;
    to[1] = this.screenScale ?? -1;
    to[2] = this.background;
    to[3] = this.transparent ? 1 : 0;
    to[4] = this.resolution;
    to[5] = this.canvas.width;
    to[6] = this.canvas.height;
    to[7] = gl.drawingBufferWidth;
    to[8] = gl.drawingBufferHeight;
    to[9] = this.backend.samples;
    to[10] = this.viewX;
    to[11] = this.viewY;
    to[12] =
      this.textures.pending.length + this.geometries.added.length + this.geometries.updated.length;
    const h = this.highlight;
    to[13] = h ? 1 : 0;
    to[14] = h ? h.xMin : 0;
    to[15] = h ? h.yMin : 0;
    to[16] = h ? h.xMax : 0;
    to[17] = h ? h.yMax : 0;
    return to;
  }

  /** Draw `root`'s display list. */
  render(root: DisplayObject): void {
    // A field a script changed since the last frame ended, or before the first, is fitted before it is drawn.
    settleFits();
    // Drawn, MorphShapes placed at a new ratio meet shape tests at it (ShapeObject.blending).
    framePassed();
    // Not drawn until it is all drawn: a render that throws leaves no frame to keep.
    this.drawnRoot = null;
    // Nothing to draw into while the context is lost, and nothing walked: what changed meanwhile
    // is drawn once it is back. Nor while a backend that gave up on a frame before the browser
    // said the context was lost waits to see whether it was (WebGLBackend.resume).
    if (this.gl.isContextLost()) {
      return;
    }

    if (this.backend.stale) {
      if (!this.backend.resume()) {
        return;
      }

      // Drawing on with the context it has: the outputs the frame given up on was to keep were
      // never all drawn, and are drawn again.
      this.keeps.lost();
      this.spans?.drop();
    }

    // The drawing buffer, which a browser may hold smaller than the canvas asks for.
    const target = this.target;
    target.width = this.gl.drawingBufferWidth;
    target.height = this.gl.drawingBufferHeight;
    target.scale = this.scale * this.resolution;
    target.resolution = this.resolution;
    // A pixel of the screen, where the host says what that is (screenScale).
    target.pixel = this.screenScale ? target.scale / this.screenScale : 1;
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

    // The lists the frame before wrote kept for its spans, this frame's written into others.
    const spans = this.spans;
    if (spans) {
      const free = spans.begin(this.scene, this.rows, this.keptGeneration);
      this.scene = free.scene;
      this.rows = free.rows;
    }

    this.scene.reset();
    this.rows.reset();
    this.filters.reset();

    // The outlines' store started again between frames, before it fills: not in a walk, where the
    // quads drawn before would name runs it let go of (text/saffron.ts, allowResets).
    if (saffronStore.used > MOST * 0.75) {
      resetSegments();
    }

    allowResets(false);
    this.checking = 0;
    try {
      this.walkFrom(root);
    } finally {
      allowResets(true);
    }

    spans?.end(this.scene, this.geometries, this.textures);
    if (this.highlight) {
      this.drawHighlight(this.highlight);
    }

    measureLayers(this.scene, this.rows, this.geometries, target);
    this.filterLayers.noteKept(this.scene);
    this.frames++;
    plan(this.scene, this.transparent ? 0 : (0xff000000 | this.background) >>> 0, this.commands);
    this.uploadOutlines();
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
    this.drawnRoot = root;
    this.drawnQuality = this.stageQuality;
    this.inputsInto(this.drawnInputs);
  }

  /**
   * The focus's rectangle, last, over all: four yellow bars inside the
   * frame, each three screen pixels wide, as a hairline is one (Flash's
   * stays that wide on a stage shown larger), on the walk's top level.
   */
  private drawHighlight(frame: FocusHighlight): void {
    const pixel = 1 / (this.screenScale ?? this.scale * this.resolution);
    const across = Math.min(HIGHLIGHT_WIDTH * pixel, (frame.xMax - frame.xMin) / 2);
    const down = Math.min(HIGHLIGHT_WIDTH * pixel, (frame.yMax - frame.yMin) / 2);
    const top = frame.yMin + down;
    const bottom = frame.yMax - down;
    this.highlightBar(frame.xMin, frame.yMin, frame.xMax, top);
    this.highlightBar(frame.xMin, bottom, frame.xMax, frame.yMax);
    this.highlightBar(frame.xMin, top, frame.xMin + across, bottom);
    this.highlightBar(frame.xMax - across, top, frame.xMax, bottom);
  }

  private highlightBar(left: number, top: number, right: number, bottom: number): void {
    if (right <= left || bottom <= top) {
      return;
    }

    const quad = this.parts.unitQuad();
    this.geometries.use(quad.id);
    const row = this.rows.add(
      right - left,
      0,
      0,
      bottom - top,
      left - this.viewX,
      top - this.viewY,
      HIGHLIGHT_COLOR,
    );
    this.scene.draw(quad.id, row, NORMAL);
  }

  /**
   * `o` and what is in it, under its parent's transform on the stage (a b
   * c d tx ty) and colour transform. Masks are walked but not drawn, nor
   * what is hidden; every object's flags are cleared, as the player
   * expects of a renderer.
   */
  private walk(o: DisplayObject, tint: ColorTransform | null, hidden: boolean): void {
    if (hidden) {
      syncHidden(o, this.snapshotting);
      return;
    }

    // Where its span begins, and whether one is kept for it (Spans): counted unkept unless plain.
    const spans = this.spans;
    const first = this.scene.length;
    const rowsFirst = this.rows.count;
    const unkept = this.unkept;
    const spanning = spans !== null && this.spanContext();
    let kept: { first: number; end: number; rowsFirst: number; rowsEnd: number } | null = null;
    if (spans !== null) {
      if (this.checking > 0 && !clean(o)) {
        throw new Error(
          `the span of an object above ${describe(o)} was taken as unchanged, but it changed`,
        );
      }

      // Plain now, as well as when its span was written: a mask walked before its place on the
      // list had its flags cleared there (Masks.walkMask), and becomes no plain object unflagged.
      const isPlain = plain(o);
      if (!isPlain) {
        this.unkept++;
      }

      const s =
        spanning && isPlain && clean(o)
          ? spans.kept(o, this.places, this.walkDepth * 6, tint, this.geometries, this.textures)
          : null;
      if (s) {
        kept = { first: s.first, end: s.end, rowsFirst: s.rowsFirst, rowsEnd: s.rowsEnd };
        this.checking++;
      }
    }

    // Its parent's transform from the stack of them, where its own goes for its children: numbers
    // a recursive call passed were boxed, six an object on every frame.
    const depth = this.walkDepth++;
    let places = this.places;
    const at = depth * 6;
    const pa = places[at];
    const pb = places[at + 1];
    const pc = places[at + 2];
    const pd = places[at + 3];
    const ptx = places[at + 4];
    const pty = places[at + 5];
    const root = o === this.drawRoot;
    // An alpha mask drawn for what it masks is placed by its parent's slot alone (drawAlphaMask).
    const placing = o === this.placedAlphaMask;
    const m = root ? this.drawMatrix : placing ? IDENTITY : o.flatPlaced;
    const a = pa * m.a + pc * m.b;
    const b = pb * m.a + pd * m.b;
    const c = pa * m.c + pc * m.d;
    const d = pb * m.c + pd * m.d;
    const tx = pa * m.tx + pc * m.ty + ptx;
    const ty = pb * m.tx + pd * m.ty + pty;
    // Its own after its parent's, where its rows and its children read it.
    if (at + 12 > places.length) {
      const grown = new Float64Array(places.length * 2);
      grown.set(places);
      this.places = grown;
      places = grown;
    }

    places[at + 6] = a;
    places[at + 7] = b;
    places[at + 8] = c;
    places[at + 9] = d;
    places[at + 10] = tx;
    places[at + 11] = ty;

    if (!hidden && o.visible) {
      noteUnsupported(o);
    }

    // What BitmapData.draw takes is drawn though hidden, or a mask.
    hidden ||= !root && !placing && (!o.visible || o.maskOf !== null || o.clipDepth > 0);

    // BitmapData.draw takes its object without its own colour transform, as adl draws it.
    const own = root ? null : o.colorTransform;
    // Into a slot of its depth's, which its subtree's walk alone reads: rows copy what they take.
    let color = own ? (tint ? this.concatAt(depth, tint, own) : own) : tint;
    // Its mask, drawn where it stands on the stage, then its scroll's rectangle, clip all it draws;
    // a 3D mask, or one inside what it masks, masks nothing in Flash. A script's mask on the display
    // list masks by its alpha where both are cached as bitmaps, as adl draws it (the `alpha-masks`
    // case): what it masks drawn as a layer, the mask's own layer composited onto it by its alpha
    // (drawAlphaMask). A timeline's masks clip by their shapes, cached or not (`alpha-masks-avm1`).
    // One met while an alpha mask is drawn clips by its shape: two masks each holding what the other
    // masks would otherwise draw each other without end.
    let clipped = false;
    let alphaMask: DisplayObject | null = null;
    // A 3D object's content is drawn into its bitmap (drawPlane), which a 2D mask clips there, in
    // its pass, not its quad on the stage.
    const plane = !hidden && !root && o.space !== null;
    if (!hidden && !plane && o.mask) {
      const mask = !o.maskOf && !o.mask.encloses(o) && !o.mask.space ? o.mask : null;
      if (mask?.parent && !this.inAlphaMask && cached(o) && cached(mask)) {
        alphaMask = mask;
      } else if (mask) {
        const w = this.placedMask(mask);
        const first = this.masks.maskBegin(this.scene);
        this.masks.walkMask(
          this.scene,
          this.rows,
          this.snapshotting,
          mask,
          w.a,
          w.b,
          w.c,
          w.d,
          w.tx,
          w.ty,
          true,
        );
        this.masks.maskUse(this.scene, first);
        clipped = true;
      } else {
        unsupported.masks++;
      }
    }

    // A blend mode draws it as a layer, composited onto what is below in its mode. An explicit
    // layer with children colours their combined pixels, its own fills with them, which then take
    // no colour of their own; without children, it colours each fill.
    // A layer of no children is its fills, drawn as normal; a mode it has no blend for (a Pixel
    // Bender shader's) is drawn as normal, and counted.
    // BitmapData.draw takes its object with no blend mode, as with no transform or colour.
    // A blend shader's mode names its kernel's chain of the frame's filters; "shader" with none is
    // normal. A filtered object blends as the bitmap Flash keeps of it, over its whole rectangle.
    const shading = !root && !hidden && o.blendMode === "shader";
    const named = shading
      ? o.blendShader
        ? KERNEL +
          this.filterLayers.kernelChain(
            o.blendShader,
            this.filters,
            BLEND,
            !plane && o.filters.length > 0,
          )
        : NORMAL
      : root
        ? NORMAL
        : BLEND_NAMES.indexOf(o.blendMode);
    if (named < 0 && !hidden) {
      unsupported.blendModes++;
    }

    const childful = o instanceof Container && o.children.length > 0;
    // A 3D object's layer is its bitmap already.
    const mode = hidden || named < 0 || (named === LAYER && (!childful || plane)) ? NORMAL : named;
    // Its filters draw it as a layer too, which they run over before its blend: adl filters the
    // object, then blends what they make, in its colour from the stage down, as a bitmap of it. The
    // 9-slice grid that reshapes what it draws itself (display/scale9.ts): its own, sliced as its
    // morphs take their new ratios, so that its bounds are this frame's; or, for a Shape, its
    // owner's, kept as the owner's children are walked, unless it is filtered, which adl draws as a
    // bitmap of it, stretched whole (sliceFor). Masks are hidden, and draw unsliced; so does what
    // BitmapData.draw takes, its Shapes by its grid too, which draws with no transform of its own.
    const ownSlice = !hidden && o.scale9Grid && !root ? sliceDrawn(o) : null;
    const slice =
      ownSlice ??
      (!hidden &&
      o instanceof ShapeObject &&
      o.parent !== null &&
      o.parent === this.sliceOwner &&
      o.filters.length === 0
        ? this.ownerSlice
        : null);
    // A 3D object's content is drawn in its own space into a bitmap, which its quad then places in
    // perspective (drawPlane); its filters run in the bitmap, its blend on the quad.
    const filtering =
      hidden || plane || o.filters.length === 0
        ? null
        : this.filterLayers.filterPlan(o, this.filterUnits, this.scale, this.drawRoot !== null);
    // Its colour, which a 3D object's bitmap takes, all above it drawn into it.
    const full = color;
    // A ShaderFilter's kernel runs over Flash's bitmap of the object, of whole pixels.
    const whole = !filtering?.whole
      ? NO_WHOLE
      : this.stageQuality === "LOW"
        ? WHOLE_ALIASED
        : WHOLE_SMOOTH;
    let layerRow = -1;
    let layer = -1;
    // A blend over what Flash keeps a bitmap of, it or the chain of only children it holds, where
    // that is fills that meet: Flash blends the bitmap as one picture, which the fills drawn
    // straight onto what is below would not be, each blended by what it covers
    // (WebGLBackend.blendDirect, SceneList.groups). One fill or a bitmap draws alike either way.
    const grouped = !hidden && blendsDirect(mode) && cachedChain(o) && severalFills(o);
    let drawnFrom = 0;
    let output: KeptOutput | null = null;
    // Its filters run before its alpha mask is applied, as Flash masks the bitmap they make: then in
    // a layer of their own, composited as normal into the one the mask is, which takes its mode.
    const wrapped = alphaMask !== null && filtering !== null;
    const inner = wrapped ? NORMAL : mode;
    if (wrapped) {
      this.scene.layerBegin();
    }

    if (mode !== NORMAL || filtering || alphaMask) {
      if (mode === LAYER || filtering) {
        layerRow = color ? this.rows.add(1, 0, 0, 1, 0, 0, color) : -1;
        color = null;
      }

      // What its filters made last, where nothing they ran on changed: composited again where it
      // moved to, and all in it walked hidden, as Flash draws a filtered object's bitmap again.
      // A blend shader's layer is composited anew each frame: a kept one's mode is a byte.
      output =
        filtering && !this.drawRoot && mode < KERNEL && !this.inAlphaMask
          ? this.filterLayers.keptOutput(
              o,
              filtering,
              slice?.key ?? "",
              a,
              b,
              c,
              d,
              tx,
              ty,
              this.target,
              this.frames,
              this.keptGeneration,
              whole,
            )
          : null;
      if (output?.reused) {
        const k = output.handle as KeepHandle;
        const rect = this.filterLayers.keptRect;
        this.scene.keptLayer(k.id, inner, layerRow, rect[0], rect[1], rect[2], rect[3]);
        this.keeps.use(k.id);
        hidden = true;
      } else {
        // Over the rectangle of what is drawn in it, which measureLayers finds; its padding is set
        // once its filters are fitted to that.
        drawnFrom = this.scene.length;
        const keep = output?.keeping ? (output.handle as KeepHandle).id : -1;
        layer = this.scene.layerBegin(filtering ? 0 : -1, keep, whole, grouped);
      }
    }

    // Drawn in its pass, which walked all in it, its flags cleared: walked here no further. Else
    // walked hidden, to clear them. What it holds is drawn into its bitmap, never straight onto
    // what is below a blend around it (soleBlended).
    const sole = this.soleBlended;
    this.soleBlended = plane ? null : sole;
    const passed = plane && this.drawPlane(o, full, pa, pb, pc, pd, ptx, pty);
    this.soleBlended = sole;
    hidden ||= plane;

    // Its scroll's rectangle clips what it draws, inside its layer.
    const r = hidden ? null : o.scroll;
    if (r) {
      // A rectangle of no size clips everything, as an empty one does.
      const width = Math.max(0, r.xMax - r.xMin);
      const height = Math.max(0, r.yMax - r.yMin);
      const first = this.masks.maskBegin(this.scene);
      this.masks.rectMask(this.scene, this.rows, a, b, c, d, tx, ty, r.xMin, r.yMin, width, height);
      this.masks.maskUse(this.scene, first);
    }

    // A shape takes a morph's new ratio as it is drawn, which its bounds and hit tests follow; one
    // whose bitmap cache Flash shows stale draws what that shows (staleShape).
    const shape =
      o instanceof ShapeObject
        ? this.staleShapes.staleShape(o, hidden, this.snapshotting, a, b, c, d)
        : null;
    // adl culls drawTriangles' triangles as they turn on the screen, or in a BitmapData's draw.
    const version = o.drawing ? o.drawing.version : 0;
    const drawn = o.drawing
      ? facing(o.drawing.layers, a * d - b * c < 0, version)
      : (shape?.layers ?? null);
    const layers =
      hidden || !drawn
        ? null
        : slice
          ? sliceLayers(drawn, slice, ownSlice ? null : o.placed, version)
          : drawn;
    if (o.drawing && layers) {
      this.parts.dropUndrawn(o, layers, version);
    }

    // A sliced line keeps the width it has in its owner's parent's space, as adl's does, times a
    // Shape child's own scale; made as a stroked layer first needs it.
    let lineBy: number[] | null = null;
    let row = -1;
    let lineRow = -1;
    // Lines that scale both ways, stroked through the transform's settled stretch, which every
    // angle and instance shares (display/stretch.ts), and placed by the rest of it.
    let stretch: Linear | null | undefined;
    let stretchRow = -1;
    if (layers) {
      // A pixel of the screen, in the stage's pixels: the least a line is wide.
      const least = 1 / (this.screenScale ?? this.scale * this.resolution);
      // Alpha left whole by the colour transform: a line's overlaps then draw nothing new.
      const opaque = !color || color.aMul + color.aAdd / 255 >= 1;
      // Read once for the object, not for each textured part.
      const smoothing = this.smoothing;
      // A layer of a part of several fills alone, its own or an ancestor's that holds it alone,
      // drawn without the layer where they do not overlap (WebGLBackend.blendDirect): looked into
      // only then, as it tessellates them again.
      const alone =
        ((layer >= 0 && blendsDirect(mode) && !grouped) ||
          (mode === NORMAL && o === this.soleBlended && !clipped)) &&
        !filtering &&
        !alphaMask &&
        !r &&
        !childful &&
        layers.length === 1 &&
        layers[0].strokes.length === 0;

      for (let i = 0; i < layers.length; i++) {
        const parts = this.parts.partsOf(layers[i], version);
        if (alone && parts.length === 1) {
          this.parts.markFlat(o, layers[i], parts[0]);
        }

        for (const part of parts) {
          // Kept while drawn, even with no texture yet: a layer let go of is tessellated again whole.
          this.geometries.use(part.handle.id);
          // A shader fill's draw names its kernel's chain of the frame's filters.
          if (part.paint?.type === "shader") {
            this.unkept++;
            if (row < 0) {
              row = this.rows.addPlaced(this.places, at + 6, color);
            }

            const chain = this.filterLayers.kernelChain(part.paint.use, this.filters, FILL_SHADER);
            this.scene.draw(part.handle.id, row, NORMAL, chain, SHADED);
            continue;
          }

          const textured = part.paint !== null || part.mesh !== null;
          const texture = textured ? this.paints.paintTexture(part) : null;
          // Its bitmap still to come, which no flag will tell of.
          if (textured && !texture) {
            this.unkept++;
            continue;
          }

          if (row < 0) {
            row = this.rows.addPlaced(this.places, at + 6, color);
          }

          if (texture) {
            this.textures.use(texture.id);
          }

          this.scene.draw(
            part.handle.id,
            row,
            NORMAL,
            texture?.id ?? -1,
            texture ? paintSampler(part, smoothing) : 0,
          );
        }

        // The layer's lines after its fills: through its stretch where they scale both ways, else
        // stroked in the stage's axes and placed by the translation alone.
        if (layers[i].strokes.length === 0) {
          continue;
        }

        if (slice && !lineBy) {
          lineBy = ownSlice ? [pa, pb, pc, pd] : this.childLineSpace(o);
        }

        const layerLines = this.lineCache.of(layers[i], version);
        const even = !lineBy && layerLines.even;
        if (even && stretch === undefined) {
          // Settled for the widest line of the object's layers that scale both ways (evenWidth).
          let widest = 0;
          for (let k = 0; k < layers.length; k++) {
            widest = Math.max(widest, this.lineCache.of(layers[k], version).width);
          }

          const m = this.stretchScratch;
          m[0] = a;
          m[1] = b;
          m[2] = c;
          m[3] = d;
          stretch = stretchOf(m, m);
          stretch = stretch && settledStretch(stretch, widest, least, stretch);
        }

        const by = even ? stretch : null;
        // A layer with a painted line in pieces, each textured by its paint as a fill's part is.
        const painted = layerLines.painted;
        const lines = painted
          ? null
          : by
            ? this.lineCache.take(
                layers[i],
                version,
                by[0],
                by[1],
                by[2],
                by[3],
                least,
                null,
                opaque,
                layerLines,
              )
            : this.lineCache.take(
                layers[i],
                version,
                a,
                b,
                c,
                d,
                least,
                lineBy,
                opaque,
                layerLines,
              );
        const pieces = !painted
          ? null
          : by
            ? this.lineCache.pieces(
                layers[i],
                version,
                by[0],
                by[1],
                by[2],
                by[3],
                least,
                null,
                opaque,
                layerLines,
              )
            : this.lineCache.pieces(
                layers[i],
                version,
                a,
                b,
                c,
                d,
                least,
                lineBy,
                opaque,
                layerLines,
              );
        // Stroked to nothing, or not built, which a later frame tries again.
        if (!lines && !pieces?.length) {
          this.unkept++;
          continue;
        }

        if (by && stretchRow < 0) {
          // m s⁻¹, s symmetric: what turns and mirrors the stretched lines into place.
          const det = by[0] * by[3] - by[1] * by[1];
          const n0 = by[3] / det;
          const n1 = -by[1] / det;
          const n3 = by[0] / det;
          stretchRow = this.rows.add(
            a * n0 + c * n1,
            b * n0 + d * n1,
            a * n1 + c * n3,
            b * n1 + d * n3,
            tx,
            ty,
            color,
          );
        } else if (!by && lineRow < 0) {
          lineRow = this.rows.addTranslated(this.places, at + 6, color);
        }

        const placed = by ? stretchRow : lineRow;
        if (lines) {
          this.geometries.use(lines.id);
          this.scene.draw(lines.id, placed, NORMAL);
          continue;
        }

        for (const { part, handle } of pieces ?? []) {
          // Kept while drawn, even with no texture yet, as a fill's part is.
          this.geometries.use(handle.id);
          const texture = part.paint ? this.paints.paintTexture(part) : null;
          if (part.paint && !texture) {
            this.unkept++;
            continue;
          }

          if (texture) {
            this.textures.use(texture.id);
          }

          this.scene.draw(
            handle.id,
            placed,
            NORMAL,
            texture?.id ?? -1,
            texture ? paintSampler(part, smoothing) : 0,
          );
        }
      }
    }

    if (!hidden && (o instanceof TextObject || o instanceof StaticTextObject)) {
      const omitted: TextOmissions = { advanced: false, clip: null, clipFrom: 0, clipTo: 0 };
      const items = o instanceof TextObject ? fieldItems(o, omitted) : staticItems(o, omitted);
      // Its embedded glyphs as Saffron draws them, all in one geometry drawn where the first of
      // them was, else as normal text.
      // In a 3D object's bitmap, whose pixels are not the stage's, as normal text.
      const advanced =
        omitted.advanced && !this.planes.inPass
          ? this.advancedTexts.advancedText(o, a, b, c, d, this.target, this.drawRoot !== null)
          : null;
      if (omitted.advanced && !advanced) {
        unsupported.advancedTexts++;
      }

      let glyphsDrawn = false;
      let glyph = 0;
      let normal = 0;

      // Device text as sharp as the text is shown: canvas pixels a stage pixel, at its stretch, its
      // runs on whole canvas pixels.
      const resolution =
        o instanceof TextObject && !o.embedFonts
          ? deviceTextResolution([a, b, c, d], this.scale * this.resolution)
          : 1;
      // Its text, where it runs over, clipped inside the gutter; its box and caret are not.
      const clip = omitted.clip;

      for (let k = 0; k < items.length; k++) {
        if (clip && k === omitted.clipFrom) {
          const first = this.masks.maskBegin(this.scene);
          this.masks.rectMask(
            this.scene,
            this.rows,
            a,
            b,
            c,
            d,
            tx,
            ty,
            clip.x,
            clip.y,
            clip.width,
            clip.height,
          );
          this.masks.maskUse(this.scene, first);
        }

        // A glyph whose tables found no room among Saffron's is drawn as normal text.
        const item = items[k];
        let drawnNormal = false;
        if (advanced && item.kind === "glyph") {
          drawnNormal = advanced.normal[normal] === glyph;
          normal += drawnNormal ? 1 : 0;
          glyph++;
        }

        if (!advanced || item.kind !== "glyph" || drawnNormal) {
          this.textItems.drawTextItem(
            this.scene,
            this.rows,
            item,
            a,
            b,
            c,
            d,
            tx,
            ty,
            color,
            resolution,
            this.target.scale,
          );
        } else if (!glyphsDrawn && advanced.handle) {
          glyphsDrawn = true;
          this.geometries.use(advanced.handle.id);
          this.scene.draw(
            advanced.handle.id,
            placedRow(this.rows, a, b, c, d, tx, ty, advanced.m, color),
            NORMAL,
          );
        }

        if (clip && k === omitted.clipTo - 1) {
          this.masks.popMask(this.scene);
        }
      }
    }

    if (o instanceof VideoObject && !hidden && o.picture && o.source) {
      const picture = o.picture;
      const texture = this.videos.texture(o.source);
      if (texture && o.boxWidth > 0 && o.boxHeight > 0) {
        const quad = this.parts.quad(picture.width, picture.height);
        const sx = o.boxWidth / picture.width;
        const sy = o.boxHeight / picture.height;
        const videoRow = this.rows.add(a * sx, b * sx, c * sy, d * sy, tx, ty, color);

        this.geometries.use(quad.id);
        this.scene.draw(
          quad.id,
          videoRow,
          NORMAL,
          texture.id,
          (o.smoothing && this.smoothing ? SMOOTH : 0) | CLAMP,
        );
      }
    }

    const store = o instanceof BitmapObject && !hidden ? o.store : null;
    if (store && !store.disposed && store.width > 0 && store.height > 0) {
      const quad = this.parts.quad(store.width, store.height);
      const texture = this.paints.storeTexture(store);
      const moved = wholePixels(
        this.places,
        at + 6,
        this.target.scale / this.target.pixel,
        this.moved,
      );
      if (moved) {
        row = this.rows.addPlaced(this.moved, 0, color);
      } else if (row < 0) {
        row = this.rows.addPlaced(this.places, at + 6, color);
      }

      this.geometries.use(quad.id);
      this.textures.use(texture.id);
      const smooth = !moved && (o as BitmapObject).smoothing && this.smoothing;
      this.scene.draw(quad.id, row, NORMAL, texture.id, (smooth ? SMOOTH : 0) | CLAMP);
    }

    if (o instanceof Container && !passed) {
      // A timeline's clip layer clips the children after it, up to its clip depth: kept track of
      // only where a child is one, as most containers have none.
      const children = o.children;
      let clips: Clips | null = null;
      let open = 0;

      // A sliced owner's Shapes are sliced by its grid, their lines as wide as in its parent's space.
      const owner = this.sliceOwner;
      const ownerSlice = this.ownerSlice;
      const ownerParent = this.ownerParent;
      // A clip in a blend mode that draws nothing but one child, as a SWF blends its art: that
      // child's fills may be drawn without the clip's layer, as a blend set on it would be. A layer,
      // mask, scroll rectangle or 3D plane on the way between leaves that layer more than them.
      const soleBlended = this.soleBlended;
      if (layer >= 0 || clipped || alphaMask || r || plane) {
        this.soleBlended =
          layer >= 0 &&
          blendsDirect(mode) &&
          !grouped &&
          !filtering &&
          !alphaMask &&
          !r &&
          !o.drawing?.layers.length
            ? soleChild(o)
            : null;
      }

      this.sliceOwner = ownSlice ? o : null;
      this.ownerSlice = ownSlice;
      if (ownSlice) {
        this.ownerParent = [pa, pb, pc, pd];
      }

      for (let i = 0; i < children.length; i++) {
        const child = children[i];
        if (!clips && child.clipDepth > 0) {
          clips = new Clips();
        }

        if (clips) {
          const n = clips.enter(child);
          for (; open > n; open--) {
            this.masks.popMask(this.scene);
          }
        }

        if (child.clipDepth > 0) {
          this.unkept++;
        }

        if (child.clipDepth > 0 && !hidden) {
          const first = this.masks.maskBegin(this.scene);
          this.masks.walkMask(
            this.scene,
            this.rows,
            this.snapshotting,
            child,
            a,
            b,
            c,
            d,
            tx,
            ty,
            false,
          );
          this.masks.maskUse(this.scene, first);
          open++;
          continue;
        }

        this.walk(child, color, hidden);
      }

      this.sliceOwner = owner;
      this.ownerSlice = ownerSlice;
      this.ownerParent = ownerParent;
      this.soleBlended = soleBlended;
      for (; open > 0; open--) {
        this.masks.popMask(this.scene);
      }

      if (!this.snapshotting) {
        o.descendantsDirty = false;
      }
    }

    if (r) {
      this.masks.popMask(this.scene);
    }

    if (output?.reused) {
      // Composited again already.
    } else if (filtering) {
      const fitted = this.filterLayers.fitFilters(
        o,
        filtering,
        drawnFrom,
        this.scene,
        this.rows,
        this.target,
        this.resolution,
        this.scale,
        this.drawRoot !== null,
        this.textureLimit,
      );
      this.scene.padLayer(layer, fitted.padding);
      this.scene.layerEnd(inner, layerRow, this.filterLayers.chainOf(fitted, this.filters));
      if (output) {
        output.pad = fitted.padding;
        this.filterLayers.ranLayer(output, layer);
      }
    }

    if (alphaMask) {
      this.drawAlphaMask(alphaMask);
      this.scene.layerEnd(mode, wrapped ? -1 : layerRow);
    } else if (!filtering && mode !== NORMAL) {
      this.scene.layerEnd(mode, layerRow);
    }

    if (clipped) {
      this.masks.popMask(this.scene);
    }

    if (kept) {
      this.checking--;
      this.checkSpan(o, kept, first, rowsFirst);
    }

    if (spanning && this.unkept === unkept) {
      (spans as Spans).record(
        o,
        first,
        this.scene.length,
        rowsFirst,
        this.rows.count,
        this.places,
        depth * 6,
        tint,
      );
    }

    this.walkDepth--;
    // A draw for BitmapData leaves them for the stage's.
    if (!this.snapshotting) {
      o.dirty = CLEAN;
    }
  }

  /**
   * Whether the walk is where spans are kept: the stage's, and not inside an
   * alpha mask, a sliced owner or a blend's only child, whose objects draw
   * by more than their own flags and transform.
   */
  private spanContext(): boolean {
    return (
      this.drawRoot === null &&
      !this.inAlphaMask &&
      this.sliceOwner === null &&
      this.soleBlended === null
    );
  }

  /**
   * `o`'s span `kept` from the frame before, compared with what its walk
   * just wrote, from entry `first` and row `rowsFirst`: copied after it as a
   * frame that keeps it would copy it, then taken off again; an error,
   * saying where they differ, where they do.
   */
  private checkSpan(
    o: DisplayObject,
    kept: { first: number; end: number; rowsFirst: number; rowsEnd: number },
    first: number,
    rowsFirst: number,
  ): void {
    const spans = this.spans as Spans;
    const scene = this.scene;
    const rows = this.rows;
    const walked = { first, end: scene.length, rowsFirst, rowsEnd: rows.count };
    const at = scene.length;
    const rowsAt = rows.append(spans.rows, kept.rowsFirst, kept.rowsEnd);
    scene.appendDraws(spans.scene, kept.first, kept.end, rowsAt - kept.rowsFirst);
    const copied = { first: at, end: scene.length, rowsFirst: rowsAt, rowsEnd: rows.count };
    const difference = spanDifference(
      "the span kept from the frame before",
      scene,
      rows,
      copied,
      "the walk",
      scene,
      rows,
      walked,
    );
    scene.truncate(at);
    rows.truncate(rowsAt);
    if (difference) {
      throw new Error(`the span of ${describe(o)} is stale: ${difference}`);
    }
  }

  /**
   * `mask`, an alpha mask, drawn into a layer of its own as it would be
   * drawn where it stands on the stage, though it is a mask: in its colour
   * and its ancestors', its filters run, from a slot of the walk's above
   * the object it masks. The layer is composited onto that object's
   * (ALPHA_MASK), which ends after it.
   */
  private drawAlphaMask(mask: DisplayObject): void {
    const w = this.placedMask(mask);
    const depth = this.walkDepth;
    const at = depth + 1;
    if ((at + 2) * 6 > this.places.length) {
      const grown = new Float64Array(this.places.length * 2);
      grown.set(this.places);
      this.places = grown;
    }

    const places = this.places;
    places[at * 6] = w.a;
    places[at * 6 + 1] = w.b;
    places[at * 6 + 2] = w.c;
    places[at * 6 + 3] = w.d;
    places[at * 6 + 4] = w.tx;
    places[at * 6 + 5] = w.ty;
    const placed = this.placedAlphaMask;
    const inMask = this.inAlphaMask;
    this.walkDepth = at;
    this.placedAlphaMask = mask;
    this.inAlphaMask = true;
    this.scene.layerBegin();
    this.walk(mask, ancestorsColor(mask), false);
    this.scene.layerEnd(ALPHA_MASK, -1);
    this.placedAlphaMask = placed;
    this.inAlphaMask = inMask;
    this.walkDepth = depth;
  }

  /**
   * The linear transform a Shape child of a sliced owner draws its lines
   * as wide through: the owner's parent's, kept as the owner's children
   * are walked, times its own matrix.
   */
  private childLineSpace(o: DisplayObject): number[] {
    const q = this.ownerParent;
    const m = o.matrix;
    return [
      q[0] * m.a + q[2] * m.b,
      q[1] * m.a + q[3] * m.b,
      q[0] * m.c + q[2] * m.d,
      q[1] * m.c + q[3] * m.d,
    ];
  }

  /** `o` walked from the stage's origin, untinted; the stage's, moved by its viewport. */
  private walkFrom(o: DisplayObject): void {
    this.walkDepth = 0;
    this.places.set(UNIT_PLACE);
    if (!this.drawRoot) {
      this.places[4] = -this.viewX;
      this.places[5] = -this.viewY;
    }

    this.walk(o, null, false);
  }

  /** `parent` and `child` concatenated into depth `depth`'s colour slot, made once and kept. */
  private concatAt(depth: number, parent: ColorTransform, child: ColorTransform): ColorTransform {
    let slot = this.colorSlots[depth];
    if (!slot) {
      slot = { ...IDENTITY_COLOR };
      this.colorSlots[depth] = slot;
    }

    return concatColorInto(slot, parent, child);
  }

  /**
   * A 3D object drawn as Flash draws it (display/plane.ts): what it and its
   * children draw, in its own space, a texel a pixel at `samples` a side
   * and averaged down, into a bitmap kept as a kept output, in a pass of
   * its own before the frame's (drawPlaneContent), in its colour `full`,
   * filtered; then the bitmap's quad, placed by its plane in its parent's
   * space (a b c d tx ty on the stage), smoothed at each pixel of Flash's.
   * The bitmap is kept while nothing it holds changes (unchanged). Nothing
   * where its quad has a corner behind the eye, or it draws nothing, or a
   * 3D object masks it, which leaves nothing of it in Flash. Whether all in
   * it was walked, or needs no walk, its flags clear.
   */
  private drawPlane(
    o: DisplayObject,
    full: ColorTransform | null,
    a: number,
    b: number,
    c: number,
    d: number,
    tx: number,
    ty: number,
  ): boolean {
    if (o.mask?.space) {
      return false;
    }

    // Counted in another's bitmap, placed by what moves with all above it.
    this.planes.place();

    // What it draws, measured again only where something in it may have changed.
    const k = this.planes.state(o);
    const unchanged = planeUnchanged(o, k, this.frames, this.snapshotting);
    const rect = unchanged && k.rect ? k.rect : drawnRect(o);
    const quad = this.planes.quad;
    if (
      !rect ||
      !placeQuad(o.placed, rect.x, rect.y, rect.x + rect.width, rect.y + rect.height, quad)
    ) {
      return false;
    }

    const { samples, texels } = bitmapScale(quad.width, quad.height, this.textureLimit);
    const width = Math.max(1, Math.ceil(quad.width * texels));
    const height = Math.max(1, Math.ceil(quad.height * texels));
    // Let go of on the first frame it is not drawn: one not drawn on the frame before is drawn
    // anew, and a timeline makes 3D objects anew as it plays. BitmapData.draw's apart, in its
    // colour and at its quality, which the stage's bitmap must not take.
    const keeps = this.snapshotting ? this.planes.drawnBitmaps : this.planes.keptBitmaps;
    let keep = keeps.get(o);
    const alive = keep !== undefined && this.keeps.alive(keep);
    if (!keep || !alive) {
      keep = this.keeps.add(0);
      keeps.set(o, keep);
    }

    this.keeps.use(keep.id);

    // Its quad, made before its content's pass, in which a 3D object inside it works out its own in
    // `quad`.
    const handle = this.planes.quadGeometry(o, width, height);
    this.geometries.use(handle.id);
    const row = this.rows.add(a, b, c, d, tx, ty, null);
    const left = quad.x;
    const top = quad.y;
    // Its bitmap kept where it holds what it would draw now: nothing in it has a flag to clear.
    const same =
      alive &&
      unchanged &&
      k.generation === this.keptGeneration &&
      k.mask === o.mask &&
      (!o.mask || o.encloses(o.mask)) &&
      k.left === left &&
      k.top === top &&
      k.texels === texels &&
      k.samples === samples &&
      k.width === width &&
      k.height === height &&
      (full ? k.colored && sameColor(k.color, full) : !k.colored);
    if (!same) {
      k.unkeepable = this.drawPlaneContent(
        o,
        full,
        left,
        top,
        texels,
        samples,
        width,
        height,
        keep.id,
      );
    }

    if (!this.snapshotting) {
      k.seenAt = this.frames;
      k.generation = this.keptGeneration;
      k.rect = rect;
      k.scrolled = o.scroll !== null;
      k.filters = o.filters;
      k.mask = o.mask;
      k.left = left;
      k.top = top;
      k.texels = texels;
      k.samples = samples;
      k.width = width;
      k.height = height;
      k.colored = full !== null;
      if (full) {
        Object.assign(k.color, full);
      }
    }

    this.scene.draw(handle.id, row, NORMAL, keep.id, PLANE);
    return true;
  }

  /**
   * A 3D object's content drawn into its bitmap, kept as kept output `keep`:
   * walked with the object as the root of a pass of its own, as
   * BitmapData.draw walks its object, placed by its own space's pixels from
   * the bitmap's corner (left, top) at `texels` a pixel, at `samples` target pixels
   * each, with lists of its own, which a 3D object in it nests in again.
   */
  private drawPlaneContent(
    o: DisplayObject,
    full: ColorTransform | null,
    left: number,
    top: number,
    texels: number,
    samples: number,
    width: number,
    height: number,
    keep: number,
  ): boolean {
    const pass = this.planes.enter();

    const outer = this.passState();
    const target = {
      width: width * samples,
      height: height * samples,
      scale: samples,
      x: 0,
      y: 0,
      resolution: 1,
      pixel: samples,
    };
    this.scene = pass.scene;
    this.rows = pass.rows;
    this.filters = pass.filters;
    this.commands = pass.commands;
    this.target = target;
    this.scale = samples;
    // Filters at the bitmap's units of the object's pixels, which a large object has fewer of.
    this.filterUnits = samples * texels;
    this.resolution = 1;
    this.screenScale = 1;
    this.drawRoot = o;
    // Its scroll's rectangle at its bitmap's origin, as its bounds have it.
    const m = { a: texels, b: 0, c: 0, d: texels, tx: -left * texels, ty: -top * texels };
    this.drawMatrix = o.scroll ? shifted(m, o.scroll) : m;
    this.sliceOwner = null;
    this.ownerSlice = null;
    let placed = false;
    try {
      this.scene.reset();
      this.rows.reset();
      this.filters.reset();
      // A walk from a slot of its own above the object's own in the frame's, as from the stage's
      // origin.
      const at = this.walkDepth + 1;
      this.walkDepth = at;
      if ((at + 2) * 6 > this.places.length) {
        const grown = new Float64Array(this.places.length * 2);
        grown.set(this.places);
        this.places = grown;
      }

      this.places.set(UNIT_PLACE, at * 6);
      this.walk(o, full, false);
      measureLayers(this.scene, this.rows, this.geometries, target);
      plan(this.scene, 0, this.commands);
      this.backend.drawPlane(
        keep,
        this.commands,
        this.scene,
        this.rows,
        this.geometries,
        this.textures,
        this.filters,
        this.keeps,
        target,
        width,
        height,
        samples,
      );
    } finally {
      placed = this.planes.leave();
      this.restorePass(outer);
    }

    return placed;
  }

  /** What advanced text's quads name of the outlines' store, uploaded. */
  private uploadOutlines(): void {
    this.backend.uploadOutlines(saffronStore.data, saffronStore.used, saffronStore.epoch);
  }

  /**
   * `o` drawn alone, as BitmapData.draw takes a display object, through `m`
   * into a `width` by `height` bitmap, read back as premultiplied ARGB: at
   * `samples` a side and averaged, as Flash covers edges (4 at its high
   * quality). Built at the draw's own
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
    const pixels = this.drawAlone(o, m, width, height, samples, (n) =>
      argbOf(
        this.backend.snapshot(
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
        ),
      ),
    );
    return pixels ?? new Uint32Array(Math.max(0, width * height));
  }

  /**
   * `o` drawn as `snapshot` draws it, then composited source over into
   * `store` at (x, y) on the GPU, into the store's texture, where it stays
   * till a script reads the pixels (Paints): nothing is read back, nor the
   * store uploaded again to show it. Not for a store too large for a
   * texture, nor an opaque one holding alpha, whose pixels read two ways
   * (BitmapStore.holdsAlpha); false, having drawn nothing, for those.
   */
  drawInto(
    store: BitmapStore,
    o: DisplayObject,
    m: { a: number; b: number; c: number; d: number; tx: number; ty: number },
    x: number,
    y: number,
    width: number,
    height: number,
    samples: number,
  ): boolean {
    if (
      store.disposed ||
      store.holdsAlpha ||
      Math.max(store.width, store.height) > this.textureLimit ||
      this.gl.isContextLost()
    ) {
      return false;
    }

    const handle = this.paints.storeTexture(store);
    const drawn = this.drawAlone(o, m, width, height, samples, (n) =>
      this.backend.drawIntoTexture(
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
        handle.id,
        x,
        y,
        !store.transparent,
      ),
    );
    if (!drawn) {
      return false;
    }

    this.paints.drawn(store);
    return true;
  }

  /**
   * `o` walked and planned alone, through `m` into a `width` by `height`
   * bitmap at `samples` a side, as few as a texture holds, then `draw`n
   * with the samples taken; null for a size no texture holds.
   */
  private drawAlone<T>(
    o: DisplayObject,
    m: { a: number; b: number; c: number; d: number; tx: number; ty: number },
    width: number,
    height: number,
    samples: number,
    draw: (samples: number) => T,
  ): T | null {
    // As many samples as a texture holds, halved as BitmapData.draw's are.
    let n = Math.max(1, samples);
    while (n > 1 && Math.max(width, height) * n > this.textureLimit) {
      n /= 2;
    }

    if (width <= 0 || height <= 0 || Math.max(width, height) > this.textureLimit) {
      return null;
    }

    const stage = this.passState();
    this.target = {
      width: width * n,
      height: height * n,
      scale: n,
      x: 0,
      y: 0,
      resolution: 1,
      pixel: n,
    };
    this.scale = n;
    this.resolution = 1;
    this.screenScale = 1;
    this.drawRoot = o;
    this.snapshotting = true;
    this.drawMatrix = o.scroll ? shifted(m, o.scroll) : m;
    try {
      this.scene.reset();
      this.rows.reset();
      this.filters.reset();
      if (saffronStore.used > MOST * 0.75) {
        resetSegments();
      }

      allowResets(false);
      this.walkFrom(o);
      measureLayers(this.scene, this.rows, this.geometries, this.target);
      plan(this.scene, 0, this.commands);
      this.uploadOutlines();
      return draw(n);
    } finally {
      allowResets(true);
      this.restorePass(stage);
    }
  }

  /**
   * What a pass of its own, BitmapData.draw's or a 3D object's bitmap's,
   * swaps out of the walk, for it to be put back (restorePass).
   */
  private passState(): PassState {
    return {
      scene: this.scene,
      rows: this.rows,
      filters: this.filters,
      commands: this.commands,
      target: this.target,
      scale: this.scale,
      filterUnits: this.filterUnits,
      resolution: this.resolution,
      screenScale: this.screenScale,
      drawRoot: this.drawRoot,
      drawMatrix: this.drawMatrix,
      snapshotting: this.snapshotting,
      walkDepth: this.walkDepth,
      sliceOwner: this.sliceOwner,
      ownerSlice: this.ownerSlice,
    };
  }

  private restorePass(s: PassState): void {
    this.scene = s.scene;
    this.rows = s.rows;
    this.filters = s.filters;
    this.commands = s.commands;
    this.target = s.target;
    this.scale = s.scale;
    this.filterUnits = s.filterUnits;
    this.resolution = s.resolution;
    this.screenScale = s.screenScale;
    this.drawRoot = s.drawRoot;
    this.drawMatrix = s.drawMatrix;
    this.snapshotting = s.snapshotting;
    this.walkDepth = s.walkDepth;
    this.sliceOwner = s.sliceOwner;
    this.ownerSlice = s.ownerSlice;
  }

  /**
   * Where a mask is drawn: on the stage, or, in a draw for BitmapData, in
   * the bitmap, where it stands to what is drawn as it stands on the stage.
   */
  private placedMask(mask: DisplayObject): Matrix {
    const root = this.drawRoot;
    // In a 3D object's bitmap by the matrices up to it, or Flash's rule for one outside it.
    if (root && this.planes.inPass) {
      return this.planeMask(root, mask);
    }

    const onStage = toStageFlat(mask);
    if (!root) {
      // Moved by the viewport, as the stage's walk is (walkFrom).
      return this.viewX === 0 && this.viewY === 0
        ? onStage
        : { ...onStage, tx: onStage.tx - this.viewX, ty: onStage.ty - this.viewY };
    }

    // One drawn through no inverse, scaled to nothing on the stage, has no place to measure the mask
    // from: it masks as it stands on the stage.
    const rootInverse = invert(toStageFlat(root));
    return rootInverse ? concat(concat(onStage, rootInverse), this.drawMatrix) : onStage;
  }

  /**
   * Where a mask is drawn in the bitmap of `o`, a 3D object, the root of its
   * bitmap's pass: one in the object by its matrices up to it; one outside
   * it by Flash's rule for that (display/plane.ts, outsideMaskMap).
   */
  private planeMask(o: DisplayObject, mask: DisplayObject): Matrix {
    let m: Matrix;
    if (o.encloses(mask)) {
      m = mask.flatPlaced;
      for (let p = mask.parent; p && p !== o; p = p.parent) {
        m = concat(m, p.flatPlaced);
      }
    } else {
      m = outsideMaskMap(o, mask);
      this.planes.place();
    }

    return concat(m, this.drawMatrix);
  }

  /** The mouse, touches and wheel on the canvas to `player`'s stage (pointer.ts); what undoes it. */
  bindPointer(player: Player): () => void {
    // The stage the canvas shows, read as each event comes: the host may zoom the view.
    const view = this;
    return bindCanvasPointer(this.canvas, player, {
      get bounds() {
        const k = view.scale * view.resolution;
        return {
          x: view.viewX,
          y: view.viewY,
          width: view.canvas.width / k,
          height: view.canvas.height / k,
        };
      },
    });
  }

  /** What the view made on its context let go of, the context with it if the canvas is its own, and its tessellator. */
  destroy(): void {
    this.canvas.removeEventListener("webglcontextlost", this.lost);
    this.canvas.removeEventListener("webglcontextrestored", this.restored);
    this.backend.destroy();
    this.releaseOutlines();
    this.ownTessellator?.dispose();
    if (this.ownCanvas && !this.gl.isContextLost()) {
      this.gl.getExtension("WEBGL_lose_context")?.loseContext();
    }
  }
}

/**
 * The object at the end of `o`'s chain of only children, those between
 * drawing nothing of their own, if it has no children itself; else null.
 */
function soleChild(o: Container): DisplayObject | null {
  let c: DisplayObject = o;
  while (
    c instanceof Container &&
    c.children.length === 1 &&
    (c === o || !c.drawing?.layers.length)
  ) {
    c = c.children[0];
  }

  return c === o || (c instanceof Container && c.children.length > 0) ? null : c;
}

/** Whether Flash keeps a bitmap of `o` or of one in its chain of only children (cached). */
function cachedChain(o: DisplayObject): boolean {
  let c = o;
  while (!cached(c)) {
    if (!(c instanceof Container) || c.children.length !== 1) {
      return false;
    }

    c = c.children[0];
  }

  return true;
}

/**
 * Whether what `o` holds alone, at the end of its chain of only children,
 * draws a layer of several fills, which drawing straight onto what is
 * below blends otherwise than Flash's kept bitmap of them.
 */
function severalFills(o: DisplayObject): boolean {
  const leaf = o instanceof Container && o.children.length > 0 ? soleChild(o) : o;
  const layers = leaf?.drawing?.layers ?? (leaf instanceof ShapeObject ? leaf.shape?.layers : null);
  return !!layers?.some((layer) => layer.fills.length > 1);
}

/**
 * Whether what `o` draws of its own follows its flags, its transform and
 * its colour alone, which its span keeps (Spans): a container, a shape or a
 * bitmap, with no filter, blend, mask, scroll rectangle, 9-slice grid, 3D
 * transform, bitmap cache, clip depth, nor a mask's part to play. Text,
 * video and the rest draw by more, and are walked.
 */
function plain(o: DisplayObject): boolean {
  return (
    (o instanceof ShapeObject
      ? o.stale === null
      : o instanceof Container || o instanceof BitmapObject) &&
    o.filters.length === 0 &&
    o.blendMode === "normal" &&
    o.mask === null &&
    o.maskOf === null &&
    o.scroll === null &&
    o.scale9Grid === null &&
    o.space === null &&
    o.clipDepth === 0 &&
    !o.cachedAsBitmap
  );
}

/** `o` as an error names it: the names, or else the indices, of it and its ancestors. */
function describe(o: DisplayObject): string {
  const path: string[] = [];
  for (let p: DisplayObject | null = o; p; p = p.parent) {
    path.push(p.name || (p.parent ? `[${p.parent.children.indexOf(p)}]` : "root"));
  }

  return `${path.reverse().join(".")} (${o.constructor.name})`;
}

/** Count what `o` asks of the renderer that it does not draw yet (shapes.ts, unsupported). */
function noteUnsupported(o: DisplayObject): void {
  if (o.filters.length > 0 && undrawnFilter(o.filters)) {
    unsupported.filters++;
  }
}

/**
 * Whether the placement at `places[at]` only moves a Bitmap, at `unit` of
 * Flash's pixels a stage pixel; if so, `out` is it moved onto whole pixels
 * of Flash's. Flash draws such a bitmap texel for pixel, smoothed or not,
 * on the pixel its twips round to, a fraction of 8 twips (0.4 of a pixel)
 * or more up (the bitmap-sampling case, drawn in adl).
 */
function wholePixels(places: Float64Array, at: number, unit: number, out: Float64Array): boolean {
  if (
    places[at + 1] !== 0 ||
    places[at + 2] !== 0 ||
    Math.abs(places[at] * unit - 1) > 1e-9 ||
    Math.abs(places[at + 3] * unit - 1) > 1e-9
  ) {
    return false;
  }

  out[0] = places[at];
  out[1] = 0;
  out[2] = 0;
  out[3] = places[at + 3];
  out[4] = Math.floor((Math.round(places[at + 4] * unit * 20) + 12) / 20) / unit;
  out[5] = Math.floor((Math.round(places[at + 5] * unit * 20) + 12) / 20) / unit;
  return true;
}

/** Where `o` stands on the stage, its matrices as the walk takes them, after their scroll's shift. */
function toStageFlat(o: DisplayObject): Matrix {
  let m = o.flatPlaced;
  for (let p = o.parent; p; p = p.parent) {
    m = concat(m, p.flatPlaced);
  }

  return m;
}

/** The colour `o`'s ancestors give what it draws, as the walk concatenates it; null for none. */
function ancestorsColor(o: DisplayObject): ColorTransform | null {
  let color: ColorTransform | null = null;
  for (let p = o.parent; p; p = p.parent) {
    const own = p.colorTransform;
    if (own) {
      color = color ? concatColor(own, color) : own;
    }
  }

  return color;
}
