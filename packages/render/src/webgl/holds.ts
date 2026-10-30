import type { GlState } from "@swf2es/context3d/device";
import {
  type Commands,
  HELD,
  HOLD_POP,
  HOLD_PUSH,
  RUN,
  STENCIL_POP,
  STENCIL_PUSH,
} from "../commands.js";
import { FilterPlan, type KernelObject, planChain } from "../filter-plan.js";
import type { Filters } from "../filters.js";
import type { SceneList } from "../scene.js";
import { Shelves } from "../shelves.js";
import type { Compositor } from "./composite.js";
import type { Draws, Masks } from "./draws.js";
import type { FilterRunner, FilterTarget } from "./filters.js";
import type { GpuTextures } from "./gpu-textures.js";
import {
  framebufferOf,
  LAYER_STEP,
  type Layer,
  layerSide,
  MSAA_BYTES,
  type Open,
  objectOf,
  type Target,
  type TargetPool,
} from "./targets.js";

/** The width of the pages held layers and their filters' targets are placed on, side by side. */
const PAGE_WIDTH = 2048;

/** A rectangle of a page, read and drawn into as a texture of its own (FilterTarget). */
interface Slot extends FilterTarget {
  x: number;
  y: number;
  page: Layer;
  /** Its page's index in the frame's (HeldLayers.pages). */
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
  /** Where its object lies in it, which its ShaderFilters read (filter-plan.ts). */
  object: KernelObject | null;
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

/**
 * The frame's held layers (HOLD_PUSH), drawn ahead of the stage a level at
 * a time: their content side by side on pages, then their filters' passes
 * in waves, each wave's targets on pages of their own; their outputs left
 * on the pages for the frame's HELD composites.
 */
export class HeldLayers {
  private readonly gl: WebGL2RenderingContext;
  private readonly state: GlState;
  private readonly pool: TargetPool;
  private readonly draws: Draws;
  private readonly compositor: Compositor;
  private readonly gpu: GpuTextures;
  /** The filters' passes, the backend's. */
  private filters!: FilterRunner<Layer>;
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
  /** The masks pushed on the held layer whose content is drawn (drawHoldContent). */
  private readonly masks: Masks = { depth: 0, past: 0 };
  /** The largest side a texture may have. */
  private textureMost = 4096;

  constructor(
    gl: WebGL2RenderingContext,
    state: GlState,
    pool: TargetPool,
    draws: Draws,
    compositor: Compositor,
    gpu: GpuTextures,
  ) {
    this.gl = gl;
    this.state = state;
    this.pool = pool;
    this.draws = draws;
    this.compositor = compositor;
    this.gpu = gpu;
  }

  /**
   * The filters' passes and the largest side a texture may have, as the
   * context comes or comes back.
   */
  setUp(filters: FilterRunner<Layer>, textureMost: number): void {
    this.filters = filters;
    this.textureMost = textureMost;
  }

  /**
   * The frame's held layers (HOLD_PUSH), drawn ahead of the stage side by
   * side: their content on pages of their own, one bind, clear and resolve
   * a page; then their filters' passes in waves, the k-th pass of every
   * chain at once, each wave's targets on pages of its own, which no pass
   * of it reads. Each layer's output is left on its page for HELD. A layer
   * larger than a page is drawn alone, as a layer of its own.
   */
  drawHolds(commands: Commands, scene: SceneList, filters: Filters, target: Target): void {
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
    this.draws.forgetRow();
    // Their content, each at the size its own layer would take, on pages no taller than the
    // frame's samples fit (fittingSamples), so that each takes them as its own layer did.
    let area = 0;
    let widest = 0;
    for (let h = from; h < to; h++) {
      area += layerSide(holds[h].width) * layerSide(holds[h].height);
      widest = Math.max(widest, layerSide(holds[h].width));
    }

    const samples = this.pool.frameSamples;
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
      whole.msaa = this.pool.layerMsaa(page, samples);
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

      this.pool.resolve(whole, page.width, page.height);
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
        this.filters.links,
        hold.object,
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
          this.pool.giveLayer(page);
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
    return this.addPage(this.pool.takeLayer(width, height), false);
  }

  /**
   * `layer` added to the frame's pages, read by no pass yet, kept for the
   * frame where `kept`: its index in `pages`.
   */
  private addPage(layer: Layer, kept: boolean): number {
    const index = this.pages.length;
    this.pages.push(layer);
    this.pageUntil.push(-1);
    this.pageKept.push(kept);
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
          object: null,
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
      hold.object = objectOf(params, from + 4);
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
    const state = this.state;
    const ops = commands.ops;
    const masks = this.masks;
    masks.depth = 0;
    masks.past = 0;
    state.stencil(null);
    state.colorMask(15);
    for (let k = hold.first; k < hold.end; k++) {
      const at = k * 4;
      switch (ops[at]) {
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
        case HELD:
          this.draws.maskBy(masks);
          this.compositeHeld(ops[at + 1], open, ops[at + 2], ops[at + 3]);
          break;
      }
    }

    state.stencil(null);
  }

  /** Held output `held` composited onto `under`, bound, in blend mode `mode`, coloured by `row`. */
  compositeHeld(held: number, under: Open, mode: number, row: number): void {
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
    const layer = this.pool.takeLayer(hold.width, hold.height, true);
    const open: Open = {
      layer,
      msaa: this.pool.layerMsaa(layer, this.pool.frameSamples),
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
    this.pool.resolve(open, layer.width, layer.height);
    const output = this.filters.run(
      filters,
      hold.chain,
      layer,
      hold.width,
      hold.height,
      target.resolution,
      hold.object,
    );
    const index = this.addPage(output, true);
    hold.result = this.slotOf(hold, 0, index, 0, 0, output.width, output.height);
  }

  /** The pages the frame took given back, as it ends. */
  givePages(): void {
    for (const page of this.pages) {
      if (page) {
        this.pool.giveLayer(page);
      }
    }

    this.pages.length = 0;
    this.pageUntil.length = 0;
    this.pageKept.length = 0;
  }
}
