// What the player lets go of in a context once Pixi has built it: its
// paths' commands, flattened to shapes by then, and that it measures and
// builds the same again from those; or, for a view's own, its paths
// whole, a copy made anew from what made it. And the shared fills of a
// morph's blends, let go once the morph drops them.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { readMorphShape, readSwf } from "../../../../packages/format/dist/index.js";
import { morphAt } from "../../../../packages/player/dist/display/morph.js";
import type {
  MorphCharacter,
  ShapeCharacter,
} from "../../../../packages/player/dist/display/timeline.js";
import {
  FILLS_IDLE_MS,
  FILLS_IDLE_VERTICES,
} from "../../../../packages/player/dist/render/pools.js";
import {
  copyContext,
  forgetCommands,
  remakeable,
  SharedFills,
} from "../../../../packages/player/dist/render/tessellate.js";
import * as w from "../../../swf-writer.ts";

const cjs = createRequire(new URL("../../../../packages/player/package.json", import.meta.url));
const pixi = pathToFileURL(cjs.resolve("pixi.js").replace(/\.js$/, ".mjs")).href;
type Tessellated = {
  vertices: ArrayLike<number>;
  uvs: ArrayLike<number>;
  indices: ArrayLike<number>;
};
type Context = {
  batchMode: string;
  dirty: boolean;
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
  autoGarbageCollect: boolean;
  instructions: {
    data: { path: { instructions: unknown[]; shapePath: { shapePrimitives: unknown[] } } };
  }[];
  moveTo(x: number, y: number): Context;
  lineTo(x: number, y: number): Context;
  closePath(): Context;
  fill(style: unknown): Context;
  stroke(style: unknown): Context;
  unload(): void;
};
const { GraphicsContext, GraphicsContextSystem } = (await import(pixi)) as {
  GraphicsContext: new () => Context;
  GraphicsContextSystem: new (
    renderer: unknown,
  ) => {
    onContextBuilt: ((context: Context) => void) | null;
    updateGpuContext(context: Context): { geometryData: Tessellated };
  };
};

/** Pixi's context system, as the player hooks it (render/hooks.ts). */
function system() {
  const contexts = new GraphicsContextSystem({
    uid: 1,
    gc: { now: 0, addResourceHash() {} },
    limits: { maxBatchableTextures: 16 },
  });
  contexts.onContextBuilt = forgetCommands as unknown as (context: Context) => void;
  return contexts;
}

function star(points: number): Context {
  const context = new GraphicsContext();
  context.batchMode = "no-batch";
  context.moveTo(100, 0);
  for (let i = 1; i < points * 2; i++) {
    const r = i % 2 ? 40 : 100;
    const a = (i * Math.PI) / points;
    context.lineTo(r * Math.cos(a) + 0.1, r * Math.sin(a) + 0.3);
  }

  return context.closePath().fill({ color: 0xff0000 }).stroke({ width: 2, color: 0x0000ff });
}

const plain = (data: Tessellated) => ({
  vertices: Array.from(data.vertices),
  uvs: Array.from(data.uvs),
  indices: Array.from(data.indices),
});

test("a context built keeps its paths' shapes and not their commands, and builds the same again", () => {
  const contexts = system();
  const context = star(40);
  const bounds = { ...context.bounds };

  const first = plain(contexts.updateGpuContext(context).geometryData);
  for (const instruction of context.instructions) {
    assert.deepEqual(instruction.data.path.instructions, []);
  }

  // Its bounds, and a build anew, as Pixi's collection or a change has it, come from the shapes.
  (context as unknown as { _boundsDirty: boolean })._boundsDirty = true;
  assert.deepEqual({ ...context.bounds }, bounds);
  context.dirty = true;
  assert.deepEqual(plain(contexts.updateGpuContext(context).geometryData), first);
  context.unload();
  assert.deepEqual(plain(contexts.updateGpuContext(context).geometryData), first);
});

test("a view's context lets go of its paths whole once built, measured first, and is copied anew", () => {
  const contexts = system();
  const make = () => star(40);
  const context = remakeable(make() as never, make as never) as unknown as Context;
  const bounds = { ...make().bounds };
  assert.equal(context.autoGarbageCollect, false);

  const first = plain(contexts.updateGpuContext(context).geometryData);
  for (const instruction of context.instructions) {
    assert.deepEqual(instruction.data.path.instructions, []);
    assert.deepEqual(instruction.data.path.shapePath.shapePrimitives, []);
  }

  assert.deepEqual({ ...context.bounds }, bounds);
  // A batched copy, made after: from what made the context, not its empty paths.
  const copy = copyContext(context as never) as unknown as Context;
  assert.notEqual(copy, context);
  assert.deepEqual(plain(contexts.updateGpuContext(copy).geometryData), first);
});

/** A square growing as it morphs, red to blue. */
function morph(): MorphCharacter {
  const square = (size: number): w.PathCommand[] => [
    { move: [0, 0] },
    { line: [size, 0] },
    { line: [size, size] },
    { line: [0, size] },
    { line: [0, 0] },
  ];
  const tag = w.morphShape({
    id: 1,
    startBounds: [0, 1200, 0, 1200],
    endBounds: [0, 2400, 0, 2400],
    fills: [{ start: 0xffff0000, end: 0xff0000ff }],
    start: [{ fill0: 1, commands: square(1200) }],
    end: [square(2400)],
  });
  const swf = readSwf(
    w.swf({ width: 100, height: 100, frameRate: 12, frameCount: 1, tags: [tag] }),
  );
  const t = swf.tags[0];
  return {
    type: "morph",
    id: 1,
    morph: readMorphShape(swf.bytes, t.code, t.offset, t.length),
    blends: new Map(),
    bitmap: () => null,
  };
}

test("an idle blend's fills are kept while its morph keeps it, and go on the frame after it drops it", () => {
  const fills = new SharedFills();
  const c = morph();
  const build = () => [new GraphicsContext()] as never;
  const first = morphAt(c, 0);
  const held = morphAt(c, 1);
  fills.take(first, first.layers, build);
  fills.take(held, held.layers, build);
  fills.give(first);
  fills.tick();
  assert.notEqual(fills.peek(first), null);

  // Ratios enough for the morph to drop its oldest blend, 0; 1, still taken, stays.
  for (let ratio = 2; ratio <= 64; ratio++) {
    morphAt(c, ratio);
  }
  assert.equal(c.blends.has(0), false);
  assert.notEqual(fills.peek(first), null);
  fills.tick();
  assert.equal(fills.peek(first), null);
  assert.notEqual(fills.peek(held), null);

  // One taken when it is dropped goes as soon as it is given back.
  morphAt(c, 65);
  assert.equal(c.blends.has(1), false);
  fills.tick();
  assert.notEqual(fills.peek(held), null);
  fills.give(held);
  assert.equal(fills.peek(held), null);
});

/** A shape of no layers, and a build of one fill Pixi tessellated into `vertices` vertices. */
function shape(id: number): ShapeCharacter {
  return { type: "shape", id, shape: { xMin: 0, xMax: 0, yMin: 0, yMax: 0 }, layers: [] } as never;
}

function tessellated(vertices: number) {
  return () => {
    const context = new GraphicsContext() as unknown as { _gpuData: unknown };
    context._gpuData = {
      1: { geometryData: { vertices: new Float32Array(vertices * 2) }, destroy() {} },
    };
    return [context] as never;
  };
}

test("an idle shape's fills are kept for FILLS_IDLE_MS, and found again in that time, not built", () => {
  let now = 0;
  const fills = new SharedFills(() => now);
  const s = shape(1);
  let builds = 0;
  const build = () => {
    builds++;
    return tessellated(10)();
  };
  const first = fills.take(s, null, build);
  fills.give(s);

  // A loop that comes back after some seconds finds them.
  now = FILLS_IDLE_MS - 1;
  fills.tick();
  assert.equal(fills.take(s, null, build), first);
  assert.equal(builds, 1);

  fills.give(s);
  now += FILLS_IDLE_MS - 1;
  fills.tick();
  assert.equal(fills.peek(s), first);
  now += 1;
  fills.tick();
  assert.equal(fills.peek(s), null);
});

test("idle fills past FILLS_IDLE_VERTICES go, the oldest first, and one taken again is not counted", () => {
  let now = 0;
  const fills = new SharedFills(() => now);
  const third = Math.floor(FILLS_IDLE_VERTICES / 3);
  const shapes = [1, 2, 3, 4].map(shape);
  for (const s of shapes) {
    fills.take(s, null, tessellated(third));
  }

  for (const s of shapes.slice(0, 3)) {
    now++;
    fills.give(s);
  }
  assert.ok(shapes.every((s) => fills.peek(s) !== null));

  // Taken again, the first is no longer idle: the fourth fits beside the other two.
  fills.take(shapes[0], null, tessellated(third));
  fills.give(shapes[3]);
  assert.ok(shapes.every((s) => fills.peek(s) !== null));

  // Given back last, it is the newest: the second, the oldest idle, goes for it.
  fills.give(shapes[0]);
  assert.equal(fills.peek(shapes[1]), null);
  assert.notEqual(fills.peek(shapes[0]), null);
  assert.notEqual(fills.peek(shapes[2]), null);
  assert.notEqual(fills.peek(shapes[3]), null);
});

test("fills let go for room and built again within FILLS_IDLE_MS grow the budget, which shrinks back", () => {
  let now = 0;
  const fills = new SharedFills(() => now, {});
  const half = FILLS_IDLE_VERTICES / 2;
  const shapes = [1, 2, 3].map(shape);
  for (const s of shapes) {
    fills.take(s, null, tessellated(half));
  }

  for (const s of shapes) {
    now++;
    fills.give(s);
  }
  assert.equal(fills.peek(shapes[0]), null);
  assert.equal(fills.budget.size, FILLS_IDLE_VERTICES);

  // The first comes back: kept for age, it went for room alone, and the budget grows by it.
  fills.take(shapes[0], null, tessellated(half));
  assert.equal(fills.budget.size, FILLS_IDLE_VERTICES + half);
  fills.give(shapes[0]);
  assert.ok(shapes.every((s) => fills.peek(s) !== null));

  // Nothing comes back for long: back to the floor, the oldest idle going as it does.
  now += 30 * FILLS_IDLE_MS;
  fills.tick();
  assert.equal(fills.budget.size, FILLS_IDLE_VERTICES);
  assert.ok(shapes.every((s) => fills.peek(s) === null));
});
