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

test("blurs run coarser only where the screen has texels to spare and the error stays small", async () => {
  const { blurShrink } = await import("../../../../packages/player/dist/render/filters.js");
  // A texel a stage pixel, no blur that way, or no passes, as ever.
  assert.equal(blurShrink(68, 2, 1, 1), 1);
  assert.equal(blurShrink(0, 2, 1, 3), 1);
  assert.equal(blurShrink(1, 2, 1, 3), 1);
  assert.equal(blurShrink(68, 0, 1, 3), 1);
  assert.equal(blurShrink(Number.NaN, 2, 1, 3), 1);
  // Narrow boxes keep every texel; a single box's sharp ends need a wider one.
  assert.equal(blurShrink(2, 2, 1, 3), 1);
  assert.equal(blurShrink(5, 2, 2, 3), 1);
  assert.equal(blurShrink(20, 1, 1, 3), 1);
  assert.equal(blurShrink(4, 1, 3, 11.2), 1);
  // Wide ones go to a texel a stage pixel at most.
  assert.equal(blurShrink(27, 2, 2.37, 3), 3);
  assert.equal(blurShrink(70, 1, 2, 3), 3);
  assert.equal(blurShrink(7, 3, 1.9, 3), 2);
  assert.equal(blurShrink(68, 2, 1, 2.5), 2);
  assert.equal(blurShrink(255, 3, 1, 40), 16);
  // A strong glow multiplies the error: it stays finer.
  assert.equal(blurShrink(27, 2, 255, 3), 1);
});
