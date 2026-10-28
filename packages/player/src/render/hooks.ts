// Where the player plugs into Pixi: the extension points of the swf2es
// fork of Pixi (vendor/pixijs), through which its policies run in Pixi's
// systems and pipes. What is Pixi's own behaviour lives in the fork.
import {
  BatcherPipe,
  FilterSystem,
  fastGlobalBoundsHooks,
  GpuGraphicsContext,
  GraphicsContextSystem,
  GraphicsPipe,
  type Renderer,
  RenderGroupSystem,
} from "pixi.js";
import { spareBatchersFor, viewGroups } from "./batchers.js";
import { measureFilterArea, noteMask } from "./blend.js";
import { batcherNameFor, colorShaderFor } from "./color.js";
import { noteBuild, type Settling } from "./settle.js";
import { releaseFromAtlases, TablePipe } from "./table.js";
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
