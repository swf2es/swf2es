// The renderer's GPU copies of bitmaps, with renderers that stand in for
// WebGL's: each keeps its own copy of a store, and one shows what another
// drew by reading it back through the renderer that drew it.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { BitmapStore } from "../../../packages/player/dist/bitmap.js";
import { BitmapObject, CONTENT, Container } from "../../../packages/player/dist/display.js";
import { PixiView } from "../../../packages/player/dist/pixi.js";
import { ColorBatcher } from "../../../packages/player/dist/pixi-color.js";
import type { Player } from "../../../packages/player/dist/player.js";

setFlagsFromString("--expose-gc");
const gc = runInNewContext("gc") as () => void;

/** A renderer that draws nothing and reads back `pixels`, counting its reads. */
function standIn(pixels: number[]) {
  const reads: unknown[] = [];
  const renderer = {
    render: () => {},
    filter: {
      _setupFilterTextures: () => {},
      _setupBindGroupsAndRender: () => {},
    },
    renderTarget: {
      adaptor: {
        copyToTexture: () => {},
        finishRenderPass: () => {},
      },
    },
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

test("nested render groups keep their hierarchy while parked and release idle batches", async () => {
  await withClock((clock) => {
    const view = new PixiView(standIn([]).renderer);
    const root = new Container();
    const branch = new Container();
    const child = new Container();
    branch.placeAtDepth(child, 1);
    root.placeAtDepth(branch, 1);
    view.prepare(root);

    const outer = view.stage.children[0].children[1];
    const inner = outer.children[1];
    assert.ok(outer && inner);
    outer.enableRenderGroup();
    inner.enableRenderGroup();
    const outerGroup = outer.renderGroup;
    const innerGroup = inner.renderGroup;
    assert.ok(outerGroup && innerGroup);
    const released: string[] = [];
    outerGroup.instructionSet.renderPipes = {
      batch: { destroyInstructionSet: () => released.push("outer") },
    };
    innerGroup.instructionSet.renderPipes = {
      batch: { destroyInstructionSet: () => released.push("inner") },
    };

    root.removeChild(branch);
    view.prepare(root);
    assert.equal(released.length, 0);
    assert.equal(outer.renderGroup, outerGroup);
    assert.equal(inner.renderGroup, innerGroup);

    root.placeAtDepth(branch, 1);
    view.prepare(root);
    assert.equal(view.stage.children[0].children[1], outer);
    released.length = 0;
    outerGroup.instructionSet.renderPipes = {
      batch: { destroyInstructionSet: () => released.push("outer") },
    };
    innerGroup.instructionSet.renderPipes = {
      batch: { destroyInstructionSet: () => released.push("inner") },
    };

    root.removeChild(branch);
    view.prepare(root);
    assert.deepEqual(released, []);
    clock.at += 5001;
    view.prepare(root);
    assert.deepEqual(released, ["outer", "inner"]);
    assert.equal(outer.renderGroup, outerGroup);
    assert.equal(inner.renderGroup, innerGroup);

    root.placeAtDepth(branch, 1);
    view.prepare(root);
    assert.equal(view.stage.children[0].children[1], outer);
  });
});

test("rapidly toggled branches keep their render group", async () => {
  const cjs = createRequire(new URL("../../../packages/player/package.json", import.meta.url));
  const entry = pathToFileURL(cjs.resolve("pixi.js").replace(/\.js$/, ".mjs")).href;
  const { Container: PixiContainer } = await import(entry);

  await withClock((clock) => {
    const view = new PixiView(standIn([]).renderer);
    const root = new Container();
    const branch = new Container();
    root.placeAtDepth(branch, 1);
    view.prepare(root);

    const outer = view.stage.children[0].children[1];
    assert.ok(outer);
    const art = outer.children[0];
    assert.ok(art);
    for (let i = 0; i < 64; i++) {
      art.addChild(new PixiContainer());
    }
    outer.enableRenderGroup();

    root.removeChild(branch);
    view.prepare(root);
    assert.equal(outer.isRenderGroup, true);
    root.placeAtDepth(branch, 1);
    view.prepare(root);
    assert.equal(outer.isRenderGroup, true);

    root.removeChild(branch);
    view.prepare(root);
    root.placeAtDepth(branch, 1);
    view.prepare(root);
    assert.equal(outer.isRenderGroup, true);

    clock.at += 5001;
    branch.setMatrix({ a: 1, b: 0, c: 0, d: 1, tx: 1, ty: 0 });
    view.prepare(root);
    assert.equal(outer.isRenderGroup, true);
  });
});

test("one-off groups give back the oldest batches past the parked limit", () => {
  const view = new PixiView(standIn([]).renderer);
  const root = new Container();
  const branches = Array.from({ length: 65 }, () => new Container());
  for (const [index, branch] of branches.entries()) {
    root.placeAtDepth(branch, index + 1);
  }

  view.prepare(root);
  const containers = view.stage.children[0].children.slice(1);
  const released: number[] = [];
  for (const [index, container] of containers.entries()) {
    container.enableRenderGroup();
    const group = container.renderGroup;
    assert.ok(group);
    group.instructionSet.renderPipes = {
      batch: { destroyInstructionSet: () => released.push(index) },
    };
  }

  for (const branch of branches) {
    root.removeChild(branch);
  }

  view.prepare(root);
  assert.deepEqual(released, [0]);
  assert.equal(
    containers.every((container) => container.isRenderGroup),
    true,
  );
});

/** A batch pipe that gives each instruction set it builds a default and a colour batcher. */
function batchPipe() {
  type Batchers = Record<string, { name: string; destroy(): void }>;
  const destroyed: string[] = [];
  const pipe = {
    _batchersByInstructionSet: {} as Record<number, Batchers | undefined>,
    buildStart(set: { uid: number }) {
      this._batchersByInstructionSet[set.uid] ??= Object.fromEntries(
        ["default", "flash-color"].map((name) => [
          name,
          { name, destroy: () => destroyed.push(name) },
        ]),
      );
    },
  };
  const renderer = {
    ...standIn([]).renderer,
    renderPipes: { batch: pipe },
  } as unknown as ConstructorParameters<typeof PixiView>[0];
  return { pipe, renderer, destroyed };
}

/** `count` bitmaps of `store` placed in `parent`, enough to group it. */
function fill(parent: Container, store: BitmapStore, count = 64): void {
  for (let i = 0; i < count; i++) {
    parent.placeAtDepth(new BitmapObject(store), i + 1);
  }
}

test("a new group builds with the batchers of one given back, not new ones", () => {
  const { pipe, renderer, destroyed } = batchPipe();
  const view = new PixiView(renderer);
  const root = new Container();
  const branches = Array.from({ length: 65 }, () => new Container());
  for (const [index, branch] of branches.entries()) {
    root.placeAtDepth(branch, index + 1);
  }

  view.prepare(root);
  const containers = view.stage.children[0].children.slice(1);
  for (const container of containers) {
    container.enableRenderGroup();
    const set = container.renderGroup?.instructionSet;
    assert.ok(set);
    pipe.buildStart(set);
  }

  const first = containers[0].renderGroup?.instructionSet.uid ?? -1;
  const given = pipe._batchersByInstructionSet[first];
  for (const branch of branches) {
    root.removeChild(branch);
  }

  view.prepare(root);
  assert.equal(pipe._batchersByInstructionSet[first], undefined);
  assert.deepEqual(destroyed, []);

  // A group a view makes takes them.
  const store = new BitmapStore(1, 1, false, 0xffffff);
  const grown = new Container();
  fill(grown, store);
  root.placeAtDepth(grown, 1);
  view.prepare(root);
  const set = view.stage.children[0].children[1].renderGroup?.instructionSet;
  assert.ok(set);
  pipe.buildStart(set);
  assert.equal(pipe._batchersByInstructionSet[set.uid], given);
  store.dispose();
});

test("given-back batchers go to groups a view makes, up to 16 groups' worth, each under its name", () => {
  const { pipe, renderer, destroyed } = batchPipe();
  const view = new PixiView(renderer);
  const store = new BitmapStore(1, 1, false, 0xffffff);
  const root = new Container();
  const arts: Container[] = [];
  const masks: Container[] = [];
  for (let i = 0; i < 17; i++) {
    const panel = new Container();
    const art = new Container();
    const mask = new Container();
    fill(art, store);
    panel.placeAtDepth(art, 1);
    panel.placeAtDepth(mask, 2);
    root.placeAtDepth(panel, i + 1);
    arts.push(art);
    masks.push(mask);
  }

  view.prepare(root);
  const panels = view.stage.children[0].children.slice(1);
  const retired = new Set<unknown>();
  for (const panel of panels) {
    const set = panel.children[1].renderGroup?.instructionSet;
    assert.ok(set);
    pipe.buildStart(set);
    retired.add(pipe._batchersByInstructionSet[set.uid]);
  }

  // Masked, each art gives up its group: 16 keep their batchers, the 17th's are destroyed.
  const unwrapped = pipe.buildStart;
  for (const [index, art] of arts.entries()) {
    art.setMask(masks[index]);
  }

  view.prepare(root);
  assert.equal(
    panels.some((panel) => panel.children[1].isRenderGroup),
    false,
  );
  assert.deepEqual(destroyed.sort(), ["default", "flash-color"]);
  const wrapped = pipe.buildStart;
  assert.notEqual(wrapped, unwrapped);

  // The panels, grouped now, take the 16 records whole, and the 17th builds anew.
  const taken = new Set<unknown>();
  for (const panel of panels) {
    const set = panel.renderGroup?.instructionSet;
    assert.ok(set);
    pipe.buildStart(set);
    const batchers = pipe._batchersByInstructionSet[set.uid];
    assert.ok(batchers);
    assert.equal(batchers.default.name, "default");
    assert.equal(batchers["flash-color"].name, "flash-color");
    if (retired.has(batchers)) {
      taken.add(batchers);
    }
  }

  assert.equal(taken.size, 16);

  // Given back again, the pipe keeps the one wrapper.
  for (const art of arts) {
    art.setMask(null);
  }

  view.prepare(root);
  const artSets = new Set<unknown>();
  for (const panel of panels) {
    const set = panel.children[1].renderGroup?.instructionSet;
    assert.ok(set);
    pipe.buildStart(set);
    artSets.add(set);
    retired.add(pipe._batchersByInstructionSet[set.uid]);
  }

  for (const [index, art] of arts.entries()) {
    art.setMask(masks[index]);
  }

  view.prepare(root);
  assert.equal(pipe.buildStart, wrapped);
  assert.equal(destroyed.length, 4);

  // A root rendered once, though in a group Pixi pooled from one a view made, builds anew.
  const once = new (view.stage.constructor as new () => typeof view.stage)();
  once.enableRenderGroup();
  const onceSet = once.renderGroup?.instructionSet;
  assert.ok(onceSet && artSets.has(onceSet));
  pipe.buildStart(onceSet);
  assert.equal(retired.has(pipe._batchersByInstructionSet[onceSet.uid]), false);
  store.dispose();
});

test("a nested group regroups under its parent's group after the branch comes back", () => {
  const view = new PixiView(standIn([]).renderer);
  const root = new Container();
  const branch = new Container();
  branch.placeAtDepth(new Container(), 1);
  root.placeAtDepth(branch, 1);
  view.prepare(root);

  const outer = view.stage.children[0].children[1];
  const inner = outer.children[1];
  outer.enableRenderGroup();
  inner.enableRenderGroup();
  root.removeChild(branch);
  view.prepare(root);
  root.placeAtDepth(branch, 1);
  view.prepare(root);

  inner.disableRenderGroup();
  inner.enableRenderGroup();
  assert.equal(inner.renderGroup?.renderGroupParent, outer.renderGroup);
  view.prepare(root);
  assert.equal(view.stage.children[0].children[1], outer);
  assert.equal(outer.children[1], inner);
});

test("a colour batcher gives back a past geometry peak after many smaller builds", () => {
  // Shader construction needs a browser; the batcher lifecycle itself does not.
  const batcher = Object.create(ColorBatcher.prototype) as ColorBatcher;
  let destroyed = 0;
  const largeGeometry = { destroy: () => destroyed++ };
  Object.assign(batcher, {
    attributeBuffer: { size: 8 << 20, destroy: () => {} },
    indexBuffer: new Uint32Array(1 << 20),
    geometry: largeGeometry,
    batches: [],
    batchIndex: 0,
    _elements: [],
    underusedBuilds: 0,
  });

  for (let frame = 0; frame < 120; frame++) {
    batcher.attributeSize = 1000;
    batcher.indexSize = 1000;
    batcher.begin();
  }

  assert.ok(batcher.attributeBuffer.size < 8 << 20);
  assert.ok(batcher.indexBuffer.byteLength < 4 << 20);
  assert.notEqual(batcher.geometry, largeGeometry);
  assert.equal(destroyed, 1);
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
    pointer: {
      handle: (...args: unknown[]) => calls.push(args),
      flush: () => {},
      cursor: () => "default",
    },
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

test("Pixi hit-tests the bound stage alone, not its children", async () => {
  const cjs = createRequire(new URL("../../../packages/player/package.json", import.meta.url));
  const entry = pathToFileURL(cjs.resolve("pixi.js").replace(/\.js$/, ".mjs")).href;
  const { Container: PixiContainer, EventBoundary } = (await import(entry)) as {
    Container: new () => {
      eventMode: string;
      hitArea: unknown;
      interactiveChildren: boolean;
    };
    EventBoundary: new (root: unknown) => { hitTest(x: number, y: number): unknown };
  };
  // Containers' event members, as the browser's Pixi loads them.
  await import(new URL("events/init.mjs", entry).href);
  const renderer = { screen: { width: 200, height: 100 } } as unknown as ConstructorParameters<
    typeof PixiView
  >[0];
  const view = new PixiView(renderer);
  const player = {
    width: 100,
    height: 50,
    pointer: { handle: () => {}, flush: () => {}, cursor: () => "default" },
  } as unknown as Player;
  // A child Pixi would pick, and count each test of.
  let tested = 0;
  const child = new PixiContainer();
  child.eventMode = "static";
  child.hitArea = {
    contains: () => {
      tested++;
      return true;
    },
  };
  view.stage.addChild(child as never);
  const unbind = view.bindPointer(player);
  const boundary = new EventBoundary(view.stage);
  assert.equal(boundary.hitTest(10, 10), view.stage);
  assert.equal(tested, 0);

  unbind();
  assert.equal(view.stage.interactiveChildren, true);
});

test("Pixi pointer moves are posted, flushed by a frame of their own where nothing else did", () => {
  const renderer = { screen: { width: 100, height: 100 } } as unknown as ConstructorParameters<
    typeof PixiView
  >[0];
  const view = new PixiView(renderer);
  const calls: string[] = [];
  const player = {
    width: 100,
    height: 100,
    pointer: {
      post: (p: { x: number }) => calls.push(`post ${p.x}`),
      flush: () => calls.push("flush"),
      handle: (type: string, p: { x: number }) => calls.push(`${type} ${p.x}`),
      cursor: () => "default",
    },
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
    view.stage.emit("pointermove", at(1));
    view.stage.emit("pointermove", at(2));
    view.stage.emit("pointerdown", at(3));
    assert.deepEqual(calls, ["post 1", "post 2", "down 3"]);
    assert.equal(frames.length, 1);
    frames[0]();
    assert.deepEqual(calls.slice(3), ["flush"]);

    view.stage.emit("pointermove", at(4));
    unbind();
    frames[1]();
    assert.deepEqual(calls.slice(4), ["post 4", "flush"]);
  } finally {
    delete g.requestAnimationFrame;
    delete g.cancelAnimationFrame;
  }
});

test("Pixi pointer positions are taken within the box CSS object-fit shows the canvas in", () => {
  // A 100 by 50 stage drawn at resolution 2, a 200 by 100 canvas, in a 400 by
  // 100 element with a 5 pixel border: a 390 by 90 content box from (15, 25).
  const canvas = {
    width: 200,
    height: 100,
    style: { cursor: "" },
    getBoundingClientRect: () => ({ left: 10, top: 20, width: 400, height: 100 }),
  };
  const renderer = {
    screen: { width: 100, height: 50 },
    resolution: 2,
    canvas,
  } as unknown as ConstructorParameters<typeof PixiView>[0];
  const view = new PixiView(renderer);
  const calls: [number, number][] = [];
  const player = {
    width: 100,
    height: 50,
    pointer: {
      handle: (_type: string, p: { x: number; y: number }) => calls.push([p.x, p.y]),
      flush: () => {},
      cursor: () => "default",
      onCursor: null,
    },
  } as unknown as Player;
  const g = globalThis as { getComputedStyle?: unknown };
  let fit = "contain";
  const border = "5px";
  g.getComputedStyle = () => ({
    get objectFit() {
      return fit;
    },
    borderLeftWidth: border,
    borderRightWidth: border,
    borderTopWidth: border,
    borderBottomWidth: border,
  });
  try {
    const unbind = view.bindPointer(player);
    const press = (clientX: number, clientY: number) => {
      view.stage.emit("pointerdown", {
        global: { x: 0, y: 0 },
        clientX,
        clientY,
        button: 0,
        buttons: 1,
      } as never);
      return calls[calls.length - 1];
    };

    // contain and scale-down: 180 by 90, from x 120; cover: 390 by 195, from y -27.5;
    // none: 200 by 100, from (110, 20); fill: the content box itself.
    assert.deepEqual(press(120 + 45, 25), [25, 0]);
    fit = "scale-down";
    assert.deepEqual(press(120 + 45, 25), [25, 0]);
    fit = "cover";
    assert.deepEqual(press(15 + 195, -27.5 + 97.5), [50, 25]);
    fit = "none";
    assert.deepEqual(press(110 + 20, 20 + 10), [10, 5]);
    fit = "fill";
    assert.deepEqual(press(15 + 39, 25 + 9), [10, 5]);

    // The player's cursor shows from the bind, as it changes, and goes with unbind.
    assert.equal(canvas.style.cursor, "default");
    const pointer = player.pointer as unknown as { onCursor: (c: string) => void };
    pointer.onCursor("pointer");
    assert.equal(canvas.style.cursor, "pointer");
    // Unbound, the canvas is left to the page's cursor, as before the bind.
    unbind();
    assert.equal(canvas.style.cursor, "");
    assert.equal(pointer.onCursor, null);
  } finally {
    delete g.getComputedStyle;
  }
});

test("the arrow is the arrow over the player, not the page's cursor Pixi's default inherits", () => {
  const events = {
    cursorStyles: { default: "inherit", pointer: "pointer" } as Record<string, unknown>,
    shown: [] as string[],
    setCursor(mode: string | null) {
      const style = this.cursorStyles[mode ?? "default"];
      this.shown.push(typeof style === "string" ? style : String(mode));
    },
  };
  const renderer = {
    screen: { width: 100, height: 100 },
    events,
  } as unknown as ConstructorParameters<typeof PixiView>[0];
  const view = new PixiView(renderer);
  const player = {
    width: 100,
    height: 100,
    pointer: { handle: () => {}, flush: () => {}, cursor: () => "default", onCursor: null },
  } as unknown as Player;

  const unbind = view.bindPointer(player);
  assert.deepEqual(events.shown, ["default"]);
  unbind();
  assert.equal(events.cursorStyles.default, "inherit");
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

test("blurred filter inputs release pooled textures without sharing idle listeners", async () => {
  const { filterDefaults } = await import("../../../packages/player/dist/filters.js");
  const { displayFilters } = await import("../../../packages/player/dist/pixi-filters.js");
  const cjs = createRequire(new URL("../../../packages/player/package.json", import.meta.url));
  const entry = pathToFileURL(cjs.resolve("pixi.js").replace(/\.js$/, ".mjs")).href;
  const pixi = await import(entry);
  const adapter = pixi.DOMAdapter.get();
  pixi.DOMAdapter.set({ ...adapter, createCanvas: () => ({ getContext: () => null }) });
  const filters: ReturnType<typeof displayFilters> = [];
  const input = pixi.RenderTexture.create({ width: 16, height: 16 });
  const whiteListeners = pixi.Texture.WHITE.source.listenerCount("change");
  try {
    for (const kind of ["glow", "dropShadow", "bevel", "gradientGlow", "gradientBevel"] as const) {
      filters.push(...displayFilters([filterDefaults(kind), filterDefaults(kind)]));
    }

    assert.equal(pixi.Texture.WHITE.source.listenerCount("change"), whiteListeners);
    const idle = filters.map((filter) => filter.resources.uBlurred);
    assert.equal(new Set(idle).size, filters.length);
    for (const [i, filter] of filters.entries()) {
      let applied = 0;
      const system = {
        applyFilter(pass: typeof filter) {
          if (pass === filter) {
            assert.notEqual(filter.resources.uBlurred, idle[i]);
            assert.equal(filter.resources.uBlurred.destroyed, false);
            applied++;
          }
        },
      } as unknown as Parameters<typeof filter.apply>[0];
      filter.apply(system, input, input, true);
      filter.apply(system, input, input, true);
      assert.equal(applied, 2);
      assert.equal(filter.resources.uBlurred, idle[i]);
      assert.equal(idle[i].listenerCount("change"), 1);
    }

    for (const filter of filters) {
      filter.destroy();
    }
    filters.length = 0;
    for (const source of idle) {
      assert.equal(source.destroyed, true);
      assert.equal(source.listenerCount("change"), 0);
    }
  } finally {
    for (const filter of filters) {
      filter.destroy();
    }
    input.destroy(true);
    pixi.DOMAdapter.set(adapter);
  }
});

test("filter back textures avoid shared empty listeners and release their private source", async () => {
  const cjs = createRequire(new URL("../../../packages/player/package.json", import.meta.url));
  const entry = pathToFileURL(cjs.resolve("pixi.js").replace(/\.js$/, ".mjs")).href;
  const pixi = await import(entry);
  const systems = [new pixi.FilterSystem({}), new pixi.FilterSystem({})];
  const input = pixi.RenderTexture.create({ width: 16, height: 16 });
  const back = pixi.RenderTexture.create({ width: 16, height: 16 });
  const listeners = pixi.Texture.EMPTY.source.listenerCount("change");
  const emptySources = [];
  try {
    for (const system of systems) {
      const group = system._globalFilterBindGroup;
      const data = {
        inputTexture: input,
        backTexture: pixi.Texture.EMPTY,
        firstEnabledIndex: 0,
        lastEnabledIndex: 0,
        filters: [{ apply() {} }],
      };
      system._applyFiltersToTexture(data, false);
      const empty = group.getResource(3);
      emptySources.push(empty);
      assert.notEqual(empty, pixi.Texture.EMPTY.source);
      assert.equal(data.backTexture, pixi.Texture.EMPTY);
      assert.equal(pixi.Texture.EMPTY.source.listenerCount("change"), listeners);

      data.backTexture = back;
      system._applyFiltersToTexture(data, false);
      assert.equal(group.getResource(3), back.source);
      assert.equal(data.backTexture, back);

      data.backTexture = pixi.Texture.EMPTY;
      data.filters[0].apply = () => {
        throw new Error("filter failed");
      };
      assert.throws(() => system._applyFiltersToTexture(data, false), /filter failed/);
      assert.equal(data.backTexture, pixi.Texture.EMPTY);
      assert.equal(group.getResource(3), empty);
    }

    assert.notEqual(emptySources[0], emptySources[1]);
  } finally {
    for (const system of systems) {
      system.destroy();
    }
    input.destroy(true);
    back.destroy(true);
  }

  for (const source of emptySources) {
    assert.equal(source.destroyed, true);
    assert.equal(source.listenerCount("change"), 0);
  }
  assert.equal(pixi.Texture.EMPTY.source.listenerCount("change"), listeners);
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
    // Kept 5 s off the list, then emptied, its lines idle 5 s more.
    const idle = () => {
      for (let k = 0; k < 2; k++) {
        clock.at += 6000;
        view.prepare(root);
      }
    };
    view.prepare(root);
    const held = linesOf();
    assert.deepEqual(view.counts, { strokeContexts: 1, strokeReuses: 0 });

    // Off the list: kept a while, then given back, and gone once idle long enough. Its Graphics
    // go too, which Pixi would keep, with their geometry, for a minute.
    const graphics = view.stage.children[0].children[1].children[1].children[0].children[1];
    root.removeChild(branch);
    view.prepare(root);
    assert.equal(graphics.destroyed, false);
    assert.equal(held.destroyed, false);
    idle();
    assert.equal(graphics.destroyed, true);
    assert.equal(held.destroyed, true);

    // Back on: drawn again, not with the context destroyed.
    root.placeAtDepth(branch, 1);
    view.prepare(root);
    assert.equal(linesOf().destroyed, false);
    assert.notEqual(linesOf(), held);
    assert.deepEqual(view.counts, { strokeContexts: 2, strokeReuses: 0 });
    const back = view.stage.children[0].children[1].children[1].children[0].children[1];
    assert.notEqual(back, graphics);
    assert.equal(back.destroyed, false);

    // Off and on again before a render: nothing is given back or drawn again.
    root.removeChild(branch);
    root.placeAtDepth(branch, 1);
    view.prepare(root);
    assert.equal(view.stage.children[0].children[1].children[1].children[0].children[1], back);
    assert.equal(back.destroyed, false);
    assert.deepEqual(view.counts, { strokeContexts: 2, strokeReuses: 0 });

    // The branch off the list, then the shape off the branch, before a render:
    // the shape still gives its lines back, as the branch last drew it.
    const again = linesOf();
    root.removeChild(branch);
    branch.removeChild(shape);
    view.prepare(root);
    idle();
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

    idle();
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

test("instances of a morph at one ratio share its blend's fills, which go once the morph drops the blend", async () => {
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
          fills: [{ start: 0xffff0000, end: 0xff0000ff }],
          start: [{ fill1: 1, commands: square }],
          end: [square],
        }),
      ],
    }),
  );
  const t = swf.tags[0];
  const character = {
    type: "morph" as const,
    id: 1,
    morph: readMorphShape(swf.bytes, t.code, t.offset, t.length),
    blends: new Map(),
    bitmap: () => null,
  };
  const shapes = [ShapeObject.ofMorph(character), ShapeObject.ofMorph(character)];
  const root = new Container();
  root.placeAtDepth(shapes[0], 1);
  root.placeAtDepth(shapes[1], 2);
  const view = new PixiView(standIn([]).renderer);
  type Fill = { context: { destroyed: boolean } };
  const fill = (k: number) =>
    (view.stage.children[0].children[1 + k].children[0].children[0] as unknown as Fill).context;
  const draw = (ratio: number) => {
    for (const shape of shapes) {
      shape.ratio = ratio;
      shape.invalidate(CONTENT);
    }

    view.prepare(root);
  };

  view.prepare(root);
  const first = fill(0);
  assert.equal(fill(1), first);

  // Kept while the morph keeps its blend, though no one draws it.
  draw(1000);
  assert.equal(fill(0), fill(1));
  assert.notEqual(fill(0), first);
  assert.equal(first.destroyed, false);

  // Sixteen ratios later its blend is dropped, and the next frame its fills.
  for (let ratio = 2000; ratio <= 17000; ratio += 1000) {
    draw(ratio);
  }

  assert.equal(first.destroyed, true);
  assert.equal(fill(0).destroyed, false);

  // Off the list, they give the blend back, which goes once idle long enough.
  const last = fill(0);
  await withClock((clock) => {
    root.removeChild(shapes[0]);
    root.removeChild(shapes[1]);
    view.prepare(root);
    assert.equal(last.destroyed, false);
    // Kept 5 s with them, then idle 5 s.
    for (let k = 0; k < 2; k++) {
      clock.at += 6000;
      view.prepare(root);
    }

    assert.equal(last.destroyed, true);
  });
});

/** A shape character of one layer: a square filled and outlined. */
async function outlinedSquare() {
  const { ShapeObject } = await import("../../../packages/player/dist/display.js");
  const { MOVE, LINE } = await import("../../../packages/player/dist/shapes.js");
  const square = [MOVE, 0, 0, LINE, 10, 0, LINE, 10, 10, LINE, 0, 10, LINE, 0, 0];
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
  return {
    type: "shape" as const,
    id: 1,
    shape: {} as never,
    layers: [
      {
        fills: [
          { fill: { type: "solid", color: 0xff000000 }, contours: [square], winding: "evenOdd" },
        ],
        strokes: [{ line, paths: [square] }],
      },
    ],
  } as unknown as ConstructorParameters<typeof ShapeObject>[0];
}

test("instances of a shape share its fills, which go once none has drawn them for a while", async () => {
  const { ShapeObject } = await import("../../../packages/player/dist/display.js");
  const character = await outlinedSquare();
  const view = new PixiView(standIn([]).renderer);
  const root = new Container();
  const shapes = [new ShapeObject(character), new ShapeObject(character)];
  root.placeAtDepth(shapes[0], 1);
  root.placeAtDepth(shapes[1], 2);
  type Fill = { context: { destroyed: boolean } };
  const fill = (k: number) =>
    (view.stage.children[0].children[1 + k].children[0].children[0] as unknown as Fill).context;

  await withClock((clock) => {
    view.prepare(root);
    const first = fill(0);
    assert.equal(fill(1), first);

    // One instance gone for good: the other still draws them.
    root.removeChild(shapes[0]);
    view.prepare(root);
    clock.at += 20000;
    view.prepare(root);
    assert.equal(first.destroyed, false);
    assert.equal(fill(0), first);

    // Both gone: kept while parked and a while idle, then destroyed.
    root.removeChild(shapes[1]);
    view.prepare(root);
    clock.at += 6000;
    view.prepare(root);
    assert.equal(first.destroyed, false);
    clock.at += 6000;
    view.prepare(root);
    assert.equal(first.destroyed, true);

    // Placed again, it is drawn anew.
    root.placeAtDepth(shapes[0], 1);
    view.prepare(root);
    assert.notEqual(fill(0), first);
    assert.equal(fill(0).destroyed, false);
  });
});

test("a draw of a shape off the list borrows the stage's fills and lines", async () => {
  const { ShapeObject } = await import("../../../packages/player/dist/display.js");
  type Drawn = { context: { destroyed: boolean } };
  const seen: Drawn["context"][][] = [];
  const renderer = {
    render: ({ container }: { container: { children: { children: unknown[] }[] } }) => {
      // The draw's container: the object's, then its art, with its fill and lines.
      const art = container.children[0].children[0] as { children: Drawn[] };
      seen.push(art.children.map((g) => g.context));
    },
    extract: { pixels: () => ({ pixels: new Uint8ClampedArray(4) }) },
  } as unknown as ConstructorParameters<typeof PixiView>[0];
  const view = new PixiView(renderer);
  const root = new Container();
  const shape = new ShapeObject(await outlinedSquare());
  root.placeAtDepth(shape, 1);
  view.prepare(root);
  const [fill, lines] = view.stage.children[0].children[1].children[0]
    .children as unknown as Drawn[];
  const contexts = [fill.context, lines.context];

  // Off the list, its art goes; a BitmapData's draw of it on each frame still builds nothing.
  root.removeChild(shape);
  view.prepare(root);
  for (let k = 0; k < 2; k++) {
    view.snapshot(shape, { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 }, 1, 1, 1);
  }

  assert.equal(seen.length, 2);
  for (const drawn of seen) {
    assert.equal(drawn.length, 2);
    assert.ok(drawn.every((context, i) => context === contexts[i]));
  }

  assert.ok(contexts.every((context) => !context.destroyed));
});

test("a child moved out of a parent that leaves the list keeps what it draws", async () => {
  const { ShapeObject } = await import("../../../packages/player/dist/display.js");
  const view = new PixiView(standIn([]).renderer);
  const character = await outlinedSquare();
  type Drawn = { destroyed: boolean; context: { destroyed: boolean } };
  const root = new Container();
  const q = new Container();
  const x = new Container();
  const p = new Container();
  const s = new ShapeObject(character);
  p.placeAtDepth(s, 1);
  x.placeAtDepth(p, 1);
  root.placeAtDepth(q, 1);
  root.placeAtDepth(x, 2);
  view.prepare(root);
  // The root's art, Q's and X's containers; X's art, P's; P's art, S's; S's art and its fill and lines.
  const art = view.stage.children[0].children[2].children[1].children[1].children[0];
  const [fill, lines] = art.children as unknown as Drawn[];

  // In one frame, S into Q, and P, which last drew it, off the list.
  q.addChildAt(s, 0);
  x.removeChild(p);
  view.prepare(root);
  const inQ = view.stage.children[0].children[1].children[1].children[0];
  assert.equal(inQ, art);
  assert.equal(fill.destroyed, false);
  assert.equal(lines.destroyed, false);
  assert.equal(lines.context.destroyed, false);
});

test("a drawing off the list keeps what it drew a while, for it to come back to", async () => {
  const { Drawing } = await import("../../../packages/player/dist/drawing.js");
  const view = new PixiView(standIn([]).renderer);
  const root = new Container();
  const sprite = new Container();
  const drawing = new Drawing();
  drawing.beginFill({ type: "solid", color: 0xff336699 });
  drawing.drawRoundRect(0, 0, 30, 20, 6, 6);
  drawing.endFill();
  sprite.drawing = drawing;
  root.placeAtDepth(sprite, 1);
  type Drawn = { destroyed: boolean; context: { destroyed: boolean } };
  const fillOf = () =>
    view.stage.children[0].children[1].children[0].children[0] as unknown as Drawn;

  await withClock((clock) => {
    view.prepare(root);
    const fill = fillOf();
    const context = fill.context;

    // Back within the idle time: as it was, not built again.
    root.removeChild(sprite);
    view.prepare(root);
    clock.at += 4000;
    view.prepare(root);
    root.placeAtDepth(sprite, 1);
    view.prepare(root);
    assert.equal(fillOf(), fill);
    assert.equal(fill.context.destroyed, false);

    // Off longer: let go, and drawn again when it comes back.
    root.removeChild(sprite);
    view.prepare(root);
    clock.at += 6000;
    view.prepare(root);
    assert.equal(fill.destroyed, true);
    assert.equal(context.destroyed, true);
    root.placeAtDepth(sprite, 1);
    view.prepare(root);
    assert.notEqual(fillOf(), fill);
    assert.equal(fillOf().destroyed, false);
    assert.equal(fillOf().context.destroyed, false);
  });
});

test("a gradient a drawing off the list let go of leaves no warning in Pixi's bind groups", async () => {
  const { Drawing } = await import("../../../packages/player/dist/drawing.js");
  const cjs = createRequire(new URL("../../../packages/player/package.json", import.meta.url));
  const entry = pathToFileURL(cjs.resolve("pixi.js").replace(/\.js$/, ".mjs")).href;
  const { getTextureBatchBindGroup } = (await import(entry)) as {
    getTextureBatchBindGroup: (textures: unknown[], size: number, most: number) => unknown;
  };
  const view = new PixiView(standIn([]).renderer);
  const root = new Container();
  const sprite = new Container();
  const drawing = new Drawing();
  drawing.beginFill({
    type: "gradient",
    radial: false,
    focal: 0,
    stops: [
      { ratio: 0, color: 0xff000000 },
      { ratio: 255, color: 0xffffffff },
    ],
    spread: 0,
    linearRgb: false,
    matrix: { a: 0.05, b: 0, c: 0, d: 0.05, tx: 0, ty: 0 },
  });
  drawing.drawRect(0, 0, 80, 80);
  drawing.endFill();
  sprite.drawing = drawing;
  root.placeAtDepth(sprite, 1);
  type Drawn = {
    context: {
      instructions: { data: { style: { texture: { source: { destroyed: boolean } } } } }[];
    };
  };

  await withClock((clock) => {
    view.prepare(root);
    const fill = view.stage.children[0].children[1].children[0].children[0] as unknown as Drawn;
    const texture = fill.context.instructions[0].data.style.texture;
    const { source } = texture;
    // As Pixi's renderer caches the textures of a Graphics it draws unbatched.
    getTextureBatchBindGroup([texture], 1, 16);
    const warned: unknown[] = [];
    const warn = console.warn;
    console.warn = (...args: unknown[]) => warned.push(args);
    try {
      root.removeChild(sprite);
      view.prepare(root);
      clock.at += 6000;
      view.prepare(root);
    } finally {
      console.warn = warn;
    }

    assert.equal(source.destroyed, true);
    assert.deepEqual(warned, []);
    // The bind group cache keeps the source: not the bytes it was made from.
    assert.equal(
      (source as unknown as { options: { resource?: unknown } }).options.resource,
      undefined,
    );
  });
});

test("a drawing kept off the list is drawn again for a change of its content or of the screen's scale", async () => {
  const { Drawing } = await import("../../../packages/player/dist/drawing.js");
  const { CONTENT } = await import("../../../packages/player/dist/display.js");
  const view = new PixiView(standIn([]).renderer);
  view.screenScale = 1;
  const root = new Container();
  const sprite = new Container();
  const drawing = new Drawing();
  drawing.lineStyle({
    width: 0,
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
  } as unknown as Parameters<InstanceType<typeof Drawing>["lineStyle"]>[0]);
  drawing.beginFill({ type: "solid", color: 0xff336699 });
  drawing.drawRect(0, 0, 30, 20);
  drawing.endFill();
  sprite.drawing = drawing;
  root.placeAtDepth(sprite, 1);
  type Drawn = { destroyed: boolean; context: { destroyed: boolean } };
  const art = () => view.stage.children[0].children[1].children[0].children as unknown as Drawn[];
  view.prepare(root);
  const [fill, lines] = art();
  const lineContext = lines.context;

  // Off the list while the screen's scale changes: its hairlines are drawn again for it on return.
  root.removeChild(sprite);
  view.prepare(root);
  view.screenScale = 2;
  view.prepare(root);
  view.prepare(root);
  root.placeAtDepth(sprite, 1);
  view.prepare(root);
  assert.equal(art()[0], fill);
  assert.notEqual(art()[1].context, lineContext);
  assert.equal(art()[1].context.destroyed, false);

  // Off the list while its drawing changes: drawn again on return.
  root.removeChild(sprite);
  view.prepare(root);
  drawing.drawRect(40, 0, 10, 10);
  sprite.invalidate(CONTENT);
  root.placeAtDepth(sprite, 1);
  view.prepare(root);
  assert.equal(fill.destroyed, true);
  assert.equal(art()[0].destroyed, false);
  assert.notEqual(art()[0], fill);
});

test("a child emptied off the list is drawn again under a parent kept off it", async () => {
  const { Drawing } = await import("../../../packages/player/dist/drawing.js");
  const { ShapeObject } = await import("../../../packages/player/dist/display.js");
  const view = new PixiView(standIn([]).renderer);
  const root = new Container();
  const sprite = new Container();
  const drawing = new Drawing();
  drawing.beginFill({ type: "solid", color: 0xff336699 });
  drawing.drawRect(0, 0, 30, 20);
  drawing.endFill();
  sprite.drawing = drawing;
  // A container that draws nothing itself is emptied at once; the shape in it is kept.
  const middle = new Container();
  const shape = new ShapeObject(await outlinedSquare());
  middle.placeAtDepth(shape, 1);
  sprite.placeAtDepth(middle, 1);
  root.placeAtDepth(sprite, 1);
  type Drawn = { destroyed: boolean; context: { destroyed: boolean } };
  // The sprite's container: its art, then the middle's container: its art, then the shape's.
  const shapeArt = () =>
    view.stage.children[0].children[1].children[1].children[1].children[0]
      .children as unknown as Drawn[];
  view.prepare(root);
  const [fill] = shapeArt();

  root.removeChild(sprite);
  view.prepare(root);
  root.placeAtDepth(sprite, 1);
  view.prepare(root);
  assert.equal(shapeArt()[0], fill);
  assert.ok(shapeArt().every((g) => !g.destroyed && !g.context.destroyed));

  // The middle moved out and back, its shape with it: drawn again under the kept sprite.
  sprite.removeChild(middle);
  root.removeChild(sprite);
  view.prepare(root);
  sprite.placeAtDepth(middle, 1);
  root.placeAtDepth(sprite, 1);
  view.prepare(root);
  assert.equal(shapeArt().length, 2);
  assert.ok(shapeArt().every((g) => !g.destroyed && !g.context.destroyed));
});

test("a child moved into a parent off the list gives its lines back", async () => {
  const { ShapeObject } = await import("../../../packages/player/dist/display.js");
  const view = new PixiView(standIn([]).renderer);
  const root = new Container();
  const x = new Container();
  const away = new Container();
  const shape = new ShapeObject(await outlinedSquare());
  x.placeAtDepth(shape, 1);
  root.placeAtDepth(x, 1);
  type Drawn = { context: { destroyed: boolean } };
  view.prepare(root);
  const lines = (
    view.stage.children[0].children[1].children[1].children[0].children[1] as unknown as Drawn
  ).context;

  await withClock((clock) => {
    away.addChildAt(shape, 0);
    view.prepare(root);
    for (let k = 0; k < 2; k++) {
      clock.at += 6000;
      view.prepare(root);
    }

    assert.equal(lines.destroyed, true);
  });
});

test("a shared fill gathers no listener per instance, so instances go in linear time", async () => {
  const { ShapeObject } = await import("../../../packages/player/dist/display.js");
  const view = new PixiView(standIn([]).renderer);
  const root = new Container();
  const character = await outlinedSquare();
  for (let k = 1; k <= 3; k++) {
    root.placeAtDepth(new ShapeObject(character), k);
  }

  view.prepare(root);
  type Drawn = { context: { listenerCount(event: string): number } };
  const fill = view.stage.children[0].children[1].children[0].children[0] as unknown as Drawn;
  assert.equal(fill.context.listenerCount("update"), 0);
  assert.equal(fill.context.listenerCount("unload"), 0);
});

test("Pixi's pool of render data destroyed contexts gave back is emptied past its most, and what is in use stays", async () => {
  const cjs = createRequire(new URL("../../../packages/player/package.json", import.meta.url));
  const entry = pathToFileURL(cjs.resolve("pixi.js").replace(/\.js$/, ".mjs")).href;
  type Pool<T> = {
    get(data?: unknown): T;
    return(item: T): void;
    clear(): void;
    totalFree: number;
  };
  type Data = { batcher: unknown };
  const { BigPool, GraphicsContextRenderData } = (await import(entry)) as {
    BigPool: { getPool<T>(type: new () => T): Pool<T> };
    GraphicsContextRenderData: new () => Data;
  };
  const pool = BigPool.getPool(GraphicsContextRenderData);
  pool.clear();
  // Render data as a renderer pools it, with a batcher that counts its destruction: Pixi's own needs a canvas.
  let destroyed = 0;
  const made = (n: number) =>
    Array.from({ length: n }, () => {
      const data = new GraphicsContextRenderData();
      data.batcher = { destroy: () => destroyed++, _updateMaxTextures: () => {} };
      return data;
    });
  const view = new PixiView(standIn([]).renderer);
  const root = new Container();

  // A few pooled stay, for contexts to come.
  for (const data of made(100)) {
    pool.return(data);
  }

  view.prepare(root);
  assert.equal(pool.totalFree, 100);
  assert.equal(destroyed, 0);

  // Past the most, the pool is emptied: what was free is destroyed, what was taken is not.
  for (const data of made(100)) {
    pool.return(data);
  }

  const inUse = pool.get({ maxTextures: 16 });
  view.prepare(root);
  assert.equal(pool.totalFree, 0);
  assert.equal(destroyed, 199);
  assert.notEqual(inUse.batcher, null);
});

test("of many objects off the list at once, only the latest 1024 are kept whole", async () => {
  const { ShapeObject } = await import("../../../packages/player/dist/display.js");
  const view = new PixiView(standIn([]).renderer);
  const root = new Container();
  const character = await outlinedSquare();
  const shapes = Array.from({ length: 1100 }, (_, k) => {
    const shape = new ShapeObject(character);
    root.placeAtDepth(shape, k + 1);
    return shape;
  });
  view.prepare(root);
  type Drawn = { destroyed: boolean };
  const fills = view.stage.children[0].children
    .slice(1)
    .map((c) => c.children[0].children[0] as unknown as Drawn);

  for (const shape of shapes) {
    root.removeChild(shape);
  }

  view.prepare(root);
  assert.equal(fills.filter((g) => g.destroyed).length, 1100 - 1024);
  assert.equal(fills[0].destroyed, true);
  assert.equal(fills[1099].destroyed, false);
});

test("a blend's copy of what is behind it is held to the target and the texture, and clears nothing", async () => {
  // Loaded with the view, it patches the copy for every renderer.
  await import("../../../packages/player/dist/pixi-blend.js");
  const cjs = createRequire(new URL("../../../packages/player/package.json", import.meta.url));
  const entry = pathToFileURL(cjs.resolve("pixi.js").replace(/\.js$/, ".mjs")).href;
  const { RenderTargetSystem } = (await import(entry)) as {
    RenderTargetSystem: {
      prototype: { copyToTexture(this: unknown, ...args: unknown[]): unknown };
    };
  };
  type Copy = [number, number, number, number, number, number];
  // A target of 893×150 pixels and a back texture of 256×128.
  const copy = (from: [number, number], size: [number, number], to: [number, number] = [0, 0]) => {
    const copies: Copy[] = [];
    const clears: unknown[] = [];
    const system = {
      getRenderTarget: () => ({ pixelWidth: 893, pixelHeight: 150 }),
      adaptor: {
        copyToTexture: (
          _source: unknown,
          _destination: unknown,
          o: { x: number; y: number },
          s: { width: number; height: number },
          d: { x: number; y: number },
        ) => copies.push([o.x, o.y, s.width, s.height, d.x, d.y]),
      },
      push: (options: { clearColor: unknown }) => clears.push(options.clearColor),
      pop: () => {},
    };
    const destination = { source: { pixelWidth: 256, pixelHeight: 128 } };
    RenderTargetSystem.prototype.copyToTexture.call(
      system,
      {},
      destination,
      { x: from[0], y: from[1] },
      { width: size[0], height: size[1] },
      { x: to[0], y: to[1] },
    );
    return { copies, clears };
  };

  // Inside: copied as asked, nothing cleared.
  assert.deepEqual(copy([10, 20], [100, 50]), { copies: [[10, 20, 100, 50, 0, 0]], clears: [] });
  // A hair wider and taller than the texture: held to it, and nothing missed.
  assert.deepEqual(copy([10, 20], [257, 129]), { copies: [[10, 20, 256, 128, 0, 0]], clears: [] });
  // Past the top-left: what the target has goes where it belongs, the rest left as it is.
  assert.deepEqual(copy([-4, -6], [100, 50]), {
    copies: [[0, 0, 96, 44, 4, 6]],
    clears: [],
  });
  // Past the bottom-right: the copy stops at the target's edge.
  assert.deepEqual(copy([850, 120], [100, 50]), {
    copies: [[850, 120, 43, 30, 0, 0]],
    clears: [],
  });
  // Wholly beyond, which Pixi's own clamp left as a width of -1 or a height
  // of -3 that GL refused: no copy at all.
  assert.deepEqual(copy([894, 150], [10, 75]), { copies: [], clears: [] });
  assert.deepEqual(copy([205, -4], [174, 1]), { copies: [], clears: [] });
});

/** Pixi's bounds, as far as these tests use them. */
interface PixiBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  clear(): void;
  addFrame(x0: number, y0: number, x1: number, y1: number): void;
}

/** Pixi's own module, as the player loads it, with the player's patches to it. */
async function patchedPixi(): Promise<{
  Bounds: new (minX?: number, minY?: number, maxX?: number, maxY?: number) => PixiBounds;
  FilterEffect: new () => { filters: unknown };
  FilterSystem: { prototype: unknown };
}> {
  await import("../../../packages/player/dist/pixi-blend.js");
  const cjs = createRequire(new URL("../../../packages/player/package.json", import.meta.url));
  const entry = pathToFileURL(cjs.resolve("pixi.js").replace(/\.js$/, ".mjs")).href;
  return import(entry);
}

test("a filter's region lies on its texture's texels at a resolution that is no whole number", async () => {
  const { Bounds, FilterSystem } = await patchedPixi();
  const system = FilterSystem.prototype as unknown as {
    _calculateFilterBounds(this: unknown, data: unknown, ...rest: unknown[]): void;
  };
  const r = 1.5;
  const data = {
    bounds: new Bounds(10.3, 20.7, 50.2, 60.1),
    filters: [
      {
        enabled: true,
        resolution: "inherit",
        padding: 3,
        antialias: "off",
        clipToViewport: false,
        compatibleRenderers: 1,
        blendRequired: false,
      },
    ],
    skip: false,
    resolution: 0,
  };
  const stub = { renderer: { type: 1, backBuffer: { useBackBuffer: true } } };
  system._calculateFilterBounds.call(stub, data, { width: 1000, height: 1000 }, false, r, 1);

  // Pixi put it on the texels, then padded it by 3 pixels, 4.5 texels:
  // half a texel off them. It is put on them again, grown by the half.
  const { minX, minY, maxX, maxY } = data.bounds;
  assert.deepEqual(
    [minX, minY, maxX, maxY].map((v) => Math.round(v * r * 1e6) / 1e6),
    [10, 26, 81, 96],
  );
});

test("a blend's copy of what is behind it starts at the texel its region does", async () => {
  const { Bounds, FilterSystem } = await patchedPixi();
  const system = FilterSystem.prototype as unknown as {
    getBackTexture(this: unknown, surface: unknown, bounds: unknown, previous?: unknown): unknown;
  };
  const r = 1.6228571428571428;
  const copies: number[][] = [];
  const stub = {
    renderer: {
      renderTarget: {
        copyToTexture: (
          _source: unknown,
          _destination: unknown,
          o: { x: number; y: number },
          s: { width: number; height: number },
        ) => copies.push([o.x, o.y, s.width, s.height]),
      },
    },
  };
  const surface = { colorTexture: { source: { resolution: r } } };

  // A blend in a layer, its region 18 texels left of and 3 above the
  // layer's, a hair short of whole: Pixi's floor took 19 and 4, and the
  // blend read, along its region's top and left, texels never copied.
  const layer = new Bounds(531 / r, 140 / r, 600 / r, 200 / r);
  const blend = new Bounds(513 / r - 1e-12, 137 / r - 1e-12, 560 / r, 170 / r);
  system.getBackTexture.call(stub, surface, blend, layer);
  assert.deepEqual(copies, [[-18, -3, 47, 33]]);
});

test("a layer's region holds its filtered children's padding, but not its own", async () => {
  const { Bounds, FilterEffect, FilterSystem } = await patchedPixi();
  const system = FilterSystem.prototype as unknown as {
    _calculateFilterArea(this: unknown, instruction: unknown, bounds: unknown): void;
  };
  type Padded = { filters: unknown; addBounds(b: unknown, skip: boolean): void };
  const effect = (...paddings: number[]) => {
    const e = new FilterEffect();
    // The second filter disabled.
    e.filters = paddings.map((padding, i) => ({ enabled: i !== 1, padding }));
    return e as Padded;
  };
  const own = effect(7);
  const child = effect(4, 10, 2.5);
  // Measured as Pixi measures: the shapes, then the effects, the child's and the object's own.
  const container = {
    parentRenderGroup: {},
    getFastGlobalBounds(_layers: boolean, bounds: PixiBounds) {
      bounds.clear();
      bounds.addFrame(10, 20, 30, 40);
      child.addBounds(bounds, true);
      own.addBounds(bounds, true);
      return bounds;
    },
  };
  const bounds = new Bounds();
  system._calculateFilterArea.call({}, { container, filterEffect: own }, bounds);
  assert.deepEqual([bounds.minX, bounds.minY, bounds.maxX, bounds.maxY], [4, 14, 36, 46]);

  // Measured for anything else, its own is padded too.
  container.getFastGlobalBounds(true, bounds);
  assert.deepEqual([bounds.minX, bounds.minY, bounds.maxX, bounds.maxY], [-3, 7, 43, 53]);
});

test("large branches keep their own instructions as they shrink, without grouping their wrappers", () => {
  const view = new PixiView(standIn([]).renderer);
  const root = new Container();
  const branch = new Container();
  const store = new BitmapStore(1, 1, false, 0xffffff);
  root.placeAtDepth(branch, 1);
  for (let i = 0; i < 64; i++) {
    branch.placeAtDepth(new BitmapObject(store), i + 1);
  }

  view.prepare(root);
  const top = view.stage.children[0];
  const grouped = top.children[1];
  assert.equal(grouped.isRenderGroup, true);
  assert.equal(top.isRenderGroup, false);
  const instructions = grouped.renderGroup;
  for (const child of [...branch.children].slice(1)) {
    branch.removeChild(child);
  }

  view.prepare(root);
  assert.equal(grouped.renderGroup, instructions);
  store.dispose();
});

test("mask partners share a group, including when an existing group's mask moves outside it", () => {
  const view = new PixiView(standIn([]).renderer);
  const root = new Container();
  const panel = new Container();
  const art = new Container();
  const mask = new Container();
  const store = new BitmapStore(1, 1, false, 0xffffff);
  root.placeAtDepth(panel, 1);
  panel.placeAtDepth(art, 1);
  panel.placeAtDepth(mask, 2);
  for (let i = 0; i < 64; i++) {
    art.placeAtDepth(new BitmapObject(store), i + 1);
  }

  view.prepare(root);
  const p = view.stage.children[0].children[1];
  const a = p.children[1];
  assert.equal(a.isRenderGroup, true);
  art.setMask(mask);
  view.prepare(root);
  assert.equal(a.isRenderGroup, false);
  assert.equal(p.isRenderGroup, true);

  // Reparenting a partner invalidates the old and new ancestors, even though the mask is unchanged.
  root.placeAtDepth(mask, 2);
  view.prepare(root);
  assert.equal(p.isRenderGroup, false);
  assert.equal(a.isRenderGroup, false);
  art.setMask(null);
  view.prepare(root);
  assert.equal(a.isRenderGroup, true);
  store.dispose();
});

test("a gradient a drawing redrew is freed once, though its fill was collected first", async () => {
  // A colour picker redraws its gradient on each move of the pointer: the
  // old fill may be collected before the view lets go of its texture.
  const { Drawing } = await import("../../../packages/player/dist/drawing.js");
  const view = new PixiView(standIn([]).renderer);
  const root = new Container();
  const sprite = new Container();
  const drawing = new Drawing();
  const draw = (color: number) => {
    drawing.clear();
    drawing.beginFill({
      type: "gradient",
      radial: false,
      focal: 0,
      stops: [
        { ratio: 0, color: 0xff000000 },
        { ratio: 255, color },
      ],
      spread: 0,
      linearRgb: false,
      matrix: { a: 0.05, b: 0, c: 0, d: 0.05, tx: 0, ty: 0 },
    });
    drawing.drawRect(0, 0, 80, 80);
    drawing.endFill();
    sprite.invalidate(CONTENT);
  };
  sprite.drawing = drawing;
  root.placeAtDepth(sprite, 1);

  type Drawn = {
    context: { instructions: { data: { style: { texture: { destroyed: boolean } } } }[] };
  };
  const shown = () =>
    (view.stage.children[0].children[1].children[0].children[0] as unknown as Drawn).context
      .instructions[0].data.style.texture;
  draw(0xff000000);
  view.prepare(root);
  const textures = [shown()];
  for (let i = 1; i < 4; i++) {
    // Drawn again, its old fill gone from the drawing, and collected before the view syncs.
    draw(0xff000000 | (i * 0x404040));
    for (let j = 0; j < 3; j++) {
      gc();
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    view.prepare(root);
    textures.push(shown());
  }

  // Each freed as the next took its place, and the one shown kept.
  assert.deepEqual(
    textures.map((t) => t.destroyed),
    [true, true, true, false],
  );
});
