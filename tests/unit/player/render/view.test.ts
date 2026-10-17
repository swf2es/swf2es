// The renderer's GPU copies of bitmaps, with renderers that stand in for
// WebGL's: each keeps its own copy of a store, and one shows what another
// drew by reading it back through the renderer that drew it.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { BitmapStore } from "../../../../packages/player/dist/bitmap/bitmap.js";
import {
  BitmapObject,
  CONTENT,
  Container,
  TRANSFORM,
} from "../../../../packages/player/dist/display/display.js";
import type { Player } from "../../../../packages/player/dist/player.js";
import { PixiView } from "../../../../packages/player/dist/render/view.js";

setFlagsFromString("--expose-gc");
const gc = runInNewContext("gc") as () => void;

/** A renderer that draws nothing and reads back `pixels`, counting its reads and keeping its uploads. */
function standIn(pixels: number[]) {
  const reads: unknown[] = [];
  const uploads: number[][] = [];
  const renderer = {
    render: () => {},
    texture: {
      initSource: (source: { resource: Uint8Array | null }) => {
        if (source.resource) {
          uploads.push([...source.resource]);
        }
      },
    },
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
  return {
    renderer: renderer as unknown as ConstructorParameters<typeof PixiView>[0],
    reads,
    uploads,
  };
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
  // Uploaded as the first drew it, and the bytes let go of after.
  assert.deepEqual(b.uploads, [drawn]);
  const theirs = [...store.copies].find((copy) => copy !== store.gpu) as unknown as {
    source: { resource: Uint8Array | null };
  };
  assert.equal(theirs.source.resource, null);

  // Read once: the first renderer is not asked again.
  second.render(new BitmapObject(store));
  assert.equal(a.reads.length, 1);

  store.dispose();
  assert.equal(store.copies.size, 0);
});

test("a renderer destroyed lets go of its copies of the stores it showed, which may outlive it", () => {
  const destroyers: { destroy(): void }[] = [];
  const renderer = {
    ...standIn([]).renderer,
    runners: { destroy: { add: (runner: { destroy(): void }) => destroyers.push(runner) } },
  } as unknown as ConstructorParameters<typeof PixiView>[0];
  const view = new PixiView(renderer);
  const store = new BitmapStore(2, 1, true, 0);
  store.setPixel32(0, 0, 0xff102030);
  view.render(new BitmapObject(store));
  assert.equal(store.copies.size, 1);

  for (const runner of destroyers) {
    runner.destroy();
  }

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
  const { batcherNameFor } = await import("../../../../packages/player/dist/render/color.js");
  const cjs = createRequire(new URL("../../../../packages/player/package.json", import.meta.url));
  const entry = pathToFileURL(cjs.resolve("pixi.js").replace(/\.js$/, ".mjs")).href;
  const { BatchableMesh, BatchableSprite } = (await import(entry)) as {
    BatchableMesh: new () => { batcherName: string; renderable: unknown };
    BatchableSprite: new () => { batcherName: string; renderable: unknown };
  };
  type Element = Parameters<typeof batcherNameFor>[0];
  const sprite = new BatchableSprite();
  assert.equal(batcherNameFor(sprite as unknown as Element), "default");
  sprite.batcherName = "host-custom";
  assert.equal(batcherNameFor(sprite as unknown as Element), "host-custom");

  const ct = { rMul: 1, gMul: 1, bMul: 1, aMul: 1, rAdd: 10, gAdd: 0, bAdd: 0, aAdd: 0 };
  sprite.renderable = { flashColor: ct };
  assert.equal(batcherNameFor(sprite as unknown as Element), "flash-color");
  sprite.renderable = { flashColor: null };
  assert.equal(batcherNameFor(sprite as unknown as Element), "host-custom");

  // A mesh, which the colour batcher does not pack, keeps its own.
  const mesh = new BatchableMesh();
  mesh.renderable = { flashColor: ct };
  assert.equal(batcherNameFor(mesh as unknown as Element), "default");
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
  const cjs = createRequire(new URL("../../../../packages/player/package.json", import.meta.url));
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
/** Pixi's module, as the player loads it. */
const pixiEntry = pathToFileURL(
  createRequire(new URL("../../../../packages/player/package.json", import.meta.url))
    .resolve("pixi.js")
    .replace(/\.js$/, ".mjs"),
).href;
const { BatcherPipe } = (await import(pixiEntry)) as { BatcherPipe: { prototype: object } };

/**
 * Pixi's batch pipe as the player uses it, its batchers stood in for: kept
 * by instruction set, taken out (takeBatchers, Pixi's own), and given to a
 * new set as it builds (batchersFor), or made.
 */
function batchPipe() {
  type Batchers = Record<string, { name: string; destroy(): void }>;
  const destroyed: string[] = [];
  const pipe = Object.assign(Object.create(BatcherPipe.prototype) as object, {
    _batchersByInstructionSet: {} as Record<number, Batchers | undefined>,
    batchersFor: null as ((set: { uid: number }) => Batchers | undefined) | null,
    buildStart(set: { uid: number }) {
      this._batchersByInstructionSet[set.uid] ??=
        this.batchersFor?.(set) ??
        Object.fromEntries(
          ["default", "flash-color"].map((name) => [
            name,
            { name, destroy: () => destroyed.push(name) },
          ]),
        );
    },
  });
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
  for (const [index, art] of arts.entries()) {
    art.setMask(masks[index]);
  }

  view.prepare(root);
  assert.equal(
    panels.some((panel) => panel.children[1].isRenderGroup),
    false,
  );
  assert.deepEqual(destroyed.sort(), ["default", "flash-color"]);

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

  // Given back again, and taken again.
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
  const cjs = createRequire(new URL("../../../../packages/player/package.json", import.meta.url));
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
  const pointer = {
    captured: false,
    post: (p: { x: number }) => calls.push(`post ${p.x}`),
    flush: () => calls.push("flush"),
    handle: (type: string, p: { x: number }) => {
      calls.push(`${type} ${p.x}`);
      pointer.captured &&= type !== "up";
    },
    cursor: () => "default",
  };
  const player = { width: 100, height: 100, pointer } as unknown as Player;
  const frames: (() => void)[] = [];
  const g = globalThis as { requestAnimationFrame?: unknown; cancelAnimationFrame?: unknown };
  g.requestAnimationFrame = (f: () => void) => frames.push(f);
  g.cancelAnimationFrame = (id: number) => {
    frames[id - 1] = () => {};
  };
  try {
    const unbind = view.bindPointer(player);
    const at = (x: number) => ({ global: { x, y: 0 }, button: 0, buttons: 0 }) as never;
    view.stage.emit("globalpointermove", at(1));
    view.stage.emit("globalpointermove", at(2));
    view.stage.emit("pointerdown", at(3));
    assert.deepEqual(calls, ["post 1", "post 2", "down 3"]);
    assert.equal(frames.length, 1);
    frames[0]();
    assert.deepEqual(calls.slice(3), ["flush"]);

    // A move off the canvas is the player's only while it holds the mouse,
    // and a release off it is a release, then, at the next move off it, the
    // leave the press held back, once.
    view.stage.emit("globalpointermove", at(150));
    pointer.captured = true;
    view.stage.emit("globalpointermove", at(160));
    view.stage.emit("pointerupoutside", at(170));
    view.stage.emit("globalpointermove", at(180));
    view.stage.emit("globalpointermove", at(190));
    assert.deepEqual(calls.slice(4), ["post 160", "up 170", "leave 180"]);
    // A release outside that held nothing leaves nothing: the leave came as the pointer left.
    view.stage.emit("pointerupoutside", at(170));
    view.stage.emit("globalpointermove", at(180));
    assert.deepEqual(calls.slice(7), ["up 170"]);
    frames[1]();

    view.stage.emit("globalpointermove", at(4));
    unbind();
    frames[2]();
    assert.deepEqual(calls.slice(8), ["flush", "post 4", "flush"]);
  } finally {
    delete g.requestAnimationFrame;
    delete g.cancelAnimationFrame;
  }
});

test("Pixi touch pointers go to the player's touches, the mouse's alone to its pointer", () => {
  const listeners = new Map<string, (e: unknown) => void>();
  const canvas = {
    style: { cursor: "" },
    addEventListener: (type: string, f: (e: unknown) => void) => listeners.set(type, f),
    removeEventListener: (type: string) => listeners.delete(type),
  };
  const renderer = {
    screen: { width: 100, height: 100 },
    canvas,
  } as unknown as ConstructorParameters<typeof PixiView>[0];
  const view = new PixiView(renderer);
  const calls: string[] = [];
  const player = {
    width: 200,
    height: 200,
    pointer: {
      post: () => {},
      flush: () => {},
      handle: (type: string, p: { x: number }) => calls.push(`mouse ${type} ${p.x}`),
      cursor: () => "default",
    },
    touch: {
      post: () => {},
      flush: () => {},
      handle: (type: string, t: { x: number; id: number; primary: boolean; width: number }) =>
        calls.push(`touch ${type} ${t.x} ${t.id} ${t.primary} ${t.width}`),
    },
  } as unknown as Player;
  const unbind = view.bindPointer(player);
  const at = (x: number, pointerType: string, pointerId = 1, isPrimary = true) =>
    ({
      global: { x, y: 0 },
      button: 0,
      buttons: 0,
      pointerType,
      pointerId,
      isPrimary,
      width: 3,
      height: 3,
      pressure: 0.5,
    }) as never;
  view.stage.emit("pointerdown", at(1, "touch"));
  view.stage.emit("pointerdown", at(2, "touch", 2, false));
  view.stage.emit("globalpointermove", at(3, "touch"));
  view.stage.emit("pointerup", at(4, "touch"));
  view.stage.emit("pointerupoutside", at(5, "touch", 2, false));
  // A finger lifted leaves the canvas; the mouse it moved stays where it was.
  view.stage.emit("pointerleave", at(5, "touch"));
  view.stage.emit("pointerdown", at(6, "mouse"));
  view.stage.emit("pointerdown", at(7, "pen"));
  // A cancel ends a touch where it last was, wherever the browser says it is.
  view.stage.emit("pointerdown", at(8, "touch", 3));
  const cancel = listeners.get("pointercancel");
  assert.ok(cancel);
  cancel({ pointerType: "touch", pointerId: 3, clientX: 999, clientY: 999, timeStamp: 1 });
  cancel({ pointerType: "touch", pointerId: 3, clientX: 999, clientY: 999, timeStamp: 2 });
  unbind();
  assert.equal(listeners.has("pointercancel"), false);
  // Stage units: the stage is twice the screen, so are the contact's width and the points.
  assert.deepEqual(calls, [
    "touch begin 2 1 true 6",
    "touch begin 4 2 false 6",
    "touch move 6 1 true 6",
    "touch end 8 1 true 6",
    "touch end 10 2 false 6",
    "mouse down 12",
    "mouse down 14",
    "touch begin 16 3 true 6",
    "touch cancel 16 3 true 6",
  ]);
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
  const { filterDefaults } = await import("../../../../packages/player/dist/display/filters.js");
  const cjs = createRequire(new URL("../../../../packages/player/package.json", import.meta.url));
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

test("filters set again with the same values keep their chain, and its output, as a tween writes them", async () => {
  const { filterDefaults } = await import("../../../../packages/player/dist/display/filters.js");
  const cjs = createRequire(new URL("../../../../packages/player/package.json", import.meta.url));
  const entry = pathToFileURL(cjs.resolve("pixi.js").replace(/\.js$/, ".mjs")).href;
  const pixi = (await import(entry)) as {
    DOMAdapter: { get(): object; set(adapter: object): void };
  };
  const adapter = pixi.DOMAdapter.get();
  pixi.DOMAdapter.set({ ...adapter, createCanvas: () => ({ getContext: () => null }) });
  try {
    const { renderer } = standIn([]);
    (renderer as unknown as { type: number }).type = 1;
    const view = new PixiView(renderer);
    const o = new Container();
    const glow = (blur: number) => [{ ...filterDefaults("glow"), blurX: blur, blurY: blur }];
    const chainOf = () =>
      (view.stage.children[0] as unknown as { filters: unknown[] | null }).filters?.[0];
    const set = (filters: ReturnType<typeof glow>) => {
      o.filters = filters;
      o.invalidate(TRANSFORM);
      view.prepare(o);
    };

    set(glow(4));
    const first = chainOf();
    assert.ok(first);
    set(glow(4));
    assert.equal(chainOf(), first);
    set(glow(5));
    assert.notEqual(chainOf(), first);
  } finally {
    pixi.DOMAdapter.set(adapter);
  }
});

test("blurred filter inputs release pooled textures without sharing idle listeners", async () => {
  const { filterDefaults } = await import("../../../../packages/player/dist/display/filters.js");
  const { displayFilters } = await import("../../../../packages/player/dist/render/filters.js");
  const cjs = createRequire(new URL("../../../../packages/player/package.json", import.meta.url));
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
  const cjs = createRequire(new URL("../../../../packages/player/package.json", import.meta.url));
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
  const { filterDefaults } = await import("../../../../packages/player/dist/display/filters.js");
  const { displayFilters } = await import("../../../../packages/player/dist/render/filters.js");
  const cjs = createRequire(new URL("../../../../packages/player/package.json", import.meta.url));
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
  const { ShapeObject, CONTENT } = await import(
    "../../../../packages/player/dist/display/display.js"
  );
  const { Drawing } = await import("../../../../packages/player/dist/display/drawing.js");
  const { MOVE, LINE } = await import("../../../../packages/player/dist/display/shapes.js");
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

  // Idle a while: those no one holds go after 30 s, however many renders, the held stay.
  const first = lines(0);
  b.setMatrix({ ...b.matrix, a: 5, d: 5 });
  turn(a, 6);
  await withClock(async (clock) => {
    view.prepare(root);
    for (let k = 0; k < 500; k++) {
      clock.at += 59;
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

test("idle lines go, the oldest first, past half a million vertices however recent", async () => {
  // Kept 30 s, a crowd's lines would otherwise hoard what the many stretches it shows tessellate.
  const { ShapeObject } = await import("../../../../packages/player/dist/display/display.js");
  const character = await outlinedSquare();
  const view = new PixiView(standIn([]).renderer);
  const root = new Container();
  const shape = new ShapeObject(character);
  root.placeAtDepth(shape, 1);
  type Lines = { context: { destroyed: boolean; _gpuData: Record<number, unknown> } };
  const lines = () =>
    (view.stage.children[0].children[1].children[0].children[1] as unknown as Lines).context;
  // Each scale a context Pixi tessellated into 200,000 vertices, given back for the next.
  const drawn: Lines["context"][] = [];
  for (const s of [1, 2, 3, 4]) {
    shape.setMatrix({ a: s, b: 0, c: 0, d: s, tx: 0, ty: 0 });
    view.prepare(root);
    const context = lines();
    context._gpuData[1] = { geometryData: { vertices: new Array(400_000) }, destroy() {} };
    drawn.push(context);
  }

  // Three idle, 600,000 vertices: the oldest went as the third did.
  assert.deepEqual(
    drawn.map((context) => context.destroyed),
    [true, false, false, false],
  );
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
  const { ShapeObject } = await import("../../../../packages/player/dist/display/display.js");
  const { MOVE, LINE } = await import("../../../../packages/player/dist/display/shapes.js");
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
  const { ShapeObject } = await import("../../../../packages/player/dist/display/display.js");
  const { MOVE, LINE } = await import("../../../../packages/player/dist/display/shapes.js");
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
  const { ShapeObject } = await import("../../../../packages/player/dist/display/display.js");
  const { MOVE, LINE } = await import("../../../../packages/player/dist/display/shapes.js");
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
    // Kept 5 s off the list, then emptied, its lines idle 30 s more.
    const idle = () => {
      for (const step of [6000, 31_000]) {
        clock.at += step;
        view.prepare(root);
      }
    };
    view.prepare(root);
    const held = linesOf();
    assert.deepEqual(view.counts, { strokeContexts: 1, strokeReuses: 0 });

    // Off the list: kept a while, then given back, and gone once idle long enough. Its Graphics
    // let go of it too, which Pixi would keep, with its geometry, for a minute: taken off and
    // kept, showing nothing, for the next content to take.
    const graphics = view.stage.children[0].children[1].children[1].children[0]
      .children[1] as unknown as { parent: unknown; destroyed: boolean; context: unknown };
    root.removeChild(branch);
    view.prepare(root);
    assert.equal(graphics.destroyed, false);
    assert.equal(held.destroyed, false);
    idle();
    assert.equal(graphics.parent, null);
    assert.notEqual(graphics.context, held);
    assert.equal(held.destroyed, true);

    // Back on: drawn again, not with the context destroyed.
    root.placeAtDepth(branch, 1);
    view.prepare(root);
    assert.equal(linesOf().destroyed, false);
    assert.notEqual(linesOf(), held);
    assert.deepEqual(view.counts, { strokeContexts: 2, strokeReuses: 0 });
    const back = view.stage.children[0].children[1].children[1].children[0].children[1];
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
  const { filterDefaults } = await import("../../../../packages/player/dist/display/filters.js");
  const cjs = createRequire(new URL("../../../../packages/player/package.json", import.meta.url));
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

test("filters blur, move and pad in pixels of the stage however far a host zooms it, as Flash Player's", async () => {
  const { filterDefaults } = await import("../../../../packages/player/dist/display/filters.js");
  const cjs = createRequire(new URL("../../../../packages/player/package.json", import.meta.url));
  const entry = pathToFileURL(cjs.resolve("pixi.js").replace(/\.js$/, ".mjs")).href;
  const pixi = await import(entry);
  const adapter = pixi.DOMAdapter.get();
  pixi.DOMAdapter.set({ ...adapter, createCanvas: () => ({ getContext: () => null }) });
  const inputs: { destroy(all: boolean): void }[] = [];
  try {
    const filtered = new Container();
    const at = { angle: 0, blurX: 4, blurY: 4, quality: 1 };
    filtered.filters = [
      { ...filterDefaults("glow"), ...at },
      { ...filterDefaults("dropShadow"), ...at, distance: 4 },
      { ...filterDefaults("bevel"), ...at, distance: 2 },
      { ...filterDefaults("gradientGlow"), ...at, distance: 4 },
    ];
    const { renderer } = standIn([0, 0, 0, 0]);
    const settable = renderer as unknown as {
      resolution: number;
      type: number;
      render(options: { container: unknown }): void;
    };
    settable.resolution = 3;
    settable.type = 1;
    const view = new PixiView(renderer);
    type Pass = { resources: Record<string, { uniforms?: Record<string, unknown> } | undefined> };
    type Flash = Pass & {
      padding: number;
      apply(system: unknown, input: unknown, output: unknown, clear: boolean): void;
    };
    type Chain = { units: number; filters: Flash[] };
    const chainOf = (container: unknown) =>
      (container as { filters?: Chain[] | null } | undefined)?.filters?.[0];
    const chain = () => chainOf(view.stage.children[0]) as Chain;
    const round = (v: number) => Math.round(v * 1000) / 1000;
    // Each filter's box widths in texels, its padding and offset in the renderer's units, and
    // the gradient's region, where it draws, in them too.
    const run = () => {
      const input = pixi.RenderTexture.create({
        width: 64,
        height: 64,
        resolution: settable.resolution,
      });
      inputs.push(input);
      return chain().filters.map((filter) => {
        const widths: number[] = [];
        const system = {
          applyFilter(pass: Pass) {
            const box = pass.resources.boxUniforms?.uniforms;
            if (box) {
              widths.push(box.uWidth as number);
              // Each step a texel of the input, however many make a stage pixel.
              const [dx, dy] = box.uDirection as Float32Array;
              assert.equal(round(dx + dy), round(1 / settable.resolution));
            }
          },
        };
        filter.apply(system, input, input, true);
        const { glowUniforms, bevelUniforms, gradientUniforms } = filter.resources;
        const uniforms = (glowUniforms ?? bevelUniforms ?? gradientUniforms)?.uniforms as Record<
          string,
          Float32Array
        >;
        const out = {
          widths,
          padding: filter.padding,
          offset: [...uniforms.uOffset].map(round),
        };
        return uniforms.uRegion ? { ...out, region: [...uniforms.uRegion].map(round) } : out;
      });
    };

    // Shown three screen pixels to a stage pixel, as a host zooming by the renderer's resolution
    // does: boxes 4 stage pixels, 12 texels wide, and reaches of 2, 6, 4 and 7 stage pixels (the
    // gradient's rect 6 right, 2 up and down), three times as far on the screen.
    const zoomed = [
      { widths: [12, 12], padding: 2, offset: [0, 0] },
      { widths: [12, 12], padding: 6, offset: [4, 0] },
      { widths: [12, 12], padding: 4, offset: [2, 0] },
      { widths: [12, 12], padding: 7, offset: [4, 0], region: [7, 5, 64, 60] },
    ];
    view.prepare(filtered);
    assert.equal(chain().units, 1);
    assert.deepEqual(run(), zoomed);

    // Averaged down to the screen, as the test page draws, alike: the screen does not count.
    view.screenScale = 1;
    view.prepare(filtered);
    assert.deepEqual(run(), zoomed);

    // Shown at half its size: the boxes 2 texels wide, the reaches as many stage pixels.
    view.screenScale = null;
    settable.resolution = 0.5;
    view.prepare(filtered);
    assert.deepEqual(
      run().map((r) => r.widths),
      [
        [2, 2],
        [2, 2],
        [2, 2],
        [2, 2],
      ],
    );

    // Off the list while the stage is scaled to half, then back: scaled all the same, a stage
    // pixel half a unit, which the padding reaches round.
    settable.resolution = 3;
    view.stage.scale.set(0.5);
    view.prepare(new Container());
    view.prepare(filtered);
    assert.equal(chain().units, 0.5);
    assert.deepEqual(run(), [
      { widths: [6, 6], padding: 1, offset: [0, 0] },
      { widths: [6, 6], padding: 3, offset: [2, 0] },
      { widths: [6, 6], padding: 2, offset: [1, 0] },
      { widths: [6, 6], padding: 4, offset: [2, 0], region: [4, 3, 63.5, 61.5] },
    ]);

    // A stage scaled to nothing filters at a unit a pixel.
    view.stage.scale.set(0);
    view.prepare(filtered);
    assert.equal(chain().units, 1);

    // A filtered child, clean below its root, follows the stage's scale as well.
    type Tree = { filters?: readonly unknown[] | null; children?: readonly unknown[] };
    const chainBelow = (t: unknown): Chain | undefined =>
      chainOf(t) ?? (t as Tree).children?.map(chainBelow).find((c) => c);
    const holder = new Container();
    holder.addChildAt(filtered, 0);
    view.stage.scale.set(1);
    view.prepare(holder);
    assert.equal(chainBelow(view.stage.children[0])?.units, 1);
    view.stage.scale.set(2);
    view.prepare(holder);
    assert.equal(chainBelow(view.stage.children[0])?.units, 2);

    // Drawn into a BitmapData at 4 samples a side: a bitmap pixel 4 units of the target.
    let drawnAt = 0;
    settable.render = ({ container }) => {
      const drawn = chainOf((container as { children: unknown[] }).children[0]);
      drawnAt ||= drawn?.units ?? 0;
    };
    const glowing = new Container();
    glowing.filters = [{ ...filterDefaults("glow"), ...at }];
    view.snapshot(glowing, { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 }, 1, 1, 4);
    assert.equal(drawnAt, 4);
  } finally {
    for (const input of inputs) {
      input.destroy(true);
    }
    pixi.DOMAdapter.set(adapter);
  }
});

test("a filtered object's colour colours its chain's output, not what is in it", async () => {
  // adl colours a filtered object's bitmap, glow and all: what is in it is drawn as though nothing
  // above it were coloured (the `blend-filtered-alpha` case).
  const { ShapeObject, TRANSFORM } = await import(
    "../../../../packages/player/dist/display/display.js"
  );
  const { filterDefaults } = await import("../../../../packages/player/dist/display/filters.js");
  const cjs = createRequire(new URL("../../../../packages/player/package.json", import.meta.url));
  const entry = pathToFileURL(cjs.resolve("pixi.js").replace(/\.js$/, ".mjs")).href;
  const pixi = (await import(entry)) as {
    DOMAdapter: { get(): object; set(adapter: object): void };
  };
  const adapter = pixi.DOMAdapter.get();
  pixi.DOMAdapter.set({ ...adapter, createCanvas: () => ({ getContext: () => null }) });
  try {
    const { renderer } = standIn([]);
    (renderer as unknown as { type: number }).type = 1;
    const view = new PixiView(renderer);
    const root = new Container();
    const ct = (aMul: number, rAdd: number) => ({
      rMul: 1,
      gMul: 1,
      bMul: 1,
      aMul,
      rAdd,
      gAdd: 0,
      bAdd: 0,
      aAdd: 0,
    });
    const outer = new Container();
    outer.colorTransform = ct(0.5, 0);
    const glowing = new Container();
    glowing.colorTransform = ct(0.8, 40);
    glowing.filters = [{ ...filterDefaults("glow"), blurX: 4, blurY: 4 }];
    const shape = new ShapeObject(await outlinedSquare());
    shape.colorTransform = ct(1, 20);
    glowing.placeAtDepth(shape, 1);
    outer.placeAtDepth(glowing, 1);
    root.placeAtDepth(outer, 1);
    view.prepare(root);

    type Node = {
      alpha: number;
      renderable: boolean;
      colorRoot: boolean;
      filters: { resources: { colorUniforms: { uniforms: { uMul: number[]; uAdd: number[] } } } }[];
      children: Node[];
      flashColor?: { aMul: number; rAdd: number } | null;
    };
    const outerContainer = view.stage.children[0].children[1] as unknown as Node;
    const glowingContainer = outerContainer.children[1];
    assert.equal(outerContainer.colorRoot, false);
    assert.equal(outerContainer.alpha, 0.5);
    assert.equal(glowingContainer.colorRoot, true);
    assert.equal(glowingContainer.alpha, 1);
    // The chain takes the colour from the stage down: the parent's alpha and its own.
    const uniforms = glowingContainer.filters[0].resources.colorUniforms.uniforms;
    assert.equal(uniforms.uMul[3], Math.fround(0.4));
    assert.equal(uniforms.uAdd[0], Math.fround(40 / 255));
    // What is in it takes its own alone.
    const art = glowingContainer.children[1].children[0].children;
    assert.ok(art.length > 0);
    assert.ok(art.every((g) => g.flashColor?.rAdd === 20 && g.flashColor.aMul === 1));

    // Faded further, the chain's colour changes; what is in it does not.
    outer.colorTransform = ct(0.25, 0);
    outer.invalidate(TRANSFORM);
    view.prepare(root);
    assert.equal(uniforms.uMul[3], Math.fround(0.2));
    assert.ok(art.every((g) => g.flashColor?.rAdd === 20 && g.flashColor.aMul === 1));
    assert.equal(glowingContainer.renderable, true);

    // Faded out, it is not drawn and its filters do not run, as Pixi skips an alpha of 0; faded
    // in again, it is.
    outer.colorTransform = ct(0, 0);
    outer.invalidate(TRANSFORM);
    view.prepare(root);
    assert.equal(glowingContainer.renderable, false);
    outer.colorTransform = ct(0.5, 0);
    outer.invalidate(TRANSFORM);
    view.prepare(root);
    assert.equal(glowingContainer.renderable, true);
  } finally {
    pixi.DOMAdapter.set(adapter);
  }
});

test("a tween's lines go once its morph drops their blend, not idle for a ratio never drawn again", async () => {
  const { ShapeObject, CONTENT } = await import(
    "../../../../packages/player/dist/display/display.js"
  );
  const { readMorphShape, readSwf } = await import("../../../../packages/format/dist/index.js");
  const w = await import("../../../swf-writer.ts");
  const square: import("../../../swf-writer.ts").PathCommand[] = [
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

  // 64 ratios later its blend is dropped, and the next frame its lines.
  for (let ratio = 2000; ratio <= 65000; ratio += 1000) {
    draw(ratio);
  }

  assert.equal(first.destroyed, true);
  assert.equal(lines().destroyed, false);
});

test("instances of a morph at one ratio share its blend's fills, which go once the morph drops the blend", async () => {
  const { ShapeObject, CONTENT } = await import(
    "../../../../packages/player/dist/display/display.js"
  );
  const { readMorphShape, readSwf } = await import("../../../../packages/format/dist/index.js");
  const w = await import("../../../swf-writer.ts");
  const square: import("../../../swf-writer.ts").PathCommand[] = [
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

  // 64 ratios later its blend is dropped, and the next frame its fills.
  for (let ratio = 2000; ratio <= 65000; ratio += 1000) {
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
  const { ShapeObject } = await import("../../../../packages/player/dist/display/display.js");
  const { MOVE, LINE } = await import("../../../../packages/player/dist/display/shapes.js");
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
  const { ShapeObject } = await import("../../../../packages/player/dist/display/display.js");
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
  const { ShapeObject } = await import("../../../../packages/player/dist/display/display.js");
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
  const { ShapeObject } = await import("../../../../packages/player/dist/display/display.js");
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
  const { Drawing } = await import("../../../../packages/player/dist/display/drawing.js");
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
    assert.equal((fill as unknown as { parent: unknown }).parent, null);
    assert.equal(context.destroyed, true);
    root.placeAtDepth(sprite, 1);
    view.prepare(root);
    assert.equal(fillOf().destroyed, false);
    assert.notEqual(fillOf().context, context);
    assert.equal(fillOf().context.destroyed, false);
  });
});

test("a gradient a drawing off the list let go of leaves no warning in Pixi's bind groups", async () => {
  const { Drawing } = await import("../../../../packages/player/dist/display/drawing.js");
  const cjs = createRequire(new URL("../../../../packages/player/package.json", import.meta.url));
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
  const { Drawing } = await import("../../../../packages/player/dist/display/drawing.js");
  const { CONTENT } = await import("../../../../packages/player/dist/display/display.js");
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
  const fillContext = fill.context;
  view.prepare(root);
  // Its Graphics stay, in place, and show the new fills; the old fills, its own, go.
  assert.equal(art()[0], fill);
  assert.equal(fill.destroyed, false);
  assert.notEqual(art()[0].context, fillContext);
  assert.equal(fillContext.destroyed, true);
});

test("a child emptied off the list is drawn again under a parent kept off it", async () => {
  const { Drawing } = await import("../../../../packages/player/dist/display/drawing.js");
  const { ShapeObject } = await import("../../../../packages/player/dist/display/display.js");
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
  const { ShapeObject } = await import("../../../../packages/player/dist/display/display.js");
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
    // Parked 5 s, then given back, idle 30 s.
    for (const step of [6000, 31_000]) {
      clock.at += step;
      view.prepare(root);
    }

    assert.equal(lines.destroyed, true);
  });
});

test("a shared fill gathers no listener per instance, so instances go in linear time", async () => {
  const { ShapeObject } = await import("../../../../packages/player/dist/display/display.js");
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
  const cjs = createRequire(new URL("../../../../packages/player/package.json", import.meta.url));
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
  const { ShapeObject } = await import("../../../../packages/player/dist/display/display.js");
  const view = new PixiView(standIn([]).renderer);
  const root = new Container();
  const character = await outlinedSquare();
  const shapes = Array.from({ length: 1100 }, (_, k) => {
    const shape = new ShapeObject(character);
    root.placeAtDepth(shape, k + 1);
    return shape;
  });
  view.prepare(root);
  // Emptied, a node's Graphics are taken off and kept for the next content to take.
  type Drawn = { parent: unknown };
  const fills = view.stage.children[0].children
    .slice(1)
    .map((c) => c.children[0].children[0] as unknown as Drawn);

  for (const shape of shapes) {
    root.removeChild(shape);
  }

  view.prepare(root);
  assert.equal(fills.filter((g) => g.parent === null).length, 1100 - 1024);
  assert.equal(fills[0].parent, null);
  assert.notEqual(fills[1099].parent, null);
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
  const { Drawing } = await import("../../../../packages/player/dist/display/drawing.js");
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

test("a shape's lines share a context through every turn and mirror of one stretch", async () => {
  // A limb that turns on every frame of a loop tessellated its lines anew
  // at each angle; a line scaled both ways is as wide through any turn of
  // a stretch, so its lines are stroked through the stretch alone.
  const { ShapeObject } = await import("../../../../packages/player/dist/display/display.js");
  const character = await outlinedSquare();
  const view = new PixiView(standIn([]).renderer);
  const root = new Container();
  // A stretch of sx by sy, turned by `angle`, mirrored if `mirror`.
  const turned = (angle: number, sx: number, sy: number, mirror = false) => {
    const shape = new ShapeObject(character);
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const flip = mirror ? -1 : 1;
    shape.setMatrix({
      a: cos * sx,
      b: sin * sx,
      c: -sin * sy * flip,
      d: cos * sy * flip,
      tx: 0,
      ty: 0,
    });
    return shape;
  };
  const shapes = [
    turned(0.3, 2, 2),
    turned(1.1, 2, 2),
    turned(2.5, 2, 2, true),
    turned(0.3, 3, 3),
    turned(0.4, 1, 0.25),
    turned(2.9, 1, 0.25, true),
  ];
  shapes.forEach((shape, i) => {
    root.placeAtDepth(shape, i + 1);
  });

  // A squash on the stage turned: its stretch is no longer diagonal.
  const squashed = turned(0.6, 1, 1);
  const { a, b, c, d } = squashed.matrix;
  squashed.setMatrix({ a, b: b * 0.25, c, d: d * 0.25, tx: 0, ty: 0 });
  shapes.push(squashed);
  // Near collapse: drawn through its transform exactly, its line still there.
  shapes.push(turned(0, 1, 1e-6));
  shapes.forEach((shape, i) => {
    root.placeAtDepth(shape, i + 1);
  });

  type Lines = {
    context: { instructions: unknown[] };
    localTransform: { a: number; b: number; c: number; d: number };
    updateLocalTransform(): void;
  };
  const strokes = (i: number) =>
    view.stage.children[0].children[1 + i].children[0].children[1] as unknown as Lines;
  const lines = (i: number) => strokes(i).context;
  view.prepare(root);

  assert.equal(lines(1), lines(0));
  assert.equal(lines(2), lines(0));
  assert.notEqual(lines(3), lines(0));
  assert.equal(lines(5), lines(4));
  assert.notEqual(lines(4), lines(0));
  // Scale 2 at any turn or mirror, scale 3, the squash at any turn, the squash turned on the stage,
  // and the one near collapse.
  assert.equal(view.counts.strokeContexts, 5);
  assert.ok(lines(7).instructions.length > 0);

  // Each one's lines reach the stage through a turn or a mirror alone, but for the grid it was
  // settled on (settledStretch), whose step for these lines, 2 to 6 pixels wide, is 1/32 or less,
  // their edges within a tenth of a pixel: the stroke is barely stretched.
  shapes.forEach((shape, i) => {
    const m = shape.matrix;
    // Pixi works its local transform out of its scale, turn and skew as it renders.
    strokes(i).updateLocalTransform();
    const l = strokes(i).localTransform;
    const w = [
      m.a * l.a + m.c * l.b,
      m.b * l.a + m.d * l.b,
      m.a * l.c + m.c * l.d,
      m.b * l.c + m.d * l.d,
    ];
    if (i === 7) {
      return;
    }

    assert.ok(
      Math.abs(Math.hypot(w[0], w[1]) - 1) < 1 / 32,
      `shape ${i}: column 1 is ${w[0]},${w[1]}`,
    );
    assert.ok(
      Math.abs(Math.hypot(w[2], w[3]) - 1) < 1 / 32,
      `shape ${i}: column 2 is ${w[2]},${w[3]}`,
    );
    assert.ok(
      Math.abs(w[0] * w[2] + w[1] * w[3]) < 1 / 16,
      `shape ${i}: columns not at right angles`,
    );
  });
});

test("a line scaled one way alone keeps its lines for each angle", async () => {
  const { ShapeObject } = await import("../../../../packages/player/dist/display/display.js");
  const character = await outlinedSquare();
  const layer = (character as unknown as { layers: { strokes: { line: object }[] }[] }).layers[0];
  layer.strokes[0].line = { ...layer.strokes[0].line, noHScale: true };
  const view = new PixiView(standIn([]).renderer);
  const root = new Container();
  for (const [i, angle] of [0.3, 1.1].entries()) {
    const shape = new ShapeObject(character);
    const cos = Math.cos(angle) * 2;
    const sin = Math.sin(angle) * 2;
    shape.setMatrix({ a: cos, b: sin, c: -sin, d: cos, tx: 0, ty: 0 });
    root.placeAtDepth(shape, i + 1);
  }

  view.prepare(root);
  // Its width reads one row of the transform, which the turn changes.
  assert.equal(view.counts.strokeContexts, 2);
});

test("a shape that pulses a little shares its lines between the frames of the pulse", async () => {
  // A character that breathes scales a few percent on every frame: each
  // frame's stretch was its own, its lines tessellated again on every
  // frame of every loop. Settled on a grid, its frames share a few.
  const { ShapeObject } = await import("../../../../packages/player/dist/display/display.js");
  const character = await outlinedSquare();
  const view = new PixiView(standIn([]).renderer);
  const root = new Container();
  const shape = new ShapeObject(character);
  root.placeAtDepth(shape, 1);
  type Lines = {
    context: unknown;
    localTransform: { a: number; b: number; c: number; d: number };
    updateLocalTransform(): void;
  };
  const strokes = () =>
    view.stage.children[0].children[1].children[0].children[1] as unknown as Lines;
  for (let f = 0; f < 48; f++) {
    const s = 1 + 0.02 * Math.sin((2 * Math.PI * f) / 48);
    const turn = 0.3 * Math.sin((2 * Math.PI * f) / 24);
    shape.setMatrix({
      a: s * Math.cos(turn),
      b: s * Math.sin(turn),
      c: -s * 0.99 * Math.sin(turn),
      d: s * 0.99 * Math.cos(turn),
      tx: 0,
      ty: 0,
    });
    view.prepare(root);
    // Its 2 pixel lines, under the stretch's inverse, reach the stage stretched by a few hundredths,
    // the even stretch's and the grid's together: their path is the shape's exactly.
    const lines = strokes();
    lines.updateLocalTransform();
    const l = lines.localTransform;
    const m = shape.matrix;
    const column = Math.hypot(m.a * l.a + m.c * l.b, m.b * l.a + m.d * l.b);
    assert.ok(Math.abs(column - 1) < 1 / 32, `frame ${f}: column 1 is ${column} long`);
  }

  // 48 frames of a pulse of 2% and a squash of 1%: a stretch or two.
  assert.ok(view.counts.strokeContexts <= 3, `${view.counts.strokeContexts} contexts`);
});

test("a wide line settles within its edges' slack, and one too wide on none", async () => {
  const { settledStretch } = await import("../../../../packages/player/dist/render/strokes.js");
  const pulse: [number, number, number, number] = [1.013, 0.002, 0.002, 1.007];
  // A hairline, nearly even, moves to an even stretch on a coarse grid of its logarithm.
  const hair = settledStretch(pulse, 1, 1);
  assert.notDeepEqual(hair, pulse);
  assert.equal(hair[1], 0);
  assert.equal(hair[0], hair[3]);
  // Its lines' edges, half a pixel out, stand where the pulse's put them within a tenth.
  const det = hair[0] * hair[3] - hair[1] * hair[2];
  const e0 = (pulse[0] * hair[3] - pulse[2] * hair[1]) / det;
  assert.ok(Math.abs(e0 - 1) * 0.5 < 0.1);
  // A line of 20 pixels settles too, but on a grid fine enough that its edges, ten pixels out,
  // stand within the slack and the grid's own fiftieth.
  const wide = settledStretch(pulse, 400, 1);
  const wideDet = wide[0] * wide[3] - wide[1] * wide[2];
  const w0 = (pulse[0] * wide[3] - pulse[2] * wide[1]) / wideDet;
  const w3 = (pulse[3] * wide[0] - pulse[1] * wide[2]) / wideDet;
  assert.ok(Math.max(Math.abs(w0 - 1), Math.abs(w3 - 1)) * 10 < 0.12);
  // One of 2000 pixels is its own stretch.
  assert.deepEqual(settledStretch(pulse, 40000, 1), pulse);
  // Stretches a step apart on the grid's scale settle alike.
  assert.deepEqual(
    settledStretch([1.0101, 0, 0, 1.0101], 1, 1),
    settledStretch([1.0102, 0, 0, 1.0102], 1, 1),
  );
});

test("a part turning inside a parent squashed a little strokes through one stretch at every angle", async () => {
  const { settledStretch, stretchOf } = await import(
    "../../../../packages/player/dist/render/strokes.js"
  );
  // A parent squashed to 0.9 of its height, a part in it turned: each angle's stretch differs.
  const turned = (angle: number, squash: number): [number, number, number, number] => {
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    return [c, squash * s, -s, squash * c];
  };
  const settled = (angle: number, squash: number, widest: number) =>
    settledStretch(stretchOf(turned(angle, squash)) as [number, number, number, number], widest, 1);
  assert.notDeepEqual(stretchOf(turned(0.3, 0.9)), stretchOf(turned(1.1, 0.9)));
  // Its hairlines, and lines of a pixel and a half, settle on one even stretch whatever the angle.
  for (const widest of [1, 30]) {
    const first = settled(0.3, 0.9, widest);
    assert.equal(first[1], 0);
    for (const angle of [0.7, 1.1, 2.5, -0.4]) {
      assert.deepEqual(settled(angle, 0.9, widest), first);
    }
  }

  // Squashed to a twentieth, a hairline is no pixel wide through an even stretch: its own.
  assert.notEqual(settled(0.3, 0.05, 1)[1], 0);
  // A line of 20 pixels in the 0.9 parent would stand a pixel off: its own as well.
  assert.notEqual(settled(0.3, 0.9, 400)[1], 0);
});

test("Pixi's pool of Graphics' batch elements is cut back as a view prepares", async () => {
  // Pixi pools one for each batch each context makes and never shrinks the
  // pool: a crowded room left 165,000 behind it.
  const cjs = createRequire(new URL("../../../../packages/player/package.json", import.meta.url));
  const entry = pathToFileURL(cjs.resolve("pixi.js").replace(/\.js$/, ".mjs")).href;
  const { BigPool, BatchableGraphics } = (await import(entry)) as {
    BigPool: { getPool(type: unknown): { totalFree: number; return(item: unknown): void } };
    BatchableGraphics: new () => unknown;
  };
  const pool = BigPool.getPool(BatchableGraphics);
  for (let i = 0; i < 10000; i++) {
    pool.return(new BatchableGraphics());
  }

  const view = new PixiView(standIn([]).renderer);
  view.prepare(new Container());
  assert.equal(pool.totalFree, 4096);
});

test("a shape drawn anew with its fills laid out alike keeps its Graphics, in place", async () => {
  // Taken off and put on, they changed the structure of the render group
  // above, which Pixi rebuilt whole: an animated character's on every frame
  // its timeline swapped a shape or moved a morph on.
  const { ShapeObject, CONTENT } = await import(
    "../../../../packages/player/dist/display/display.js"
  );
  const { readMorphShape, readSwf } = await import("../../../../packages/format/dist/index.js");
  const w = await import("../../../swf-writer.ts");
  const square: import("../../../swf-writer.ts").PathCommand[] = [
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
  const shape = ShapeObject.ofMorph(character);
  const root = new Container();
  root.placeAtDepth(shape, 1);
  const view = new PixiView(standIn([]).renderer);
  type Drawn = { context: unknown; destroyed: boolean };
  const art = () =>
    [...view.stage.children[0].children[1].children[0].children] as unknown as Drawn[];
  view.prepare(root);
  const before = art();
  const fills = before[0].context;

  shape.ratio = 30000;
  shape.invalidate(CONTENT);
  view.prepare(root);

  assert.equal(art().length, before.length);
  art().forEach((graphic, k) => {
    assert.equal(graphic, before[k]);
  });
  assert.notEqual(art()[0].context, fills);
  assert.equal(before[0].destroyed, false);
});

test("a shape swapped for one with fills and lines laid out alike keeps its Graphics, and its lines", async () => {
  const { ShapeObject, CONTENT } = await import(
    "../../../../packages/player/dist/display/display.js"
  );
  const [first, second] = [await outlinedSquare(), await outlinedSquare()];
  const shape = new ShapeObject(first);
  shape.setMatrix({ a: 2, b: 0, c: 0, d: 2, tx: 0, ty: 0 });
  const root = new Container();
  root.placeAtDepth(shape, 1);
  const view = new PixiView(standIn([]).renderer);
  type Drawn = { context: { instructions: unknown[]; destroyed: boolean }; destroyed: boolean };
  const art = () =>
    [...view.stage.children[0].children[1].children[0].children] as unknown as Drawn[];
  view.prepare(root);
  const [fill, lines] = art();
  const oldLines = lines.context;

  // As a timeline swaps a character's shape at a depth.
  shape.shape = second;
  shape.character = second;
  shape.invalidate(CONTENT);
  view.prepare(root);

  const [nextFill, nextLines] = art();
  assert.equal(nextFill, fill);
  assert.equal(nextLines, lines);
  assert.notEqual(nextLines.context, oldLines);
  assert.ok(nextLines.context.instructions.length > 0);
  // The old lines given back once, kept idle for a loop to come back to, not destroyed twice over.
  assert.equal(oldLines.destroyed, false);
  assert.equal(view.counts.strokeContexts, 2);
});

test("a render group not rebuilt for a while has its Graphics batched, and drawn alone again once rebuilt", async () => {
  // Drawn alone, each Graphics was a draw call, thousands in a crowded
  // room and most of them scenery; batched, a settled group's are a few,
  // and a group rebuilt again goes back to drawing them alone, as a batch
  // packs its vertices again at each rebuild.
  const { ShapeObject } = await import("../../../../packages/player/dist/display/display.js");
  const character = await outlinedSquare();
  const view = new PixiView(standIn([]).renderer);
  const root = new Container();
  root.placeAtDepth(new ShapeObject(character), 1);
  type Drawn = { context: { batchMode: string }; shared: { batchMode: string }; settled?: boolean };
  type Group = { $builtAt?: number; $settled?: boolean; structureDidChange: boolean };
  const art = () =>
    [...view.stage.children[0].children[1].children[0].children] as unknown as Drawn[];

  await withClock((clock) => {
    view.prepare(root);
    // As Pixi gives the stage a group of its own when it renders it, rebuilt now.
    view.stage.enableRenderGroup();
    const group = view.stage.renderGroup as unknown as Group;
    group.$builtAt = clock.at;
    view.prepare(root);
    assert.ok(art().every((g) => !g.settled && g.context === (g.shared as unknown)));

    // Not rebuilt for 2 s: batched copies drawn, the shared contexts kept.
    clock.at += 2500;
    view.prepare(root);
    assert.equal(group.$settled, true);
    assert.equal(group.structureDidChange, true);
    for (const g of art()) {
      assert.equal(g.settled, true);
      assert.equal(g.context.batchMode, "batch");
      assert.notEqual(g.context, g.shared as unknown);
    }

    // Rebuilt for a change of its own: drawn alone again.
    group.$builtAt = clock.at;
    view.prepare(root);
    assert.equal(group.$settled, false);
    assert.ok(art().every((g) => !g.settled && g.context === (g.shared as unknown)));
  });
});

test("Graphics a settled group batched draw alone again in a group that has not settled", async () => {
  // A branch moved under an animated group, or made a group of its own,
  // brings its batched Graphics along: they would be packed again at each
  // of that group's rebuilds.
  const { ShapeObject } = await import("../../../../packages/player/dist/display/display.js");
  const character = await outlinedSquare();
  const view = new PixiView(standIn([]).renderer);
  const root = new Container();
  root.placeAtDepth(new ShapeObject(character), 1);
  type Drawn = { settled?: boolean; context: unknown; shared: unknown };
  type Group = { $builtAt?: number; $settled?: boolean; $settling?: boolean };

  await withClock((clock) => {
    view.prepare(root);
    view.stage.enableRenderGroup();
    const stageGroup = view.stage.renderGroup as unknown as Group;
    stageGroup.$builtAt = clock.at;
    clock.at += 2500;
    view.prepare(root);
    const branch = view.stage.children[0].children[1] as unknown as {
      enableRenderGroup(): void;
      disableRenderGroup(): void;
      renderGroup: Group;
      children: { children: Drawn[] }[];
    };
    const art = () => branch.children[0].children;
    assert.ok(art().every((g) => g.settled));

    // The branch becomes a group of its own, just rebuilt.
    branch.enableRenderGroup();
    branch.renderGroup.$builtAt = clock.at;
    view.prepare(root);
    assert.ok(art().every((g) => !g.settled && g.context === g.shared));
    assert.equal(branch.renderGroup.$settled, false);
  });
});

test("a large shape under a colour transform draws alone until its group settles, or a renderer is not WebGL", async () => {
  // A batched copy is packed again at each rebuild and each change of the
  // transform, every frame of a creature fading out; drawn alone, a draw
  // takes the transform in a row of the table or in uniforms instead.
  const { ShapeObject } = await import("../../../../packages/player/dist/display/display.js");
  const { MOVE, LINE } = await import("../../../../packages/player/dist/display/shapes.js");
  const { ColorAloneSystem } = await import("../../../../packages/player/dist/render/color.js");
  const disc: number[] = [MOVE, 200, 0];
  for (let k = 1; k <= 240; k++) {
    const a = (2 * Math.PI * k) / 240;
    disc.push(LINE, Math.round(200 * Math.cos(a)), Math.round(200 * Math.sin(a)));
  }

  const large = (await outlinedSquare()) as unknown as {
    layers: { fills: { contours: number[][] }[]; strokes: { paths: number[][] }[] }[];
  };
  large.layers[0].fills[0].contours = [disc];
  large.layers[0].strokes[0].paths = [disc];
  const small = await outlinedSquare();
  const view = new PixiView(standIn([]).renderer);
  const root = new Container();
  const shapes = [
    new ShapeObject(large as unknown as ConstructorParameters<typeof ShapeObject>[0]),
    new ShapeObject(small),
  ];
  for (const [i, shape] of shapes.entries()) {
    shape.colorTransform = {
      rMul: 1,
      gMul: 1,
      bMul: 1,
      aMul: 1,
      rAdd: 40,
      gAdd: 0,
      bAdd: 0,
      aAdd: 0,
    };
    root.placeAtDepth(shape, i + 1);
  }

  type Drawn = { context: { batchMode: string }; shared: unknown; settled?: boolean };
  type Group = { $builtAt?: number; $settled?: boolean };
  const art = (k: number) =>
    [...view.stage.children[0].children[1 + k].children[0].children] as unknown as Drawn[];
  const alone = (g: Drawn) => g.context === g.shared;
  const webgl = new ColorAloneSystem({ type: 1 });
  let other: InstanceType<typeof ColorAloneSystem> | null = null;
  try {
    await withClock((clock) => {
      view.prepare(root);
      view.stage.enableRenderGroup();
      const group = view.stage.renderGroup as unknown as Group;
      group.$builtAt = clock.at;
      view.prepare(root);
      // Weighed before it is ever built: the large shape's fill and lines alone, the small batched.
      assert.ok(art(0).every(alone));
      assert.ok(art(1).every((g) => !alone(g) && g.context.batchMode === "batch"));

      // Settled: batched copies, packed once.
      clock.at += 2500;
      view.prepare(root);
      assert.equal(group.$settled, true);
      assert.ok(art(0).every((g) => g.settled && !alone(g) && g.context.batchMode === "batch"));

      // Rebuilt again: alone again.
      group.$builtAt = clock.at;
      view.prepare(root);
      assert.ok(art(0).every(alone));

      // A renderer that is not WebGL, whose graphics shader has no colour transform: batched copies.
      other = new ColorAloneSystem({ type: 2 });
      assert.ok(art(0).every((g) => !alone(g) && g.context.batchMode === "batch"));
    });
  } finally {
    webgl.destroy();
    (other as InstanceType<typeof ColorAloneSystem> | null)?.destroy();
  }
});

test("batched Graphics are looked through only in groups that change, and follow a move to another settled group", async () => {
  // A static stage's thousands of batched Graphics were looked through on every frame an animated
  // group beside them was rebuilt.
  const { settle, unsettle } = await import("../../../../packages/player/dist/render/settle.js");
  const { SharedGraphics } = await import("../../../../packages/player/dist/render/shared.js");
  const cjs = createRequire(new URL("../../../../packages/player/package.json", import.meta.url));
  const entry = pathToFileURL(cjs.resolve("pixi.js").replace(/\.js$/, ".mjs")).href;
  const pixi = (await import(entry)) as {
    Container: new () => {
      enableRenderGroup(): void;
      addChild(...c: unknown[]): void;
      renderGroup: Parameters<typeof settle>[0];
    };
  };
  const stage = new pixi.Container();
  stage.enableRenderGroup();
  const group = () => {
    const c = new pixi.Container();
    c.enableRenderGroup();
    stage.addChild(c);
    return c;
  };
  const scenery = group();
  const shelf = group();
  const animated = group();
  const parts = Array.from({ length: 3 }, () => {
    const part = new pixi.Container();
    const g = new SharedGraphics();
    part.addChild(g);
    scenery.addChild(part);
    return { part, g };
  });
  settle(scenery.renderGroup);
  settle(shelf.renderGroup);
  assert.ok(parts.every(({ g }) => g.settled));
  assert.equal(scenery.renderGroup.$batched?.size, 3);

  // The animated group rebuilt, the scenery unchanged: nothing of the scenery's is touched.
  scenery.renderGroup.structureDidChange = false;
  unsettle(new Set([animated.renderGroup]), [animated.renderGroup]);
  assert.ok(parts.every(({ g }) => g.settled));

  // One part moved to the settled shelf stays batched, listed there; one to the animated group draws alone.
  shelf.addChild(parts[0].part);
  animated.addChild(parts[1].part);
  unsettle(new Set([animated.renderGroup]), [scenery.renderGroup, animated.renderGroup]);
  assert.equal(parts[0].g.settled, true);
  assert.ok(shelf.renderGroup.$batched?.has(parts[0].g));
  assert.equal(parts[1].g.settled, false);
  assert.equal(parts[2].g.settled, true);
  assert.equal(scenery.renderGroup.$batched?.size, 1);
});

test("a mask's Graphics are never batched, as they draw in another group", async () => {
  const { ShapeObject } = await import("../../../../packages/player/dist/display/display.js");
  const character = await outlinedSquare();
  const view = new PixiView(standIn([]).renderer);
  const root = new Container();
  const masked = new ShapeObject(character);
  const mask = new ShapeObject(character);
  root.placeAtDepth(masked, 1);
  root.placeAtDepth(mask, 2);
  masked.setMask(mask);
  type Drawn = { settled?: boolean };

  await withClock((clock) => {
    view.prepare(root);
    view.stage.enableRenderGroup();
    (view.stage.renderGroup as unknown as { $builtAt: number }).$builtAt = clock.at;
    clock.at += 2500;
    view.prepare(root);
    const containers = view.stage.children[0].children as unknown as {
      includeInBuild: boolean;
      children: { children: Drawn[] }[];
    }[];
    const maskContainer = containers.find((c) => c.includeInBuild === false);
    assert.ok(maskContainer);
    assert.ok(maskContainer.children[0].children.every((g) => !g.settled));
  });
});

test("a child taken off gives its Graphics, emptied, to the next shape placed", async () => {
  // A frame-by-frame timeline takes its children off and puts new ones on
  // every frame; each made and destroyed its Graphics, most of the cost of
  // a swap.
  const { ShapeObject } = await import("../../../../packages/player/dist/display/display.js");
  const character = await outlinedSquare();
  const view = new PixiView(standIn([]).renderer);
  const root = new Container();
  // Turned, scaled and colour-transformed, so that what it leaves on its Graphics shows.
  const first = new ShapeObject(character);
  first.setMatrix({ a: 1.5, b: 0.8, c: -0.8, d: 1.5, tx: 30, ty: 20 });
  first.colorTransform = {
    rMul: 1,
    gMul: 1,
    bMul: 1,
    aMul: 1,
    rAdd: 40,
    gAdd: 0,
    bAdd: 0,
    aAdd: 0,
  };
  root.placeAtDepth(first, 1);
  type Drawn = {
    parent: unknown;
    context: unknown;
    shared: unknown;
    destroyed: boolean;
    visible: boolean;
    flashColor?: unknown;
    settled?: boolean;
    localTransform: { a: number; b: number; c: number; d: number; tx: number; ty: number };
    updateLocalTransform(): void;
  };
  const art = (k: number) =>
    [...view.stage.children[0].children[1 + k].children[0].children] as unknown as Drawn[];

  await withClock((clock) => {
    view.prepare(root);
    const [fill, lines] = art(0);
    const oldLines = lines.context;
    assert.notEqual(fill.flashColor ?? null, null);

    // Off the list, kept 5 s whole, then emptied: its Graphics kept, showing nothing.
    root.removeChild(first);
    view.prepare(root);
    clock.at += 6000;
    view.prepare(root);
    assert.equal(fill.parent, null);
    assert.equal(lines.parent, null);
    assert.notEqual(lines.context, oldLines);

    // Kept as a new one would be: uncoloured, shown, drawing its shared context alone.
    for (const g of [fill, lines]) {
      assert.equal(g.flashColor ?? null, null);
      assert.equal(g.settled, false);
      assert.equal(g.visible, true);
      assert.equal(g.context, g.shared);
      g.updateLocalTransform();
      const { a, b, c, d, tx, ty } = g.localTransform;
      assert.deepEqual([a, b, c, d, tx, ty], [1, 0, 0, 1, 0, 0]);
    }

    // Another shape placed takes them, drawing its own fills and lines, uncoloured.
    root.placeAtDepth(new ShapeObject(character), 1);
    view.prepare(root);
    const taken = art(0);
    assert.ok(taken.includes(fill) && taken.includes(lines));
    assert.ok(
      taken.every((g) => !g.destroyed && g.parent !== null && (g.flashColor ?? null) === null),
    );
  });
});

test("a new object of a released one's character takes its node, reset, and the old one gets its own back", async () => {
  // A timeline that places its children anew on every frame made and
  // dropped hundreds of nodes a frame, with their containers and filters.
  const { ShapeObject } = await import("../../../../packages/player/dist/display/display.js");
  const { filterDefaults } = await import("../../../../packages/player/dist/display/filters.js");
  const cjs = createRequire(new URL("../../../../packages/player/package.json", import.meta.url));
  const entry = pathToFileURL(cjs.resolve("pixi.js").replace(/\.js$/, ".mjs")).href;
  const pixi = (await import(entry)) as {
    DOMAdapter: { get(): object; set(adapter: object): void };
  };
  const adapter = pixi.DOMAdapter.get();
  pixi.DOMAdapter.set({ ...adapter, createCanvas: () => ({ getContext: () => null }) });
  try {
    const character = await outlinedSquare();
    const { renderer } = standIn([]);
    (renderer as unknown as { type: number }).type = 1;
    const view = new PixiView(renderer);
    const root = new Container();
    const glow = () => [{ ...filterDefaults("glow"), blurX: 4, blurY: 4 }];
    type Placed = {
      filters: unknown[] | null;
      alpha: number;
      colorRoot: boolean;
      visible: boolean;
      localTransform: { a: number; b: number; tx: number; ty: number };
      updateLocalTransform(): void;
      children: { children: unknown[] }[];
    };
    const placed = (k: number) => view.stage.children[0].children[1 + k] as unknown as Placed;

    const first = new ShapeObject(character);
    first.setMatrix({ a: 0, b: 1, c: -1, d: 0, tx: 30, ty: 20 });
    first.colorTransform = {
      rMul: 1,
      gMul: 1,
      bMul: 1,
      aMul: 0.5,
      rAdd: 0,
      gAdd: 0,
      bAdd: 0,
      aAdd: 0,
    };
    first.visible = false;
    first.filters = glow();
    root.placeAtDepth(first, 1);
    view.prepare(root);
    const container = placed(0);
    const chain = container.filters?.[0];
    assert.ok(chain);
    const art = [...container.children[0].children];

    // Its place taken by another of the character: the node comes back to it, as the new one is.
    root.removeChild(first);
    const second = new ShapeObject(character);
    second.setMatrix({ a: 1, b: 0, c: 0, d: 1, tx: 5, ty: 6 });
    second.filters = glow();
    root.placeAtDepth(second, 1);
    view.prepare(root);
    assert.equal(placed(0), container);
    assert.equal(container.filters?.[0], chain);
    assert.equal(container.alpha, 1);
    // Nor does the chain it keeps colour what its filters make in the first one's colour.
    const uniforms = (chain as { resources: { colorUniforms: { uniforms: { uColored: number } } } })
      .resources.colorUniforms.uniforms;
    assert.equal(uniforms.uColored, 0);
    assert.equal(container.visible, true);
    container.updateLocalTransform();
    const { a, b, tx, ty } = container.localTransform;
    assert.deepEqual([a, b, tx, ty], [1, 0, 5, 6]);
    assert.deepEqual(container.children[0].children, art);

    // One without filters takes it without them.
    root.removeChild(second);
    const third = new ShapeObject(character);
    root.placeAtDepth(third, 1);
    view.prepare(root);
    assert.equal(placed(0), container);
    assert.equal(container.filters, null);

    // The first back on the list has a node of its own, drawn anew, its filters with it.
    root.placeAtDepth(first, 2);
    view.prepare(root);
    assert.equal(placed(0), container);
    assert.notEqual(placed(1), container);
    // Its alpha is its chain's, which colours what the filters make, not what they are run on.
    assert.equal(placed(1).alpha, 1);
    assert.equal(placed(1).colorRoot, true);
    assert.equal(placed(1).visible, false);
    assert.ok(placed(1).filters?.[0]);
    assert.equal(placed(1).children[0].children.length, art.length);
  } finally {
    pixi.DOMAdapter.set(adapter);
  }
});

test("an object made a mask as it leaves the list keeps its node from a new one of its character", async () => {
  // Released before the object it masks takes it as its mask, it was listed
  // spare: taken, the new one drew as the mask, and itself not at all.
  const { ShapeObject } = await import("../../../../packages/player/dist/display/display.js");
  const character = await outlinedSquare();
  const view = new PixiView(standIn([]).renderer);
  const root = new Container();
  const mask = new ShapeObject(character);
  const masked = new Container();
  root.placeAtDepth(mask, 1);
  root.placeAtDepth(masked, 2);
  view.prepare(root);

  masked.setMask(mask);
  root.removeChild(mask);
  root.placeAtDepth(new ShapeObject(character), 3);
  view.prepare(root);
  const [, maskedContainer, next] = view.stage.children[0].children;
  assert.notEqual(maskedContainer.mask, next);
  assert.equal(maskedContainer.mask, view.stage.children[1].children[0]);
  assert.notEqual(next.includeInBuild, false);
});

test("spare nodes are listed once, kept to the most, and dropped as a SWF unloads", async () => {
  // They hold their objects' characters: kept on past an unload, they kept the SWF.
  const { ShapeObject, unloads } = await import(
    "../../../../packages/player/dist/display/display.js"
  );
  const { SPARE_NODES_MOST } = await import("../../../../packages/player/dist/render/pools.js");
  const character = await outlinedSquare();
  const view = new PixiView(standIn([]).renderer);
  const spares = view as unknown as {
    spareNodes: Map<unknown, Set<unknown>>;
    spareSince: Map<unknown, number>;
  };
  const root = new Container();

  await withClock(() => {
    const placeAll = (n: number) => {
      for (let i = 0; i < n; i++) {
        root.placeAtDepth(new ShapeObject(character), i + 1);
      }

      view.prepare(root);
    };
    const removeAll = () => {
      for (const child of [...root.children]) {
        root.removeChild(child);
      }

      view.prepare(root);
    };

    placeAll(3);
    removeAll();
    assert.equal(spares.spareSince.size, 3);
    assert.equal(spares.spareNodes.get(character)?.size, 3);

    // Taken by new objects, they leave the lists; released again, each is listed once.
    placeAll(3);
    assert.equal(spares.spareSince.size, 0);
    removeAll();
    assert.equal(spares.spareSince.size, 3);

    // Past the most, the oldest go.
    placeAll(SPARE_NODES_MOST + 10);
    removeAll();
    assert.equal(spares.spareSince.size, SPARE_NODES_MOST);
    assert.equal(spares.spareNodes.get(character)?.size, SPARE_NODES_MOST);

    // An unload lets go of them all at the next prepare.
    unloads.count++;
    view.prepare(root);
    assert.equal(spares.spareSince.size, 0);
    assert.equal(spares.spareNodes.size, 0);
  });
});

test("a node off the list keeps none of its children, and arranges them anew as it comes back", async () => {
  // A spare node kept its last object's children, and all below them, for as long as it was kept.
  const { ShapeObject } = await import("../../../../packages/player/dist/display/display.js");
  const character = await outlinedSquare();
  const view = new PixiView(standIn([]).renderer);
  const nodes = (view as unknown as { nodes: WeakMap<object, { kids: readonly unknown[] }> }).nodes;
  const root = new Container();
  const branch = new Container();
  const child = new ShapeObject(character);
  branch.placeAtDepth(child, 1);
  root.placeAtDepth(branch, 1);
  view.prepare(root);
  assert.equal(nodes.get(branch)?.kids.length, 1);

  root.removeChild(branch);
  view.prepare(root);
  assert.equal(nodes.get(branch)?.kids.length, 0);

  // Its child gone while it was off, it comes back with its art alone.
  branch.removeChild(child);
  root.placeAtDepth(branch, 1);
  view.prepare(root);
  const container = view.stage.children[0].children[1];
  assert.equal(container.children.length, 1);
  assert.equal(nodes.get(branch)?.kids.length, 0);
});

test("an unload takes the lines' budget back to its floor at the next prepare", async () => {
  const { unloads } = await import("../../../../packages/player/dist/display/display.js");
  const { LINES_IDLE_VERTICES } = await import("../../../../packages/player/dist/render/pools.js");
  const view = new PixiView(standIn([]).renderer);
  const budget = (view as unknown as { lines: { budget: { size: number } } }).lines.budget;
  const root = new Container();
  view.prepare(root);
  budget.size = 2_000_000;
  view.prepare(root);
  // Not grown, it shrinks only slowly on its own.
  assert.ok(budget.size > 1_900_000, `${budget.size}`);

  unloads.count++;
  view.prepare(root);
  assert.equal(budget.size, LINES_IDLE_VERTICES);
});

test("the wheel reaches the player in Flash's lines, keeps the page from scrolling only where the SWF takes it, and leaves Ctrl's zoom to the page", () => {
  const listeners = new Map<string, (e: unknown) => void>();
  const canvas = {
    style: { cursor: "" },
    addEventListener: (type: string, f: (e: unknown) => void) => listeners.set(type, f),
    removeEventListener: (type: string) => listeners.delete(type),
  };
  const renderer = {
    screen: { width: 100, height: 100 },
    canvas,
  } as unknown as ConstructorParameters<typeof PixiView>[0];
  const view = new PixiView(renderer);
  const calls: string[] = [];
  let taken = true;
  const player = {
    width: 200,
    height: 200,
    pointer: {
      post: () => {},
      flush: () => {},
      cursor: () => "default",
      wheel: (p: { x: number }, delta: number) => {
        calls.push(`${p.x} ${delta}`);
        return taken;
      },
    },
  } as unknown as Player;
  const unbind = view.bindPointer(player);
  const wheel = listeners.get("wheel");
  assert.ok(wheel);
  const turn = (deltaY: number, deltaMode = 0, ctrlKey = false) => {
    let prevented = false;
    wheel({
      deltaY,
      deltaMode,
      ctrlKey,
      offsetX: 5,
      offsetY: 5,
      buttons: 0,
      preventDefault: () => {
        prevented = true;
      },
    });
    return prevented;
  };

  // A notch, however many pixels the browser makes it, is 3 lines, up positive.
  assert.equal(turn(100), true);
  turn(-100);
  turn(53);
  turn(200);
  turn(3, 1);
  // A touchpad's pixels add up: 100 of them are 3 lines.
  for (let i = 0; i < 4; i++) {
    turn(10);
  }

  // Where the SWF does not take it the page scrolls; with Ctrl, a pinch too, the page zooms
  // and the SWF hears nothing.
  taken = false;
  assert.equal(turn(100), false);
  taken = true;
  assert.equal(turn(100, 0, true), false);
  unbind();
  assert.equal(listeners.has("wheel"), false);
  assert.deepEqual(calls, [
    "10 -3",
    "10 3",
    "10 -3",
    "10 -6",
    "10 -3",
    "10 0",
    "10 0",
    "10 0",
    "10 -1",
    "10 -3",
  ]);
});

test("multiply and subtract blend directly only while the stage's pixels are opaque", async () => {
  const { Drawing } = await import("../../../../packages/player/dist/display/drawing.js");
  const { renderer } = standIn([]);
  const background = { alpha: 1 };
  Object.assign(renderer, { type: 1, background });
  const view = new PixiView(renderer);
  const filled = (mode: string) => {
    const sprite = new Container();
    const drawing = new Drawing();
    drawing.beginFill({ type: "solid", color: 0xff336699 });
    drawing.drawRect(0, 0, 30, 20);
    drawing.endFill();
    sprite.drawing = drawing;
    sprite.blendMode = mode;
    return sprite;
  };
  const root = new Container();
  const multiply = filled("multiply");
  const subtract = filled("subtract");
  const add = filled("add");
  root.placeAtDepth(multiply, 1);
  root.placeAtDepth(subtract, 2);
  root.placeAtDepth(add, 3);
  const nodes = (view as unknown as { nodes: WeakMap<object, { directBlend: string | null }> })
    .nodes;
  const direct = () => [multiply, subtract, add].map((o) => nodes.get(o)?.directBlend ?? null);

  view.prepare(root);
  assert.deepEqual(direct(), ["multiply", "subtract", "add"]);

  // An erase outside any layer clears the stage's pixels below what comes after it: the blends
  // drawn before it choose again on the frame it comes on, though nothing in them changed.
  const eraser = filled("erase");
  root.placeAtDepth(eraser, 0);
  view.prepare(root);
  assert.deepEqual(direct(), [null, null, "add"]);
  root.removeChild(eraser);
  view.prepare(root);
  assert.deepEqual(direct(), ["multiply", "subtract", "add"]);

  // In a layer, it clears the layer's alone.
  const layer = new Container();
  layer.blendMode = "layer";
  layer.placeAtDepth(filled("erase"), 1);
  root.placeAtDepth(layer, 0);
  view.prepare(root);
  assert.deepEqual(direct(), ["multiply", "subtract", "add"]);

  // A host that makes the stage clear, as a transparent window mode, is seen on the frame it draws.
  background.alpha = 0;
  view.prepare(root);
  assert.deepEqual(direct(), [null, null, "add"]);
  background.alpha = 1;
  view.prepare(root);
  assert.deepEqual(direct(), ["multiply", "subtract", "add"]);
});
