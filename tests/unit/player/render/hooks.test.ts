// Where the player plugs into the Pixi fork: each extension point of a
// renderer's systems and pipes set, once, and the static ones as the
// module loads.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { hookRenderer } from "../../../../packages/player/dist/render/hooks.js";
import { TablePipe } from "../../../../packages/player/dist/render/table.js";

const cjs = createRequire(new URL("../../../../packages/player/package.json", import.meta.url));
const pixi = pathToFileURL(cjs.resolve("pixi.js").replace(/\.js$/, ".mjs")).href;
type Class = { prototype: object };
const {
  BatcherPipe,
  FilterSystem,
  fastGlobalBoundsHooks,
  GpuGraphicsContext,
  GraphicsContextSystem,
  GraphicsPipe,
  RenderGroupSystem,
} = (await import(pixi)) as Record<string, Class> & {
  fastGlobalBoundsHooks: { onMask: unknown };
  GpuGraphicsContext: { onReset: unknown };
};

type Hooked = Record<string, unknown>;
const made = (cls: Class) => Object.create(cls.prototype) as Hooked;

test("each extension point of a renderer is set, once, and a stand-in's are left", () => {
  const table = Object.create(TablePipe.prototype) as Hooked;
  const graphics = made(GraphicsPipe);
  const batch = made(BatcherPipe);
  const graphicsContext = made(GraphicsContextSystem);
  const renderGroup = made(RenderGroupSystem);
  const filter = made(FilterSystem);
  const renderer = {
    renderPipes: { graphics, batch, flashTable: table },
    graphicsContext,
    renderGroup,
    filter,
  };
  hookRenderer(renderer as unknown as Parameters<typeof hookRenderer>[0]);

  assert.equal(graphics.aloneDrawer, table);
  for (const hook of [
    graphics.shaderFor,
    batch.batcherNameFor,
    batch.batchersFor,
    graphicsContext.onContextBuilt,
    renderGroup.onBuildInstructions,
    filter.filterAreaHook,
  ]) {
    assert.equal(typeof hook, "function");
  }

  // Once: a second view of the same renderer sets nothing again.
  graphics.shaderFor = null;
  hookRenderer(renderer as unknown as Parameters<typeof hookRenderer>[0]);
  assert.equal(graphics.shaderFor, null);

  // Every renderer's.
  assert.equal(typeof fastGlobalBoundsHooks.onMask, "function");
  assert.equal(typeof GpuGraphicsContext.onReset, "function");

  // A stand-in, as the view's tests make, has nothing set on it.
  const standIn = { renderPipes: { graphics: {}, batch: {} }, filter: {} };
  hookRenderer(standIn as unknown as Parameters<typeof hookRenderer>[0]);
  assert.deepEqual(standIn, { renderPipes: { graphics: {}, batch: {} }, filter: {} });
});

/** The build hook hookRenderer sets on a render group system, as Pixi calls it. */
function buildHook(): (group: object, forced: boolean) => void {
  const renderGroup = made(RenderGroupSystem);
  const renderer = { renderPipes: {}, renderGroup };
  hookRenderer(renderer as unknown as Parameters<typeof hookRenderer>[0]);
  return renderGroup.onBuildInstructions as (group: object, forced: boolean) => void;
}

const tick = () => new Promise((done) => setTimeout(done, 5));

test("a group's build only for a context given back is no change of its own, so it stays settled", async () => {
  const build = buildHook();
  const group: { $builtAt?: number } = {};

  build(group, false);
  const first = group.$builtAt;
  assert.equal(typeof first, "number");
  await tick();

  build(group, true);
  assert.equal(group.$builtAt, first);

  // A build after that, or one with a change of its own, is a change again.
  build(group, false);
  assert.ok((group.$builtAt ?? 0) > (first ?? 0));
});

test("a group taken from Pixi's pool and first built for a context given back is timed from then", () => {
  const build = buildHook();
  // As disableRenderGroup leaves a group it retires, for Pixi to pool and lend again.
  const group: { $builtAt?: number } = { $builtAt: undefined };

  build(group, true);
  assert.equal(typeof group.$builtAt, "number");
});
