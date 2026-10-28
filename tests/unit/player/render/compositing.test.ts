import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { Container } from "../../../../packages/player/dist/display/display.js";
import { Compositing } from "../../../../packages/player/dist/render/compositing.js";
import { makeNode } from "../../../../packages/player/dist/render/node.js";

test("a blend keeps its layer as its stage turns clear, and a single fill drops it as the stage turns opaque", async (t) => {
  const cjs = createRequire(new URL("../../../../packages/player/package.json", import.meta.url));
  const entry = pathToFileURL(cjs.resolve("pixi.js").replace(/\.js$/, ".mjs")).href;
  const pixi = (await import(entry)) as {
    DOMAdapter: { get(): object; set(adapter: object): void };
  };
  const adapter = pixi.DOMAdapter.get();
  pixi.DOMAdapter.set({ ...adapter, createCanvas: () => ({ getContext: () => null }) });
  t.after(() => pixi.DOMAdapter.set(adapter));

  type Renderer = ConstructorParameters<typeof Compositing>[0];
  type Planes = ConstructorParameters<typeof Compositing>[1];
  const modes = ["multiply", "subtract"];
  for (let i = 0; i < modes.length; i++) {
    const background = { alpha: 1 };
    const renderer = { type: 1, background } as Renderer;
    const compositing = new Compositing(renderer, {} as Planes, { filterUnits: 1 });

    // Of several draws: blended by the GPU over an opaque stage, through a blend filter over a
    // clear one, the same layer kept either way, as what it drew stands.
    const node = makeNode(new Container());
    node.blend = modes[i];
    node.singleDraw = 2;
    compositing.checkStageClear();
    compositing.sync(node, false, false);
    const layer = node.filters[0];
    assert.ok(layer);
    assert.deepEqual(node.container.filters, [layer]);
    assert.equal(node.directBlend, modes[i]);

    background.alpha = 0;
    compositing.checkStageClear();
    compositing.sync(node, false, false);
    assert.equal(node.directBlend, null);
    assert.equal(node.filters[0], layer);
    assert.equal(node.container.filters?.[0], layer);
    assert.equal(node.container.filters?.length, 2);
    assert.ok(node.container.filters?.every((filter) => filter.groups !== null));
    compositing.forget(node);
    node.container.destroy({ children: true });

    // A single fill takes a layer over a clear stage, and lets it go, destroyed and detached,
    // as the stage turns opaque, which the GPU blends it over as it is drawn.
    const fill = makeNode(new Container());
    fill.blend = modes[i];
    fill.singleDraw = 1;
    compositing.sync(fill, false, false);
    const kept = fill.filters[0];
    assert.ok(kept);
    assert.equal(fill.container.filters?.[0], kept);

    background.alpha = 1;
    compositing.checkStageClear();
    assert.equal(kept.groups, null);
    assert.equal(fill.filters.length, 0);
    assert.equal(fill.directBlend, modes[i]);
    assert.equal(fill.container.filters, null);
    compositing.forget(fill);
    fill.container.destroy({ children: true });
  }
});
