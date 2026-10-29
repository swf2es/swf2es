// The renderer as the player drives it (docs/renderer.md): a view that
// owns a WebGL 2 canvas, walks the display list into a scene list and its
// rows, and has @swf2es/render plan and draw it.
import { type ColorTransform, IDENTITY, type Matrix } from "@swf2es/format";
import { Tessellator } from "@swf2es/native/render";
import {
  BLEND_NAMES,
  CLAMP,
  Commands,
  Filters,
  Geometries,
  type KeepHandle,
  Keeps,
  LAYER,
  measureLayers,
  NORMAL,
  PLANE,
  plan,
  Rows,
  SceneList,
  SMOOTH,
  Textures,
} from "@swf2es/render";
import { WebGLBackend } from "@swf2es/render/webgl";
import { argbOf, type BitmapStore } from "../bitmap/bitmap.js";
import { BitmapObject } from "../display/bitmapobject.js";
import { concatColorInto, IDENTITY_COLOR, sameColor } from "../display/color.js";
import { Container } from "../display/container.js";
import { CLEAN, type DisplayObject } from "../display/displayobject.js";
import { concat, invert, shifted } from "../display/geometry.js";
import { bitmapScale, drawnRect, outsideMaskMap, placeQuad } from "../display/plane.js";
import { type Slice, sliceDrawn, sliceLayers } from "../display/scale9.js";
import { ShapeObject } from "../display/shapeobject.js";
import { facing } from "../display/shapes.js";
import { type Linear, settledStretch, stretchOf } from "../display/stretch.js";
import { StaticTextObject, TextObject } from "../display/textobjects.js";
import { Clips } from "../display/walk.js";
import type { Drawer } from "../hosts.js";
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
import { LineCache } from "./lines.js";
import { Masks, toStageFlat } from "./masks.js";
import { Paints, paintSampler } from "./paints.js";
import { Parts } from "./parts.js";
import { Planes, planeUnchanged } from "./planes.js";
import { bindCanvasPointer } from "./pointer.js";
import { unsupported } from "./shapes.js";
import { StaleShapes } from "./stale-shapes.js";
import { deviceTextResolution, fieldItems, staticItems, type TextOmissions } from "./text.js";
import { placedRow, TextItems } from "./text-items.js";

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
}

/** No transform, where a walk starts. */
const UNIT_PLACE = [1, 0, 0, 1, 0, 0];

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
  readonly canvas: HTMLCanvasElement;
  readonly gl: WebGL2RenderingContext;
  /** View pixels a stage pixel, before the resolution: a host showing the stage larger. */
  scale = 1;
  /** Screen pixels a stage pixel, which hairlines will be drawn a pixel of; the scale's if null. */
  screenScale: number | null = null;
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
  private commands = new Commands();
  private filters = new Filters();
  private readonly lineCache: LineCache;
  private readonly parts: Parts;
  private readonly paints = new Paints(this.textures);
  private readonly staleShapes = new StaleShapes();
  private readonly textItems: TextItems;
  private readonly advancedTexts: AdvancedTexts;
  private readonly masks: Masks;
  private readonly filterLayers: FilterLayers;
  private readonly planes: Planes;
  /** The largest texture side the context makes, which a filtered layer's padding must fit. */
  private readonly textureLimit: number;
  /** The outlines' store kept while the view is (text/saffron.ts, holdSegments), let go of with it. */
  private readonly releaseOutlines = holdSegments();
  /** The walk's depth, and a colour transform a depth, which a concatenation there is made in. */
  private walkDepth = 0;
  /** Each depth's transform on the stage, a b c d tx ty, which its children are placed under. */
  private places = new Float64Array(6 * 64);
  private readonly colorSlots: ColorTransform[] = [];
  /** The sliced owner whose children are walked now, its slice, and its parent's linear transform. */
  private sliceOwner: DisplayObject | null = null;
  private ownerSlice: Slice | null = null;
  private ownerParent: number[] = [1, 0, 0, 1];
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
  /** An object's transform's linear part, made its stretch in place (stretchOf). */
  private readonly stretchScratch: Linear = [0, 0, 0, 0];

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
    this.textureLimit = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;

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
    this.backend.restore(this.geometries);
    this.textures.lost();
    this.keeps.lost();
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

    // The outlines' store started again between frames, before it fills: not in a walk, where the
    // quads drawn before would name runs it let go of (text/saffron.ts, allowResets).
    if (saffronStore.used > MOST * 0.75) {
      resetSegments();
    }

    allowResets(false);
    try {
      this.walkFrom(root);
    } finally {
      allowResets(true);
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
  }

  /**
   * `o` and what is in it, under its parent's transform on the stage (a b
   * c d tx ty) and colour transform. Masks are walked but not drawn, nor
   * what is hidden; every object's flags are cleared, as the player
   * expects of a renderer.
   */
  private walk(o: DisplayObject, tint: ColorTransform | null, hidden: boolean): void {
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
    const m = root ? this.drawMatrix : o.flatPlaced;
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
    hidden ||= !root && (!o.visible || o.maskOf !== null || o.clipDepth > 0);

    // BitmapData.draw takes its object without its own colour transform, as adl draws it.
    const own = root ? null : o.colorTransform;
    // Into a slot of its depth's, which its subtree's walk alone reads: rows copy what they take.
    let color = own ? (tint ? this.concatAt(depth, tint, own) : own) : tint;
    // Its mask, drawn where it stands on the stage, then its scroll's rectangle, clip all it draws;
    // a 3D mask, or one inside what it masks, masks nothing in Flash.
    let clipped = false;
    // A 3D object's content is drawn into its bitmap (drawPlane), which a 2D mask clips there, in
    // its pass, not its quad on the stage.
    const plane = !hidden && !root && o.space !== null;
    if (!hidden && !plane && o.mask) {
      const mask = !o.maskOf && !o.mask.encloses(o) && !o.mask.space ? o.mask : null;
      if (mask) {
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
    const named = root ? NORMAL : BLEND_NAMES.indexOf(o.blendMode);
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
        filtering && !this.drawRoot
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
            )
          : null;
      if (output?.reused) {
        const k = output.handle as KeepHandle;
        const rect = this.filterLayers.keptRect;
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

    // Drawn in its pass, which walked all in it, its flags cleared: walked here no further. Else
    // walked hidden, to clear them.
    const passed = plane && this.drawPlane(o, full, pa, pb, pc, pd, ptx, pty);
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
      for (let i = 0; i < layers.length; i++) {
        for (const { part, handle } of this.parts.partsOf(layers[i], version)) {
          // Kept while drawn, even with no texture yet: a layer let go of is tessellated again whole.
          this.geometries.use(handle.id);
          const textured = part.paint !== null || part.mesh !== null;
          const texture = textured ? this.paints.paintTexture(part) : null;
          if (textured && !texture) {
            continue;
          }

          if (row < 0) {
            row = this.rows.addPlaced(this.places, at + 6, color);
          }

          if (texture) {
            this.textures.use(texture.id);
          }

          this.scene.draw(
            handle.id,
            row,
            NORMAL,
            texture?.id ?? -1,
            texture ? paintSampler(part, this.smoothing) : 0,
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

        const even = !lineBy && this.lineCache.of(layers[i], version).even;
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
        const lines = by
          ? this.lineCache.take(layers[i], version, by[0], by[1], by[2], by[3], least, null, opaque)
          : this.lineCache.take(layers[i], version, a, b, c, d, least, lineBy, opaque);
        if (!lines) {
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

        this.geometries.use(lines.id);
        this.scene.draw(lines.id, by ? stretchRow : lineRow, NORMAL);
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

      // Device text as sharp as the text is shown: canvas pixels a stage pixel, at its stretch.
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

    const store = o instanceof BitmapObject && !hidden ? o.store : null;
    if (store && !store.disposed && store.width > 0 && store.height > 0) {
      const quad = this.parts.quad(store.width, store.height);
      const texture = this.paints.storeTexture(store);
      if (row < 0) {
        row = this.rows.addPlaced(this.places, at + 6, color);
      }

      this.geometries.use(quad.id);
      this.textures.use(texture.id);
      const smooth = (o as BitmapObject).smoothing && this.smoothing;
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
      this.scene.layerEnd(mode, layerRow, this.filterLayers.chainOf(fitted, this.filters));
      if (output) {
        output.pad = fitted.padding;
        this.filterLayers.ranLayer(output, layer);
      }
    } else if (mode !== NORMAL) {
      this.scene.layerEnd(mode, layerRow);
    }

    if (clipped) {
      this.masks.popMask(this.scene);
    }

    this.walkDepth--;
    // A draw for BitmapData leaves them for the stage's.
    if (!this.snapshotting) {
      o.dirty = CLEAN;
    }
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
    const keeps = this.snapshotting ? this.planes.drawnKeeps : this.planes.keeps;
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
    // As many samples as a texture holds, halved as BitmapData.draw's are.
    let n = Math.max(1, samples);
    while (n > 1 && Math.max(width, height) * n > this.textureLimit) {
      n /= 2;
    }

    if (width <= 0 || height <= 0 || Math.max(width, height) > this.textureLimit) {
      return new Uint32Array(Math.max(0, width * height));
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
    this.releaseOutlines();
    this.ownTessellator?.dispose();
    if (this.ownCanvas) {
      this.gl.getExtension("WEBGL_lose_context")?.loseContext();
    }
  }
}

/** Count what `o` asks of the renderer that it does not draw yet (shapes.ts, unsupported). */
function noteUnsupported(o: DisplayObject): void {
  if (o.filters.length > 0 && undrawnFilter(o.filters)) {
    unsupported.filters++;
  }
}
