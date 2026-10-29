import { GlState, linkProgram } from "@swf2es/context3d/device";
import {
  CLEAR,
  COMPOSITE,
  type Commands,
  FILTER,
  HELD,
  HOLD_POP,
  HOLD_PUSH,
  LAYER_POP,
  LAYER_PUSH,
  RUN,
  STENCIL_POP,
  STENCIL_PUSH,
} from "../commands.js";
import { FilterPlan, planChain } from "../filter-plan.js";
import type { Filters } from "../filters.js";
import { type Geometries, type GeometryData, GLYPH_FLOATS } from "../geometry.js";
import type { Keeps } from "../keeps.js";
import type { Rows } from "../rows.js";
import {
  ADD,
  CLAMP,
  DRAW,
  LAYER,
  MESH,
  MIRROR,
  NORMAL,
  PLANE,
  REPEAT,
  SCREEN,
  type SceneList,
  SMOOTH,
  SNAP,
} from "../scene.js";
import { Shelves } from "../shelves.js";
import type { Textures } from "../textures.js";
import { FilterRunner, type FilterTarget } from "./filters.js";
import {
  BACK_UNIT,
  COLOR_AT,
  compositeFragment,
  compositeVertex,
  DEPTH_AT,
  FILL_SLOT,
  FILL_TEXTURES,
  FILL_UNIT,
  fillFragment,
  fillVertex,
  GLYPH_AT,
  glyphsFragment,
  glyphsVertex,
  LAYER_UNIT,
  meshFragment,
  meshVertex,
  ORIGIN_AT,
  OUTLINE_UNIT,
  POSITION_AT,
  RUN_AT,
  RUN_MOST,
  SNAP_BIT,
  TEXEL_AT,
  TEXTURE_UNIT,
  TINT_AT,
} from "./programs.js";
import { Stage } from "./stage.js";
import {
  framebufferOf,
  LAYER_STEP,
  type Layer,
  layerSide,
  MSAA_BYTES,
  type Open,
  Targets,
} from "./targets.js";
import { GpuTextures } from "./textures.js";

/** What the backend calls of WEBGL_multi_draw. */
interface MultiDraw {
  multiDrawElementsWEBGL(
    mode: number,
    counts: Int32Array,
    countsOffset: number,
    type: number,
    offsets: Int32Array,
    offsetsOffset: number,
    drawCount: number,
  ): void;
}

/**
 * Bytes a vertex in the atlas: its position's two floats, its texel's two, then its colour's four
 * bytes, or a mesh's depth's float.
 */
const VERTEX_BYTES = 20;
/** The most masks the stencil's eight bits count. */
const STENCIL_MOST = 255;
/** Bytes a vertex of advanced text's glyph quads, in an atlas of their own. */
const GLYPH_BYTES = GLYPH_FLOATS * 4;
/** The fewest glyph vertices the glyph atlas holds once a text needs it. */
const GLYPHS_LEAST = 1024;

/** The width of the pages held layers and their filters' targets are placed on, side by side. */
const PAGE_WIDTH = 2048;

/** A rectangle of a page, read and drawn into as a texture of its own (FilterTarget). */
interface Slot extends FilterTarget {
  x: number;
  y: number;
  page: Layer;
  /** Its page's index in the frame's (WebGLBackend.pages). */
  index: number;
}

/**
 * A held layer (HOLD_PUSH): its rectangle on the target, the operations it
 * draws by, its chain of filters, planned, and its targets by the plan's
 * slots; its output once drawn, or null where none is.
 */
interface Hold {
  x: number;
  y: number;
  width: number;
  height: number;
  first: number;
  end: number;
  chain: number;
  plan: FilterPlan;
  targets: (Slot | null)[];
  /** Its slots' records, kept from frame to frame, and the last pass that uses each. */
  slots: Slot[];
  lastUse: number[];
  result: Slot | null;
  /** Its content's rectangle on the pages (Shelves), -1 where it is drawn alone; the wave's. */
  shelf: number;
  wave: number;
  /** Whether its pass of the wave drawing is drawn, or it has none. */
  drawn: boolean;
  /** Its level (HOLD_PUSH), one past the deepest held layer in it. */
  level: number;
}
/** The fewest vertices the atlas holds room for, and its indices thrice that. */
const LEAST = 1 << 16;
/** Holes past which, and past the live vertices, the atlas is packed again. */
const SLACK = 1 << 16;

/** Where a geometry lies in the atlas, or the glyph atlas with its text's mode and table. */
interface Place {
  vertexStart: number;
  vertices: number;
  indexStart: number;
  indices: number;
  glyphs: { mode: Float32Array; table: Float32Array } | null;
}

/** Where a frame is drawn: the target's size in pixels, and how stage pixels map onto it. */
export interface Target {
  width: number;
  height: number;
  /** Target pixels a stage pixel, and where the stage's origin lies on the target. */
  scale: number;
  x: number;
  y: number;
  /** Target pixels a unit of the target's own, which filters read their input's size in. */
  resolution: number;
  /**
   * Target pixels a side of a pixel of Flash's, which a mesh's texture is
   * read once in: a pixel of the screen, or a BitmapData's draw's sample.
   */
  pixel: number;
}

/**
 * Executes a frame's commands on a WebGL 2 context it owns, through one
 * cache of its state. Every geometry is copied once into an atlas of a
 * vertex and an index buffer, and drawn from it a call an entry, the
 * buffers bound once and the entry told its row; rows go up once a frame
 * into a float texture. A geometry let go of leaves a hole, and the atlas
 * is packed again from the geometries' own arrays once the holes outweigh
 * what is live.
 */
export class WebGLBackend {
  readonly gl: WebGL2RenderingContext;
  readonly state: GlState;
  private readonly targets: Targets;
  private readonly stage: Stage;
  private readonly gpu: GpuTextures;
  private program!: WebGLProgram;
  private rowLocation: WebGLUniformLocation | null = null;
  private viewLocation: WebGLUniformLocation | null = null;
  private fillUnitLocation: WebGLUniformLocation | null = null;
  /** WEBGL_multi_draw, which draws a run of fills alike a call (drawEntries), where there is. */
  private multi: MultiDraw | null = null;
  private runsLocation: WebGLUniformLocation | null = null;
  /** A run's draws: their index counts, their offsets in bytes, and their rows (FILL_SLOT). */
  private readonly runCounts = new Int32Array(RUN_MOST);
  private readonly runOffsets = new Int32Array(RUN_MOST);
  private readonly runRows = new Int32Array(RUN_MOST);
  /** Draws gathered by gatherRun, and the fill units they sample, a bit each. */
  private runCount = 0;
  private runUnits = 0;
  /**
   * The texture and sampling each fill unit was last given (runSlot), -1 for
   * none, and the unit to take next when every one holds a texture.
   */
  private readonly unitIds = new Int32Array(FILL_TEXTURES).fill(-1);
  private readonly unitSampling = new Int32Array(FILL_TEXTURES);
  private unitNext = 0;
  /** The meshes' program (MESH), and where it takes its row, view, fragments' place and mode. */
  private mesh!: WebGLProgram;
  private meshRowLocation: WebGLUniformLocation | null = null;
  private meshViewLocation: WebGLUniformLocation | null = null;
  private meshFragLocation: WebGLUniformLocation | null = null;
  private meshModeLocation: WebGLUniformLocation | null = null;
  /**
   * The view the target drawn into gives the fill program, and where its
   * fragments lie from the stage's origin (meshFragment's uFrag): told the
   * mesh program as it next draws a mesh, once they change (meshStale).
   */
  private readonly view = new Float32Array(4);
  private readonly frag = new Float32Array(4);
  private meshStale = true;
  /** The row and mode (REPEAT, SMOOTH) the mesh program was told last, -1 for none. */
  private meshRow = -1;
  private meshMode = -1;
  /**
   * Advanced text's program (GeometryData.glyphs), where it takes its row, view, Flash's
   * pixels a stage pixel, mode and table; and its own atlas of vertices,
   * with its own index buffer.
   */
  private glyphProgram!: WebGLProgram;
  private glyphRowLocation: WebGLUniformLocation | null = null;
  private glyphViewLocation: WebGLUniformLocation | null = null;
  private glyphUnitLocation: WebGLUniformLocation | null = null;
  private glyphModeLocation: WebGLUniformLocation | null = null;
  private glyphTableLocation: WebGLUniformLocation | null = null;
  private glyphStale = true;
  /** Flash's pixels a stage pixel: the target's pixels a stage pixel over those a pixel of Flash's. */
  private unit = 1;
  private glyphArray!: WebGLVertexArrayObject;
  private glyphBuffer!: WebGLBuffer;
  private glyphIndexBuffer!: WebGLBuffer;
  /** The glyph atlas' room and top, of vertices and of indices, and its vertices live and let go of. */
  private readonly glyphs = {
    capacity: 0,
    top: 0,
    indexCapacity: 0,
    indexTop: 0,
    live: 0,
    holes: 0,
  };
  /** The layers' composite program and where it takes its mode and row. */
  private composite!: WebGLProgram;
  private modeLocation: WebGLUniformLocation | null = null;
  private compositeRowLocation: WebGLUniformLocation | null = null;
  private offsetLocation: WebGLUniformLocation | null = null;

  private flipLocation: WebGLUniformLocation | null = null;
  private backOffsetLocation: WebGLUniformLocation | null = null;
  private rectLocation: WebGLUniformLocation | null = null;
  /** The filters' passes, their programs made as first run. */
  private filters!: FilterRunner<Layer>;
  /** The layers drawn into now, innermost last. */
  private layers: Open[] = [];
  /**
   * The frame's held layers (HOLD_PUSH); the pages they took, null once
   * given back; the last wave each is read in, and whether an output is on
   * it, which keeps it for the frame.
   */
  private readonly holds: Hold[] = [];
  private readonly pages: (Layer | null)[] = [];
  private readonly pageUntil: number[] = [];
  private readonly pageKept: boolean[] = [];
  /** A page drawn into whole, a held layer's rectangle of one, and a held output composited. */
  private readonly pageOpen: Open = { layer: null, msaa: null, x: 0, y: 0, width: 0, height: 0 };
  private readonly holdOpen: Open = { layer: null, msaa: null, x: 0, y: 0, width: 0, height: 0 };
  private readonly heldOpen: Open = { layer: null, msaa: null, x: 0, y: 0, width: 0, height: 0 };
  private readonly shelves = new Shelves();
  /** The largest side a texture may have. */
  private textureMost = 4096;
  /**
   * Samples a pixel the stage and its layers are drawn with, 1 for none:
   * Flash's anti-aliasing by the quality, as the host sets it.
   */
  samples = 1;
  /** The mask counts of the targets below the layers drawn into now, two numbers each. */
  private readonly below: number[] = [];
  /** A copy of what is below a layer whose mode reads it, the target's size. */
  private back: WebGLTexture | null = null;
  private backFramebuffer: WebGLFramebuffer | null = null;
  private backWidth = 0;
  private backHeight = 0;
  /** The row and texture the last draw was told, so neither is told again. */
  private lastRow = -1;
  private vertexArray!: WebGLVertexArrayObject;
  private vertexBuffer!: WebGLBuffer;
  private indexBuffer!: WebGLBuffer;
  private vertexCapacity = 0;
  private indexCapacity = 0;
  private vertexTop = 0;
  private indexTop = 0;
  private live = 0;
  private holes = 0;
  private places: (Place | null)[] = [];

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    this.state = new GlState(gl);
    this.targets = new Targets(gl, this.state);
    this.stage = new Stage(gl, this.state, this.targets);
    this.gpu = new GpuTextures(gl, this.state);
    this.setUp();
  }

  /**
   * The context came back after it was lost: everything made again, every
   * geometry copied in again from the registry's arrays. The textures were
   * lost with it, which their owners add again (Textures.lost).
   */
  restore(geometries: Geometries): void {
    this.setUp();
    geometries.added.length = 0;
    geometries.removed.length = 0;
    geometries.updated.length = 0;
    this.repack(geometries);
    this.repackGlyphs(geometries);
  }

  /** Programs, buffers and textures made, as the context comes or comes back. */
  private setUp(): void {
    const gl = this.gl;
    this.state.forget();
    this.textureMost = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
    this.multi = gl.getExtension("WEBGL_multi_draw") as MultiDraw | null;
    try {
      this.program = linkProgram(gl, fillVertex(this.multi !== null), fillFragment);
    } catch (e) {
      if (!this.multi) {
        throw e;
      }

      // An extension offered whose shader directive the compiler refuses: a call a draw.
      this.multi = null;
      this.program = linkProgram(gl, fillVertex(false), fillFragment);
    }

    this.unitIds.fill(-1);
    this.rowLocation = gl.getUniformLocation(this.program, "uRow");
    this.runsLocation = gl.getUniformLocation(this.program, "uRuns");
    this.viewLocation = gl.getUniformLocation(this.program, "uView");
    this.state.useProgram(this.program);
    gl.uniform1i(gl.getUniformLocation(this.program, "uRows"), 0);
    gl.uniform1iv(
      gl.getUniformLocation(this.program, "uTextures"),
      Array.from({ length: FILL_TEXTURES }, (_, k) => FILL_UNIT + k),
    );
    this.fillUnitLocation = gl.getUniformLocation(this.program, "uUnit");
    this.mesh = linkProgram(gl, meshVertex, meshFragment);
    this.meshRowLocation = gl.getUniformLocation(this.mesh, "uRow");
    this.meshViewLocation = gl.getUniformLocation(this.mesh, "uView");
    this.meshFragLocation = gl.getUniformLocation(this.mesh, "uFrag");
    this.meshModeLocation = gl.getUniformLocation(this.mesh, "uMode");
    this.state.useProgram(this.mesh);
    gl.uniform1i(gl.getUniformLocation(this.mesh, "uRows"), 0);
    gl.uniform1i(gl.getUniformLocation(this.mesh, "uTexture"), TEXTURE_UNIT);
    this.meshStale = true;
    this.meshRow = -1;
    this.meshMode = -1;
    this.glyphProgram = linkProgram(gl, glyphsVertex, glyphsFragment);
    this.glyphRowLocation = gl.getUniformLocation(this.glyphProgram, "uRow");
    this.glyphViewLocation = gl.getUniformLocation(this.glyphProgram, "uView");
    this.glyphUnitLocation = gl.getUniformLocation(this.glyphProgram, "uUnit");
    this.glyphModeLocation = gl.getUniformLocation(this.glyphProgram, "uMode");
    this.glyphTableLocation = gl.getUniformLocation(this.glyphProgram, "uTable");
    this.state.useProgram(this.glyphProgram);
    gl.uniform1i(gl.getUniformLocation(this.glyphProgram, "uRows"), 0);
    gl.uniform1i(gl.getUniformLocation(this.glyphProgram, "uSegments"), OUTLINE_UNIT);
    this.glyphStale = true;
    this.composite = linkProgram(gl, compositeVertex, compositeFragment);
    this.state.useProgram(this.composite);
    gl.uniform1i(gl.getUniformLocation(this.composite, "uLayer"), LAYER_UNIT);
    gl.uniform1i(gl.getUniformLocation(this.composite, "uBack"), BACK_UNIT);
    gl.uniform1i(gl.getUniformLocation(this.composite, "uRows"), 0);
    this.modeLocation = gl.getUniformLocation(this.composite, "uMode");
    this.compositeRowLocation = gl.getUniformLocation(this.composite, "uRow");
    this.offsetLocation = gl.getUniformLocation(this.composite, "uOffset");
    this.flipLocation = gl.getUniformLocation(this.composite, "uFlip");
    this.backOffsetLocation = gl.getUniformLocation(this.composite, "uBackOffset");
    this.rectLocation = gl.getUniformLocation(this.composite, "uRect");
    this.filters = new FilterRunner(gl, this.state, {
      take: (width, height) => this.targets.takeLayer(width, height, true),
      give: (layer) => this.targets.giveLayer(layer),
      texture: (id) => this.gpu.textures[id] ?? null,
      sampler: (bits) => this.gpu.sampler(bits),
    });
    this.targets.setUp();
    this.layers = [];
    this.stage.setUp();
    this.back = null;
    this.backFramebuffer = null;
    this.backWidth = 0;
    this.backHeight = 0;
    this.vertexArray = gl.createVertexArray() as WebGLVertexArrayObject;
    this.vertexBuffer = gl.createBuffer() as WebGLBuffer;
    this.indexBuffer = gl.createBuffer() as WebGLBuffer;
    this.state.bindVertexArray(this.vertexArray);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffer);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer);
    gl.enableVertexAttribArray(POSITION_AT);
    gl.vertexAttribPointer(POSITION_AT, 2, gl.FLOAT, false, VERTEX_BYTES, 0);
    gl.enableVertexAttribArray(TEXEL_AT);
    gl.vertexAttribPointer(TEXEL_AT, 2, gl.FLOAT, false, VERTEX_BYTES, 8);
    gl.enableVertexAttribArray(COLOR_AT);
    gl.vertexAttribPointer(COLOR_AT, 4, gl.UNSIGNED_BYTE, true, VERTEX_BYTES, 16);
    // The same bytes as a mesh's depth, which the mesh program reads in place of the colour.
    gl.enableVertexAttribArray(DEPTH_AT);
    gl.vertexAttribPointer(DEPTH_AT, 1, gl.FLOAT, false, VERTEX_BYTES, 16);
    this.glyphArray = gl.createVertexArray() as WebGLVertexArrayObject;
    this.glyphBuffer = gl.createBuffer() as WebGLBuffer;
    this.glyphIndexBuffer = gl.createBuffer() as WebGLBuffer;
    this.state.bindVertexArray(this.glyphArray);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.glyphBuffer);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.glyphIndexBuffer);
    gl.enableVertexAttribArray(POSITION_AT);
    gl.vertexAttribPointer(POSITION_AT, 2, gl.FLOAT, false, GLYPH_BYTES, 0);
    for (const [at, offset] of [
      [ORIGIN_AT, 8],
      [GLYPH_AT, 24],
      [RUN_AT, 40],
      [TINT_AT, 56],
    ]) {
      gl.enableVertexAttribArray(at);
      gl.vertexAttribPointer(at, 4, gl.FLOAT, false, GLYPH_BYTES, offset);
    }

    Object.assign(this.glyphs, {
      capacity: 0,
      top: 0,
      indexCapacity: 0,
      indexTop: 0,
      live: 0,
      holes: 0,
    });
    this.gpu.setUp();
    this.vertexCapacity = 0;
    this.indexCapacity = 0;
    this.places = [];
  }

  /**
   * Draw a frame: what the geometries added and removed first, then the
   * rows, then the commands; onto the canvas, or into `root`, a layer the
   * target's size, as BitmapData.draw's frames go.
   */
  execute(
    commands: Commands,
    scene: SceneList,
    rows: Rows,
    geometries: Geometries,
    textures: Textures,
    filters: Filters,
    keeps: Keeps,
    target: Target,
    root: Layer | null = null,
  ): void {
    // A frame drawn into a layer, for BitmapData, is no frame of the canvas': idle layers are
    // counted in the canvas' frames.
    const counted = root === null;
    const gl = this.gl;
    if (gl.isContextLost()) {
      return;
    }

    this.place(geometries);
    this.gpu.uploadTextures(textures);
    for (const id of keeps.removed) {
      const layer = this.targets.kept[id];
      if (layer) {
        this.targets.giveLayer(layer);
        this.targets.kept[id] = null;
      }
    }

    keeps.removed.length = 0;
    this.gpu.uploadRows(rows);
    const state = this.state;
    state.scissor(null);
    state.colorMask(15);
    state.useProgram(this.program);
    state.bindVertexArray(this.vertexArray);
    state.bindTexture(0, this.gpu.rowsTexture);
    // As many samples as the GPU takes; a BitmapData's frame supersamples instead, as Flash's draw
    // does. Its layers take the stage's, so that their edges are the stage's.
    const stage = root ? null : this.stage.stageBuffers(target.width, target.height, this.samples);
    // An erase or alpha blend outside any layer clears what it covers on the stage, as adl does,
    // which the blends after it read: an opaque canvas keeps no alpha, so such a frame is drawn
    // into a layer the canvas' size, then copied onto it. Multisampled buffers keep it already.
    const cleared =
      !root && !stage && !this.stage.canvasAlpha && commands.clearsTarget
        ? this.stage.stageAlpha(target.width, target.height)
        : null;
    const into = root ?? cleared;
    if (into) {
      // Its own stencil, for the masks drawn into it.
      this.targets.layerMsaa(into, 1);
    }

    this.targets.frameSamples = stage?.samples ?? 1;
    this.drawHolds(commands, scene, filters, target);
    const canvas: Open = {
      layer: into,
      msaa: stage,
      x: 0,
      y: 0,
      width: target.width,
      height: target.height,
    };
    this.layers.length = 0;
    this.drawInto(canvas, target);

    this.lastRow = -1;
    // The masks pushed on the target drawn into: what is drawn passes where its stencil holds as
    // many. Its eight bits hold 255: those pushed past that are left out, and their pops with
    // them. A layer has a stencil of its own, and the target below keeps its count meanwhile.
    let depth = 0;
    let past = 0;
    const below = this.below;
    below.length = 0;
    state.stencil(null);
    const ops = commands.ops;
    for (let k = 0; k < commands.length; k++) {
      const at = k * 4;
      switch (ops[at]) {
        case CLEAR: {
          const p = commands.params;
          const from = ops[at + 1];
          gl.clearColor(p[from], p[from + 1], p[from + 2], p[from + 3]);
          gl.clearStencil(0);
          gl.stencilMask(0xff);
          gl.clear(gl.COLOR_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);
          break;
        }

        case RUN:
          // Premultiplied, as every blend mode will be.
          this.useFill();
          state.setBlend(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
          this.drawEntries(scene, ops[at + 1], ops[at + 1] + ops[at + 2], false);
          break;
        case STENCIL_PUSH:
        case STENCIL_POP: {
          // The mask's coverage, once a pixel however its fills overlap: counted up into the
          // stencil where the masks pushed before it pass, and back down where it and they did.
          const push = ops[at] === STENCIL_PUSH;
          if (push ? depth >= STENCIL_MOST || past > 0 : past > 0) {
            past += push ? 1 : -1;
            break;
          }

          this.useFill();
          state.colorMask(0);
          state.stencil(gl.EQUAL, depth, push ? gl.INCR : gl.DECR);
          this.drawEntries(scene, ops[at + 1], ops[at + 1] + ops[at + 2], true);
          depth += push ? 1 : -1;
          state.colorMask(15);
          state.stencil(depth > 0 ? gl.EQUAL : null, depth, gl.KEEP);
          break;
        }

        case HOLD_PUSH:
          // Drawn ahead of the stage (drawHolds).
          while (ops[k * 4] !== HOLD_POP) {
            k++;
          }

          break;
        case HELD:
          state.stencil(depth > 0 ? gl.EQUAL : null, depth, gl.KEEP);
          this.compositeHeld(ops[at + 1], this.layers.at(-1) ?? canvas, ops[at + 2], ops[at + 3]);
          break;

        case LAYER_PUSH: {
          below.push(depth, past);
          depth = 0;
          past = 0;
          const p = commands.params;
          const from = ops[at + 1];
          const width = p[from + 2];
          const height = p[from + 3];
          const filtered = ops[at + 2] === 1;
          // A filtered one of the size its filters' targets take for it, which they read alike.
          const layer = this.targets.takeLayer(width, height, filtered);
          const open: Open = {
            layer,
            msaa: this.targets.layerMsaa(layer, this.targets.frameSamples),
            x: p[from],
            y: p[from + 1],
            width,
            height,
          };
          this.layers.push(open);
          this.drawInto(open, target);
          state.stencil(null);
          state.colorMask(15);
          gl.clearColor(0, 0, 0, 0);
          gl.clearStencil(0);
          gl.stencilMask(0xff);
          // Its rectangle alone, as a layer taken may be larger, unless filters read past it.
          state.scissor(filtered ? null : [0, 0, width, height]);
          gl.clear(gl.COLOR_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);
          state.scissor(null);
          break;
        }

        case FILTER: {
          const open = this.layers.at(-1);
          if (open?.layer) {
            state.stencil(null);
            // Whole, as the filters read past its rectangle.
            this.targets.resolve(open, open.layer.width, open.layer.height);
            open.layer = this.filters.run(
              filters,
              ops[at + 1],
              open.layer,
              open.width,
              open.height,
              target.resolution,
            );
          }

          break;
        }

        case LAYER_POP: {
          const open = this.layers.pop() as Open;
          past = below.pop() as number;
          depth = below.pop() as number;
          this.targets.resolve(open, open.width, open.height);
          const under = this.layers.at(-1) ?? canvas;
          this.drawInto(under, target);
          // Composited where the masks on the target below let it be.
          state.stencil(depth > 0 ? gl.EQUAL : null, depth, gl.KEEP);
          this.compositeLayer(open, under, ops[at + 1], ops[at + 2]);
          const keep = ops[at + 3];
          if (keep >= 0) {
            // Kept for the frames after, the output kept before given back.
            const before = this.targets.kept[keep];
            if (before && before !== open.layer) {
              this.targets.giveLayer(before);
            }

            this.targets.kept[keep] = open.layer;
          } else {
            this.targets.giveLayer(open.layer as Layer);
          }

          break;
        }

        case COMPOSITE: {
          const p = commands.params;
          const from = ops[at + 1];
          const layer = this.targets.kept[p[from + 4]];
          if (layer) {
            const kept: Open = {
              layer,
              msaa: null,
              x: p[from],
              y: p[from + 1],
              width: p[from + 2],
              height: p[from + 3],
            };
            state.stencil(depth > 0 ? gl.EQUAL : null, depth, gl.KEEP);
            this.compositeLayer(kept, this.layers.at(-1) ?? canvas, ops[at + 2], ops[at + 3]);
          }

          break;
        }
      }
    }

    state.stencil(null);
    if (canvas.msaa) {
      this.stage.present(canvas.msaa);
    }

    if (cleared) {
      // Its rows run down, the canvas' up.
      this.stage.toCanvas(cleared.framebuffer, target.width, target.height, true);
    }

    for (const page of this.pages) {
      if (page) {
        this.targets.giveLayer(page);
      }
    }

    this.pages.length = 0;
    this.pageUntil.length = 0;
    this.pageKept.length = 0;
    if (counted) {
      this.dropIdleLayers();
      this.targets.frame++;
    }
  }

  /**
   * A frame drawn into a layer `samples` times the size of a `width` by
   * `height` bitmap a side, as `execute` draws, then halved till a sample a
   * pixel, and read back: premultiplied RGBA bytes, a row at a time from
   * the top, as BitmapData.draw takes them.
   */
  snapshot(
    commands: Commands,
    scene: SceneList,
    rows: Rows,
    geometries: Geometries,
    textures: Textures,
    filters: Filters,
    keeps: Keeps,
    target: Target,
    width: number,
    height: number,
    samples: number,
  ): Uint8Array {
    const gl = this.gl;
    const bytes = new Uint8Array(width * height * 4);
    if (gl.isContextLost()) {
      return bytes;
    }

    const layer = this.drawSampled(
      commands,
      scene,
      rows,
      geometries,
      textures,
      filters,
      keeps,
      target,
      width,
      height,
      samples,
    );
    this.state.bindFramebuffer(layer.framebuffer);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
    this.targets.giveLayer(layer);
    return bytes;
  }

  /**
   * A 3D object's bitmap drawn (PLANE): the commands, as `execute` draws
   * them, into a layer `samples` times the size of a `width` by `height`
   * bitmap a side, halved till a sample a texel, and kept as kept output
   * `keep` (Keeps), the one kept before given back. Called as the frame is
   * walked, before its own commands are drawn, which composite it.
   */
  drawPlane(
    keep: number,
    commands: Commands,
    scene: SceneList,
    rows: Rows,
    geometries: Geometries,
    textures: Textures,
    filters: Filters,
    keeps: Keeps,
    target: Target,
    width: number,
    height: number,
    samples: number,
  ): void {
    const gl = this.gl;
    if (gl.isContextLost()) {
      return;
    }

    const layer = this.drawSampled(
      commands,
      scene,
      rows,
      geometries,
      textures,
      filters,
      keeps,
      target,
      width,
      height,
      samples,
    );
    // Clear past the bitmap, which a layer taken may be larger than: its quad's smoothing reads
    // half a texel past its edges.
    this.state.bindFramebuffer(layer.framebuffer);
    this.state.stencil(null);
    this.state.colorMask(15);
    gl.clearColor(0, 0, 0, 0);
    for (const [x, y, w, h] of [
      [width, 0, layer.width - width, layer.height],
      [0, height, width, layer.height - height],
    ]) {
      if (w > 0 && h > 0) {
        this.state.scissor([x, y, w, h]);
        gl.clear(gl.COLOR_BUFFER_BIT);
      }
    }

    this.state.scissor(null);
    const before = this.targets.kept[keep];
    if (before && before !== layer) {
      this.targets.giveLayer(before);
    }

    this.targets.kept[keep] = layer;
  }

  /**
   * The commands drawn, as `execute` draws them, into a layer `samples`
   * times the size of a `width` by `height` bitmap a side, halved till a
   * sample a pixel: the layer, its first `width` by `height` the bitmap.
   */
  private drawSampled(
    commands: Commands,
    scene: SceneList,
    rows: Rows,
    geometries: Geometries,
    textures: Textures,
    filters: Filters,
    keeps: Keeps,
    target: Target,
    width: number,
    height: number,
    samples: number,
  ): Layer {
    let layer = this.targets.takeLayer(width * samples, height * samples);
    this.execute(commands, scene, rows, geometries, textures, filters, keeps, target, layer);
    for (let k = samples; k > 1; k /= 2) {
      const half = this.filters.halve(layer, (width * k) / 2, (height * k) / 2);
      this.targets.giveLayer(layer);
      layer = half;
    }

    return layer;
  }

  /** The free layers, and the stage's (stageAlpha), undrawn into for LAYER_IDLE_FRAMES let go of. */
  private dropIdleLayers(): void {
    this.stage.dropIdleLayer();
    this.targets.dropIdleLayers();
  }

  /**
   * Draw into `open` from here on: its framebuffer bound, its viewport its
   * rectangle's size, and the stage placed on it as on the canvas, its
   * rectangle's corner the origin, its rows running up on the canvas and
   * down in a layer. The fill program takes the view.
   */
  private drawInto(open: Open, target: Target): void {
    const gl = this.gl;
    const state = this.state;
    const ox = open.ox ?? 0;
    const oy = open.oy ?? 0;
    state.bindFramebuffer(framebufferOf(open));
    state.viewport(ox, oy, open.width, open.height);
    state.useProgram(this.program);
    const down = open.layer ? 1 : -1;
    const view = this.view;
    view[0] = (2 * target.scale) / open.width;
    view[1] = (down * 2 * target.scale) / open.height;
    view[2] = -1 + (2 * (target.x - open.x)) / open.width;
    view[3] = -down * (1 - (2 * (target.y - open.y)) / open.height);
    gl.uniform4fv(this.viewLocation, view);
    // A layer's rows run down from its corner; the canvas' up from its bottom.
    const frag = this.frag;
    frag[0] = open.x - target.x - ox;
    frag[1] = (open.layer ? open.y : open.y + open.height) - target.y - oy;
    frag[2] = down;
    frag[3] = target.pixel;
    this.unit = target.scale / target.pixel;
    gl.uniform1f(this.fillUnitLocation, this.unit);
    this.meshStale = true;
    this.glyphStale = true;
  }

  /**
   * The frame's held layers (HOLD_PUSH), drawn ahead of the stage side by
   * side: their content on pages of their own, one bind, clear and resolve
   * a page; then their filters' passes in waves, the k-th pass of every
   * chain at once, each wave's targets on pages of its own, which no pass
   * of it reads. Each layer's output is left on its page for HELD. A layer
   * larger than a page is drawn alone, as a layer of its own.
   */
  private drawHolds(commands: Commands, scene: SceneList, filters: Filters, target: Target): void {
    const count = this.gatherHolds(commands);
    // A level at a time, which the planner gives in order: a held layer's content composites
    // those in it, of the levels before.
    for (let from = 0; from < count; ) {
      let to = from + 1;
      while (to < count && this.holds[to].level === this.holds[from].level) {
        to++;
      }

      this.drawHoldLevel(from, to, commands, scene, filters, target);
      from = to;
    }
  }

  /** Held layers `from` up to `to`, of one level, drawn side by side (drawHolds). */
  private drawHoldLevel(
    from: number,
    to: number,
    commands: Commands,
    scene: SceneList,
    filters: Filters,
    target: Target,
  ): void {
    const gl = this.gl;
    const state = this.state;
    const holds = this.holds;
    // The pages this level takes, from here on, which its waves give back.
    const levelPages = this.pages.length;
    const shelves = this.shelves;
    this.lastRow = -1;
    // Their content, each at the size its own layer would take, on pages no taller than the
    // frame's samples fit (fittingSamples), so that each takes them as its own layer did.
    let area = 0;
    let widest = 0;
    for (let h = from; h < to; h++) {
      area += layerSide(holds[h].width) * layerSide(holds[h].height);
      widest = Math.max(widest, layerSide(holds[h].width));
    }

    const samples = this.targets.frameSamples;
    let width = this.pageWidth(area, widest);
    const fitting = Math.floor(MSAA_BYTES / (width * samples * 8) / LAYER_STEP) * LAYER_STEP;
    shelves.reset(width, samples > 1 ? Math.min(this.textureMost, fitting) : this.textureMost);
    for (let h = from; h < to; h++) {
      const hold = holds[h];
      hold.shelf = shelves.add(layerSide(hold.width), layerSide(hold.height));
      if (hold.shelf < 0) {
        this.drawHoldAlone(hold, commands, scene, filters, target);
      }
    }

    for (let p = 0; p < shelves.pages; p++) {
      const index = this.takePage(width, shelves.heights[p]);
      const page = this.pages[index] as Layer;
      const whole = this.pageOpen;
      whole.layer = page;
      whole.msaa = this.targets.layerMsaa(page, samples);
      whole.width = page.width;
      whole.height = page.height;
      state.bindFramebuffer(framebufferOf(whole));
      state.scissor(null);
      state.stencil(null);
      state.colorMask(15);
      gl.clearColor(0, 0, 0, 0);
      gl.clearStencil(0);
      gl.stencilMask(0xff);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);
      for (let h = from; h < to; h++) {
        const hold = holds[h];
        if (hold.shelf < 0 || shelves.page[hold.shelf] !== p) {
          continue;
        }

        const content = this.holdOpen;
        content.layer = page;
        content.msaa = whole.msaa;
        content.x = hold.x;
        content.y = hold.y;
        content.width = hold.width;
        content.height = hold.height;
        content.ox = shelves.x[hold.shelf];
        content.oy = shelves.y[hold.shelf];
        // Kept to its rectangle by the viewport alone, as the composites in it scissor themselves.
        this.drawInto(content, target);
        this.drawHoldContent(commands, hold, scene, content);
        this.slotOf(hold, 0, index, content.ox, content.oy, hold.width, hold.height);
      }

      this.targets.resolve(whole, page.width, page.height);
    }

    // Their filters, planned, then drawn a wave at a time: each wave's new targets on pages of its
    // own, which none of its passes reads, as each reads what earlier waves drew. A page goes back
    // once no pass after reads it, unless an output is on it.
    let waves = 0;
    for (let h = from; h < to; h++) {
      const hold = holds[h];
      if (hold.shelf < 0) {
        continue;
      }

      const plan = hold.plan;
      planChain(
        plan,
        filters,
        hold.chain,
        hold.width,
        hold.height,
        target.resolution,
        this.gpu.hasTexture,
      );
      hold.targets.length = plan.slots;
      hold.targets.fill(null, 1);
      hold.lastUse.length = plan.slots;
      hold.lastUse.fill(-1);
      for (let k = 0; k < plan.count; k++) {
        const pass = plan.passes[k];
        hold.lastUse[pass.input] = k;
        hold.lastUse[pass.output] = k;
        if (pass.blurred >= 0) {
          hold.lastUse[pass.blurred] = k;
        }
      }

      this.notePage(hold, 0);
      waves = Math.max(waves, plan.count);
    }

    for (let k = 0; k < waves; k++) {
      area = 0;
      widest = 0;
      for (let h = from; h < to; h++) {
        const hold = holds[h];
        const plan = hold.plan;
        if (hold.shelf >= 0 && k < plan.count && !hold.targets[plan.passes[k].output]) {
          const slot = plan.passes[k].output;
          area += layerSide(plan.slotWidth[slot]) * layerSide(plan.slotHeight[slot]);
          widest = Math.max(widest, layerSide(plan.slotWidth[slot]));
        }
      }

      width = this.pageWidth(area, widest);
      shelves.reset(width, this.textureMost);
      for (let h = from; h < to; h++) {
        const hold = holds[h];
        const plan = hold.plan;
        hold.wave = -1;
        if (hold.shelf >= 0 && k < plan.count && !hold.targets[plan.passes[k].output]) {
          const slot = plan.passes[k].output;
          hold.wave = shelves.add(
            layerSide(plan.slotWidth[slot]),
            layerSide(plan.slotHeight[slot]),
          );
        }
      }

      const first = this.pages.length;
      for (let p = 0; p < shelves.pages; p++) {
        const page = this.pages[this.takePage(width, shelves.heights[p])] as Layer;
        state.bindFramebuffer(page.framebuffer);
        state.scissor(null);
        state.colorMask(15);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
      }

      for (let h = from; h < to; h++) {
        const hold = holds[h];
        if (hold.wave >= 0) {
          const plan = hold.plan;
          const slot = plan.passes[k].output;
          this.slotOf(
            hold,
            slot,
            first + shelves.page[hold.wave],
            shelves.x[hold.wave],
            shelves.y[hold.wave],
            plan.slotWidth[slot],
            plan.slotHeight[slot],
          );
          this.notePage(hold, slot);
        }
      }

      // The passes drawing into one page together, so that it is bound once: a target drawn into
      // again, as a blur's runs take turns between two, is on an earlier wave's page.
      let left = 0;
      for (let h = from; h < to; h++) {
        const hold = holds[h];
        hold.drawn = !(hold.shelf >= 0 && k < hold.plan.count);
        left += hold.drawn ? 0 : 1;
      }

      while (left > 0) {
        let page = -1;
        for (let h = from; h < to; h++) {
          const hold = holds[h];
          if (hold.drawn) {
            continue;
          }

          const output = hold.targets[hold.plan.passes[k].output] as Slot;
          if (page < 0) {
            page = output.index;
          }

          if (output.index === page) {
            this.filters.drawPass(hold.plan, k, hold.targets, false);
            hold.drawn = true;
            left--;
          }
        }
      }

      for (let index = levelPages; index < this.pages.length; index++) {
        const page = this.pages[index];
        if (page && !this.pageKept[index] && this.pageUntil[index] <= k) {
          this.targets.giveLayer(page);
          this.pages[index] = null;
        }
      }
    }

    for (let h = from; h < to; h++) {
      const hold = holds[h];
      if (hold.shelf >= 0) {
        hold.result = hold.targets[hold.plan.result];
      }
    }
  }

  /**
   * The width of a page for rectangles of `area` in all, the widest `widest`:
   * about square, in LAYER_STEP's steps, at most PAGE_WIDTH.
   */
  private pageWidth(area: number, widest: number): number {
    const square = Math.ceil(Math.sqrt(area) / LAYER_STEP) * LAYER_STEP;
    return Math.min(this.textureMost, PAGE_WIDTH, Math.max(widest, square));
  }

  /** A page of at least `width` by `height` taken for the frame: its index in `pages`. */
  private takePage(width: number, height: number): number {
    const index = this.pages.length;
    this.pages.push(this.targets.takeLayer(width, height));
    this.pageUntil.push(-1);
    this.pageKept.push(false);
    return index;
  }

  /** Slot `slot` of `hold` noted on its page: read until its last pass, or kept as its output. */
  private notePage(hold: Hold, slot: number): void {
    const index = (hold.targets[slot] as Slot).index;
    this.pageUntil[index] = Math.max(this.pageUntil[index], hold.lastUse[slot]);
    if (slot === hold.plan.result) {
      this.pageKept[index] = true;
    }
  }

  /** The held layers' rectangles and operations (HOLD_PUSH), which the commands begin with: how many. */
  private gatherHolds(commands: Commands): number {
    const ops = commands.ops;
    const params = commands.params;
    const holds = this.holds;
    let count = 0;
    for (let k = 0; k < commands.length && ops[k * 4] === HOLD_PUSH; k++) {
      const from = ops[k * 4 + 1];
      let hold = holds[count];
      if (!hold) {
        hold = {
          x: 0,
          y: 0,
          width: 0,
          height: 0,
          first: 0,
          end: 0,
          chain: 0,
          plan: new FilterPlan(),
          targets: [],
          slots: [],
          lastUse: [],
          result: null,
          shelf: -1,
          wave: -1,
          drawn: false,
          level: 0,
        };
        holds[count] = hold;
      }

      count++;
      hold.level = ops[k * 4 + 3];
      hold.x = params[from];
      hold.y = params[from + 1];
      hold.width = params[from + 2];
      hold.height = params[from + 3];
      hold.first = k + 1;

      while (ops[k * 4] !== HOLD_POP) {
        k++;
      }

      hold.end = k;
      hold.chain = ops[k * 4 + 1];
      hold.result = null;
      hold.targets.length = 0;
    }

    return count;
  }

  /**
   * Slot `slot` of `hold`'s targets: the rectangle of page `index` from (x,
   * y) a target of `width` by `height` takes, as its own layer would; its
   * record kept from frame to frame.
   */
  private slotOf(
    hold: Hold,
    slot: number,
    index: number,
    x: number,
    y: number,
    width: number,
    height: number,
  ): Slot {
    const page = this.pages[index] as Layer;
    let record = hold.slots[slot];
    if (!record) {
      record = {
        framebuffer: page.framebuffer,
        texture: page.texture,
        x,
        y,
        width,
        height,
        page,
        index,
      };
      hold.slots[slot] = record;
    }

    record.framebuffer = page.framebuffer;
    record.texture = page.texture;
    record.x = x;
    record.y = y;
    record.width = layerSide(width);
    record.height = layerSide(height);
    record.page = page;
    record.index = index;
    hold.targets[slot] = record;
    return record;
  }

  /**
   * Held layer `hold`'s draws, masks and held layers' composites into
   * `open`, bound, its stencil starting clear.
   */
  private drawHoldContent(commands: Commands, hold: Hold, scene: SceneList, open: Open): void {
    const gl = this.gl;
    const state = this.state;
    const ops = commands.ops;
    let depth = 0;
    let past = 0;
    state.stencil(null);
    state.colorMask(15);
    for (let k = hold.first; k < hold.end; k++) {
      const at = k * 4;
      switch (ops[at]) {
        case RUN:
          this.useFill();
          state.setBlend(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
          this.drawEntries(scene, ops[at + 1], ops[at + 1] + ops[at + 2], false);
          break;
        case STENCIL_PUSH:
        case STENCIL_POP: {
          const push = ops[at] === STENCIL_PUSH;
          if (push ? depth >= STENCIL_MOST || past > 0 : past > 0) {
            past += push ? 1 : -1;
            break;
          }

          this.useFill();
          state.colorMask(0);
          state.stencil(gl.EQUAL, depth, push ? gl.INCR : gl.DECR);
          this.drawEntries(scene, ops[at + 1], ops[at + 1] + ops[at + 2], true);
          depth += push ? 1 : -1;
          state.colorMask(15);
          state.stencil(depth > 0 ? gl.EQUAL : null, depth, gl.KEEP);
          break;
        }

        case HELD:
          state.stencil(depth > 0 ? gl.EQUAL : null, depth, gl.KEEP);
          this.compositeHeld(ops[at + 1], open, ops[at + 2], ops[at + 3]);
          break;
      }
    }

    state.stencil(null);
  }

  /** Held output `held` composited onto `under`, bound, in blend mode `mode`, coloured by `row`. */
  private compositeHeld(held: number, under: Open, mode: number, row: number): void {
    const hold = this.holds[held];
    const result = hold.result;
    if (!result) {
      return;
    }

    const open = this.heldOpen;
    open.layer = result.page;
    open.x = hold.x;
    open.y = hold.y;
    open.width = hold.width;
    open.height = hold.height;
    open.ox = result.x;
    open.oy = result.y;
    this.compositeLayer(open, under, mode, row);
  }

  /**
   * Held layer `hold`, too large for a page, drawn as a layer of its own and
   * filtered there, its output left in a page of its own.
   */
  private drawHoldAlone(
    hold: Hold,
    commands: Commands,
    scene: SceneList,
    filters: Filters,
    target: Target,
  ): void {
    const gl = this.gl;
    const state = this.state;
    const layer = this.targets.takeLayer(hold.width, hold.height, true);
    const open: Open = {
      layer,
      msaa: this.targets.layerMsaa(layer, this.targets.frameSamples),
      x: hold.x,
      y: hold.y,
      width: hold.width,
      height: hold.height,
    };
    this.drawInto(open, target);
    state.scissor(null);
    state.colorMask(15);
    state.stencil(null);
    gl.clearColor(0, 0, 0, 0);
    gl.clearStencil(0);
    gl.stencilMask(0xff);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);
    this.drawHoldContent(commands, hold, scene, open);
    this.targets.resolve(open, layer.width, layer.height);
    const output = this.filters.run(
      filters,
      hold.chain,
      layer,
      hold.width,
      hold.height,
      target.resolution,
    );
    const index = this.pages.length;
    this.pages.push(output);
    this.pageUntil.push(-1);
    this.pageKept.push(true);
    hold.result = this.slotOf(hold, 0, index, 0, 0, output.width, output.height);
  }

  /** The fill program, its vertex array and rows bound, as runs and masks draw with them. */
  private useFill(): void {
    this.state.useProgram(this.program);
    this.state.bindVertexArray(this.vertexArray);
    this.state.bindTexture(0, this.gpu.rowsTexture);
  }

  /**
   * `open` composited onto `under`, bound, in blend mode `mode`, coloured by
   * row `row` (or -1), over its rectangle alone: through GL's blending where
   * it computes Flash's blend, else from a copy of what is below there, the
   * result replacing it. Its rectangle is cut to `under`'s, as a filtered
   * one may reach past the canvas; in `under`'s framebuffer its rows run
   * up on the canvas and down in a layer.
   */
  private compositeLayer(open: Open, under: Open, mode: number, row: number): void {
    const gl = this.gl;
    const state = this.state;
    const dx = open.x - under.x;
    const dy = open.y - under.y;
    const flip = !under.layer;
    const y = flip ? under.height - dy - open.height : dy;
    const x0 = Math.max(0, dx);
    const y0 = Math.max(0, y);
    const width = Math.min(under.width, dx + open.width) - x0;
    const height = Math.min(under.height, y + open.height) - y0;
    if (width <= 0 || height <= 0) {
      return;
    }

    const direct = mode === NORMAL || mode === LAYER || mode === ADD || mode === SCREEN;
    // The rectangle's corner in the target's framebuffer, where the target is a held layer's
    // rectangle of a page (HOLD_PUSH).
    const fx = x0 + (under.ox ?? 0);
    const fy = y0 + (under.oy ?? 0);
    // Where the copy of what is below has the rectangle's corner, less where the target has it.
    let backX = 0;
    let backY = 0;
    if (!direct) {
      // Out of a multisampled page, its rectangle resolved into the page's own texture first, which
      // a blit may then copy anywhere: copied where it lies, the copy would stay as large as the
      // page's far corner.
      let from = framebufferOf(under);
      const paged = under.msaa !== null && under.layer !== null && under.ox !== undefined;
      if (paged) {
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, from);
        gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, (under.layer as Layer).framebuffer);
        gl.blitFramebuffer(
          fx,
          fy,
          fx + width,
          fy + height,
          fx,
          fy,
          fx + width,
          fy + height,
          gl.COLOR_BUFFER_BIT,
          gl.NEAREST,
        );
        from = (under.layer as Layer).framebuffer;
      }

      // Copied from its corner, or out of a multisampled target to where it lies, as a blit
      // resolving must keep its rectangle: then as large as the rectangle's far corner.
      const bx = under.msaa && !paged ? fx : 0;
      const by = under.msaa && !paged ? fy : 0;
      backX = fx - bx;
      backY = fy - by;
      const right = bx + width;
      const top = by + height;
      if (!this.back || this.backWidth < right || this.backHeight < top) {
        if (this.back) {
          state.dropTexture(this.back);
          gl.deleteTexture(this.back);
          gl.deleteFramebuffer(this.backFramebuffer);
          this.backFramebuffer = null;
        }

        this.back = gl.createTexture() as WebGLTexture;
        this.backWidth = Math.max(this.backWidth, Math.ceil(right / LAYER_STEP) * LAYER_STEP);
        this.backHeight = Math.max(this.backHeight, Math.ceil(top / LAYER_STEP) * LAYER_STEP);
        state.bindTexture(BACK_UNIT, this.back);
        state.activeTexture(BACK_UNIT);
        gl.texImage2D(
          gl.TEXTURE_2D,
          0,
          gl.RGBA8,
          this.backWidth,
          this.backHeight,
          0,
          gl.RGBA,
          gl.UNSIGNED_BYTE,
          null,
        );
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      }

      // Blitted, not copied: the canvas' colour may have no alpha, which copyTexSubImage2D into an
      // RGBA texture refuses, where a blit fills it in.
      // Out of a multisampled target the blit resolves the rectangle alone.
      if (!this.backFramebuffer) {
        this.backFramebuffer = gl.createFramebuffer() as WebGLFramebuffer;
        gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.backFramebuffer);
        gl.framebufferTexture2D(
          gl.DRAW_FRAMEBUFFER,
          gl.COLOR_ATTACHMENT0,
          gl.TEXTURE_2D,
          this.back,
          0,
        );
      } else {
        gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.backFramebuffer);
      }

      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, from);
      gl.blitFramebuffer(
        fx,
        fy,
        fx + width,
        fy + height,
        bx,
        by,
        right,
        top,
        gl.COLOR_BUFFER_BIT,
        gl.NEAREST,
      );
      // Both bindings back as the state cache has them.
      gl.bindFramebuffer(gl.FRAMEBUFFER, framebufferOf(under));
    }

    state.bindTexture(LAYER_UNIT, (open.layer as Layer).texture);
    state.bindSampler(LAYER_UNIT, null);
    state.bindSampler(BACK_UNIT, null);
    state.useProgram(this.composite);
    state.bindVertexArray(null);
    gl.uniform1i(this.modeLocation, mode);
    gl.uniform1i(this.compositeRowLocation, row);
    // Less its corner on its page, where it is a held layer's rectangle of one (HELD), and past
    // the target's, where that is one.
    const ox = (under.ox ?? 0) - (open.ox ?? 0);
    const oy = (under.oy ?? 0) - (open.oy ?? 0);
    gl.uniform2i(this.offsetLocation, dx + ox, flip ? under.height - 1 - dy - oy : dy + oy);
    gl.uniform1i(this.flipLocation, flip ? 1 : 0);
    gl.uniform2i(this.backOffsetLocation, backX, backY);
    switch (mode) {
      case ADD:
        state.setBlend(gl.ONE, gl.ONE);
        break;
      case SCREEN:
        state.setBlend(gl.ONE, gl.ONE_MINUS_SRC_COLOR);
        break;
      case NORMAL:
      case LAYER:
        state.setBlend(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        break;
      default:
        state.setBlend(null);
    }

    // Over the rectangle alone, in the target's clip space; the scissor keeps it to whole pixels.
    const tw = under.width;
    const th = under.height;
    gl.uniform4f(
      this.rectLocation,
      (2 * x0) / tw - 1,
      (2 * y0) / th - 1,
      (2 * (x0 + width)) / tw - 1,
      (2 * (y0 + height)) / th - 1,
    );
    state.scissor([fx, fy, width, height]);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    state.scissor(null);
  }

  /** The draws at `scene`'s entries from `first` up to `end`; for the stencil alone, untextured. */
  private drawEntries(scene: SceneList, first: number, end: number, stencil: boolean): void {
    const gl = this.gl;
    const state = this.state;
    // Whether the mesh or the glyph program is in use, till the next entry of neither.
    let other = false;
    for (let i = first; i < end; i++) {
      if (scene.kind[i] !== DRAW) {
        continue;
      }

      const place = this.places[scene.geometry[i]];
      if (!place) {
        continue;
      }

      // A mesh by the mesh program; in a mask, its triangles' coverage as a fill's. Glyphs by the
      // glyph program, in a mask too, which covers their shapes alone.
      if (place.glyphs) {
        this.drawGlyphs(scene, i, place);
        other = true;
        continue;
      }

      if (!stencil && scene.sampler[i] & (MESH | PLANE)) {
        other = this.drawMesh(scene, i, place) || other;
        continue;
      }

      if (other) {
        this.useFill();
        other = false;
      }

      i = this.gatherRun(scene, i, end, stencil);
      const draws = this.runCount;
      if (draws === 0) {
        continue;
      }

      for (let k = 0; k < FILL_TEXTURES; k++) {
        if (this.runUnits & (1 << k)) {
          state.bindTexture(FILL_UNIT + k, this.gpu.textures[this.unitIds[k]] as WebGLTexture);
          state.bindSampler(FILL_UNIT + k, this.gpu.sampler(this.unitSampling[k]));
        }
      }

      if (!this.multi) {
        if (this.runRows[0] !== this.lastRow) {
          this.lastRow = this.runRows[0];
          gl.uniform1i(this.rowLocation, this.lastRow);
        }

        gl.drawElements(gl.TRIANGLES, this.runCounts[0], gl.UNSIGNED_INT, this.runOffsets[0]);
        continue;
      }

      gl.uniform4iv(this.runsLocation, this.runRows, 0, Math.ceil(draws / 4) * 4);
      this.multi.multiDrawElementsWEBGL(
        gl.TRIANGLES,
        this.runCounts,
        0,
        gl.UNSIGNED_INT,
        this.runOffsets,
        0,
        draws,
      );
    }

    if (other) {
      this.useFill();
    }
  }

  /**
   * The fills from entry `i` on that one call draws, as many as fit its
   * textures (FILL_TEXTURES, each with its sampling) and, without
   * WEBGL_multi_draw, one: their runCounts, runOffsets and runRows (FILL_SLOT),
   * and the units their textures take in runUnits. The last entry gathered,
   * past those whose texture is gone, which draw nothing.
   */
  private gatherRun(scene: SceneList, i: number, end: number, stencil: boolean): number {
    const textures = this.gpu.textures;
    const most = this.multi ? RUN_MOST : 1;
    let draws = 0;
    let last = i;
    this.runUnits = 0;

    for (let j = i; j < end && draws < most; j++) {
      if (scene.kind[j] !== DRAW) {
        continue;
      }

      const place = this.places[scene.geometry[j]];
      if (!place) {
        continue;
      }

      if (place.glyphs || (!stencil && scene.sampler[j] & (MESH | PLANE))) {
        break;
      }

      const id = stencil ? -1 : scene.texture[j];
      let slot = 0;
      if (id >= 0) {
        if (!textures[id]) {
          last = j;
          continue;
        }

        const sampling = scene.sampler[j] & (SMOOTH | REPEAT | MIRROR);
        slot = this.runSlot(id, sampling);
        if (slot === 0) {
          break;
        }
      }

      this.runCounts[draws] = place.indices;
      this.runOffsets[draws] = place.indexStart * 4;
      this.runRows[draws] =
        scene.row[j] | (slot << FILL_SLOT) | (scene.sampler[j] & SNAP ? SNAP_BIT : 0);
      draws++;
      last = j;
    }

    this.runCount = draws;

    return last;
  }

  /**
   * The slot (FILL_SLOT) of the unit texture `id` is sampled from so in the
   * run: the one it was left on, else one the run has not taken, an empty
   * one first, so that a texture stays where it is from run to run; 0 when
   * the run has taken all.
   */
  private runSlot(id: number, sampling: number): number {
    for (let k = 0; k < FILL_TEXTURES; k++) {
      if (this.unitIds[k] === id && this.unitSampling[k] === sampling) {
        this.runUnits |= 1 << k;
        return k + 1;
      }
    }

    let free = -1;
    for (let n = 0; n < FILL_TEXTURES; n++) {
      const k = (this.unitNext + n) % FILL_TEXTURES;
      if (!(this.runUnits & (1 << k)) && (free < 0 || this.unitIds[k] < 0)) {
        free = k;
        if (this.unitIds[k] < 0) {
          break;
        }
      }
    }

    if (free < 0) {
      return 0;
    }

    this.unitIds[free] = id;
    this.unitSampling[free] = sampling;
    this.unitNext = (free + 1) % FILL_TEXTURES;
    this.runUnits |= 1 << free;
    return free + 1;
  }

  /**
   * Entry `i`, advanced text's glyph quads (GeometryData.glyphs), drawn by the glyph
   * program from its atlas, which is told the view as it changed, and its
   * text's mode and table; the glyph program left in use.
   */
  private drawGlyphs(scene: SceneList, i: number, place: Place): void {
    const gl = this.gl;
    const state = this.state;
    const glyphs = place.glyphs as NonNullable<Place["glyphs"]>;
    state.useProgram(this.glyphProgram);
    state.bindVertexArray(this.glyphArray);
    if (this.glyphStale) {
      gl.uniform4fv(this.glyphViewLocation, this.view);
      gl.uniform1f(this.glyphUnitLocation, this.unit);
      this.glyphStale = false;
    }

    gl.uniform1i(this.glyphRowLocation, scene.row[i]);
    gl.uniform4fv(this.glyphModeLocation, glyphs.mode);
    gl.uniform4fv(this.glyphTableLocation, glyphs.table);
    state.bindTexture(OUTLINE_UNIT, this.gpu.outlines);
    state.bindSampler(OUTLINE_UNIT, null);
    gl.drawElements(gl.TRIANGLES, place.indices, gl.UNSIGNED_INT, place.indexStart * 4);
  }

  /**
   * Entry `i`, a mesh (MESH), drawn by the mesh program, which is told the
   * view as it changed, and its row and mode as they change; whether it
   * was drawn, the mesh program left in use.
   */
  private drawMesh(scene: SceneList, i: number, place: Place): boolean {
    const id = scene.texture[i];
    const plane = (scene.sampler[i] & PLANE) !== 0;
    const texture =
      id < 0
        ? null
        : plane
          ? (this.targets.kept[id]?.texture ?? null)
          : (this.gpu.textures[id] ?? null);
    if (!texture) {
      return false;
    }

    const gl = this.gl;
    const state = this.state;
    state.useProgram(this.mesh);
    // The atlas' vertices, which a glyph draw before may have left bound for its own.
    state.bindVertexArray(this.vertexArray);
    if (this.meshStale) {
      gl.uniform4fv(this.meshViewLocation, this.view);
      gl.uniform4fv(this.meshFragLocation, this.frag);
      this.meshStale = false;
    }

    const row = scene.row[i];
    if (row !== this.meshRow) {
      this.meshRow = row;
      gl.uniform1i(this.meshRowLocation, row);
    }

    const mode = scene.sampler[i] & (REPEAT | SMOOTH | PLANE);
    if (mode !== this.meshMode) {
      this.meshMode = mode;
      gl.uniform3i(
        this.meshModeLocation,
        mode & REPEAT ? 1 : 0,
        mode & SMOOTH ? 1 : 0,
        mode & PLANE ? 1 : 0,
      );
    }

    state.bindTexture(TEXTURE_UNIT, texture);
    // A plane's bitmap smoothed; a mesh's read texel by texel, but through a sampler without
    // mipmaps, as a texture with none needs.
    state.bindSampler(TEXTURE_UNIT, this.gpu.sampler(plane ? SMOOTH | CLAMP : CLAMP));
    gl.drawElements(gl.TRIANGLES, place.indices, gl.UNSIGNED_INT, place.indexStart * 4);
    return true;
  }

  /**
   * The geometries removed since the last frame let go of, and those added
   * copied in: at the top while they fit, else into an atlas packed again,
   * grown to twice what is live.
   */
  private place(geometries: Geometries): void {
    for (const id of geometries.removed) {
      const place = this.places[id];
      if (place?.glyphs) {
        this.places[id] = null;
        this.glyphs.live -= place.vertices;
        this.glyphs.holes += place.vertices;
      } else if (place) {
        this.places[id] = null;
        this.live -= place.vertices;
        this.holes += place.vertices;
      }
    }

    geometries.removed.length = 0;
    // Changed in place: copied again where they lie, else as added.
    for (const id of geometries.updated) {
      const place = this.places[id];
      const data = geometries.get(id);
      if (place && data && !data.glyphs && place.vertices === data.positions.length / 2) {
        this.copyVertices(data, place.vertexStart);
      } else if (place && data) {
        this.places[id] = null;
        if (place.glyphs) {
          this.glyphs.live -= place.vertices;
          this.glyphs.holes += place.vertices;
        } else {
          this.live -= place.vertices;
          this.holes += place.vertices;
        }

        geometries.added.push(id);
      }
    }

    geometries.updated.length = 0;
    let vertices = 0;
    let indices = 0;
    let glyphVertices = 0;
    let glyphIndices = 0;
    for (const id of geometries.added) {
      const data = geometries.get(id);
      if (data?.glyphs) {
        glyphVertices += data.glyphs.vertices.length / GLYPH_FLOATS;
        glyphIndices += data.indices.length;
      } else if (data) {
        vertices += data.positions.length / 2;
        indices += data.indices.length;
      }
    }

    // Each atlas packed again on its own, so that texts' quads made again often never repack
    // the shapes', nor shapes the texts'.
    const g = this.glyphs;
    const shapes =
      this.vertexTop + vertices > this.vertexCapacity ||
      this.indexTop + indices > this.indexCapacity ||
      (this.holes > SLACK && this.holes > this.live);
    const texts =
      g.top + glyphVertices > g.capacity ||
      g.indexTop + glyphIndices > g.indexCapacity ||
      (g.holes > GLYPHS_LEAST && g.holes > g.live);
    if (shapes) {
      this.repack(geometries);
    }

    if (texts) {
      this.repackGlyphs(geometries);
    }

    for (const id of geometries.added) {
      const data = geometries.get(id);
      if (data && !(data.glyphs ? texts : shapes)) {
        this.copyIn(id, data);
      }
    }

    geometries.added.length = 0;
  }

  /** Every live shape's geometry copied into new buffers, with room for twice what is live. */
  private repack(geometries: Geometries): void {
    const gl = this.gl;
    const ids = geometries.live();
    let vertices = 0;
    let indices = 0;
    for (const id of ids) {
      const data = geometries.get(id) as GeometryData;
      if (!data.glyphs) {
        vertices += data.positions.length / 2;
        indices += data.indices.length;
      }
    }

    this.vertexCapacity = Math.max(LEAST, vertices * 2);
    this.indexCapacity = Math.max(LEAST * 3, indices * 2);
    this.state.bindVertexArray(this.vertexArray);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, this.vertexCapacity * VERTEX_BYTES, gl.STATIC_DRAW);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, this.indexCapacity * 4, gl.STATIC_DRAW);
    this.vertexTop = 0;
    this.indexTop = 0;
    this.live = 0;
    this.holes = 0;
    for (const id of ids) {
      const data = geometries.get(id) as GeometryData;
      if (!data.glyphs) {
        this.copyIn(id, data);
      }
    }
  }

  /** Every live text's quads copied into new glyph buffers: none till a text needs them. */
  private repackGlyphs(geometries: Geometries): void {
    const gl = this.gl;
    const g = this.glyphs;
    const ids = geometries.live();
    let vertices = 0;
    let indices = 0;
    for (const id of ids) {
      const data = geometries.get(id) as GeometryData;
      if (data.glyphs) {
        vertices += data.glyphs.vertices.length / GLYPH_FLOATS;
        indices += data.indices.length;
      }
    }

    g.capacity = vertices > 0 ? Math.max(GLYPHS_LEAST, vertices * 2) : 0;
    g.indexCapacity = vertices > 0 ? Math.max(GLYPHS_LEAST * 2, indices * 2) : 0;
    this.state.bindVertexArray(this.glyphArray);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.glyphBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, g.capacity * GLYPH_BYTES, gl.STATIC_DRAW);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, g.indexCapacity * 4, gl.STATIC_DRAW);
    g.top = 0;
    g.indexTop = 0;
    g.live = 0;
    g.holes = 0;
    for (const id of ids) {
      const data = geometries.get(id) as GeometryData;
      if (data.glyphs) {
        this.copyGlyphs(id, data);
      }
    }
  }

  /** `data` copied in at the top of the atlas, its indices made absolute. */
  private copyIn(id: number, data: GeometryData): void {
    if (data.glyphs) {
      this.copyGlyphs(id, data);
      return;
    }

    const gl = this.gl;
    const count = data.positions.length / 2;
    const base = this.vertexTop;
    this.copyVertices(data, base);
    const indices = new Uint32Array(data.indices.length);
    for (let i = 0; i < indices.length; i++) {
      indices[i] = data.indices[i] + base;
    }

    this.state.bindVertexArray(this.vertexArray);
    gl.bufferSubData(gl.ELEMENT_ARRAY_BUFFER, this.indexTop * 4, indices);
    this.places[id] = {
      vertexStart: base,
      vertices: count,
      indexStart: this.indexTop,
      indices: indices.length,
      glyphs: null,
    };
    this.vertexTop += count;
    this.indexTop += indices.length;
    this.live += count;
  }

  /** `data`'s vertices interleaved into the atlas from vertex `base`. */
  private copyVertices(data: GeometryData, base: number): void {
    const gl = this.gl;
    const count = data.positions.length / 2;
    const bytes = new ArrayBuffer(count * VERTEX_BYTES);
    const floats = new Float32Array(bytes);
    const words = new Uint32Array(bytes);
    const texels = data.texels;
    const depths = data.depths;
    for (let i = 0; i < count; i++) {
      floats[i * 5] = data.positions[i * 2];
      floats[i * 5 + 1] = data.positions[i * 2 + 1];
      floats[i * 5 + 2] = texels ? texels[i * 2] : 0;
      floats[i * 5 + 3] = texels ? texels[i * 2 + 1] : 0;
      if (depths) {
        floats[i * 5 + 4] = depths[i];
      } else {
        words[i * 5 + 4] = data.colors[i];
      }
    }

    gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffer);
    gl.bufferSubData(gl.ARRAY_BUFFER, base * VERTEX_BYTES, floats);
  }

  /** Glyph quads copied in at the top of the glyph atlas, their indices made absolute in it. */
  private copyGlyphs(id: number, data: GeometryData): void {
    const gl = this.gl;
    const g = this.glyphs;
    const glyphs = data.glyphs as NonNullable<GeometryData["glyphs"]>;
    const count = glyphs.vertices.length / GLYPH_FLOATS;
    const indices = new Uint32Array(data.indices.length);
    for (let i = 0; i < indices.length; i++) {
      indices[i] = data.indices[i] + g.top;
    }

    this.state.bindVertexArray(this.glyphArray);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.glyphBuffer);
    gl.bufferSubData(gl.ARRAY_BUFFER, g.top * GLYPH_BYTES, glyphs.vertices);
    gl.bufferSubData(gl.ELEMENT_ARRAY_BUFFER, g.indexTop * 4, indices);
    this.places[id] = {
      vertexStart: g.top,
      vertices: count,
      indexStart: g.indexTop,
      indices: indices.length,
      glyphs: { mode: glyphs.mode, table: glyphs.table },
    };
    g.top += count;
    g.indexTop += indices.length;
    g.live += count;
  }

  /** Advanced text's outlines uploaded (GpuTextures.uploadOutlines). */
  uploadOutlines(data: Float32Array, count: number, epoch: number): void {
    this.gpu.uploadOutlines(data, count, epoch);
  }

  /** What the backend made on the context, deleted. */
  destroy(): void {
    const gl = this.gl;
    gl.deleteProgram(this.program);
    gl.deleteVertexArray(this.vertexArray);
    gl.deleteBuffer(this.vertexBuffer);
    gl.deleteBuffer(this.indexBuffer);
    gl.deleteProgram(this.composite);
    gl.deleteProgram(this.mesh);
    gl.deleteProgram(this.glyphProgram);
    gl.deleteVertexArray(this.glyphArray);
    gl.deleteBuffer(this.glyphBuffer);
    gl.deleteBuffer(this.glyphIndexBuffer);
    this.filters.destroy();
    for (const open of this.layers) {
      if (open.layer) {
        this.targets.deleteLayer(open.layer);
      }
    }

    this.targets.destroy();

    if (this.back) {
      gl.deleteTexture(this.back);
      gl.deleteFramebuffer(this.backFramebuffer);
    }

    this.stage.destroy();

    this.gpu.destroy();
    this.state.forget();
  }
}
