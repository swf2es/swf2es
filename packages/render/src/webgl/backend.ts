import { GlState, linkProgram } from "@swf2es/context3d/device";
import {
  CLEAR,
  COMPOSITE,
  type Commands,
  FILTER,
  LAYER_POP,
  LAYER_PUSH,
  RUN,
  STENCIL_POP,
  STENCIL_PUSH,
} from "../commands.js";
import type { Filters } from "../filters.js";
import { type Geometries, type GeometryData, GLYPH_FLOATS } from "../geometry.js";
import type { Keeps } from "../keeps.js";
import { ROW_FLOATS, ROWS_A_LINE, type Rows } from "../rows.js";
import {
  ADD,
  CLAMP,
  DRAW,
  LAYER,
  MESH,
  MIRROR,
  NORMAL,
  REPEAT,
  SCREEN,
  type SceneList,
  SMOOTH,
} from "../scene.js";
import type { Textures } from "../textures.js";
import { FilterRunner } from "./filters.js";
import { SizedPool } from "./pool.js";
import {
  COLOR_AT,
  compositeFragment,
  compositeVertex,
  DEPTH_AT,
  fillFragment,
  fillVertex,
  GLYPH_AT,
  glyphsFragment,
  glyphsVertex,
  meshFragment,
  meshVertex,
  ORIGIN_AT,
  OUTLINE_ROW,
  POSITION_AT,
  ROW_TEXELS,
  RUN_AT,
  TEXEL_AT,
  TINT_AT,
} from "./programs.js";

/**
 * Bytes a vertex in the atlas: its position's two floats, its texel's two, then its colour's four
 * bytes, or a mesh's depth's float.
 */
const VERTEX_BYTES = 20;
/** The most masks the stencil's eight bits count. */
const STENCIL_MOST = 255;
/** The texture unit an entry's texture is bound to; the rows are on 0. */
const TEXTURE_UNIT = 1;
/** The units a composite reads its layer and what is below from. */
const LAYER_UNIT = 2;
const BACK_UNIT = 3;
/** The unit advanced text's outlines are on (uploadOutlines); the filters take 4 to 6. */
const OUTLINE_UNIT = 7;
/** Bytes a vertex of advanced text's glyph quads, in an atlas of their own. */
const GLYPH_BYTES = GLYPH_FLOATS * 4;
/** The fewest glyph vertices the glyph atlas holds once a text needs it. */
const GLYPHS_LEAST = 1024;

/**
 * A target a layer is drawn into: a texture at least its rectangle's size,
 * with a stencil of its own for masks within it. Its rows run down, the
 * first the rectangle's top, as filters read them.
 */
interface Layer {
  framebuffer: WebGLFramebuffer;
  texture: WebGLTexture;
  /** Its stencil, made as it is first drawn into unmultisampled; filters' targets take none. */
  stencil: WebGLRenderbuffer | null;
  width: number;
  height: number;
  /** The frame it was last drawn into. */
  usedAt: number;
}

/**
 * Multisampled colour and depth-stencil a target is drawn into, its edges
 * covered by `samples` a pixel, then resolved into a texture to be read.
 */
interface Multisampled {
  framebuffer: WebGLFramebuffer;
  color: WebGLRenderbuffer;
  depthStencil: WebGLRenderbuffer;
  width: number;
  height: number;
  samples: number;
  /** The frame it was last drawn into. */
  usedAt: number;
}

/**
 * The most a multisampled target may take, colour and depth-stencil
 * together, 8 bytes a sample, as web's fittingSamples has for the Pixi
 * view's canvas.
 */
const MSAA_BYTES = 256 * 1024 * 1024;

/**
 * The samples a target of `width` by `height` takes for `samples`, a power
 * of two, as a driver rounds others for colour and depth-stencil alike
 * or not: halved till its buffers fit MSAA_BYTES, none (1) where two would
 * not. A layer goes so far, as one padded as far as a texture goes would
 * take gigabytes; the stage, as web's canvas, keeps 4 at least.
 */
function fittingSamples(width: number, height: number, samples: number, least = 1): number {
  let fitting = 1;
  while (fitting * 2 <= samples) {
    fitting *= 2;
  }

  const floor = Math.min(fitting, least);
  while (fitting > floor && width * height * fitting * 8 > MSAA_BYTES) {
    fitting /= 2;
  }

  return fitting;
}

/** The sizes a layer's texture is made in: rounded up to a multiple, so that one serves many. */
const LAYER_STEP = 128;
/**
 * The sizes a small layer's side is made in, under LAYER_STEP: a glow of a
 * few dozen pixels took a texture of 128 a side, and a crowd keeps
 * thousands of them as their filters' outputs.
 */
const SMALL_STEP = 16;
/**
 * The most the free layers and multisampled buffers may take between
 * frames, past which the least lately freed go as a frame ends; within a
 * frame its own working set may pass it.
 */
const FREE_BYTES = 128 * 1024 * 1024;

/** A side of a layer made for `n` pixels: rounded up to SMALL_STEP, past LAYER_STEP to that. */
function layerSide(n: number): number {
  return n <= LAYER_STEP
    ? Math.max(SMALL_STEP, Math.ceil(n / SMALL_STEP) * SMALL_STEP)
    : Math.ceil(n / LAYER_STEP) * LAYER_STEP;
}

/** The bytes multisampled buffers take: colour and depth-stencil, 8 a sample. */
function msaaBytes(msaa: { width: number; height: number; samples: number }): number {
  return msaa.width * msaa.height * msaa.samples * 8;
}

/** The bytes a layer takes: its colour, and its stencil where it has one. */
function layerBytes(layer: { width: number; height: number; stencil: unknown }): number {
  return layer.width * layer.height * (layer.stencil ? 8 : 4);
}
/** Frames a free layer is kept undrawn into before it is let go of. */
const LAYER_IDLE_FRAMES = 60;

/**
 * A target drawn into: its rectangle of the canvas, in pixels from the
 * top left, and the layer it is drawn into, or none for the canvas itself.
 */
interface Open {
  layer: Layer | null;
  /** What it is drawn into while it is multisampled, resolved before it is read. */
  msaa: Multisampled | null;
  x: number;
  y: number;
  width: number;
  height: number;
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
  private program!: WebGLProgram;
  private rowLocation: WebGLUniformLocation | null = null;
  private viewLocation: WebGLUniformLocation | null = null;
  private texturedLocation: WebGLUniformLocation | null = null;
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
   * which shares the index buffer, and the outlines' texture.
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
  private glyphCapacity = 0;
  private glyphTop = 0;
  private outlines: WebGLTexture | null = null;
  /** The outlines uploaded: of which epoch, how many segments, and the texture's rows. */
  private outlineEpoch = -1;
  private outlineCount = 0;
  private outlineRows = 0;
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
  /** Layers free to draw into, and those drawn into now, innermost last. */
  /** Layers free to draw into, by their size. */
  private freeLayers = new SizedPool<Layer>(layerBytes);
  private layers: Open[] = [];
  /** Frames executed, which a layer's idleness is counted in. */
  private frame = 0;
  /** The layers kept from frame to frame, by their ids in Keeps. */
  private kept: (Layer | null)[] = [];
  /**
   * Samples a pixel the stage and its layers are drawn with, 1 for none:
   * Flash's anti-aliasing by the quality, as the host sets it.
   */
  samples = 1;
  /**
   * The samples the layers of the frame drawing take: the stage's, which a
   * BitmapData's frame draws with none of.
   */
  private frameSamples = 1;
  /** The most samples the GPU takes, and whether the canvas has alpha, asked once. */
  private maxSamples = 1;
  private canvasAlpha = false;
  /** Multisampled buffers free to draw a layer into, kept while drawn into often enough. */
  private freeMsaa = new SizedPool<Multisampled>(msaaBytes);
  /**
   * The stage's multisampled buffers, and the texture they resolve into
   * before an opaque canvas.
   */
  private stageMsaa: Multisampled | null = null;
  private stageResolved: { framebuffer: WebGLFramebuffer; texture: WebGLTexture } | null = null;
  /** The layer a frame that clears the stage is drawn into before an opaque canvas (stageAlpha). */
  private stageLayer: Layer | null = null;
  /** The mask counts of the targets below the layers drawn into now, two numbers each. */
  private readonly below: number[] = [];
  /** A copy of what is below a layer whose mode reads it, the target's size. */
  private back: WebGLTexture | null = null;
  private backFramebuffer: WebGLFramebuffer | null = null;
  private backWidth = 0;
  private backHeight = 0;
  /** The row and texture the last draw was told, so neither is told again. */
  private lastRow = -1;
  private lastTexture = -2;
  /** The textures uploaded, by the registry's ids, and their sizes; the samplers made, by their bits. */
  private textures: (WebGLTexture | null)[] = [];
  private sizes: number[] = [];
  private samplers: (WebGLSampler | null)[] = [];
  private vertexArray!: WebGLVertexArrayObject;
  private vertexBuffer!: WebGLBuffer;
  private indexBuffer!: WebGLBuffer;
  private rowsTexture!: WebGLTexture;
  private rowLines = 0;
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
    this.repack(geometries);
  }

  /** Programs, buffers and textures made, as the context comes or comes back. */
  private setUp(): void {
    const gl = this.gl;
    this.state.forget();
    this.program = linkProgram(gl, fillVertex, fillFragment);
    this.rowLocation = gl.getUniformLocation(this.program, "uRow");
    this.viewLocation = gl.getUniformLocation(this.program, "uView");
    this.state.useProgram(this.program);
    gl.uniform1i(gl.getUniformLocation(this.program, "uRows"), 0);
    gl.uniform1i(gl.getUniformLocation(this.program, "uTexture"), TEXTURE_UNIT);
    this.texturedLocation = gl.getUniformLocation(this.program, "uTextured");
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
    this.outlines = null;
    this.outlineEpoch = -1;
    this.outlineCount = 0;
    this.outlineRows = 0;
    this.textures = [];
    this.samplers = [];
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
      take: (width, height) => this.takeLayer(width, height, true),
      give: (layer) => this.giveLayer(layer),
      texture: (id) => this.textures[id] ?? null,
      sampler: (bits) => this.sampler(bits),
    });
    this.freeLayers = new SizedPool<Layer>(layerBytes);
    this.layers = [];
    this.kept = [];
    this.stageMsaa = null;
    this.stageResolved = null;
    this.stageLayer = null;
    this.freeMsaa = new SizedPool<Multisampled>(msaaBytes);
    this.maxSamples = gl.getParameter(gl.MAX_SAMPLES) as number;
    this.canvasAlpha = gl.getContextAttributes()?.alpha ?? false;
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
    this.state.bindVertexArray(this.glyphArray);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.glyphBuffer);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer);
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

    this.glyphCapacity = 0;
    this.glyphTop = 0;
    this.rowsTexture = gl.createTexture() as WebGLTexture;
    this.state.bindTexture(0, this.rowsTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    this.rowLines = 0;
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
    this.uploadTextures(textures);
    for (const id of keeps.removed) {
      const layer = this.kept[id];
      if (layer) {
        this.giveLayer(layer);
        this.kept[id] = null;
      }
    }

    keeps.removed.length = 0;
    this.uploadRows(rows);
    const state = this.state;
    state.scissor(null);
    state.colorMask(15);
    state.useProgram(this.program);
    state.bindVertexArray(this.vertexArray);
    state.bindTexture(0, this.rowsTexture);
    // As many samples as the GPU takes; a BitmapData's frame supersamples instead, as Flash's draw
    // does. Its layers take the stage's, so that their edges are the stage's.
    const stage = root ? null : this.stageBuffers(target.width, target.height, this.samples);
    // An erase or alpha blend outside any layer clears what it covers on the stage, as adl does,
    // which the blends after it read: an opaque canvas keeps no alpha, so such a frame is drawn
    // into a layer the canvas' size, then copied onto it. Multisampled buffers keep it already.
    const cleared =
      !root && !stage && !this.canvasAlpha && commands.clearsTarget
        ? this.stageAlpha(target.width, target.height)
        : null;
    const into = root ?? cleared;
    if (into) {
      // Its own stencil, for the masks drawn into it.
      this.layerMsaa(into, 1);
    }

    this.frameSamples = stage?.samples ?? 1;
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
    this.lastTexture = -2;
    gl.uniform1i(this.texturedLocation, 0);
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
          const layer = this.takeLayer(width, height, filtered);
          const open: Open = {
            layer,
            msaa: this.layerMsaa(layer, this.frameSamples),
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
            this.resolve(open, open.layer.width, open.layer.height);
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
          this.resolve(open, open.width, open.height);
          const under = this.layers.at(-1) ?? canvas;
          this.drawInto(under, target);
          // Composited where the masks on the target below let it be.
          state.stencil(depth > 0 ? gl.EQUAL : null, depth, gl.KEEP);
          this.compositeLayer(open, under, ops[at + 1], ops[at + 2]);
          const keep = ops[at + 3];
          if (keep >= 0) {
            // Kept for the frames after, the output kept before given back.
            const before = this.kept[keep];
            if (before && before !== open.layer) {
              this.giveLayer(before);
            }

            this.kept[keep] = open.layer;
          } else {
            this.giveLayer(open.layer as Layer);
          }

          break;
        }

        case COMPOSITE: {
          const p = commands.params;
          const from = ops[at + 1];
          const layer = this.kept[p[from + 4]];
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
      this.present(canvas.msaa);
    }

    if (cleared) {
      // Its rows run down, the canvas' up.
      this.toCanvas(cleared.framebuffer, target.width, target.height, true);
    }

    if (counted) {
      this.dropIdleLayers();
      this.frame++;
    }
  }

  /**
   * A frame drawn into a layer `samples` times the size of a `width` by
   * `height` bitmap a side, as `execute` draws, then halved till a sample a
   * pixel, and read back: premultiplied RGBA bytes, a row at a time from
   * the top, as BitmapData.draw takes them, as the Pixi view's snapshot does.
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

    let layer = this.takeLayer(width * samples, height * samples);
    this.execute(commands, scene, rows, geometries, textures, filters, keeps, target, layer);
    for (let k = samples; k > 1; k /= 2) {
      const half = this.filters.halve(layer, (width * k) / 2, (height * k) / 2);
      this.giveLayer(layer);
      layer = half;
    }

    this.state.bindFramebuffer(layer.framebuffer);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
    this.giveLayer(layer);
    return bytes;
  }

  /** The free layers, and the stage's (stageAlpha), undrawn into for LAYER_IDLE_FRAMES let go of. */
  private dropIdleLayers(): void {
    const stage = this.stageLayer;
    if (stage && this.frame - stage.usedAt > LAYER_IDLE_FRAMES) {
      this.deleteLayer(stage);
      this.stageLayer = null;
    }

    this.freeLayers.trim(this.frame, LAYER_IDLE_FRAMES, FREE_BYTES - this.freeMsaa.bytes, (l) =>
      this.deleteLayer(l),
    );
    this.freeMsaa.trim(this.frame, LAYER_IDLE_FRAMES, FREE_BYTES - this.freeLayers.bytes, (m) =>
      this.deleteMultisampled(m),
    );
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
    state.bindFramebuffer(this.framebufferOf(open));
    state.viewport(0, 0, open.width, open.height);
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
    frag[0] = open.x - target.x;
    frag[1] = (open.layer ? open.y : open.y + open.height) - target.y;
    frag[2] = down;
    frag[3] = target.pixel;
    this.unit = target.scale / target.pixel;
    this.meshStale = true;
    this.glyphStale = true;
  }

  /** The framebuffer `open` is drawn into: its multisampled one while it has one, else its own. */
  private framebufferOf(open: Open): WebGLFramebuffer | null {
    return open.msaa?.framebuffer ?? open.layer?.framebuffer ?? null;
  }

  /**
   * `open`'s multisampled pixels resolved into its layer's texture, its
   * first `width` by `height`, once: what reads it after reads them.
   */
  private resolve(open: Open, width: number, height: number): void {
    const msaa = open.msaa;
    const layer = open.layer;
    if (!msaa || !layer) {
      return;
    }

    const gl = this.gl;
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, msaa.framebuffer);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, layer.framebuffer);
    gl.blitFramebuffer(0, 0, width, height, 0, 0, width, height, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    // Bound as the state cache has it.
    gl.bindFramebuffer(gl.FRAMEBUFFER, msaa.framebuffer);
    open.msaa = null;
    // Free for the next layer: only those drawn into now hold multisampled buffers.
    this.freeMsaa.give(msaa, this.frame, msaa.samples);
  }

  /**
   * The stage's multisampled pixels onto the canvas: resolved straight onto
   * one with alpha; into a texture first for an opaque one, as a resolve
   * must keep its format.
   */
  private present(msaa: Multisampled): void {
    const gl = this.gl;
    const { width, height } = msaa;
    const resolved = this.stageResolved;
    if (resolved) {
      this.state.bindFramebuffer(msaa.framebuffer);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, resolved.framebuffer);
      gl.blitFramebuffer(0, 0, width, height, 0, 0, width, height, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    }

    this.toCanvas(resolved?.framebuffer ?? msaa.framebuffer, width, height, false);
  }

  /**
   * The first `width` by `height` pixels of `source` copied onto the canvas,
   * upside down where `flip`. Bound through the state cache first and as
   * it was after, so the cache holds what is bound, whatever it held.
   */
  private toCanvas(source: WebGLFramebuffer, width: number, height: number, flip: boolean): void {
    const gl = this.gl;
    this.state.bindFramebuffer(source);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
    const top = flip ? 0 : height;
    gl.blitFramebuffer(
      0,
      0,
      width,
      height,
      0,
      height - top,
      width,
      top,
      gl.COLOR_BUFFER_BIT,
      gl.NEAREST,
    );
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, source);
  }

  /**
   * The layer the canvas' size a frame that clears the stage is drawn into
   * before an opaque canvas (execute): its own, kept apart from the free
   * layers so that none smaller takes it, made again for another size, let
   * go of once idle as they are.
   */
  private stageAlpha(width: number, height: number): Layer {
    const known = this.stageLayer;
    if (known && known.width === width && known.height === height) {
      known.usedAt = this.frame;
      return known;
    }

    if (known) {
      this.deleteLayer(known);
    }

    const layer = this.makeLayer(width, height);
    this.stageLayer = layer;
    return layer;
  }

  /**
   * The stage's multisampled buffers and their resolve, made again for
   * another size or samples; none where it takes no samples.
   */
  private stageBuffers(width: number, height: number, wanted: number): Multisampled | null {
    const gl = this.gl;
    const samples = fittingSamples(width, height, Math.min(wanted, this.maxSamples), 4);
    const known = this.stageMsaa;
    if (known && known.width === width && known.height === height && known.samples === samples) {
      return known;
    }

    this.dropStageBuffers();
    const msaa = samples > 1 ? this.multisampled(width, height, samples) : null;
    if (!msaa) {
      return null;
    }

    this.stageMsaa = msaa;
    if (this.canvasAlpha) {
      return msaa;
    }

    const texture = gl.createTexture() as WebGLTexture;
    this.state.bindTexture(LAYER_UNIT, texture);
    this.state.activeTexture(LAYER_UNIT);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    const framebuffer = gl.createFramebuffer() as WebGLFramebuffer;
    this.state.bindFramebuffer(framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    this.stageResolved = { framebuffer, texture };
    return msaa;
  }

  /** The stage's multisampled buffers and their resolve let go of, as samples or size change. */
  private dropStageBuffers(): void {
    const gl = this.gl;
    if (this.stageMsaa) {
      this.deleteMultisampled(this.stageMsaa);
      this.stageMsaa = null;
    }

    if (this.stageResolved) {
      this.state.dropTexture(this.stageResolved.texture);
      gl.deleteTexture(this.stageResolved.texture);
      gl.deleteFramebuffer(this.stageResolved.framebuffer);
      this.stageResolved = null;
    }
  }

  /**
   * Multisampled buffers to draw `layer` into at `wanted` samples, as many
   * as fit, free ones of its size or made; none where it takes none, its
   * own stencil then made if it has none.
   */
  private layerMsaa(layer: Layer, wanted: number): Multisampled | null {
    const samples = fittingSamples(layer.width, layer.height, wanted);
    const kept = samples > 1 ? this.freeMsaa.take(layer.width, layer.height, samples) : null;
    if (kept) {
      return kept;
    }

    const msaa = samples > 1 ? this.multisampled(layer.width, layer.height, samples) : null;
    if (!msaa && !layer.stencil) {
      const gl = this.gl;
      const stencil = gl.createRenderbuffer() as WebGLRenderbuffer;
      gl.bindRenderbuffer(gl.RENDERBUFFER, stencil);
      gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH24_STENCIL8, layer.width, layer.height);
      this.state.bindFramebuffer(layer.framebuffer);
      gl.framebufferRenderbuffer(
        gl.FRAMEBUFFER,
        gl.DEPTH_STENCIL_ATTACHMENT,
        gl.RENDERBUFFER,
        stencil,
      );
      layer.stencil = stencil;
    }

    return msaa;
  }

  /** Multisampled buffers, or none where the driver leaves their framebuffer incomplete. */
  private multisampled(width: number, height: number, samples: number): Multisampled | null {
    const gl = this.gl;
    const color = gl.createRenderbuffer() as WebGLRenderbuffer;
    gl.bindRenderbuffer(gl.RENDERBUFFER, color);
    gl.renderbufferStorageMultisample(gl.RENDERBUFFER, samples, gl.RGBA8, width, height);
    const depthStencil = gl.createRenderbuffer() as WebGLRenderbuffer;
    gl.bindRenderbuffer(gl.RENDERBUFFER, depthStencil);
    gl.renderbufferStorageMultisample(gl.RENDERBUFFER, samples, gl.DEPTH24_STENCIL8, width, height);
    const framebuffer = gl.createFramebuffer() as WebGLFramebuffer;
    this.state.bindFramebuffer(framebuffer);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, color);
    gl.framebufferRenderbuffer(
      gl.FRAMEBUFFER,
      gl.DEPTH_STENCIL_ATTACHMENT,
      gl.RENDERBUFFER,
      depthStencil,
    );
    const msaa = { framebuffer, color, depthStencil, width, height, samples, usedAt: this.frame };
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
      this.deleteMultisampled(msaa);
      return null;
    }

    return msaa;
  }

  private deleteMultisampled(msaa: Multisampled): void {
    this.gl.deleteFramebuffer(msaa.framebuffer);
    this.gl.deleteRenderbuffer(msaa.color);
    this.gl.deleteRenderbuffer(msaa.depthStencil);
  }

  /** The fill program, its vertex array and rows bound, as runs and masks draw with them. */
  private useFill(): void {
    this.state.useProgram(this.program);
    this.state.bindVertexArray(this.vertexArray);
    this.state.bindTexture(0, this.rowsTexture);
  }

  /**
   * A layer of at least `width` by `height`, the smallest of those free
   * that is, or one made, its sides rounded as layerSide rounds them;
   * `exact`, of just the rounded size, which filters take so that a frame's
   * targets are alike, and no larger than it needs.
   */
  private takeLayer(width: number, height: number, exact = false): Layer {
    width = layerSide(width);
    height = layerSide(height);
    // Found by its size, or the smallest size held that holds it.
    const found =
      this.freeLayers.take(width, height) ??
      (exact ? null : this.freeLayers.takeFitting(width, height));
    if (found) {
      found.usedAt = this.frame;
      return found;
    }

    return this.makeLayer(width, height);
  }

  /** A layer just `width` by `height`, made. */
  private makeLayer(width: number, height: number): Layer {
    const gl = this.gl;
    const texture = gl.createTexture() as WebGLTexture;
    this.state.bindTexture(LAYER_UNIT, texture);
    this.state.activeTexture(LAYER_UNIT);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    // Read texel by texel: with no mipmaps, the default filter would leave it incomplete, reading 0.
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    const framebuffer = gl.createFramebuffer() as WebGLFramebuffer;
    this.state.bindFramebuffer(framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    return { framebuffer, texture, stencil: null, width, height, usedAt: this.frame };
  }

  /** A layer free again, kept for the layers after it while it is drawn into often enough. */
  private giveLayer(layer: Layer): void {
    this.freeLayers.give(layer, this.frame);
  }

  private deleteLayer(layer: Layer): void {
    this.state.dropTexture(layer.texture);
    this.gl.deleteFramebuffer(layer.framebuffer);
    this.gl.deleteTexture(layer.texture);
    if (layer.stencil) {
      this.gl.deleteRenderbuffer(layer.stencil);
    }
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
    // Where the copy of what is below has the rectangle's corner, less where the target has it.
    let backX = 0;
    let backY = 0;
    if (!direct) {
      // Copied from its corner, or out of a multisampled target to where it lies, as a blit
      // resolving must keep its rectangle: then as large as the rectangle's far corner.
      const bx = under.msaa ? x0 : 0;
      const by = under.msaa ? y0 : 0;
      backX = x0 - bx;
      backY = y0 - by;
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
      // Out of a multisampled target the blit resolves the rectangle, as the Pixi fork's bounded
      // resolve does.
      const from = this.framebufferOf(under);
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
        x0,
        y0,
        x0 + width,
        y0 + height,
        bx,
        by,
        right,
        top,
        gl.COLOR_BUFFER_BIT,
        gl.NEAREST,
      );
      // Both bindings back as the state cache has them.
      gl.bindFramebuffer(gl.FRAMEBUFFER, from);
    }

    state.bindTexture(LAYER_UNIT, (open.layer as Layer).texture);
    state.bindSampler(LAYER_UNIT, null);
    state.bindSampler(BACK_UNIT, null);
    state.useProgram(this.composite);
    state.bindVertexArray(null);
    gl.uniform1i(this.modeLocation, mode);
    gl.uniform1i(this.compositeRowLocation, row);
    gl.uniform2i(this.offsetLocation, dx, flip ? under.height - 1 - dy : dy);
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
    state.scissor([x0, y0, width, height]);
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

      if (!stencil && scene.sampler[i] & MESH) {
        other = this.drawMesh(scene, i, place) || other;
        continue;
      }

      if (other) {
        this.useFill();
        other = false;
      }

      const row = scene.row[i];
      if (row !== this.lastRow) {
        this.lastRow = row;
        gl.uniform1i(this.rowLocation, row);
      }

      const id = stencil ? -1 : scene.texture[i];
      const texture = id >= 0 ? (this.textures[id] ?? null) : null;
      if (id >= 0 && !texture) {
        continue;
      }

      if (id >= 0 !== this.lastTexture >= 0) {
        gl.uniform1i(this.texturedLocation, id >= 0 ? 1 : 0);
      }

      this.lastTexture = id;
      if (texture) {
        state.bindTexture(TEXTURE_UNIT, texture);
        state.bindSampler(TEXTURE_UNIT, this.sampler(scene.sampler[i]));
      }

      gl.drawElements(gl.TRIANGLES, place.indices, gl.UNSIGNED_INT, place.indexStart * 4);
    }

    if (other) {
      this.useFill();
    }
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
    state.bindTexture(OUTLINE_UNIT, this.outlines);
    state.bindSampler(OUTLINE_UNIT, null);
    gl.drawElements(gl.TRIANGLES, place.indices, gl.UNSIGNED_INT, place.indexStart * 4);
  }

  /**
   * Advanced text's outlines (GeometryData.glyphs), `count` segments of four floats each
   * in `data`, as the player's store holds them: uploaded whole for another
   * `epoch` or a larger store, else the rows added since.
   */
  uploadOutlines(data: Float32Array, count: number, epoch: number): void {
    const gl = this.gl;
    if (gl.isContextLost() || count === 0) {
      return;
    }

    const rows = data.length / 4 / OUTLINE_ROW;
    let from = epoch === this.outlineEpoch ? this.outlineCount : 0;
    if (!this.outlines || rows !== this.outlineRows) {
      if (this.outlines) {
        this.state.dropTexture(this.outlines);
        gl.deleteTexture(this.outlines);
      }

      this.outlines = gl.createTexture() as WebGLTexture;
      this.state.bindTexture(OUTLINE_UNIT, this.outlines);
      this.state.activeTexture(OUTLINE_UNIT);
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA32F, OUTLINE_ROW, rows);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      this.outlineRows = rows;
      from = 0;
    }

    if (from < count) {
      const first = Math.floor(from / OUTLINE_ROW);
      const height = Math.ceil(count / OUTLINE_ROW) - first;
      this.state.bindTexture(OUTLINE_UNIT, this.outlines);
      this.state.activeTexture(OUTLINE_UNIT);
      gl.texSubImage2D(
        gl.TEXTURE_2D,
        0,
        0,
        first,
        OUTLINE_ROW,
        height,
        gl.RGBA,
        gl.FLOAT,
        data,
        first * OUTLINE_ROW * 4,
      );
    }

    this.outlineEpoch = epoch;
    this.outlineCount = count;
  }

  /**
   * Entry `i`, a mesh (MESH), drawn by the mesh program, which is told the
   * view as it changed, and its row and mode as they change; whether it
   * was drawn, the mesh program left in use.
   */
  private drawMesh(scene: SceneList, i: number, place: Place): boolean {
    const id = scene.texture[i];
    const texture = id >= 0 ? (this.textures[id] ?? null) : null;
    if (!texture) {
      return false;
    }

    const gl = this.gl;
    const state = this.state;
    state.useProgram(this.mesh);
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

    const mode = scene.sampler[i] & (REPEAT | SMOOTH);
    if (mode !== this.meshMode) {
      this.meshMode = mode;
      gl.uniform2i(this.meshModeLocation, mode & REPEAT ? 1 : 0, mode & SMOOTH ? 1 : 0);
    }

    state.bindTexture(TEXTURE_UNIT, texture);
    // Read texel by texel, but through a sampler without mipmaps, as a texture with none needs.
    state.bindSampler(TEXTURE_UNIT, this.sampler(CLAMP));
    gl.drawElements(gl.TRIANGLES, place.indices, gl.UNSIGNED_INT, place.indexStart * 4);
    return true;
  }

  /** The textures removed since the last frame deleted, and those added or changed uploaded, their pixels let go. */
  private uploadTextures(textures: Textures): void {
    const gl = this.gl;
    for (const id of textures.removed) {
      const texture = this.textures[id];
      if (texture) {
        this.state.dropTexture(texture);
        gl.deleteTexture(texture);
        this.textures[id] = null;
      }
    }

    textures.removed.length = 0;
    for (const id of textures.pending) {
      const data = textures.get(id);
      if (!data?.pixels) {
        continue;
      }

      let texture = this.textures[id];
      if (!texture) {
        texture = gl.createTexture() as WebGLTexture;
        this.textures[id] = texture;
        this.sizes[id * 2] = -1;
      }

      this.state.bindTexture(TEXTURE_UNIT, texture);
      this.state.activeTexture(TEXTURE_UNIT);
      // Pixels of the same size go into the texture there is; another size makes it again.
      if (this.sizes[id * 2] === data.width && this.sizes[id * 2 + 1] === data.height) {
        gl.texSubImage2D(
          gl.TEXTURE_2D,
          0,
          0,
          0,
          data.width,
          data.height,
          gl.RGBA,
          gl.UNSIGNED_BYTE,
          data.pixels,
        );
        data.pixels = null;
        continue;
      }

      this.sizes[id * 2] = data.width;
      this.sizes[id * 2 + 1] = data.height;
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA8,
        data.width,
        data.height,
        0,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        data.pixels,
      );
      data.pixels = null;
    }

    textures.pending.length = 0;
  }

  /** The sampler for `bits` (SMOOTH, and REPEAT or MIRROR), made as first asked for. */
  private sampler(bits: number): WebGLSampler {
    const known = this.samplers[bits];
    if (known) {
      return known;
    }

    const gl = this.gl;
    const sampler = gl.createSampler() as WebGLSampler;
    const filter = bits & SMOOTH ? gl.LINEAR : gl.NEAREST;
    const wrap = bits & REPEAT ? gl.REPEAT : bits & MIRROR ? gl.MIRRORED_REPEAT : gl.CLAMP_TO_EDGE;
    gl.samplerParameteri(sampler, gl.TEXTURE_MIN_FILTER, filter);
    gl.samplerParameteri(sampler, gl.TEXTURE_MAG_FILTER, filter);
    gl.samplerParameteri(sampler, gl.TEXTURE_WRAP_S, wrap);
    gl.samplerParameteri(sampler, gl.TEXTURE_WRAP_T, wrap);
    this.samplers[bits] = sampler;
    return sampler;
  }

  /** The rows a frame wrote, uploaded in one call, the texture made taller first if they need it. */
  private uploadRows(rows: Rows): void {
    const gl = this.gl;
    const lines = Math.max(1, Math.ceil(rows.count / ROWS_A_LINE));
    const width = ROWS_A_LINE * ROW_TEXELS;
    this.state.bindTexture(0, this.rowsTexture);
    this.state.activeTexture(0);
    if (lines > this.rowLines) {
      this.rowLines = Math.max(lines, this.rowLines * 2);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, width, this.rowLines, 0, gl.RGBA, gl.FLOAT, null);
    }

    if (rows.count > 0) {
      // Whole lines: the data holds ROW_FLOATS a row for as many rows as its lines hold.
      gl.texSubImage2D(
        gl.TEXTURE_2D,
        0,
        0,
        0,
        width,
        lines,
        gl.RGBA,
        gl.FLOAT,
        rows.data.subarray(0, lines * ROWS_A_LINE * ROW_FLOATS),
      );
    }
  }

  /**
   * The geometries removed since the last frame let go of, and those added
   * copied in: at the top while they fit, else into an atlas packed again,
   * grown to twice what is live.
   */
  private place(geometries: Geometries): void {
    for (const id of geometries.removed) {
      const place = this.places[id];
      if (place) {
        this.places[id] = null;
        this.live -= place.vertices;
        this.holes += place.vertices;
      }
    }

    geometries.removed.length = 0;
    let vertices = 0;
    let glyphs = 0;
    let indices = 0;
    for (const id of geometries.added) {
      const data = geometries.get(id);
      if (data?.glyphs) {
        glyphs += data.glyphs.vertices.length / GLYPH_FLOATS;
        indices += data.indices.length;
      } else if (data) {
        vertices += data.positions.length / 2;
        indices += data.indices.length;
      }
    }

    if (
      this.vertexTop + vertices > this.vertexCapacity ||
      this.glyphTop + glyphs > this.glyphCapacity ||
      this.indexTop + indices > this.indexCapacity ||
      (this.holes > SLACK && this.holes > this.live)
    ) {
      geometries.added.length = 0;
      this.repack(geometries);
      return;
    }

    for (const id of geometries.added) {
      const data = geometries.get(id);
      if (data) {
        this.copyIn(id, data);
      }
    }

    geometries.added.length = 0;
  }

  /** Every live geometry copied into new buffers, with room for twice what is live. */
  private repack(geometries: Geometries): void {
    const gl = this.gl;
    const ids = geometries.live();
    let vertices = 0;
    let glyphs = 0;
    let indices = 0;
    for (const id of ids) {
      const data = geometries.get(id) as GeometryData;
      if (data.glyphs) {
        glyphs += data.glyphs.vertices.length / GLYPH_FLOATS;
      } else {
        vertices += data.positions.length / 2;
      }

      indices += data.indices.length;
    }

    this.vertexCapacity = Math.max(LEAST, vertices * 2);
    this.indexCapacity = Math.max(LEAST * 3, indices * 2);
    this.state.bindVertexArray(this.vertexArray);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, this.vertexCapacity * VERTEX_BYTES, gl.STATIC_DRAW);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, this.indexCapacity * 4, gl.STATIC_DRAW);
    // The glyph atlas only once a text needs it.
    this.glyphCapacity = glyphs > 0 ? Math.max(GLYPHS_LEAST, glyphs * 2) : 0;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.glyphBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, this.glyphCapacity * GLYPH_BYTES, gl.STATIC_DRAW);
    this.glyphTop = 0;
    this.vertexTop = 0;
    this.indexTop = 0;
    this.live = 0;
    this.holes = 0;
    this.places = [];
    for (const id of ids) {
      this.copyIn(id, geometries.get(id) as GeometryData);
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

    const base = this.vertexTop;
    const indices = new Uint32Array(data.indices.length);
    for (let i = 0; i < indices.length; i++) {
      indices[i] = data.indices[i] + base;
    }

    this.state.bindVertexArray(this.vertexArray);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffer);
    gl.bufferSubData(gl.ARRAY_BUFFER, base * VERTEX_BYTES, floats);
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

  /** Glyph quads copied in at the top of the glyph atlas, their indices made absolute in it. */
  private copyGlyphs(id: number, data: GeometryData): void {
    const gl = this.gl;
    const glyphs = data.glyphs as NonNullable<GeometryData["glyphs"]>;
    const count = glyphs.vertices.length / GLYPH_FLOATS;
    const base = this.glyphTop;
    const indices = new Uint32Array(data.indices.length);
    for (let i = 0; i < indices.length; i++) {
      indices[i] = data.indices[i] + base;
    }

    this.state.bindVertexArray(this.glyphArray);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.glyphBuffer);
    gl.bufferSubData(gl.ARRAY_BUFFER, base * GLYPH_BYTES, glyphs.vertices);
    gl.bufferSubData(gl.ELEMENT_ARRAY_BUFFER, this.indexTop * 4, indices);
    this.places[id] = {
      vertexStart: base,
      vertices: count,
      indexStart: this.indexTop,
      indices: indices.length,
      glyphs: { mode: glyphs.mode, table: glyphs.table },
    };
    this.glyphTop += count;
    this.indexTop += indices.length;
    this.live += count;
  }

  /** What the backend made on the context, deleted. */
  destroy(): void {
    const gl = this.gl;
    gl.deleteProgram(this.program);
    gl.deleteVertexArray(this.vertexArray);
    gl.deleteBuffer(this.vertexBuffer);
    gl.deleteBuffer(this.indexBuffer);
    gl.deleteTexture(this.rowsTexture);
    gl.deleteProgram(this.composite);
    gl.deleteProgram(this.mesh);
    gl.deleteProgram(this.glyphProgram);
    gl.deleteVertexArray(this.glyphArray);
    gl.deleteBuffer(this.glyphBuffer);
    if (this.outlines) {
      gl.deleteTexture(this.outlines);
    }

    this.filters.destroy();
    this.freeLayers.clear((l) => this.deleteLayer(l));

    for (const open of this.layers) {
      if (open.layer) {
        this.deleteLayer(open.layer);
      }
    }

    for (const layer of this.kept) {
      if (layer) {
        this.deleteLayer(layer);
      }
    }

    if (this.back) {
      gl.deleteTexture(this.back);
      gl.deleteFramebuffer(this.backFramebuffer);
    }

    this.dropStageBuffers();
    if (this.stageLayer) {
      this.deleteLayer(this.stageLayer);
    }

    this.freeMsaa.clear((m) => this.deleteMultisampled(m));

    for (const texture of this.textures) {
      if (texture) {
        gl.deleteTexture(texture);
      }
    }

    for (const sampler of this.samplers) {
      if (sampler) {
        gl.deleteSampler(sampler);
      }
    }

    this.state.forget();
  }
}
