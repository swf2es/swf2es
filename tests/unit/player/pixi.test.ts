// The renderer's GPU copies of bitmaps, with renderers that stand in for
// WebGL's: each keeps its own copy of a store, and one shows what another
// drew by reading it back through the renderer that drew it.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { BitmapStore } from "../../../packages/player/dist/bitmap.js";
import { BitmapObject, Container } from "../../../packages/player/dist/display.js";
import { PixiView } from "../../../packages/player/dist/pixi.js";
import type { Player } from "../../../packages/player/dist/player.js";

/** A renderer that draws nothing and reads back `pixels`, counting its reads. */
function standIn(pixels: number[]) {
  const reads: unknown[] = [];
  const renderer = {
    render: () => {},
    extract: {
      pixels: (target: unknown) => {
        reads.push(target);
        return { pixels: Uint8ClampedArray.from(pixels) };
      },
    },
  };
  return { renderer: renderer as unknown as ConstructorParameters<typeof PixiView>[0], reads };
}

test("a store shown by two renderers has a copy in each, and what one drew reaches the other", () => {
  // Two pixels, premultiplied RGBA as a texture holds them.
  const drawn = [0x10, 0x20, 0x30, 0xff, 0x40, 0x20, 0x10, 0x80];
  const a = standIn(drawn);
  const b = standIn([]);
  const first = new PixiView(a.renderer);
  const second = new PixiView(b.renderer);
  const store = new BitmapStore(2, 1, true, 0);

  // The first renderer draws into the store; nothing comes back yet.
  assert.equal(
    first.drawInto(store, new Container(), { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 }, 0, 0, 2, 1, 1),
    true,
  );
  assert.equal(store.newerOnGpu, true);
  assert.equal(store.copies.size, 1);
  assert.equal(a.reads.length, 0);

  // The second shows it: read back through the first, uploaded to a copy of its own.
  second.render(new BitmapObject(store));
  assert.equal(store.copies.size, 2);
  assert.equal(a.reads.length, 1);
  assert.equal(b.reads.length, 0);
  assert.deepEqual(
    [...store.pixels].map((p) => p.toString(16)),
    ["ff102030", "80402010"],
  );
  const theirs = [...store.copies].find((copy) => copy !== store.gpu) as unknown as {
    source: { resource: Uint8Array };
  };
  assert.deepEqual([...theirs.source.resource], drawn);

  // Read once: the first renderer is not asked again.
  second.render(new BitmapObject(store));
  assert.equal(a.reads.length, 1);

  store.dispose();
  assert.equal(store.copies.size, 0);
});

test("a timeline mask's range goes in a container it masks, a scroll clips the rest, and a mask off the list sits beside the root", () => {
  const view = new PixiView(standIn([]).renderer);
  const root = new Container();
  const [mask, , , c] = [1, 2, 3, 4].map((depth) => {
    const child = new Container();
    root.placeAtDepth(child, depth);
    return child;
  });
  mask.clipDepth = 3;
  view.prepare(root);

  const top = view.stage.children[0];
  const [art, maskContainer, group, cContainer] = top.children;
  assert.equal(top.children.length, 4);
  assert.equal(art.children.length, 0);
  assert.equal(group.mask, maskContainer);
  assert.equal(group.children.length, 2);
  assert.ok(!cContainer.mask);
  assert.equal(maskContainer.includeInBuild, false);

  // Scrolled: its art and children go in a container the scroll's rectangle masks.
  root.scroll = { xMin: 5, yMin: 5, xMax: 25, yMax: 15 };
  root.invalidate(1);
  view.prepare(root);
  const [clip, content] = top.children;
  assert.equal(top.children.length, 2);
  assert.equal(content.mask, clip);
  assert.equal(content.children.length, 4);
  assert.deepEqual([top.x, top.y], [-5, -5]);

  // A mask off the list clips from beside the root, at its own place.
  const off = new Container();
  off.setMatrix({ a: 1, b: 0, c: 0, d: 1, tx: 30, ty: 40 });
  c.setMask(off);
  view.prepare(root);
  const holder = view.stage.children[1];
  assert.equal(holder.children.length, 1);
  assert.equal(holder.children[0].x, 30);
  const cNode = content.children[3];
  assert.equal(cNode.mask, holder.children[0]);

  // And none once the mask is taken off.
  c.setMask(null);
  view.prepare(root);
  assert.equal(holder.children.length, 0);
  assert.ok(!cNode.mask);
});

test("a batchable keeps the batcher name it is given, and one under a colour transform goes to swf2es's", async () => {
  // Pixi as the player loads it, its ES module, which pixi-color.ts patched.
  const cjs = createRequire(new URL("../../../packages/player/package.json", import.meta.url));
  const entry = pathToFileURL(cjs.resolve("pixi.js").replace(/\.js$/, ".mjs")).href;
  const { BatchableSprite } = (await import(entry)) as {
    BatchableSprite: new () => { batcherName: string; renderable: unknown };
  };
  const sprite = new BatchableSprite();
  assert.equal(sprite.batcherName, "default");
  sprite.batcherName = "host-custom";
  assert.equal(sprite.batcherName, "host-custom");

  const ct = { rMul: 1, gMul: 1, bMul: 1, aMul: 1, rAdd: 10, gAdd: 0, bAdd: 0, aAdd: 0 };
  sprite.renderable = { flashColor: ct };
  assert.equal(sprite.batcherName, "flash-color");
  sprite.renderable = { flashColor: null };
  assert.equal(sprite.batcherName, "host-custom");
});

test("Pixi pointer delivery scales to SWF coordinates and stops on unbind", () => {
  const renderer = { screen: { width: 200, height: 100 } } as unknown as ConstructorParameters<
    typeof PixiView
  >[0];
  const view = new PixiView(renderer);
  const calls: unknown[][] = [];
  const player = {
    width: 100,
    height: 50,
    pointer: { handle: (...args: unknown[]) => calls.push(args) },
  } as unknown as Player;
  const unbind = view.bindPointer(player);
  const event = {
    global: { x: 30, y: 20 },
    button: 0,
    buttons: 1,
    altKey: true,
    ctrlKey: false,
    shiftKey: false,
  };
  view.stage.emit("pointerdown", event as never);
  assert.deepEqual(calls, [
    [
      "down",
      { x: 15, y: 10, button: 0, buttons: 1, altKey: true, ctrlKey: false, shiftKey: false },
    ],
  ]);
  unbind();
  view.stage.emit("pointerdown", event as never);
  assert.equal(calls.length, 1);
});

test("Flash's filters are left out under WebGPU, and a fresh view destroys those it made", async () => {
  const { filterDefaults } = await import("../../../packages/player/dist/filters.js");
  const cjs = createRequire(new URL("../../../packages/player/package.json", import.meta.url));
  const entry = pathToFileURL(cjs.resolve("pixi.js").replace(/\.js$/, ".mjs")).href;
  const pixi = (await import(entry)) as {
    Filter: { prototype: { destroy: (...args: unknown[]) => void } };
    DOMAdapter: { get(): object; set(adapter: object): void };
  };
  // Node has no canvas, whose WebGL Pixi asks a program's precision of: one without a context.
  const adapter = pixi.DOMAdapter.get();
  pixi.DOMAdapter.set({ ...adapter, createCanvas: () => ({ getContext: () => null }) });
  const blurred = () => {
    const o = new Container();
    o.filters = [{ ...filterDefaults("blur"), blurX: 4, blurY: 4 }];
    return o;
  };
  const filtersOf = (view: InstanceType<typeof PixiView>) =>
    (view.stage.children[0] as unknown as { filters: unknown[] | null }).filters;

  // WebGL (1) gets the blur; WebGPU (2) none, for Pixi would skip the whole chain.
  for (const [type, count] of [
    [1, 1],
    [2, 0],
  ]) {
    const { renderer } = standIn([]);
    (renderer as unknown as { type: number }).type = type;
    const view = new PixiView(renderer);
    view.prepare(blurred());
    assert.equal(filtersOf(view)?.length ?? 0, count);
  }

  // A draw's fresh view: its blur and the blur's own pass destroyed with it.
  const destroy = pixi.Filter.prototype.destroy;
  let destroyed = 0;
  pixi.Filter.prototype.destroy = function (this: unknown, ...args: unknown[]) {
    destroyed++;
    destroy.apply(this, args);
  };
  try {
    const { renderer } = standIn([0, 0, 0, 0]);
    (renderer as unknown as { type: number }).type = 1;
    new PixiView(renderer).snapshot(blurred(), { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 }, 1, 1, 1);
  } finally {
    pixi.Filter.prototype.destroy = destroy;
    pixi.DOMAdapter.set(adapter);
  }

  assert.ok(destroyed >= 2);
});

test("a convolution pads its reach and the pixel adl adds, and knows the padding after it", async () => {
  const { filterDefaults } = await import("../../../packages/player/dist/filters.js");
  const { displayFilters } = await import("../../../packages/player/dist/pixi-filters.js");
  const cjs = createRequire(new URL("../../../packages/player/package.json", import.meta.url));
  const entry = pathToFileURL(cjs.resolve("pixi.js").replace(/\.js$/, ".mjs")).href;
  const pixi = (await import(entry)) as {
    DOMAdapter: { get(): object; set(adapter: object): void };
  };
  const adapter = pixi.DOMAdapter.get();
  pixi.DOMAdapter.set({ ...adapter, createCanvas: () => ({ getContext: () => null }) });
  try {
    const [convolution, blur] = displayFilters([
      { ...filterDefaults("convolution"), matrixX: 5, matrixY: 3, matrix: new Array(15).fill(1) },
      { ...filterDefaults("blur"), blurX: 4, blurY: 4 },
    ]) as unknown as { padding: number; inset?: number }[];
    assert.equal(convolution.padding, 3);
    assert.equal(blur.padding, 2);
    assert.equal(convolution.inset, 5);
  } finally {
    pixi.DOMAdapter.set(adapter);
  }
});
