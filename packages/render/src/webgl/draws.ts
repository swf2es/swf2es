import { type GlState, linkProgram } from "@swf2es/context3d/device";
import {
  CLAMP,
  DRAW,
  MESH,
  MIRROR,
  PLANE,
  REPEAT,
  type SceneList,
  SMOOTH,
  SNAP,
} from "../scene.js";
import type { GeometryAtlas, Place } from "./atlas.js";
import type { Target } from "./backend.js";
import {
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
  SNAP_BIT,
  TEXTURE_UNIT,
} from "./programs.js";
import { framebufferOf, type Open, type Targets } from "./targets.js";
import type { GpuTextures } from "./textures.js";

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

/** The most masks the stencil's eight bits count. */
export const STENCIL_MOST = 255;

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
  private readonly targets: Targets;
  /** The fill program, and where it takes its row, view and Flash's pixels a stage pixel. */
  program!: WebGLProgram;
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
  /** The row and texture the last draw was told, so neither is told again. */
  lastRow = -1;

  constructor(
    gl: WebGL2RenderingContext,
    state: GlState,
    atlas: GeometryAtlas,
    gpu: GpuTextures,
    targets: Targets,
  ) {
    this.gl = gl;
    this.state = state;
    this.atlas = atlas;
    this.gpu = gpu;
    this.targets = targets;
  }

  /** The fill, mesh and glyph programs made, as the context comes or comes back. */
  setUp(): void {
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

  /** The fill program, its vertex array and rows bound, as runs and masks draw with them. */
  useFill(): void {
    this.state.useProgram(this.program);
    this.state.bindVertexArray(this.atlas.vertexArray);
    this.state.bindTexture(0, this.gpu.rowsTexture);
  }

  /** The draws at `scene`'s entries from `first` up to `end`; for the stencil alone, untextured. */
  drawEntries(scene: SceneList, first: number, end: number, stencil: boolean): void {
    const gl = this.gl;
    const state = this.state;
    const places = this.atlas.places;
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
          ? (this.targets.kept[id]?.texture ?? null)
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

  /** The programs made on the context, deleted. */
  destroy(): void {
    const gl = this.gl;
    gl.deleteProgram(this.program);
    gl.deleteProgram(this.mesh);
    gl.deleteProgram(this.glyphProgram);
  }
}
