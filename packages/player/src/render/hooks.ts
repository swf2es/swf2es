// Where the player plugs into Pixi: the extension points of the swf2es
// fork of Pixi (vendor/pixijs), through which its policies run in Pixi's
// systems and pipes. What is Pixi's own behaviour lives in the fork.
import {
  BatcherPipe,
  type Container,
  FilterSystem,
  fastGlobalBoundsHooks,
  GpuGraphicsContext,
  GraphicsContextSystem,
  GraphicsPipe,
  type InstructionSet,
  type Renderer,
  RenderGroupSystem,
} from "pixi.js";
import { spareBatchersFor, viewGroups } from "./batchers.js";
import { measureFilterArea, noteMask } from "./blend.js";
import { batcherNameFor, colorShaderFor } from "./color.js";
import { noteBuild, type Settling } from "./settle.js";
import {
  addToProtoRun,
  isProtoItem,
  markProto,
  protoChanged,
  protoTakesGraphics,
  protoTakesSprite,
  releaseFromAtlases,
  TablePipe,
} from "./table.js";
import { forgetCommands } from "./tessellate.js";

// Every renderer's: what Pixi measures and resets is the same for all of them.
fastGlobalBoundsHooks.onMask = noteMask;
GpuGraphicsContext.onReset = releaseFromAtlases;

const hooked = new WeakSet<Renderer>();

/** Plug the player into `renderer`'s systems and pipes, once; another renderer's, as a stand-in's, are left. */
export function hookRenderer(renderer: Renderer): void {
  if (hooked.has(renderer)) {
    return;
  }

  hooked.add(renderer);
  const graphicsPipe = renderer.renderPipes?.graphics;
  const found = (renderer.renderPipes as object as { flashTable?: unknown } | undefined)
    ?.flashTable;
  const table = found instanceof TablePipe ? found : null;
  if (graphicsPipe instanceof GraphicsPipe) {
    graphicsPipe.aloneDrawer = table;
    graphicsPipe.shaderFor = (graphics) => colorShaderFor(graphics, renderer);
  }

  if (table) {
    hookProto(renderer, table);
  }

  const batchPipe = renderer.renderPipes?.batch;
  if (batchPipe instanceof BatcherPipe) {
    batchPipe.batcherNameFor = batcherNameFor;
    batchPipe.batchersFor = (set) => spareBatchersFor(batchPipe, set);
    // Batches on the GPU alone, packed in buffers every group shares (WebGL 2; others keep their own).
    batchPipe.gpuResident = true;
    if (table) {
      // Pixi has a group's batches uploaded once its transforms are updated, before anything is
      // drawn: the table plans the group's runs then, for their rows to go up at once.
      const upload = batchPipe.upload;
      batchPipe.upload = function (this: BatcherPipe, instructionSet) {
        table.prepare(instructionSet);
        upload.call(this, instructionSet);
      };
    }
  }

  const contexts = (renderer as { graphicsContext?: unknown }).graphicsContext;
  if (contexts instanceof GraphicsContextSystem) {
    contexts.onContextBuilt = forgetCommands;
  }

  if (renderer.renderGroup instanceof RenderGroupSystem) {
    // The view forms groups only where every mask dependency stays inside them.
    renderer.renderGroup.canDeferInvisibleGroup = (group) => viewGroups.has(group.instructionSet);
    renderer.renderGroup.onBuildInstructions = (group, forced) =>
      noteBuild(group as unknown as Settling, forced);
  }

  const filter = (renderer as { filter?: unknown }).filter;
  if (filter instanceof FilterSystem) {
    filter.filterAreaHook = measureFilterArea;
  }
}

/**
 * Step 0's prototype (render/table.ts, setProto): Graphics and Sprites it
 * takes go into proto runs as they are added, not to Pixi's batches or
 * the table's runs, and Pixi's updates of them are left out, as a proto
 * run writes their rows as it is planned. A Graphics' new context is
 * found as it is planned, so it needs no rebuild of its group either.
 */
function hookProto(renderer: Renderer, table: TablePipe): void {
  const pipes = renderer.renderPipes as unknown as Record<string, unknown>;
  const graphicsPipe = pipes.graphics;
  const spritePipe = pipes.sprite;
  const batchPipe = pipes.batch as BatcherPipe;
  for (const [pipe, takes] of [
    [graphicsPipe instanceof GraphicsPipe ? graphicsPipe : null, protoTakesGraphics],
    // Pixi's bundle leaves SpritePipe out of its exports: the pipe named "sprite".
    [spritePipe && typeof spritePipe === "object" ? spritePipe : null, protoTakesSprite],
  ] as const) {
    if (!pipe) {
      continue;
    }

    const target = pipe as unknown as {
      addRenderable(item: Container, set: InstructionSet): void;
      updateRenderable(item: Container): void;
      validateRenderable(item: Container): boolean;
    };
    const { addRenderable, updateRenderable, validateRenderable } = target;
    target.addRenderable = function (item, set) {
      const taken = table.active && takes(item as never, renderer as never);
      if (!taken && isProtoItem(item)) {
        // Its batch data, untouched while the prototype drew it, made again from what it is now.
        item.didViewUpdate = true;
      }

      markProto(item, taken);
      if (!taken) {
        addRenderable.call(this, item, set);
        return;
      }

      batchPipe.break(set);
      addToProtoRun(item, set);
    };
    target.updateRenderable = function (item) {
      if (isProtoItem(item)) {
        // Its run's rows are written again as it is planned (retain), not here.
        protoChanged(item);
      } else {
        updateRenderable.call(this, item);
      }
    };
    target.validateRenderable = function (item) {
      if (!isProtoItem(item)) {
        return validateRenderable.call(this, item);
      }

      // Pixi's group is built again only for one that is no longer the prototype's to draw.
      return !(table.active && takes(item as never, renderer as never));
    };
  }
}
