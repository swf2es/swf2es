// Pixi's GraphicsPipe and render-group builds patched, as this module loads,
// for Graphics drawn alone: a swapped context rebuilds nothing, and a group
// left alone a while has its Graphics batched; and a filtered render group's
// fast bounds placed in its parent's; and a filter's resolution lookup kept
// from a texture a resize destroyed. Loaded by view.ts before any renderer is
// made. Also SharedGraphics, the Graphics that draws a context its
// instances share. GraphicsPipe's execute, for a Graphics drawn alone
// under a colour transform, is patched beside the colour shader it draws
// with, in render/color.ts.
import type { ColorTransform } from "@swf2es/format";
import {
  BatchTextureArray,
  type Bounds,
  boundsPool,
  FilterSystem,
  GpuGraphicsContext,
  Graphics,
  type GraphicsContext,
  GraphicsContextSystem,
  GraphicsPipe,
  type InstructionSet,
  Matrix,
  Container as PixiContainer,
  type Renderer,
  RenderGroupSystem,
  Texture,
} from "pixi.js";
import { forgetShown, type SharingGraphics, showFor } from "./color.js";
// Registers the table's pipe with Pixi, which the override below looks up by name.
import "./table.js";
import type { TablePipe } from "./table.js";

/** A Graphics as settling batches it, with the colour transform it is drawn under. */
type Batching = SharingGraphics & { flashColor?: ColorTransform | null };

/**
 * Batch the Graphics of a render group, its own and not those of a group
 * nested in it: showFor picks the batched copy of each one's shared
 * context, and the group lists it (`$batched`), for unsettle to find. A
 * mask's are left alone: drawn into the group of what it masks, they would
 * be packed there and kept, though its own group's rebuilds draw them
 * alone again.
 */
export function settle(group: Settling): void {
  const root = group.root;
  // Already changing, its next rebuild is one of its own, not its batching's.
  const changing = group.structureDidChange;
  group.$settled = true;
  let switched = false;
  const visit = (container: PixiContainer) => {
    if (container.includeInBuild === false) {
      return;
    }

    const graphics = container as Batching;
    if (container instanceof Graphics && !graphics.settled && graphics.shared) {
      graphics.settled = true;
      showFor(graphics, graphics.flashColor ?? null);
      group.$batched ??= new Set();
      group.$batched.add(graphics);
      switched = true;
    }

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

/** Which call of unsettle last marked a group, to note once what it was before the call changed it. */
let passes = 0;

/**
 * Mark `unsettling` unsettled, and look through the Graphics batched by
 * the groups of `scanned` (those, and any whose structure changed): each
 * one still in its settled group stays batched, one moved to another
 * settled group is listed there, and any other, in a group unsettling,
 * one that has not settled, or off the stage, is drawn alone again. A
 * Graphics leaves its group only as the group's structure changes, so the
 * batched of groups that neither unsettle nor change need no look: a
 * static stage's many batched Graphics cost nothing while an animated
 * group beside it is rebuilt on every frame.
 */
export function unsettle(unsettling: Set<Settling>, scanned: Iterable<Settling>): void {
  const pass = ++passes;
  for (const group of unsettling) {
    group.$settled = false;
    mark(group, pass);
  }

  for (const from of scanned) {
    const list = from.$batched;
    if (!list) {
      continue;
    }

    for (const graphics of list as Set<Batching>) {
      if (graphics.destroyed || !graphics.settled) {
        list.delete(graphics);
        continue;
      }

      const group = graphics.parentRenderGroup as unknown as Settling | null;
      if (group?.$settled) {
        if (group !== from) {
          list.delete(graphics);
          group.$batched ??= new Set();
          group.$batched.add(graphics);
        }

        continue;
      }

      list.delete(graphics);
      graphics.settled = false;
      showFor(graphics, graphics.flashColor ?? null);
      if (group) {
        mark(group, pass);
        group.structureDidChange = true;
        group.$settling = !group.$changing;
      }
    }
  }
}

/** Note, once a call, whether `group` was changing before the call: its rebuild is then its own. */
function mark(group: Settling, pass: number): void {
  if (group.$pass !== pass) {
    group.$pass = pass;
    group.$changing = group.structureDidChange;
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
 * A context's tessellation kept in typed arrays once built, rather than
 * the arrays of numbers Pixi pushes it into: some 130 MB of a crowded
 * room's heap were these, its UVs half of them, all zero for a fill
 * without a texture. Pixi reads them only to pack a context's vertices,
 * and builds into new arrays (reset). Kept as each is packed into the
 * same Float32Array: positions as 32-bit floats for a context drawn
 * alone, packed as they are, but as 64-bit ones for one batched, packed
 * through its transform; UVs as 32-bit floats, packed as they are, or
 * a view of zeros for a context without a texture; indices as 16-bit
 * integers where its vertices are few enough.
 */
type Tessellated = {
  vertices: ArrayLike<number>;
  uvs: ArrayLike<number>;
  indices: ArrayLike<number>;
};
type GpuContext = {
  isBatchable: boolean;
  batches: { texture: Texture }[];
  geometryData: Tessellated | null;
};
/** Shorter arrays stay as Pixi made them: a typed array costs some 100 bytes more. */
const COMPACT_LEAST = 64;
/** Zeros, the UVs of every context without a texture, grown to the largest's. */
let zeros = new Float32Array(1024);

function compact(gpu: GpuContext): void {
  const data = gpu.geometryData;
  if (!data || !Array.isArray(data.vertices) || data.vertices.length < COMPACT_LEAST) {
    return;
  }

  const vertices = data.vertices as number[];
  data.vertices = gpu.isBatchable ? new Float64Array(vertices) : new Float32Array(vertices);
  let white = true;
  for (const batch of gpu.batches) {
    white &&= batch.texture === Texture.WHITE;
  }

  const uvs = data.uvs.length;
  if (white && zeros.length < uvs) {
    zeros = new Float32Array(Math.max(uvs, zeros.length * 2));
  }

  data.uvs = white ? zeros.subarray(0, uvs) : new Float32Array(data.uvs as number[]);
  const indices = data.indices as number[];
  data.indices =
    vertices.length / 2 <= 0x10000 ? new Uint16Array(indices) : new Uint32Array(indices);
}

const contextSystem = GraphicsContextSystem.prototype as unknown as {
  _renderer: Renderer;
  updateGpuContext(context: GraphicsContext): GpuContext;
};
const updateGpuContext = contextSystem.updateGpuContext;
contextSystem.updateGpuContext = function (context) {
  const built = (context as unknown as PipeGraphics)._gpuData[this._renderer.uid];
  const building = context.dirty || !built;
  const gpu = updateGpuContext.call(this, context);
  if (building) {
    compact(gpu);
    forgetCommands(context);
  }

  return gpu;
};

/** A path as Pixi keeps it: its commands, and the shapes they flatten to, built once. */
type Commands = { instructions: unknown[]; _shapePath?: unknown; _dirty: boolean };

/**
 * Let go of the commands of a context's paths once they are flattened to
 * shapes, which is all Pixi reads of them again: to build the context
 * again, as a lost context or Pixi's collection of what went unused for a
 * minute has it, to measure its bounds, and to hit test it. A crowded
 * room's contexts kept some 120 MB of these, an object and an array for
 * each segment. Every context of the player is made whole before it is
 * first built (render/tessellate.ts); a path changed after that, as only
 * a cut drawn later would change one, is flattened again from what it
 * has, which no context does.
 */
function forgetCommands(context: GraphicsContext): void {
  for (const instruction of context.instructions) {
    const data = instruction.data as { path?: Commands; hole?: Commands };
    for (const path of [data.path, data.hole]) {
      if (path?._shapePath && !path._dirty && path.instructions.length > 0) {
        path.instructions = [];
      }
    }
  }
}
// Pixi empties the arrays to build into them again: typed arrays are given back as new ones.
const resetGpu = GpuGraphicsContext.prototype.reset;
GpuGraphicsContext.prototype.reset = function (this: GpuGraphicsContext) {
  const data = (this as unknown as GpuContext).geometryData;
  if (data && !Array.isArray(data.vertices)) {
    data.vertices = [];
    data.uvs = [];
    data.indices = [];
  }

  resetGpu.call(this);
};

/**
 * A batch's textures cleared without leaving their IDs behind. Pixi sets
 * each ID it held to null rather than deleting it, so that the lookup of
 * every pooled batch grew by each texture it was ever given, in a crowded
 * room 19 MB of them. A lookup missed reads the same either way.
 */
(BatchTextureArray.prototype as unknown as { clear(): void }).clear = function (
  this: BatchTextureArray,
) {
  const ids = this.ids as Record<number, number | null>;
  for (let i = 0; i < this.count; i++) {
    const texture = this.textures[i];
    this.textures[i] = null as unknown as (typeof this.textures)[number];
    delete ids[texture.uid];
  }

  this.count = 0;
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
  /** Whether it was changing as unsettle first touched it, whose rebuild is then its own; and in which call. */
  $changing?: boolean;
  $pass?: number;
  /** The Graphics settle batched in it, some since destroyed, unbatched or moved (unsettle). */
  $batched?: Set<Graphics>;
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

  override destroy(options?: Parameters<Graphics["destroy"]>[0]): void {
    forgetShown(this);
    super.destroy(options);
  }

  /** Draw `context` without listening on it: a shared context would gather a listener for every instance. */
  show(context: GraphicsContext): void {
    if (context !== this.context) {
      (this as unknown as { _context: GraphicsContext })._context = context;
      this.onViewUpdate();
    }
  }
}
