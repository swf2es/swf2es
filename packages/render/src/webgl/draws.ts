import { type GlState, linkProgram } from "@swf2es/context3d/device";
import { type Commands, RUN, STENCIL_POP, STENCIL_PUSH } from "../commands.js";
import { FILL_SHADER, type Filters } from "../filters.js";
import { fillKernel, kernelImagesFit } from "../kernel-shaders.js";
import {
  ADD,
  CLAMP,
  DRAW,
  MESH,
  MIRROR,
  PLANE,
  REPEAT,
  SCREEN,
  type SceneList,
  SHADED,
  SMOOTH,
  SNAP,
} from "../scene.js";
import type { GeometryAtlas, Place } from "./atlas.js";
import type { GpuTextures } from "./gpu-textures.js";
import type { KernelHost, KernelPrograms } from "./kernels.js";
import {
  BACK_UNIT,
  blendFillFragment,
  FILL_SLOT,
  FILL_TEXTURES,
  FILL_UNIT,
  fillFragment,
  fillVertex,
  glyphsFragment,
  glyphsVertex,
  meshFragment,
  meshVertex,
  OUTLINE_UNIT,
  RUN_MOST,
  RUN_UNIT,
  SNAP_BIT,
  TEXTURE_UNIT,
} from "./programs.js";
import { framebufferOf, type Open, type Target, type TargetPool } from "./targets.js";

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

/** Last scene entry, table start, draw count, used units, then each unit's texture and sampling. */
const RUN_STRIDE = 4 + FILL_TEXTURES * 2;

/** The most masks the stencil's eight bits count. */
const STENCIL_MOST = 255;

/**
 * The masks pushed on a target drawn into: what is drawn passes where its
 * stencil holds `depth` of them. Its eight bits hold STENCIL_MOST: those
 * pushed past that are left out, `past` of them, and their pops with them.
 */
export interface Masks {
  depth: number;
  past: number;
}

/**
 * The draws of a scene list's entries into the target bound: fills in runs,
 * one multi-draw of the atlas's index ranges a run where WEBGL_multi_draw
 * is, meshes and advanced text's glyphs each by a program of its own, and
 * the masks' coverage into the stencil; and the view of the target drawn
 * into, which each program is told.
 */
export class Draws {
  private readonly gl: WebGL2RenderingContext;
  private readonly state: GlState;
  private readonly atlas: GeometryAtlas;
  private readonly gpu: GpuTextures;
  private readonly pool: TargetPool;
  /** The fill program, and where it takes its row, view and Flash's pixels a stage pixel. */
  program!: WebGLProgram;
  private rowLocation: WebGLUniformLocation | null = null;
  private viewLocation: WebGLUniformLocation | null = null;
  private fillUnitLocation: WebGLUniformLocation | null = null;
  /**
   * The fill program that blends a fill straight onto what is below it
   * (drawBlended), a draw a call, and where it takes what the fill program
   * does and the blend's mode, its layer's row and where the copy of what
   * is below lies.
   */
  private blendProgram!: WebGLProgram;
  private blendRowLocation: WebGLUniformLocation | null = null;
  private blendViewLocation: WebGLUniformLocation | null = null;
  private blendUnitLocation: WebGLUniformLocation | null = null;
  private blendModeLocation: WebGLUniformLocation | null = null;
  private blendLayerRowLocation: WebGLUniformLocation | null = null;
  private blendBackLocation: WebGLUniformLocation | null = null;
  /** WEBGL_multi_draw, which draws a run of fills alike a call (drawEntries), where there is. */
  private multi: MultiDraw | null = null;
  /** Avoid the dynamically indexed uniform table used in the Intel GPU hang reproducer. */
  private runTable: WebGLTexture | null = null;
  private runBaseLocation: WebGLUniformLocation | null = null;
  private runTableHeight = 0;
  private runTableMost = 0;
  private tableRows = new Int32Array(RUN_MOST);
  private tableCounts = new Int32Array(RUN_MOST);
  private tableOffsets = new Int32Array(RUN_MOST);
  private runs = new Int32Array(RUN_STRIDE * 256);
  private commandStarts = new Uint32Array(256);
  private prepared = false;
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
   * pixels a stage pixel, mode and table; its vertices are in an atlas of their own.
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
  /**
   * The row a fill drawn alone (without WEBGL_multi_draw) last told the fill
   * program, so that it is not told again; -1 for none (forgetRow).
   */
  private lastRow = -1;

  /** Each shader fill's fragment shader by its entry in the frame's filters, for the generation it is of. */
  private readonly fillShaders = new Map<number, string | null>();
  /** A shader fill's program as it is linked: its rows' unit. */
  private readonly prepareFill = (program: WebGLProgram) => {
    this.gl.uniform1i(this.gl.getUniformLocation(program, "uRows"), 0);
  };
  private fillFilters: Filters | null = null;
  private fillGeneration = -1;

  constructor(
    gl: WebGL2RenderingContext,
    state: GlState,
    atlas: GeometryAtlas,
    gpu: GpuTextures,
    pool: TargetPool,
    /** Where shader fills find the frame's filters, whose chains their draws name (SHADED). */
    private readonly host: KernelHost & { filters(): Filters | null },
    /** Shader fills' programs, the backend's one cache of kernels'. */
    private readonly kernels: KernelPrograms,
  ) {
    this.gl = gl;
    this.state = state;
    this.atlas = atlas;
    this.gpu = gpu;
    this.pool = pool;
  }

  /** The fill, mesh and glyph programs made, as the context comes or comes back. */
  setUp(textureMost: number): void {
    const gl = this.gl;
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
    this.viewLocation = gl.getUniformLocation(this.program, "uView");
    this.state.useProgram(this.program);
    gl.uniform1i(gl.getUniformLocation(this.program, "uRows"), 0);
    gl.uniform1iv(
      gl.getUniformLocation(this.program, "uTextures"),
      Array.from({ length: FILL_TEXTURES }, (_, k) => FILL_UNIT + k),
    );
    this.runTable = null;
    this.runTableHeight = 0;
    this.runTableMost = textureMost;
    this.prepared = false;
    this.runBaseLocation = gl.getUniformLocation(this.program, "uRunBase");
    if (this.multi) {
      this.sizeRunTable(1);
      gl.uniform1i(gl.getUniformLocation(this.program, "uRunTable"), RUN_UNIT);
    }

    this.fillUnitLocation = gl.getUniformLocation(this.program, "uUnit");
    this.blendProgram = linkProgram(gl, fillVertex(false), blendFillFragment);
    this.blendRowLocation = gl.getUniformLocation(this.blendProgram, "uRow");
    this.blendViewLocation = gl.getUniformLocation(this.blendProgram, "uView");
    this.blendUnitLocation = gl.getUniformLocation(this.blendProgram, "uUnit");
    this.blendModeLocation = gl.getUniformLocation(this.blendProgram, "uMode");
    this.blendLayerRowLocation = gl.getUniformLocation(this.blendProgram, "uLayerRow");
    this.blendBackLocation = gl.getUniformLocation(this.blendProgram, "uBackOffset");
    this.state.useProgram(this.blendProgram);
    gl.uniform1i(gl.getUniformLocation(this.blendProgram, "uRows"), 0);
    gl.uniform1i(gl.getUniformLocation(this.blendProgram, "uBack"), BACK_UNIT);
    gl.uniform1iv(
      gl.getUniformLocation(this.blendProgram, "uTextures"),
      Array.from({ length: FILL_TEXTURES }, (_, k) => FILL_UNIT + k),
    );
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
    this.lastRow = -1;
  }

  /** Upload before any draws, so that updating a run cannot stall earlier draws reading it. */
  prepare(commands: Commands, scene: SceneList): void {
    this.prepared = false;
    if (!this.multi) {
      return;
    }

    if (commands.length > this.commandStarts.length) {
      this.commandStarts = new Uint32Array(commands.ops.length / 4);
    }

    let count = 0;
    let run = 0;
    const ops = commands.ops;
    for (let k = 0; k < commands.length; k++) {
      const at = k * 4;
      const op = ops[at];
      if (op !== RUN && op !== STENCIL_PUSH && op !== STENCIL_POP) {
        continue;
      }

      const stencil = op !== RUN;
      const end = ops[at + 1] + ops[at + 2];
      this.commandStarts[k] = run;
      // Held layers execute in a different order. Save each run's bindings independently
      // of the commands executed before it.
      this.unitIds.fill(-1);
      this.unitNext = 0;
      for (let i = ops[at + 1]; i < end; i++) {
        if (scene.kind[i] !== DRAW) {
          continue;
        }

        const place = this.atlas.places[scene.geometry[i]];
        if (!place || place.glyphs || (!stencil && scene.sampler[i] & (MESH | PLANE | SHADED))) {
          continue;
        }

        i = this.gatherRun(scene, i, end, stencil);
        const needed = count + this.runCount;
        if (needed > RUN_MOST * this.runTableMost) {
          // An unusually large frame still draws by updating the first row a run at a time.
          return;
        }

        if (needed > this.tableRows.length) {
          const size = Math.min(
            RUN_MOST * this.runTableMost,
            Math.max(needed, this.tableRows.length * 2),
          );
          const rows = new Int32Array(size);
          rows.set(this.tableRows);
          this.tableRows = rows;
          const counts = new Int32Array(size);
          counts.set(this.tableCounts);
          this.tableCounts = counts;
          const offsets = new Int32Array(size);
          offsets.set(this.tableOffsets);
          this.tableOffsets = offsets;
        }

        if (run + RUN_STRIDE > this.runs.length) {
          const runs = new Int32Array(this.runs.length * 2);
          runs.set(this.runs);
          this.runs = runs;
        }

        this.runs[run] = i;
        this.runs[run + 1] = count;
        this.runs[run + 2] = this.runCount;
        this.runs[run + 3] = this.runUnits;
        for (let j = 0; j < FILL_TEXTURES; j++) {
          if (this.runUnits & (1 << j)) {
            this.runs[run + 4 + j * 2] = this.unitIds[j];
            this.runs[run + 5 + j * 2] = this.unitSampling[j];
          }
        }

        run += RUN_STRIDE;
        for (let j = 0; j < this.runCount; j++) {
          this.tableRows[count] = this.runRows[j];
          this.tableCounts[count] = this.runCounts[j];
          this.tableOffsets[count++] = this.runOffsets[j];
        }
      }
    }

    const height = Math.ceil(count / RUN_MOST);
    if (height > 0) {
      this.sizeRunTable(height);
      const gl = this.gl;
      this.state.bindTexture(RUN_UNIT, this.runTable);
      this.state.activeTexture(RUN_UNIT);
      gl.texSubImage2D(
        gl.TEXTURE_2D,
        0,
        0,
        0,
        RUN_MOST,
        height,
        gl.RED_INTEGER,
        gl.INT,
        this.tableRows,
      );
    }

    this.prepared = true;
  }

  private sizeRunTable(height: number): void {
    if (height <= this.runTableHeight) {
      return;
    }

    const gl = this.gl;
    if (this.runTable) {
      this.state.dropTexture(this.runTable);
      gl.deleteTexture(this.runTable);
    }

    this.runTableHeight = Math.min(this.runTableMost, Math.max(height, this.runTableHeight * 2));
    this.runTable = gl.createTexture();
    this.state.bindTexture(RUN_UNIT, this.runTable);
    this.state.activeTexture(RUN_UNIT);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.R32I, RUN_MOST, this.runTableHeight);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  }

  /**
   * Draw into `open` from here on: its framebuffer bound, its viewport its
   * rectangle's size, and the stage placed on it as on the canvas, its
   * rectangle's corner the origin, its rows running up on the canvas and
   * down in a layer. The fill program takes the view.
   */
  drawInto(open: Open, target: Target): void {
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

  /** The row the fill program was told forgotten, so that the next fill tells it again. */
  forgetRow(): void {
    this.lastRow = -1;
  }

  /** The fill program, its vertex array and rows bound, as runs and masks draw with them. */
  useFill(): void {
    this.state.useProgram(this.program);
    this.state.bindVertexArray(this.atlas.vertexArray);
    this.state.bindTexture(0, this.gpu.rowsTexture);
  }

  /** Entries `first` up to `end` drawn as fills, where the masks pushed pass. */
  drawRun(scene: SceneList, first: number, end: number, command: number): void {
    const gl = this.gl;
    // Premultiplied, as every blend mode will be.
    this.useFill();
    this.state.setBlend(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    this.drawEntries(scene, first, end, false, command);
  }

  /**
   * Whether entry `i` is a flat fill (GeometryData.flat), a bitmap's quad or
   * one fill of a shape, of no mesh, shader fill or text, whose texture, if
   * it samples one, is there. Drawn straight onto what is below in a blend
   * mode, it is as its layer would be composited, as no part of it is over
   * another.
   */
  blendable(scene: SceneList, i: number): boolean {
    if (scene.kind[i] !== DRAW || scene.sampler[i] & (MESH | PLANE | SHADED)) {
      return false;
    }

    const place = this.atlas.places[scene.geometry[i]];
    const id = scene.texture[i];
    return !!place && place.flat && !place.glyphs && (id < 0 || !!this.gpu.textures[id]);
  }

  /**
   * Entry `i`, blendable, drawn onto the target bound in blend mode `mode`,
   * coloured by its layer's row `layerRow` (or -1), where the masks pushed
   * pass: GL's blending computing add and screen, the program the rest
   * from the copy of what is below (Compositor.copyBelow), whose texel at a
   * fragment is (`backX`, `backY`) short of it.
   */
  drawBlended(
    scene: SceneList,
    i: number,
    mode: number,
    layerRow: number,
    backX: number,
    backY: number,
  ): void {
    const gl = this.gl;
    const state = this.state;
    state.useProgram(this.blendProgram);
    state.bindVertexArray(this.atlas.vertexArray);
    state.bindTexture(0, this.gpu.rowsTexture);
    gl.uniform4fv(this.blendViewLocation, this.view);
    gl.uniform1f(this.blendUnitLocation, this.unit);
    gl.uniform1i(this.blendModeLocation, mode);
    gl.uniform1i(this.blendLayerRowLocation, layerRow);
    gl.uniform2i(this.blendBackLocation, backX, backY);
    this.gatherRun(scene, i, i + 1, false);
    if (this.runCount === 0) {
      return;
    }

    for (let k = 0; k < FILL_TEXTURES; k++) {
      if (this.runUnits & (1 << k)) {
        state.bindTexture(FILL_UNIT + k, this.gpu.textures[this.unitIds[k]] as WebGLTexture);
        state.bindSampler(FILL_UNIT + k, this.gpu.sampler(this.unitSampling[k]));
      }
    }

    gl.uniform1i(this.blendRowLocation, this.runRows[0]);
    switch (mode) {
      case ADD:
        state.setBlend(gl.ONE, gl.ONE);
        break;
      case SCREEN:
        state.setBlend(gl.ONE, gl.ONE_MINUS_SRC_COLOR);
        break;
      default:
        state.setBlend(null);
    }

    gl.drawElements(gl.TRIANGLES, this.runCounts[0], gl.UNSIGNED_INT, this.runOffsets[0]);
  }

  /**
   * Entries `first` up to `end`, a mask, pushed onto `masks` (STENCIL_PUSH)
   * or popped off them (STENCIL_POP), left out past STENCIL_MOST: its
   * coverage, once a pixel however its fills overlap, counted up into the
   * stencil where the masks pushed before it pass, and back down where it
   * and they did.
   */
  drawMask(
    scene: SceneList,
    first: number,
    end: number,
    push: boolean,
    masks: Masks,
    command: number,
  ): void {
    if (push ? masks.depth >= STENCIL_MOST || masks.past > 0 : masks.past > 0) {
      masks.past += push ? 1 : -1;
      return;
    }

    const gl = this.gl;
    const state = this.state;
    this.useFill();
    state.colorMask(0);
    state.stencil(gl.EQUAL, masks.depth, push ? gl.INCR : gl.DECR);
    this.drawEntries(scene, first, end, true, command);
    masks.depth += push ? 1 : -1;
    state.colorMask(15);
    this.maskBy(masks);
  }

  /** What is drawn from here on kept to where `masks` pass, by the stencil. */
  maskBy(masks: Masks): void {
    const gl = this.gl;
    this.state.stencil(masks.depth > 0 ? gl.EQUAL : null, masks.depth, gl.KEEP);
  }

  /** The draws at `scene`'s entries from `first` up to `end`; for the stencil alone, untextured. */
  drawEntries(
    scene: SceneList,
    first: number,
    end: number,
    stencil: boolean,
    command: number,
  ): void {
    const gl = this.gl;
    const state = this.state;
    const places = this.atlas.places;
    let run = this.prepared ? this.commandStarts[command] : 0;

    // Whether the mesh or the glyph program is in use, till the next entry of neither.
    let other = false;
    for (let i = first; i < end; i++) {
      if (scene.kind[i] !== DRAW) {
        continue;
      }

      const place = places[scene.geometry[i]];
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

      if (!stencil && scene.sampler[i] & SHADED) {
        other = this.drawShaded(scene, i, place) || other;
        continue;
      }

      if (other) {
        this.useFill();
        other = false;
      }

      let base = 0;
      let draws: number;
      let units: number;
      const bindings = run + 4;
      if (this.prepared) {
        i = this.runs[run];
        base = this.runs[run + 1];
        draws = this.runs[run + 2];
        units = this.runs[run + 3];
        run += RUN_STRIDE;
      } else {
        i = this.gatherRun(scene, i, end, stencil);
        draws = this.runCount;
        units = this.runUnits;
      }

      if (draws === 0) {
        continue;
      }

      for (let k = 0; k < FILL_TEXTURES; k++) {
        if (units & (1 << k)) {
          const id = this.prepared ? this.runs[bindings + k * 2] : this.unitIds[k];
          const sampling = this.prepared ? this.runs[bindings + k * 2 + 1] : this.unitSampling[k];
          state.bindTexture(FILL_UNIT + k, this.gpu.textures[id] as WebGLTexture);
          state.bindSampler(FILL_UNIT + k, this.gpu.sampler(sampling));
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

      state.bindTexture(RUN_UNIT, this.runTable);
      state.bindSampler(RUN_UNIT, null);
      if (!this.prepared) {
        state.activeTexture(RUN_UNIT);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, draws, 1, gl.RED_INTEGER, gl.INT, this.runRows);
      }

      gl.uniform1i(this.runBaseLocation, base);
      this.multi.multiDrawElementsWEBGL(
        gl.TRIANGLES,
        this.prepared ? this.tableCounts : this.runCounts,
        base,
        gl.UNSIGNED_INT,
        this.prepared ? this.tableOffsets : this.runOffsets,
        base,
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
    const places = this.atlas.places;
    const textures = this.gpu.textures;
    const most = this.multi ? RUN_MOST : 1;
    let draws = 0;
    let last = i;
    this.runUnits = 0;

    for (let j = i; j < end && draws < most; j++) {
      if (scene.kind[j] !== DRAW) {
        continue;
      }

      const place = places[scene.geometry[j]];
      if (!place) {
        continue;
      }

      if (place.glyphs || (!stencil && scene.sampler[j] & (MESH | PLANE | SHADED))) {
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
    state.bindVertexArray(this.atlas.glyphArray);
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
          ? (this.pool.keptLayer(id)?.texture ?? null)
          : (this.gpu.textures[id] ?? null);
    if (!texture) {
      return false;
    }

    const gl = this.gl;
    const state = this.state;
    state.useProgram(this.mesh);
    // The atlas' vertices, which a glyph draw before may have left bound for its own.
    state.bindVertexArray(this.atlas.vertexArray);
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
   * Entry `i`, a shader fill (SHADED), drawn by its kernel's program, after
   * the mesh's vertex shader, told the view, its row and its kernel's
   * uniforms; whether it was drawn, its program left in use.
   */
  private drawShaded(scene: SceneList, i: number, place: Place): boolean {
    const filters = this.host.filters();
    const chain = scene.texture[i];
    if (!filters || chain < 0 || chain >= filters.chainCount) {
      return false;
    }

    // A kernel the GPU will not link, of more images than a program binds, or with an image
    // gone, fills nothing. Its shader is found once a frame for its entry; its program is the
    // cache's, linked again where another took its place.
    const entry = filters.chains[chain];
    const fragment = this.fillShader(filters, entry);
    const kernel = fragment ? this.kernels.use(meshVertex, fragment, this.prepareFill) : null;
    if (!kernel) {
      return false;
    }

    const gl = this.gl;
    this.state.bindVertexArray(this.atlas.vertexArray);
    gl.uniform4fv(kernel.at("uView"), this.view);
    gl.uniform4fv(kernel.at("uFrag"), this.frag);
    gl.uniform1i(kernel.at("uRow"), scene.row[i]);
    this.kernels.setUniforms(kernel, filters, entry, this.host);
    // The mesh program is told its uniforms again after another program drew.
    this.meshStale = true;
    this.meshRow = -1;
    this.meshMode = -1;
    gl.drawElements(gl.TRIANGLES, place.indices, gl.UNSIGNED_INT, place.indexStart * 4);
    return true;
  }

  /** The fragment shader of the shader fill at entry `i` of `filters`, made once a frame; null for none. */
  private fillShader(filters: Filters, i: number): string | null {
    if (this.fillFilters !== filters || this.fillGeneration !== filters.generation) {
      this.fillShaders.clear();
      this.fillFilters = filters;
      this.fillGeneration = filters.generation;
    }

    let fragment = this.fillShaders.get(i);
    if (fragment === undefined) {
      const source = filters.kernels[i];
      const images =
        source && filters.kind[i] === FILL_SHADER
          ? this.kernels.readImages(filters, i, this.host)
          : null;
      fragment = source && images && kernelImagesFit(images) ? fillKernel(source, images) : null;
      this.fillShaders.set(i, fragment);
    }

    return fragment;
  }

  /** The programs and draw table made on the context, deleted. */
  destroy(): void {
    if (this.runTable) {
      this.state.dropTexture(this.runTable);
      this.gl.deleteTexture(this.runTable);
      this.runTable = null;
    }

    const gl = this.gl;
    gl.deleteProgram(this.program);
    gl.deleteProgram(this.mesh);
    gl.deleteProgram(this.glyphProgram);
  }
}
