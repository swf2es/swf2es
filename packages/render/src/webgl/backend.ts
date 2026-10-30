import { GlState } from "@swf2es/context3d/device";
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
import type { SceneList } from "../scene.js";
import type { Textures } from "../textures.js";
import { GeometryAtlas } from "./atlas.js";
import { Compositor } from "./composite.js";
import { Draws, type Masks } from "./draws.js";
import { FilterRunner } from "./filters.js";
import { GpuTextures } from "./gpu-textures.js";
import { HeldLayers } from "./holds.js";
import { KernelPrograms } from "./kernels.js";
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
  /** The filters' passes, their programs made as first run. */
  private filters!: FilterRunner<Layer>;
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
  /** The mask counts of the targets below the layers drawn into now, two numbers each. */
  private readonly below: number[] = [];

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    this.state = new GlState(gl);
    this.kernels = new KernelPrograms(gl, this.state);
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
    this.atlas.repack(geometries);
    this.atlas.repackGlyphs(geometries);
  }

  /** Programs, buffers and textures made, as the context comes or comes back. */
  private setUp(): void {
    const gl = this.gl;
    this.state.forget();
    // Kernels' programs made again as first used, the context's own gone with it.
    this.kernels.clear();
    const textureMost = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
    this.draws.setUp();
    this.compositor.setUp();
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
    );
    this.holds.setUp(this.filters, textureMost);
    this.pool.setUp();
    this.layers = [];
    this.stage.setUp();
    this.atlas.setUp();
    this.gpu.setUp();
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

    this.frameFilters = filters;
    this.atlas.place(geometries);
    this.gpu.uploadTextures(textures);
    for (const id of keeps.removed) {
      this.pool.release(id);
    }

    keeps.removed.length = 0;
    this.gpu.uploadRows(rows);
    const state = this.state;
    state.scissor(null);
    state.colorMask(15);
    state.useProgram(this.draws.program);
    state.bindVertexArray(this.atlas.vertexArray);
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
          this.draws.drawRun(scene, ops[at + 1], ops[at + 1] + ops[at + 2]);
          break;
        case STENCIL_PUSH:
        case STENCIL_POP:
          this.draws.drawMask(
            scene,
            ops[at + 1],
            ops[at + 1] + ops[at + 2],
            ops[at] === STENCIL_PUSH,
            masks,
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
    this.pool.giveLayer(layer);
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
    this.execute(commands, scene, rows, geometries, textures, filters, keeps, target, layer);
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
    this.kernels.clear();
    for (const open of this.layers) {
      if (open.layer) {
        this.pool.deleteLayer(open.layer);
      }
    }

    this.pool.destroy();
    this.stage.destroy();
    this.gpu.destroy();
    this.state.forget();
  }
}
