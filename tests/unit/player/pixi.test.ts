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
    timeStamp: 1234,
  };
  view.stage.emit("pointerdown", event as never);
  assert.deepEqual(calls, [
    [
      "down",
      {
        x: 15,
        y: 10,
        button: 0,
        buttons: 1,
        altKey: true,
        ctrlKey: false,
        shiftKey: false,
        time: 1234,
      },
    ],
  ]);
  unbind();
  view.stage.emit("pointerdown", event as never);
  assert.equal(calls.length, 1);
});

test("Pixi pointer moves are handled once a frame, the last of them, and before a press", () => {
  const renderer = { screen: { width: 100, height: 100 } } as unknown as ConstructorParameters<
    typeof PixiView
  >[0];
  const view = new PixiView(renderer);
  const calls: [string, number][] = [];
  const player = {
    width: 100,
    height: 100,
    pointer: { handle: (type: string, p: { x: number }) => calls.push([type, p.x]) },
  } as unknown as Player;
  const frames: (() => void)[] = [];
  const g = globalThis as { requestAnimationFrame?: unknown; cancelAnimationFrame?: unknown };
  g.requestAnimationFrame = (f: () => void) => frames.push(f);
  g.cancelAnimationFrame = (id: number) => {
    frames[id - 1] = () => {};
  };
  try {
    const unbind = view.bindPointer(player);
    const at = (x: number) => ({ global: { x, y: 0 }, button: 0, buttons: 0 }) as never;
    for (const x of [1, 2, 3]) {
      view.stage.emit("pointermove", at(x));
    }

    assert.deepEqual(calls, []);
    assert.equal(frames.length, 1);
    frames[0]();
    assert.deepEqual(calls, [["move", 3]]);

    view.stage.emit("pointermove", at(4));
    view.stage.emit("pointerdown", at(5));
    assert.deepEqual(calls.slice(1), [
      ["move", 4],
      ["down", 5],
    ]);
    frames[1]();
    assert.equal(calls.length, 3);
    unbind();
  } finally {
    delete g.requestAnimationFrame;
    delete g.cancelAnimationFrame;
  }
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

test("instances that see a character alike share its lines, which live while one holds them", async () => {
  const { ShapeObject, CONTENT } = await import("../../../packages/player/dist/display.js");
  const { Drawing } = await import("../../../packages/player/dist/drawing.js");
  const { MOVE, LINE } = await import("../../../packages/player/dist/shapes.js");
  const view = new PixiView(standIn([]).renderer);
  const line = {
    width: 40,
    color: 0xff000000,
    startCap: 0,
    endCap: 0,
    join: 0,
    miterLimit: 3,
    noHScale: false,
    noVScale: false,
    pixelHinting: false,
    noClose: false,
    fill: null,
  };
  const character = {
    type: "shape" as const,
    id: 1,
    shape: {} as never,
    layers: [{ fills: [], strokes: [{ line, paths: [[MOVE, 0, 0, LINE, 10, 0, LINE, 10, 10]] }] }],
  } as unknown as ConstructorParameters<typeof ShapeObject>[0];
  const root = new Container();
  const [a, b] = [1, 2].map((depth) => {
    const shape = new ShapeObject(character);
    shape.setMatrix({ a: 2, b: 0, c: 0, d: 2, tx: depth * 20, ty: 0 });
    root.placeAtDepth(shape, depth);
    return shape;
  });
  type Lines = { context: { destroyed: boolean } };
  const lines = (i: number) =>
    (view.stage.children[0].children[1 + i].children[0].children[1] as unknown as Lines).context;
  const turn = (shape: InstanceType<typeof ShapeObject>, s: number) =>
    shape.setMatrix({ ...shape.matrix, a: s, d: s });

  // Seen alike, one context for both.
  view.prepare(root);
  assert.equal(lines(0), lines(1));
  assert.deepEqual(view.counts, { strokeContexts: 1, strokeReuses: 1 });

  // One turns: a context of its own; the other's stays, held.
  turn(a, 3);
  view.prepare(root);
  const shared = lines(1);
  assert.notEqual(lines(0), shared);
  assert.equal(shared.destroyed, false);

  // It turns back: the context it had is found, not made again.
  turn(a, 2);
  view.prepare(root);
  assert.equal(lines(0), shared);
  assert.deepEqual(view.counts, { strokeContexts: 2, strokeReuses: 2 });

  // Swapped in, not listened on: a shared context gathers no listener an instance.
  const listened = lines(0) as unknown as { listenerCount(event: string): number };
  assert.equal(listened.listenerCount("update"), 0);
  assert.equal(listened.listenerCount("unload"), 0);

  // Drawn anew, its content changed: still the character's lines, shared.
  a.invalidate(CONTENT);
  view.prepare(root);
  assert.equal(lines(0), shared);
  assert.equal(shared.destroyed, false);

  // A drawing's lines are its own, as its layers change.
  for (const depth of [3, 4]) {
    const shape = new ShapeObject(null);
    const drawing = new Drawing();
    drawing.lineStyle(line);
    drawing.moveTo(0, 0);
    drawing.lineTo(10, 10);
    shape.drawing = drawing;
    root.placeAtDepth(shape, depth);
  }

  view.prepare(root);
  assert.notEqual(lines(2), lines(3));

  // Idle a while: those no one holds go after 5 s, however many renders, the held stay.
  const first = lines(0);
  b.setMatrix({ ...b.matrix, a: 5, d: 5 });
  turn(a, 6);
  await withClock(async (clock) => {
    view.prepare(root);
    for (let k = 0; k < 500; k++) {
      clock.at += 9;
      view.prepare(root);
    }

    assert.equal(first.destroyed, false);
    clock.at += 1000;
    view.prepare(root);
    assert.equal(first.destroyed, true);
  });
  assert.equal(lines(0).destroyed, false);
  assert.equal(lines(1).destroyed, false);
});

/** `performance.now` as a clock the test moves, for what it runs. */
async function withClock(run: (clock: { at: number }) => Promise<void> | void): Promise<void> {
  const clock = { at: performance.now() };
  const now = performance.now;
  performance.now = () => clock.at;
  try {
    await run(clock);
  } finally {
    performance.now = now;
  }
}

test("a shape's fills and lines are drawn unbatched", async () => {
  const { ShapeObject } = await import("../../../packages/player/dist/display.js");
  const { MOVE, LINE } = await import("../../../packages/player/dist/shapes.js");
  const view = new PixiView(standIn([]).renderer);
  const line = {
    width: 40,
    color: 0xff000000,
    startCap: 0,
    endCap: 0,
    join: 0,
    miterLimit: 3,
    noHScale: false,
    noVScale: false,
    pixelHinting: false,
    noClose: false,
    fill: null,
  };
  const character = {
    type: "shape" as const,
    id: 1,
    shape: {} as never,
    layers: [{ fills: [], strokes: [{ line, paths: [[MOVE, 0, 0, LINE, 10, 0, LINE, 10, 10]] }] }],
  } as unknown as ConstructorParameters<typeof ShapeObject>[0];
  const root = new Container();
  root.placeAtDepth(new ShapeObject(character), 1);
  view.prepare(root);

  // The fills' Graphics, then the lines'.
  const art = view.stage.children[0].children[1].children[0];
  const modes = art.children.map(
    (g) => (g as unknown as { context: { batchMode: string } }).context.batchMode,
  );
  assert.deepEqual(modes, ["no-batch", "no-batch"]);
});

test("the thinnest line is a pixel of the screen, however many the renderer draws a stage pixel with", async () => {
  const { ShapeObject } = await import("../../../packages/player/dist/display.js");
  const { MOVE, LINE } = await import("../../../packages/player/dist/shapes.js");
  const renderer = { ...standIn([]).renderer, resolution: 3 } as unknown as ConstructorParameters<
    typeof PixiView
  >[0];
  const view = new PixiView(renderer);
  const hairline = {
    width: 1,
    color: 0xff000000,
    startCap: 0,
    endCap: 0,
    join: 0,
    miterLimit: 3,
    noHScale: false,
    noVScale: false,
    pixelHinting: false,
    noClose: false,
    fill: null,
  };
  const character = {
    type: "shape" as const,
    id: 1,
    shape: {} as never,
    layers: [{ fills: [], strokes: [{ line: hairline, paths: [[MOVE, 0, 0, LINE, 10, 0]] }] }],
  } as unknown as ConstructorParameters<typeof ShapeObject>[0];
  const root = new Container();
  root.placeAtDepth(new ShapeObject(character), 1);
  type Stroked = { instructions: { action: string; data: { style: { width: number } } }[] };
  const width = () => {
    const lines = view.stage.children[0].children[1].children[0].children[1] as unknown as {
      context: Stroked;
    };
    return lines.context.instructions.find((i) => i.action === "stroke")?.data.style.width;
  };

  // Shown three screen pixels to the stage's, as a zoomed stage is: a third of a stage pixel.
  view.prepare(root);
  assert.equal(width(), 1 / 3);

  // Averaged down to the screen, as the test page draws: a whole one, drawn again unasked.
  view.screenScale = 1;
  view.prepare(root);
  assert.equal(width(), 1);
});

test("an object off the list gives its lines back, and has them again when it comes back", async () => {
  const { ShapeObject } = await import("../../../packages/player/dist/display.js");
  const { MOVE, LINE } = await import("../../../packages/player/dist/shapes.js");
  const view = new PixiView(standIn([]).renderer);
  const line = {
    width: 40,
    color: 0xff000000,
    startCap: 0,
    endCap: 0,
    join: 0,
    miterLimit: 3,
    noHScale: false,
    noVScale: false,
    pixelHinting: false,
    noClose: false,
    fill: null,
  };
  const character = {
    type: "shape" as const,
    id: 1,
    shape: {} as never,
    layers: [{ fills: [], strokes: [{ line, paths: [[MOVE, 0, 0, LINE, 10, 0, LINE, 10, 10]] }] }],
  } as unknown as ConstructorParameters<typeof ShapeObject>[0];
  type Lines = { context: { destroyed: boolean } };
  const root = new Container();
  // A shape in a container, so that what leaves is a whole branch.
  const branch = new Container();
  const shape = new ShapeObject(character);
  shape.setMatrix({ a: 3, b: 0, c: 0, d: 3, tx: 0, ty: 0 });
  branch.placeAtDepth(shape, 1);
  root.placeAtDepth(branch, 1);
  const linesOf = () =>
    (view.stage.children[0].children[1].children[1].children[0].children[1] as unknown as Lines)
      .context;

  await withClock(async (clock) => {
    view.prepare(root);
    const held = linesOf();
    assert.deepEqual(view.counts, { strokeContexts: 1, strokeReuses: 0 });

    // Off the list: given back, then gone once idle long enough.
    root.removeChild(branch);
    view.prepare(root);
    assert.equal(held.destroyed, false);
    clock.at += 6000;
    view.prepare(root);
    assert.equal(held.destroyed, true);

    // Back on: drawn again, not with the context destroyed.
    root.placeAtDepth(branch, 1);
    view.prepare(root);
    assert.equal(linesOf().destroyed, false);
    assert.notEqual(linesOf(), held);
    assert.deepEqual(view.counts, { strokeContexts: 2, strokeReuses: 0 });

    // The branch off the list, then the shape off the branch, before a render:
    // the shape still gives its lines back, as the branch last drew it.
    const again = linesOf();
    root.removeChild(branch);
    branch.removeChild(shape);
    view.prepare(root);
    clock.at += 6000;
    view.prepare(root);
    assert.equal(again.destroyed, true);
    branch.placeAtDepth(shape, 1);
    root.placeAtDepth(branch, 1);
    view.prepare(root);
    assert.equal(linesOf().destroyed, false);

    // Many made and taken off: none stay held, and all go once idle.
    const made: Lines["context"][] = [];
    for (let k = 0; k < 50; k++) {
      const other = new ShapeObject(character);
      other.setMatrix({ a: 1 + k / 10, b: 0, c: 0, d: 1, tx: 0, ty: 0 });
      root.placeAtDepth(other, 10);
      view.prepare(root);
      made.push(
        (view.stage.children[0].children[2].children[0].children[1] as unknown as Lines).context,
      );
      root.removeChild(other);
      view.prepare(root);
    }

    clock.at += 6000;
    view.prepare(root);
    assert.ok(made.every((context) => context.destroyed));
    assert.equal(linesOf().destroyed, false);
  });
});

test("a filtered or blended object is drawn into its filters multisampled as its target is", async () => {
  const { filterDefaults } = await import("../../../packages/player/dist/filters.js");
  const cjs = createRequire(new URL("../../../packages/player/package.json", import.meta.url));
  const entry = pathToFileURL(cjs.resolve("pixi.js").replace(/\.js$/, ".mjs")).href;
  const pixi = (await import(entry)) as {
    DOMAdapter: { get(): object; set(adapter: object): void };
  };
  const adapter = pixi.DOMAdapter.get();
  pixi.DOMAdapter.set({ ...adapter, createCanvas: () => ({ getContext: () => null }) });
  try {
    const filtered = new Container();
    filtered.filters = [{ ...filterDefaults("glow"), blurX: 4, blurY: 4 }];
    const blended = new Container();
    blended.blendMode = "multiply";
    const layer = new Container();
    layer.blendMode = "layer";
    // Both: one filter left "off" would turn multisampling off for all of them.
    const both = new Container();
    both.filters = [{ ...filterDefaults("glow"), blurX: 4, blurY: 4 }];
    both.blendMode = "overlay";
    for (const o of [filtered, blended, layer, both]) {
      const { renderer } = standIn([]);
      (renderer as unknown as { type: number }).type = 1;
      const view = new PixiView(renderer);
      view.prepare(o);
      const filters = (view.stage.children[0] as unknown as { filters: { antialias: string }[] })
        .filters;
      assert.ok(filters.length > 0);
      // Pixi's default, "off", would leave the object's edges stepped.
      assert.deepEqual(
        filters.map((f) => f.antialias),
        filters.map(() => "inherit"),
      );
    }
  } finally {
    pixi.DOMAdapter.set(adapter);
  }
});

test("a tween's lines go once its morph drops their blend, not idle for a ratio never drawn again", async () => {
  const { ShapeObject, CONTENT } = await import("../../../packages/player/dist/display.js");
  const { readMorphShape, readSwf } = await import("../../../packages/format/dist/index.js");
  const w = await import("../../swf-writer.ts");
  const square: import("../../swf-writer.ts").PathCommand[] = [
    { move: [0, 0] },
    { line: [400, 0] },
    { line: [400, 400] },
    { line: [0, 400] },
    { line: [0, 0] },
  ];
  const swf = readSwf(
    w.swf({
      width: 50,
      height: 50,
      frameRate: 12,
      frameCount: 1,
      tags: [
        w.morphShape({
          id: 1,
          startBounds: [0, 400, 0, 400],
          endBounds: [0, 400, 0, 400],
          fills: [],
          lines: [{ startWidth: 20, endWidth: 80, startColor: 0xff000000, endColor: 0xff000000 }],
          start: [{ line: 1, commands: square }],
          end: [square],
        }),
      ],
    }),
  );
  const t = swf.tags[0];
  const morph = readMorphShape(swf.bytes, t.code, t.offset, t.length);
  const shape = ShapeObject.ofMorph({
    type: "morph",
    id: 1,
    morph,
    blends: new Map(),
    bitmap: () => null,
  });
  const root = new Container();
  root.placeAtDepth(shape, 1);
  const view = new PixiView(standIn([]).renderer);
  type Lines = { context: { destroyed: boolean } };
  const lines = () =>
    (view.stage.children[0].children[1].children[0].children[1] as unknown as Lines).context;
  const draw = (ratio: number) => {
    shape.ratio = ratio;
    shape.invalidate(CONTENT);
    view.prepare(root);
  };

  view.prepare(root);
  const first = lines();

  // Given back as the tween moves on, it idles while its blend is kept.
  draw(1000);
  assert.equal(first.destroyed, false);

  // Sixteen ratios later its blend is dropped, and the next frame its lines.
  for (let ratio = 2000; ratio <= 17000; ratio += 1000) {
    draw(ratio);
  }

  assert.equal(first.destroyed, true);
  assert.equal(lines().destroyed, false);
});
