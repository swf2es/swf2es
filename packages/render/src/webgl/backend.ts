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
import type { Filters } from "../filters.js";
import type { Geometries } from "../geometry.js";
import type { Keeps } from "../keeps.js";
import type { Rows } from "../rows.js";
import { blendsDirect, NORMAL, type SceneList } from "../scene.js";
import type { Textures } from "../textures.js";
import { GeometryAtlas } from "./atlas.js";
import { Compositor, readsBelow } from "./composite.js";
import { Draws, type Masks } from "./draws.js";
import { FilterRunner } from "./filters.js";
import { GpuTextures } from "./gpu-textures.js";
import { HeldLayers } from "./holds.js";
import { KernelPrograms } from "./kernels.js";
import { LinkLosses } from "./losses.js";
import { ProgramQueue } from "./precompile.js";
import { LAYER_UNIT, TEXTURE_UNIT } from "./programs.js";
import { Stage } from "./stage.js";
import { type Layer, type Open, objectOf, type Target, TargetPool } from "./targets.js";

export type { Target } from "./targets.js";

/**
 * Executes a frame's commands on a WebGL 2 context it owns, through one
 * cache of its state. Every geometry is copied once into an atlas of a
 * vertex and an index buffer, and drawn from it a call an entry, the
 * buffers bound once and the entry told its row; rows go up once a frame
 * into a float texture. A geometry let go of leaves a hole, and the atlas
 * is packed again from the geometries' own arrays once the holes outweigh
 * what is live. Its parts, which it owns and makes again with the context:
 * the geometry atlas (atlas.ts), the textures and rows (gpu-textures.ts),
 * the entries' draws (draws.ts), the render targets (targets.ts), the held
 * layers (holds.ts), the composites (composite.ts) and the stage's way onto
 * the canvas (stage.ts).
 */
/** compositeOver's program and its uniforms. */
interface OverProgram {
  program: WebGLProgram;
  at: WebGLUniformLocation | null;
  opaque: WebGLUniformLocation | null;
}

/** A triangle over the viewport, of no attributes. */
const OVER_VERTEX = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

/** Flash's source over on whole bytes (WebGLBackend.compositeOver), both textures read at the pixel's own texel. */
const OVER_FRAGMENT = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D uSource;
uniform sampler2D uBelow;
uniform ivec2 uAt;
uniform bool uOpaque;
out vec4 finalColor;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy) - uAt;
  ivec4 s = ivec4(round(texelFetch(uSource, p, 0) * 255.0));
  ivec4 d = ivec4(round(texelFetch(uBelow, p, 0) * 255.0));
  ivec4 o = s.a == 255 ? s : s.a == 0 ? d : min(ivec4(255), s + ((d * (256 - s.a)) >> 8));
  if (uOpaque) {
    o.a = 255;
  }

  finalColor = vec4(o) / 255.0;
}`;

export class WebGLBackend {
  readonly gl: WebGL2RenderingContext;
  readonly state: GlState;
  private readonly pool: TargetPool;
  private readonly stage: Stage;
  private readonly gpu: GpuTextures;
  private readonly atlas: GeometryAtlas;
  private readonly compositor: Compositor;
  private readonly draws: Draws;
  private readonly holds: HeldLayers;
  /** Pixel Bender kernels' programs, which the filters, the compositor and the draws share. */
  private readonly kernels: KernelPrograms;
  /** The filters' passes, their programs linked ahead (programs). */
  private filters!: FilterRunner<Layer>;
  /** Programs linked and warmed over the frames after the first, ahead of their first use. */
  private programs!: ProgramQueue;
  /** The layers drawn into now, innermost last. */
  private layers: Open[] = [];
  /** The frame's filters being drawn, whose chains blend shaders' modes name (KERNEL). */
  private frameFilters: Filters | null = null;
  /**
   * Samples a pixel the stage and its layers are drawn with, 1 for none:
   * Flash's anti-aliasing by the quality, as the host sets it.
   */
  samples = 1;
  /** The masks pushed on the target drawn into now (execute). */
  private readonly masks: Masks = { depth: 0, past: 0 };
  /** A layer's rectangle, as blendDirect reads it. */
  private readonly rect = { x: 0, y: 0, width: 0, height: 0 };
  /** The mask counts of the targets below the layers drawn into now, two numbers each. */
  private readonly below: number[] = [];
  /** The program `compositeOver` draws with, linked ahead (programs); null till then and after a lost context. */
  private overProgram: OverProgram | null = null;
  /** Framebuffers onto registry textures, drawn into or read, by texture id, with the texture they were made for. */
  private textureFramebuffers: ({ texture: WebGLTexture; framebuffer: WebGLFramebuffer } | null)[] =
    [];
  /** Which failed links are a lost context's (gaveUp, and the kernels'). */
  private readonly losses: LinkLosses;
  /** Whether what the context holds is made (setUp): not after it was lost, till it is back. */
  private made = false;
  /** Whether frames draw: made, and no work given up on since (gaveUp). */
  private ready = false;
  /** The failure work was last given up on for, the context not flagged lost (resume). */
  private fault: unknown = null;

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    this.state = new GlState(gl);
    this.losses = new LinkLosses(gl);
    this.kernels = new KernelPrograms(gl, this.state, this.losses);
    this.pool = new TargetPool(gl, this.state);
    this.stage = new Stage(gl, this.state, this.pool);
    this.gpu = new GpuTextures(gl, this.state);
    this.atlas = new GeometryAtlas(gl, this.state);
    this.compositor = new Compositor(
      gl,
      this.state,
      {
        filters: () => this.frameFilters,
        texture: (id) => this.gpu.textures[id] ?? null,
        sampler: (bits) => this.gpu.sampler(bits),
      },
      this.kernels,
    );
    this.draws = new Draws(
      gl,
      this.state,
      this.atlas,
      this.gpu,
      this.pool,
      {
        filters: () => this.frameFilters,
        texture: (id) => this.gpu.textures[id] ?? null,
        sampler: (bits) => this.gpu.sampler(bits),
      },
      this.kernels,
    );
    this.holds = new HeldLayers(gl, this.state, this.pool, this.draws, this.compositor, this.gpu);
    // A context lost already gives up here, and is made again once it is restored.
    try {
      this.setUp();
      this.made = this.ready = true;
    } catch (e) {
      this.gaveUp(e);
    }
  }

  /**
   * Whether frames wait (resume): the context was lost and is not back
   * yet, or work was given up on as lost before the browser said so.
   */
  get stale(): boolean {
    return !this.ready;
  }

  /**
   * Whether a stale backend draws again, the context not flagged lost: not
   * while a failure that said nothing may yet be a loss Chrome has not
   * flagged (LinkLosses); after that, it was the shaders' fault, and frames
   * draw on as before the failure, linking again what failed, which then
   * throws. Nothing is made again on a live context, whose objects are
   * all there, a BitmapData's newest pixels among them. Throws that
   * failure where the setUp it came from never finished.
   */
  resume(): boolean {
    if (this.ready) {
      return true;
    }

    if (this.gl.isContextLost() || !this.losses.expired) {
      return false;
    }

    if (!this.made) {
      throw this.fault;
    }

    this.losses.concede();
    this.ready = true;
    return true;
  }

  /** Whether frames draw: the context there, and what it holds made. */
  private get usable(): boolean {
    return this.ready && !this.gl.isContextLost();
  }

  /**
   * Whether what the context holds may be drawn into and read: made, and
   * not lost. Not stopped by a frame given up on as lost (stale): a
   * BitmapData's texture, whose pixels may be newer than its store's, is
   * read, filled and drawn into meanwhile as ever, unless that needs a
   * program that fails.
   */
  private get live(): boolean {
    return this.made && !this.gl.isContextLost();
  }

  /**
   * The context came back after it was lost: everything made again, every
   * geometry copied in again from the registry's arrays. The textures were
   * lost with it, which their owners add again (Textures.lost). Lost again
   * meanwhile, it stays stale, for the next restore.
   */
  restore(geometries: Geometries): void {
    this.losses.clear();
    this.made = this.ready = false;
    geometries.added.length = 0;
    geometries.removed.length = 0;
    geometries.updated.length = 0;
    if (this.gl.isContextLost()) {
      return;
    }

    try {
      this.setUp();
      this.atlas.repack(geometries);
      this.atlas.repackGlyphs(geometries);
      this.made = this.ready = true;
    } catch (e) {
      this.gaveUp(e);
    }
  }

  /**
   * Work that threw `e` given up on, where a program would not be made as
   * the context was lost (LinkLosses): frames wait (stale) till it is
   * restored, or till the failure turns out the shaders' (resume), with
   * nothing thrown. Anything else is thrown on.
   */
  private gaveUp(e: unknown): void {
    if (!this.losses.lost(e)) {
      throw e;
    }

    this.ready = false;
    this.fault = e;
  }

  /** Programs, buffers and textures made, as the context comes or comes back. */
  private setUp(): void {
    const gl = this.gl;
    this.state.forget();
    // WebGL takes a flat varying from a triangle's last vertex, Metal from its first. Where
    // they differ, Safari's ANGLE rewrites the indices of every indexed draw from a program
    // with flat varyings, as all of these have, into buffers of its own: thousands a frame
    // from one atlas, charged to the page's process, which iOS then kills. Every flat value
    // here is the same at a triangle's three corners (a draw's row, a glyph's quad), so with
    // the first vertex provoking nothing drawn changes, and nothing is rewritten.
    const provoking = gl.getExtension("WEBGL_provoking_vertex") as {
      provokingVertexWEBGL(mode: number): void;
      readonly FIRST_VERTEX_CONVENTION_WEBGL: number;
    } | null;
    provoking?.provokingVertexWEBGL(provoking.FIRST_VERTEX_CONVENTION_WEBGL);
    // Kernels' programs made again as first used, the context's own gone with it.
    this.kernels.clear();
    const textureMost = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
    // A lost context's programs went with it: all queued again.
    this.programs = new ProgramQueue(gl, this.state);
    this.overProgram = null;
    this.programs.add("over", OVER_VERTEX, OVER_FRAGMENT, [TEXTURE_UNIT, LAYER_UNIT], (program) =>
      this.overMade(program),
    );
    this.filters = new FilterRunner(
      gl,
      this.state,
      {
        take: (width, height) => this.pool.takeLayer(width, height, true),
        give: (layer) => this.pool.giveLayer(layer),
        texture: (id) => this.gpu.textures[id] ?? null,
        sampler: (bits) => this.gpu.sampler(bits),
      },
      this.kernels,
      this.programs,
    );
    this.holds.setUp(this.filters, textureMost);
    this.pool.setUp();
    this.layers = [];
    this.stage.setUp();
    this.atlas.setUp();
    this.gpu.setUp();
    // The context's own, gone with it.
    this.textureFramebuffers = [];
    // Linked last: a context lost meanwhile throws here (gaveUp), the rest made, for destroy.
    this.draws.setUp(textureMost);
    this.compositor.setUp();
  }

  /**
   * Draw a frame: what the geometries added and removed first, then the
   * rows, then the commands, onto the canvas. Nothing while the context is
   * lost; a frame the context is lost in midway is given up on (gaveUp).
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
  ): void {
    if (!this.usable) {
      return;
    }

    try {
      this.run(commands, scene, rows, geometries, textures, filters, keeps, target, null);
      this.losses.endFrame();
    } catch (e) {
      this.gaveUp(e);
    }
  }

  /**
   * A frame drawn as `execute` draws it, onto the canvas or into `root`, a
   * layer the target's size, as BitmapData.draw's frames go.
   */
  private run(
    commands: Commands,
    scene: SceneList,
    rows: Rows,
    geometries: Geometries,
    textures: Textures,
    filters: Filters,
    keeps: Keeps,
    target: Target,
    root: Layer | null,
  ): void {
    // A frame drawn into a layer, for BitmapData, is no frame of the canvas': idle layers are
    // counted in the canvas' frames.
    const counted = root === null;
    // Once the first frame is drawn, the programs not drawn with yet are made, a frame's share,
    // before this frame draws anything: Chrome clears a canvas it composited at the first draw
    // call after, into whatever framebuffer, and the stage's blit onto the canvas is none. A
    // warming draw after a frame that blitted and drew nothing else, as of a stage holding
    // nothing, wiped that frame, and the canvas showed black.
    if (counted) {
      this.programs.step();
    }

    const gl = this.gl;
    this.frameFilters = filters;
    this.atlas.place(geometries);
    this.gpu.uploadTextures(textures, this.clearTexture);
    for (const id of keeps.removed) {
      this.pool.release(id);
    }

    keeps.removed.length = 0;
    this.gpu.uploadRows(rows);
    this.draws.prepare(commands, scene);
    const state = this.state;
    state.scissor(null);
    state.colorMask(15);
    state.useProgram(this.draws.program);
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
      this.pool.layerMsaa(into, 1);
    }

    this.pool.beginFrame(stage?.samples ?? 1);
    this.holds.drawHolds(commands, scene, filters, target);
    const canvas: Open = {
      layer: into,
      msaa: stage,
      x: 0,
      y: 0,
      width: target.width,
      height: target.height,
      opaque: commands.opaqueStage,
    };
    this.layers.length = 0;
    this.draws.drawInto(canvas, target);

    this.draws.forgetRow();
    // The masks pushed on the target drawn into. A layer has a stencil of its own, and the
    // target below keeps its count meanwhile.
    const masks = this.masks;
    masks.depth = 0;
    masks.past = 0;
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
          this.draws.drawRun(scene, ops[at + 1], ops[at + 1] + ops[at + 2], k);
          break;
        case STENCIL_PUSH:
        case STENCIL_POP:
          this.draws.drawMask(
            scene,
            ops[at + 1],
            ops[at + 1] + ops[at + 2],
            ops[at] === STENCIL_PUSH,
            masks,
            k,
          );
          break;

        case HOLD_PUSH:
          // Drawn ahead of the stage (drawHolds).
          while (ops[k * 4] !== HOLD_POP) {
            k++;
          }

          break;
        case HELD:
          this.draws.maskBy(masks);
          this.holds.compositeHeld(
            ops[at + 1],
            this.layers.at(-1) ?? canvas,
            ops[at + 2],
            ops[at + 3],
          );
          break;

        case LAYER_PUSH: {
          if (this.blendDirect(commands, k, scene, canvas)) {
            // Its run and its pop with it.
            k += 2;
            break;
          }

          below.push(masks.depth, masks.past);
          masks.depth = 0;
          masks.past = 0;
          const p = commands.params;
          const from = ops[at + 1];
          const width = p[from + 2];
          const height = p[from + 3];
          const filtered = ops[at + 2] === 1;
          // A filtered one of the size its filters' targets take for it, which they read alike.
          const layer = this.pool.takeLayer(width, height, filtered);
          const open: Open = {
            layer,
            msaa: this.pool.layerMsaa(layer, this.pool.frameSamples),
            x: p[from],
            y: p[from + 1],
            width,
            height,
            object: objectOf(p, from + 4),
          };
          this.layers.push(open);
          this.draws.drawInto(open, target);
          state.stencil(null);
          state.colorMask(15);
          gl.clearColor(0, 0, 0, 0);
          gl.clearStencil(0);
          gl.stencilMask(0xff);
          // Its rectangle alone, as a layer taken may be larger, unless filters read past it, as far
          // as they read.
          state.scissor(filtered ? [0, 0, layer.width, layer.height] : [0, 0, width, height]);
          gl.clear(gl.COLOR_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);
          state.scissor(null);
          break;
        }

        case FILTER: {
          const open = this.layers.at(-1);
          if (open?.layer) {
            state.stencil(null);
            // Whole, as the filters read past its rectangle.
            this.pool.resolve(open, open.layer.width, open.layer.height);
            open.layer = this.filters.run(
              filters,
              ops[at + 1],
              open.layer,
              open.width,
              open.height,
              target.resolution,
              open.object,
            );
          }

          break;
        }

        case LAYER_POP: {
          const open = this.layers.pop() as Open;
          masks.past = below.pop() as number;
          masks.depth = below.pop() as number;
          this.pool.resolve(open, open.width, open.height);
          const under = this.layers.at(-1) ?? canvas;
          this.draws.drawInto(under, target);
          // Composited where the masks on the target below let it be.
          this.draws.maskBy(masks);
          this.compositor.compositeLayer(open, under, ops[at + 1], ops[at + 2]);
          const keep = ops[at + 3];
          if (keep >= 0) {
            // Kept for the frames after, the output kept before given back.
            this.pool.keep(keep, open.layer as Layer);
          } else {
            this.pool.giveLayer(open.layer as Layer);
          }

          break;
        }

        case COMPOSITE: {
          const p = commands.params;
          const from = ops[at + 1];
          const layer = this.pool.keptLayer(p[from + 4]);
          if (layer) {
            const kept: Open = {
              layer,
              msaa: null,
              x: p[from],
              y: p[from + 1],
              width: p[from + 2],
              height: p[from + 3],
            };
            this.draws.maskBy(masks);
            this.compositor.compositeLayer(
              kept,
              this.layers.at(-1) ?? canvas,
              ops[at + 2],
              ops[at + 3],
            );
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

    this.holds.givePages();
    if (counted) {
      // The free layers, and the stage's (stageAlpha), undrawn into for LAYER_IDLE_FRAMES let go of.
      this.stage.dropIdleLayer();
      this.pool.endFrame();
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
    if (!this.live) {
      return bytes;
    }

    try {
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
      this.pool.giveLayer(layer);
    } catch (e) {
      this.gaveUp(e);
    }

    return bytes;
  }

  /**
   * BitmapData.draw on the GPU: the commands drawn as `snapshot` draws
   * them, into a layer of their own (the object may show the texture
   * itself), then over texture `id` of the registry at (x, y), as Flash's
   * store composites source over (compositeOver), where it stays: nothing
   * is read back; `opaque` for an opaque store's texture. Pending
   * textures, the one drawn into among them, are uploaded first. Whether
   * it was drawn; not on a lost context or without the texture.
   */
  drawIntoTexture(
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
    id: number,
    x: number,
    y: number,
    opaque: boolean,
  ): boolean {
    if (!this.live) {
      return false;
    }

    try {
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
      const into = this.textureFramebuffer(id);
      if (into) {
        this.compositeOver(layer, into, x, y, width, height, opaque);
      }

      this.pool.giveLayer(layer);
      return into !== null;
    } catch (e) {
      this.gaveUp(e);
      return false;
    }
  }

  /**
   * `layer`'s first `width` by `height` texels over those of `into` at
   * (x, y), as Flash's store composites source over, a channel at a time
   * on whole bytes: s + ((d * (256 - sa)) >> 8), at most 255, a source of
   * alpha 255 put as it is and one of 0 leaving what was there; an opaque
   * store's alpha 255 after. GL's own blending rounds where Flash floors,
   * a level apart: the destination's rectangle is copied into a layer of
   * its own first, and both read exactly.
   */
  private compositeOver(
    layer: Layer,
    into: WebGLFramebuffer,
    x: number,
    y: number,
    width: number,
    height: number,
    opaque: boolean,
  ): void {
    const gl = this.gl;
    const state = this.state;
    state.scissor(null);
    const below = this.pool.takeLayer(width, height);
    this.blit(into, x, y, below.framebuffer, 0, 0, width, height);
    const over = this.overProgramMade();
    state.bindFramebuffer(into);
    state.viewport(x, y, width, height);
    state.colorMask(15);
    state.stencil(null);
    state.setBlend(null);
    state.useProgram(over.program);
    state.bindVertexArray(null);
    const nearest = this.gpu.sampler(0);
    state.bindTexture(TEXTURE_UNIT, layer.texture);
    state.bindSampler(TEXTURE_UNIT, nearest);
    state.bindTexture(LAYER_UNIT, below.texture);
    state.bindSampler(LAYER_UNIT, nearest);
    gl.uniform2i(over.at, x, y);
    gl.uniform1i(over.opaque, opaque ? 1 : 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    this.pool.giveLayer(below);
  }

  /** compositeOver's program: linked ahead, its link finished now if not yet, or linked now. */
  private overProgramMade(): OverProgram {
    if (!this.overProgram && !this.programs.take("over")) {
      const program = linkProgram(this.gl, OVER_VERTEX, OVER_FRAGMENT);
      this.state.useProgram(program);
      this.overMade(program);
    }

    return this.overProgram as OverProgram;
  }

  /** compositeOver's program of `program`, linked and in use, its samplers told their units. */
  private overMade(program: WebGLProgram): void {
    const gl = this.gl;
    gl.uniform1i(gl.getUniformLocation(program, "uSource"), TEXTURE_UNIT);
    gl.uniform1i(gl.getUniformLocation(program, "uBelow"), LAYER_UNIT);
    this.overProgram = {
      program,
      at: gl.getUniformLocation(program, "uAt"),
      opaque: gl.getUniformLocation(program, "uOpaque"),
    };
  }

  /**
   * Texture `id`'s `width` by `height` texels read back, premultiplied RGBA
   * row by row; null on a lost context or without the texture.
   */
  readTexture(id: number, width: number, height: number): Uint8Array | null {
    const framebuffer = this.live ? this.textureFramebuffer(id) : null;
    if (!framebuffer) {
      return null;
    }

    const bytes = new Uint8Array(width * height * 4);
    this.state.bindFramebuffer(framebuffer);
    this.gl.readPixels(0, 0, width, height, this.gl.RGBA, this.gl.UNSIGNED_BYTE, bytes);
    return bytes;
  }

  /**
   * Texture `id`'s `width` by `height` texels at (x, y) cleared to `pixel`,
   * premultiplied ARGB, which comes back exactly; false on a lost context
   * or without the texture.
   */
  fillTexture(
    textures: Textures,
    id: number,
    x: number,
    y: number,
    width: number,
    height: number,
    pixel: number,
  ): boolean {
    if (!this.live) {
      return false;
    }

    this.gpu.uploadTextures(textures, this.clearTexture);
    const framebuffer = this.textureFramebuffer(id);
    if (!framebuffer) {
      return false;
    }

    this.clearRect(framebuffer, x, y, width, height, pixel);
    return true;
  }

  /** A texture of one colour, `width` by `height`, made: cleared to it (GpuTextures' uploadTextures). */
  private readonly clearTexture = (id: number, width: number, height: number, pixel: number) => {
    const framebuffer = this.textureFramebuffer(id);
    if (framebuffer) {
      this.clearRect(framebuffer, 0, 0, width, height, pixel);
    }
  };

  /** `width` by `height` texels at (x, y) of `framebuffer` cleared to `pixel`, premultiplied ARGB, exactly. */
  private clearRect(
    framebuffer: WebGLFramebuffer,
    x: number,
    y: number,
    width: number,
    height: number,
    pixel: number,
  ): void {
    const gl = this.gl;
    this.state.bindFramebuffer(framebuffer);
    this.state.colorMask(15);
    this.state.scissor([x, y, width, height]);
    gl.clearColor(
      ((pixel >>> 16) & 0xff) / 255,
      ((pixel >>> 8) & 0xff) / 255,
      (pixel & 0xff) / 255,
      (pixel >>> 24) / 255,
    );
    gl.clear(gl.COLOR_BUFFER_BIT);
    this.state.scissor(null);
  }

  /**
   * Texture `from`'s `width` by `height` texels at (x, y) copied to (dx, dy)
   * of texture `to`, replacing what was there: as a memmove where they are
   * one texture, through a layer of its own, as a texture copied into
   * itself is GL's feedback loop. Pending textures are uploaded first.
   * False on a lost context or without either texture.
   */
  copyTexture(
    textures: Textures,
    from: number,
    x: number,
    y: number,
    width: number,
    height: number,
    to: number,
    dx: number,
    dy: number,
  ): boolean {
    const gl = this.gl;
    if (!this.live) {
      return false;
    }

    this.gpu.uploadTextures(textures, this.clearTexture);
    const source = this.textureFramebuffer(from);
    const target = source ? this.textureFramebuffer(to) : null;
    if (!source || !target) {
      return false;
    }

    this.state.scissor(null);
    if (from !== to) {
      this.blit(source, x, y, target, dx, dy, width, height);
      return true;
    }

    const between = this.pool.takeLayer(width, height);
    this.state.bindFramebuffer(between.framebuffer);
    gl.invalidateSubFramebuffer(gl.FRAMEBUFFER, [gl.COLOR_ATTACHMENT0], 0, 0, width, height);
    this.blit(source, x, y, between.framebuffer, 0, 0, width, height);
    this.blit(between.framebuffer, 0, 0, target, dx, dy, width, height);
    this.pool.giveLayer(between);
    return true;
  }

  /** `width` by `height` texels at (x, y) of `from` blitted to (dx, dy) of `to`, the state cache's binding `to` after. */
  private blit(
    from: WebGLFramebuffer,
    x: number,
    y: number,
    to: WebGLFramebuffer,
    dx: number,
    dy: number,
    width: number,
    height: number,
  ): void {
    const gl = this.gl;
    this.state.bindFramebuffer(to);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, from);
    gl.blitFramebuffer(
      x,
      y,
      x + width,
      y + height,
      dx,
      dy,
      dx + width,
      dy + height,
      gl.COLOR_BUFFER_BIT,
      gl.NEAREST,
    );
    // Bound as the state cache has it.
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, to);
  }

  /** A framebuffer onto texture `id`, made as first asked for; null for an id of no texture. */
  private textureFramebuffer(id: number): WebGLFramebuffer | null {
    const gl = this.gl;
    const texture = this.gpu.textures[id] ?? null;
    const known = this.textureFramebuffers[id] ?? null;
    if (known?.texture === texture) {
      return known.framebuffer;
    }

    // The id names another texture now: its framebuffer goes with the one it was made for.
    if (known) {
      gl.deleteFramebuffer(known.framebuffer);
      this.textureFramebuffers[id] = null;
    }

    if (!texture) {
      return null;
    }

    const framebuffer = gl.createFramebuffer() as WebGLFramebuffer;
    this.state.bindFramebuffer(framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    this.textureFramebuffers[id] = { texture, framebuffer };
    return framebuffer;
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
    if (!this.usable) {
      return;
    }

    try {
      this.planeInto(
        keep,
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
    } catch (e) {
      this.gaveUp(e);
    }
  }

  /** drawPlane's drawing, what throws thrown on. */
  private planeInto(
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
    this.pool.keep(keep, layer);
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
    let layer = this.pool.takeLayer(width * samples, height * samples);
    this.run(commands, scene, rows, geometries, textures, filters, keeps, target, layer);
    for (let k = samples; k > 1; k /= 2) {
      const half = this.filters.halve(layer, (width * k) / 2, (height * k) / 2);
      this.pool.giveLayer(layer);
      layer = half;
    }

    return layer;
  }

  /** Advanced text's outlines uploaded (GpuTextures.uploadOutlines). */
  uploadOutlines(data: Float32Array, count: number, epoch: number): void {
    this.gpu.uploadOutlines(data, count, epoch);
  }

  /** What the backend made on the context, deleted. */
  destroy(): void {
    this.draws.destroy();
    this.atlas.destroy();
    this.compositor.destroy();
    this.filters.destroy();
    this.programs.destroy();
    this.kernels.clear();
    for (const open of this.layers) {
      if (open.layer) {
        this.pool.deleteLayer(open.layer);
      }
    }

    this.pool.destroy();
    this.stage.destroy();
    for (const known of this.textureFramebuffers) {
      if (known) {
        this.gl.deleteFramebuffer(known.framebuffer);
      }
    }

    this.textureFramebuffers = [];
    if (this.overProgram) {
      this.gl.deleteProgram(this.overProgram.program);
      this.overProgram = null;
    }

    this.gpu.destroy();
    this.state.forget();
  }

  /**
   * The layer pushed at command `k` drawn straight onto the target below,
   * if it may be: unfiltered and not kept, one run of a flat geometry alone
   * (Draws.blendable) drawn normally in it, and a mode (blendsDirect) whose
   * blend of the fill pixel by pixel, its edges covering the pixels in part,
   * is that of the layer's pixels covered alike, as each is linear in what
   * covers it (add short of its sums' clamp); its colour on the quad's.
   * Where fills of one shape meet inside a pixel, each blended by what it
   * covers there is as adl blends them, not the pixel they make together,
   * which a layer would blend. A layer and its
   * resolve and composite left out, what reads what is below copies it as
   * the composite would. Whether it was.
   */
  private blendDirect(commands: Commands, k: number, scene: SceneList, canvas: Open): boolean {
    const ops = commands.ops;
    const at = k * 4;
    const run = at + 4;
    const pop = at + 8;
    if (
      k + 2 >= commands.length ||
      ops[at + 2] !== 0 ||
      ops[run] !== RUN ||
      ops[run + 2] !== 1 ||
      ops[run + 3] !== NORMAL ||
      ops[pop] !== LAYER_POP ||
      ops[pop + 3] >= 0 ||
      !blendsDirect(ops[pop + 1]) ||
      !this.draws.blendable(scene, ops[run + 1])
    ) {
      return false;
    }

    const p = commands.params;
    const from = ops[at + 1];
    const under = this.layers.at(-1) ?? canvas;
    const rect = this.rect;
    rect.x = p[from];
    rect.y = p[from + 1];
    rect.width = p[from + 2];
    rect.height = p[from + 3];
    const mode = ops[pop + 1];
    const compositor = this.compositor;
    if (!compositor.cover(rect, under)) {
      return true;
    }

    // Drawn into already, as a kept output is composited (COMPOSITE); a copy of what is below
    // binds its framebuffer back.
    const reads = readsBelow(mode, under.opaque);
    const back = reads && compositor.copyBelow(under);
    this.draws.maskBy(this.masks);
    const place = compositor.place;
    // Kept to the layer's rectangle, as the composite is, past which nothing below is copied.
    this.state.scissor([place.fx, place.fy, place.width, place.height]);
    this.draws.drawBlended(
      scene,
      ops[run + 1],
      mode,
      reads,
      ops[pop + 2],
      back ? place.backX : 0,
      back ? place.backY : 0,
    );
    this.state.scissor(null);
    return true;
  }
}
