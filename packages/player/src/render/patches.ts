// Pixi's GraphicsPipe and render-group builds patched, as this module loads,
// for Graphics drawn alone: a swapped context rebuilds nothing, and a group
// left alone a while has its Graphics batched. Loaded by view.ts before any
// renderer is made. Also SharedGraphics, the Graphics that draws a context
// its instances share.
import type { ColorTransform } from "@swf2es/format";
import {
  Graphics,
  type GraphicsContext,
  GraphicsPipe,
  type InstructionSet,
  type Container as PixiContainer,
  type Renderer,
  RenderGroupSystem,
} from "pixi.js";
import { type SharingGraphics, showFor } from "./color.js";
// Registers the table's pipe with Pixi, which the override below looks up by name.
import "./table.js";
import type { TablePipe } from "./table.js";

/**
 * Batch the Graphics of a render group, its own and not those of a group
 * nested in it, or draw them alone again: showFor picks the batched copy
 * of each one's shared context. A mask's are left alone: drawn into the
 * group of what it masks, they would be packed there and kept, though its
 * own group's rebuilds draw them alone again.
 */
export function settle(group: Settling, settled: boolean): void {
  const root = group.root;
  // Already changing, its next rebuild is one of its own, not its batching's.
  const changing = group.structureDidChange;
  group.$settled = settled;
  let switched = false;
  const visit = (container: PixiContainer) => {
    if (container.includeInBuild === false) {
      return;
    }

    const graphics = container as SharingGraphics & { flashColor?: ColorTransform | null };
    if (container instanceof Graphics && !!graphics.settled !== settled && graphics.shared) {
      graphics.settled = settled;
      showFor(graphics, graphics.flashColor ?? null);
      switched = true;
    }

    // An index, not for-of: a rebuilt group is walked whole each frame.
    const children = container.children;
    for (let i = 0; i < children.length; i++) {
      if (!children[i].isRenderGroup) {
        visit(children[i]);
      }
    }
  };
  if (root) {
    visit(root);
  }

  if (switched) {
    group.structureDidChange = true;
    group.$settling = !changing;
  }
}

/**
 * Whether a Graphics whose view changed needs its render group's
 * instructions built again. Pixi asks whether it was batched by whether it
 * has GPU data at all, which every Graphics drawn once has, so one that
 * is drawn alone, as a shape's fills and lines are, had its whole group
 * rebuilt each time its context was swapped: an animated character's on
 * every frame. Each build now records whether it batched the Graphics or
 * gave it an instruction of its own (GraphicsGpuData's unused `batched`):
 * drawn alone by the last build and still to be, its instruction draws the
 * context it has when it runs, and nothing needs rebuilding. One the last
 * build batched, even into no batches at all as an empty context is, gets
 * an instruction only from a rebuild. Where the renderer draws the
 * transform table (render/table.ts), one drawn alone joins a run of it
 * rather than having an instruction to itself.
 */
type PipeGraphics = { _gpuData: Record<number, { batched?: boolean } | undefined> };
const pipe = GraphicsPipe.prototype as unknown as {
  renderer: Renderer;
  addRenderable(graphics: Graphics, instructionSet: InstructionSet): void;
  validateRenderable(graphics: Graphics): boolean;
  _rebuild(graphics: Graphics): void;
};
const addGraphics = pipe.addRenderable;
pipe.addRenderable = function (graphics, instructionSet) {
  const table = (this.renderer.renderPipes as unknown as { flashTable?: TablePipe }).flashTable;
  const batchable = this.renderer.graphicsContext.updateGpuContext(graphics.context).isBatchable;
  if (!batchable && table?.active) {
    if (
      graphics.didViewUpdate ||
      !(graphics as unknown as PipeGraphics)._gpuData[this.renderer.uid]
    ) {
      this._rebuild(graphics);
    }

    this.renderer.renderPipes.batch.break(instructionSet);
    table.add(graphics, instructionSet);
  } else {
    addGraphics.call(this, graphics, instructionSet);
  }

  const data = (graphics as unknown as PipeGraphics)._gpuData[this.renderer.uid];
  if (data) {
    data.batched = this.renderer.graphicsContext.getGpuContext(graphics.context).isBatchable;
  }
};
pipe.validateRenderable = function (graphics) {
  const gpuContext = this.renderer.graphicsContext.updateGpuContext(graphics.context);
  const data = (graphics as unknown as PipeGraphics)._gpuData[this.renderer.uid];
  return gpuContext.isBatchable || data?.batched !== false;
};

/**
 * How long a render group goes without its instructions being rebuilt
 * before its Graphics are batched. Each Graphics drawn alone is a draw
 * call of its own, thousands in a crowded room, most of them scenery that
 * never changes; batched, they are a few. But a batch packs its vertices
 * again whenever its group is rebuilt, as an animated character's is on
 * most frames: only a group that has settled is batched, and it is drawn
 * alone again as soon as it is rebuilt, by anything but its batching.
 */
export const SETTLE_MS = 2000;

/** A render group as the player marks it: when it was last rebuilt, and whether its Graphics are batched. */
export type Settling = {
  root: PixiContainer | null;
  renderGroupChildren: Settling[];
  structureDidChange: boolean;
  $builtAt?: number;
  $settled?: boolean;
  $settling?: boolean;
  /** The rebuild settleGroups last looked at. */
  $seen?: number;
};
const buildInstructions = (
  RenderGroupSystem.prototype as unknown as {
    _buildInstructions(group: Settling, renderer: unknown): void;
  }
)._buildInstructions;
(
  RenderGroupSystem.prototype as unknown as {
    _buildInstructions(group: Settling, renderer: unknown): void;
  }
)._buildInstructions = function (group, renderer) {
  // Its own batching's rebuild is not a change of its own.
  if (group.$settling) {
    group.$settling = false;
  } else {
    group.$builtAt = performance.now();
  }

  buildInstructions.call(this, group, renderer);
};

/**
 * A Graphics of a context it does not own and that never changes once
 * built: a shape's or a drawing's fills, a glyph's, or lines, whose context
 * is swapped for the transform's as the object turns. It does not listen on
 * the context, which is destroyed only once no one holds it: a shared
 * one's listeners, one an instance or a glyph, made each swap and each
 * destroy search them all, so that a text of n glyphs of one font took
 * O(n²) to go.
 */
export class SharedGraphics extends Graphics {
  /** The context it stands for, which the cache counts: what it draws, or that drawn as a batched copy (showFor). */
  shared: GraphicsContext;
  declare flashColor?: ColorTransform | null;
  /** Whether its render group has settled, which batches it (settle). */
  declare settled?: boolean;

  constructor(context?: GraphicsContext) {
    super(context);
    this.shared = this.context;
    this.context.off("update", this.onViewUpdate, this);
    this.context.off("unload", this.unload, this);
  }

  /** Stand for `context` instead, drawn as its colour transform needs. */
  swap(context: GraphicsContext): void {
    this.shared = context;
    showFor(this, this.flashColor ?? null);
  }

  /** Draw `context` without listening on it: a shared context would gather a listener for every instance. */
  show(context: GraphicsContext): void {
    if (context !== this.context) {
      (this as unknown as { _context: GraphicsContext })._context = context;
      this.onViewUpdate();
    }
  }
}
