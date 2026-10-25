import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { Plane } from "../../../../packages/player/dist/render/three.js";

const cjs = createRequire(new URL("../../../../packages/player/package.json", import.meta.url));
const entry = pathToFileURL(cjs.resolve("pixi.js").replace(/\.js$/, ".mjs")).href;
const pixi = await import(entry);
const identity = { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 };

function setup(
  t: import("node:test").TestContext,
  render: (options: { container: Plane["holder"] | Plane["quad"] }) => void = () => {},
) {
  const adapter = pixi.DOMAdapter.get();
  pixi.DOMAdapter.set({ ...adapter, createCanvas: () => ({ getContext: () => null }) });
  t.after(() => pixi.DOMAdapter.set(adapter));
  const warnings: unknown[][] = [];
  t.mock.method(console, "warn", (...args: unknown[]) => warnings.push(args));
  const renderer = {
    runners: { contextChange: { add() {} } },
    render,
  } as unknown as Parameters<Plane["draw"]>[0];
  const plane = new Plane();
  const content = new pixi.Container();
  let closed = false;
  const destroy = () => {
    if (!closed) {
      closed = true;
      plane.destroy(content);
    }
  };
  t.after(destroy);

  return { plane, renderer, warnings, destroy };
}

test("resizing a 3D plane rebinds its bitmap before destroying the previous one", (t) => {
  const { plane, renderer, warnings, destroy } = setup(t);
  let previous:
    | { bitmap: Plane["quad"]["texture"]; source: Plane["quad"]["texture"]["source"] }
    | undefined;
  for (const size of [8, 120, 8]) {
    assert.equal(plane.place(identity, 0, 0, size, size, 1), true);
    plane.draw(renderer);
    const bitmap = plane.quad.texture;
    assert.equal(plane.quad.shader?.resources.uTexture, bitmap.source);
    assert.equal(bitmap.source.destroyed, false);
    if (previous) {
      assert.notEqual(bitmap, previous.bitmap);
      assert.equal(previous.source.destroyed, true);
      assert.equal(previous.source.listenerCount("change"), 0);
    }

    previous = { bitmap, source: bitmap.source };
  }

  destroy();
  assert.ok(previous);
  assert.equal(previous.source.destroyed, true);
  assert.deepEqual(warnings, []);
});

test("a 3D plane's averaging pass releases a sampled target before pool eviction", (t) => {
  let average: Plane["quad"] | undefined;
  let source: Plane["quad"]["texture"]["source"] | undefined;
  const { plane, renderer, warnings } = setup(t, ({ container }) => {
    if (container instanceof pixi.Mesh) {
      const mesh = container as Plane["quad"];
      average = mesh;
      source = mesh.texture.source;
      assert.equal(mesh.shader?.resources.uTexture, source);
      assert.equal(source.destroyed, false);
    }
  });
  // Rounding to pool size steps puts this sampled target over the pool's texel budget.
  assert.equal(plane.place(identity, 0, 0, 1000, 1040, 1), true);
  plane.draw(renderer);
  assert.deepEqual(warnings, []);
  assert.ok(average);
  assert.ok(source);
  assert.equal(source.destroyed, true);
  assert.equal(source.listenerCount("change"), 0);
  assert.notEqual(average.shader?.resources.uTexture, source);
  assert.equal(average.shader?.resources.uTexture.destroyed, false);
  assert.notEqual(average.texture.source, source);
  assert.deepEqual(warnings, []);
});
