import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { Container } from "../../../../packages/player/dist/display/display.js";
import { Compositing } from "../../../../packages/player/dist/render/compositing.js";
import { makeNode } from "../../../../packages/player/dist/render/node.js";

test("retiring a blend layer detaches its destroyed filter after direct blending stops", async (t) => {
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
    const node = makeNode(new Container());
    node.blend = modes[i];
    node.singleDraw = 2;
    compositing.checkStageClear();
    compositing.sync(node, false, false);
    const layer = node.filters[0];
    assert.ok(layer);
    assert.equal(node.container.filters?.[0], layer);

    // The stage becoming clear first switches the blend to a filter. The
    // next sync retires the cached layer with the direct blend already null.
    background.alpha = 0;
    compositing.checkStageClear();
    assert.equal(node.directBlend, null);
    compositing.sync(node, false, false);
    assert.equal(layer.groups, null);
    assert.equal(node.filters.length, 0);
    assert.ok(!node.container.filters?.includes(layer));
    assert.ok(node.container.filters?.every((filter) => filter.groups !== null));
    node.container.destroy({ children: true });
  }
});
