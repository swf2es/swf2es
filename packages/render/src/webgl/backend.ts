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
import { FilterPlan, planChain } from "../filter-plan.js";
import type { Filters } from "../filters.js";
import type { Geometries } from "../geometry.js";
import type { Keeps } from "../keeps.js";
import type { Rows } from "../rows.js";
import type { SceneList } from "../scene.js";
import { Shelves } from "../shelves.js";
import type { Textures } from "../textures.js";
import { GeometryAtlas } from "./atlas.js";
import { Compositor } from "./composite.js";
import { Draws, STENCIL_MOST } from "./draws.js";
import { FilterRunner, type FilterTarget } from "./filters.js";
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
  private readonly atlas: GeometryAtlas;
  private readonly compositor: Compositor;
  private readonly draws: Draws;
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

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    this.state = new GlState(gl);
    this.targets = new Targets(gl, this.state);
    this.stage = new Stage(gl, this.state, this.targets);
    this.gpu = new GpuTextures(gl, this.state);
    this.atlas = new GeometryAtlas(gl, this.state);
    this.compositor = new Compositor(gl, this.state);
    this.draws = new Draws(gl, this.state, this.atlas, this.gpu, this.targets);
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
    this.textureMost = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
    this.draws.setUp();
    this.compositor.setUp();
    this.filters = new FilterRunner(gl, this.state, {
      take: (width, height) => this.targets.takeLayer(width, height, true),
      give: (layer) => this.targets.giveLayer(layer),
      texture: (id) => this.gpu.textures[id] ?? null,
      sampler: (bits) => this.gpu.sampler(bits),
    });
    this.targets.setUp();
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

    this.atlas.place(geometries);
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
    this.draws.drawInto(canvas, target);

    this.draws.lastRow = -1;
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
          this.draws.useFill();
          state.setBlend(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
          this.draws.drawEntries(scene, ops[at + 1], ops[at + 1] + ops[at + 2], false);
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

          this.draws.useFill();
          state.colorMask(0);
          state.stencil(gl.EQUAL, depth, push ? gl.INCR : gl.DECR);
          this.draws.drawEntries(scene, ops[at + 1], ops[at + 1] + ops[at + 2], true);
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
          this.draws.drawInto(under, target);
          // Composited where the masks on the target below let it be.
          state.stencil(depth > 0 ? gl.EQUAL : null, depth, gl.KEEP);
          this.compositor.compositeLayer(open, under, ops[at + 1], ops[at + 2]);
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
    this.draws.lastRow = -1;
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
        this.draws.drawInto(content, target);
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
          this.draws.useFill();
          state.setBlend(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
          this.draws.drawEntries(scene, ops[at + 1], ops[at + 1] + ops[at + 2], false);
          break;
        case STENCIL_PUSH:
        case STENCIL_POP: {
          const push = ops[at] === STENCIL_PUSH;
          if (push ? depth >= STENCIL_MOST || past > 0 : past > 0) {
            past += push ? 1 : -1;
            break;
          }

          this.draws.useFill();
          state.colorMask(0);
          state.stencil(gl.EQUAL, depth, push ? gl.INCR : gl.DECR);
          this.draws.drawEntries(scene, ops[at + 1], ops[at + 1] + ops[at + 2], true);
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
    this.compositor.compositeLayer(open, under, mode, row);
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
    this.draws.drawInto(open, target);
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
    for (const open of this.layers) {
      if (open.layer) {
        this.targets.deleteLayer(open.layer);
      }
    }

    this.targets.destroy();
    this.stage.destroy();
    this.gpu.destroy();
    this.state.forget();
  }
}
