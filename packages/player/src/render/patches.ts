// Pixi's GraphicsPipe and render-group builds patched, as this module loads,
// for Graphics drawn alone: a swapped context rebuilds nothing, and a group
// left alone a while has its Graphics batched; and a filtered render group's
// fast bounds placed in its parent's; and a filter's resolution lookup kept
// from a texture a resize destroyed. Loaded by view.ts before any renderer is
// made. Also SharedGraphics, the Graphics that draws a context its
// instances share.
import type { ColorTransform } from "@swf2es/format";
import {
  type Bounds,
  boundsPool,
  FilterSystem,
  Graphics,
  type GraphicsContext,
  GraphicsPipe,
  type InstructionSet,
  Matrix,
  Container as PixiContainer,
  type Renderer,
  RenderGroupSystem,
  type Texture,
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
 * The fast bounds Pixi fits a filter's input to, with a render group that
 * has effects of its own placed in its parent's group. Pixi gathers such a
 * group's bounds in the group's own space and adds them to its parent's
 * unmoved, where a group without effects is moved by its place in the
 * parent: a filtered submenu batched as a group of its own, beside the
 * filtered menu it is a child of, lost to the menu's filter as much of its
 * right side as it stood to the right of the menu. Pixi's walk itself,
 * with that placing in it rather than around each call, as it visits
 * every object below each filter on every frame; and it notes a mask from
 * outside what it measures (areaWatch), which bounds it as no change of
 * the object's tells.
 */
type Measured = PixiContainer & {
  _getGlobalBoundsRecursive(layers: boolean, bounds: Bounds, layer: unknown): void;
  parentRenderLayer: unknown;
  localDisplayStatus: number;
  renderPipeId?: string;
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
  effects: { addBounds?: (bounds: Bounds, skipUpdateTransform?: boolean) => void }[];
};
const measured = PixiContainer.prototype as unknown as Measured;
/** The inverse of a group's transform, as Pixi's walk takes a padded effect's bounds back. */
const INVERSE = new Matrix();

/**
 * What a filter's area is measured from, and whether a mask outside it
 * bounds something in it: set by the filter system's measure (render/blend.ts).
 */
export const areaWatch: { root: PixiContainer | null; outside: boolean } = {
  root: null,
  outside: false,
};

/** Whether `inner` is `outer` or under it. */
function within(outer: PixiContainer, inner: PixiContainer): boolean {
  for (let p: PixiContainer | null = inner; p; p = p.parent) {
    if (p === outer) {
      return true;
    }
  }

  return false;
}

// How deep the walk is: the object measured itself is in its own group's space, which
// getFastGlobalBounds then takes to the stage; only a group below it needs placing. (Pixi
// also places a measured group without effects by its relative transform, which the stage's
// then moves again; no filter measures one, as a filter is an effect, so that is left.)
let measuring = 0;
measured._getGlobalBoundsRecursive = function (this: Measured, layers, bounds, layer) {
  if (layers && this.parentRenderLayer && this.parentRenderLayer !== layer) {
    return;
  }

  if (this.localDisplayStatus !== 7 || !this.measurable) {
    return;
  }

  const watch = areaWatch.root;
  if (watch && !areaWatch.outside) {
    const mask = this.mask;
    if (mask instanceof PixiContainer && !within(watch, mask)) {
      areaWatch.outside = true;
    }
  }

  const effects = this.effects;
  const manageEffects = effects.length > 0;
  const placing = measuring > 0 && !!this.renderGroup && manageEffects;
  const into = placing ? boundsPool.get().clear() : bounds;
  const local = this.renderGroup || manageEffects ? boundsPool.get().clear() : into;
  if (this.boundsArea) {
    into.addRect(this.boundsArea, this.worldTransform);
  } else {
    if (this.renderPipeId) {
      const view = this.bounds;
      local.addFrame(view.minX, view.minY, view.maxX, view.maxY, this.groupTransform);
    }

    const children = this.children as Measured[];
    // Restored however the walk ends: one that throws leaves no depth behind for the next.
    measuring++;
    try {
      for (let i = 0; i < children.length; i++) {
        children[i]._getGlobalBoundsRecursive(layers, local, layer);
      }
    } finally {
      measuring--;
    }
  }

  if (manageEffects) {
    let advanced = false;
    const group = (this.renderGroup || this.parentRenderGroup) as unknown as {
      worldTransform: Matrix;
    };
    for (let i = 0; i < effects.length; i++) {
      const addBounds = effects[i].addBounds;
      if (addBounds) {
        if (!advanced) {
          advanced = true;
          local.applyMatrix(group.worldTransform);
        }

        addBounds.call(effects[i], local, true);
      }
    }

    if (advanced) {
      local.applyMatrix(group.worldTransform.copyTo(INVERSE).invert());
    }

    into.addBounds(local);
    boundsPool.return(local);
  } else if (this.renderGroup) {
    into.addBounds(local, this.relativeGroupTransform);
    boundsPool.return(local);
  }

  if (placing) {
    if (into.isValid) {
      bounds.addBounds(into, this.relativeGroupTransform);
    }

    boundsPool.return(into);
  }
};

/**
 * Pixi 8.21's filter resolution lookup, made safe for a texture a resize
 * destroyed. A filter's push asks it before setting up the entry it has
 * just pushed, whose input texture is then the one it held when last
 * used, given back to the pool since; a resize lets the pool destroy the
 * textures it kept for the old screen size, which leaves that texture
 * without a source, and a filter inside a filter then threw. The walk is
 * Pixi's, so applyFilter, which asks it of the live entry, gets what it
 * did. Pixi 8.22 drops the push's lookup, and this with it.
 */
type FilterStack = {
  _filterStack: { skip: boolean; inputTexture?: Texture }[];
  _filterStackIndex: number;
  _findFilterResolution(rootResolution: number): number;
};
(FilterSystem.prototype as unknown as FilterStack)._findFilterResolution = function (
  this: FilterStack,
  rootResolution,
) {
  let currentIndex = this._filterStackIndex - 1;
  while (currentIndex > 0 && this._filterStack[currentIndex].skip) {
    --currentIndex;
  }

  const source =
    currentIndex > 0 ? this._filterStack[currentIndex].inputTexture?.source : undefined;
  return source ? source._resolution : rootResolution;
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
