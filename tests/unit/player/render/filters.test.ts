import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

test("gradient filters detach their owned textures before destroying them", async (t) => {
  const { filterDefaults } = await import("../../../../packages/player/dist/display/filters.js");
  const { displayFilters } = await import("../../../../packages/player/dist/render/filters.js");
  const cjs = createRequire(new URL("../../../../packages/player/package.json", import.meta.url));
  const entry = pathToFileURL(cjs.resolve("pixi.js").replace(/\.js$/, ".mjs")).href;
  const pixi = await import(entry);
  const adapter = pixi.DOMAdapter.get();
  pixi.DOMAdapter.set({ ...adapter, createCanvas: () => ({ getContext: () => null }) });
  t.after(() => pixi.DOMAdapter.set(adapter));
  const warnings: unknown[][] = [];
  t.mock.method(console, "warn", (...args: unknown[]) => warnings.push(args));

  for (const kind of ["gradientGlow", "gradientBevel"] as const) {
    const [filter] = displayFilters([filterDefaults(kind)]);
    const gradient = filter.resources.uGradient;
    const idle = filter.resources.uBlurred;
    assert.equal(gradient.destroyed, false);
    assert.equal(gradient.listenerCount("change"), 1);
    filter.destroy();
    assert.equal(gradient.destroyed, true);
    assert.equal(gradient.listenerCount("change"), 0);
    assert.equal(idle.destroyed, true);
    assert.equal(idle.listenerCount("change"), 0);
    assert.equal(filter.groups, null);
  }

  assert.deepEqual(warnings, []);
});
