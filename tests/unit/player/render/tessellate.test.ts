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

type BatchContext = {
  batchMode: string;
  rect(x: number, y: number, width: number, height: number): BatchContext;
  fill(style: unknown): BatchContext;
  stroke(style: unknown): BatchContext;
  texture(
    texture: unknown,
    tint: number,
    x: number,
    y: number,
    width: number,
    height: number,
  ): BatchContext;
  moveTo(x: number, y: number): BatchContext;
  lineTo(x: number, y: number): BatchContext;
  destroy(): void;
};
type Batch = {
  indexOffset: number;
  indexSize: number;
  attributeOffset: number;
  attributeSize: number;
  baseColor: number;
  alpha: number;
  topology: string;
  texture: unknown;
};
type BatchedGeometry = {
  batches: Batch[];
  geometryData: { vertices: ArrayLike<number>; indices: ArrayLike<number>; uvs: ArrayLike<number> };
};
const {
  GraphicsContext: BatchGraphicsContext,
  GraphicsContextSystem: BatchContextSystem,
  Texture: BatchTexture,
} = (await import(pixi)) as {
  GraphicsContext: new () => BatchContext;
  GraphicsContextSystem: new (
    renderer: unknown,
  ) => { updateGpuContext(context: BatchContext): BatchedGeometry };
  Texture: { EMPTY: unknown };
};

function buildBatches(context: BatchContext): BatchedGeometry {
  context.batchMode = "batch";
  const contexts = new BatchContextSystem({
    uid: 1,
    gc: { now: 0, addResourceHash() {} },
    limits: { maxBatchableTextures: 16 },
  });
  return contexts.updateGpuContext(context);
}

test("dense identical fills keep one batch beyond 16-bit vertex indices", () => {
  const context = new BatchGraphicsContext();
  const count = 17_000;
  for (let i = 0; i < count; i++) {
    context.rect(i * 3, 0, 2, 2);
  }

  context.fill({ color: 0x336699, alpha: 0.5 });
  const { batches, geometryData: data } = buildBatches(context);
  assert.equal(batches.length, 1);
  assert.equal(batches[0].attributeOffset, 0);
  assert.equal(batches[0].indexOffset, 0);
  assert.equal(batches[0].attributeSize, count * 4);
  assert.equal(batches[0].indexSize, count * 6);
  assert.ok(data.indices instanceof Uint32Array);
  const first = Array.from(data.indices).slice(0, 6);
  for (let i = 0; i < count; i++) {
    for (let j = 0; j < 4; j++) {
      assert.equal(data.vertices[i * 8 + j * 2], i * 3 + data.vertices[j * 2]);
      assert.equal(data.vertices[i * 8 + j * 2 + 1], data.vertices[j * 2 + 1]);
    }

    for (let j = 0; j < 6; j++) {
      assert.equal(data.indices[i * 6 + j], i * 4 + first[j]);
    }
  }

  context.destroy();
});

test("paint and topology changes preserve contiguous batch order", () => {
  const context = new BatchGraphicsContext();
  context.rect(0, 0, 2, 2).fill({ color: 0xff0000 });
  context.rect(4, 0, 2, 2).fill({ color: 0xff0000 });
  context.rect(8, 0, 2, 2).fill({ color: 0x0000ff });
  context.rect(12, 0, 2, 2).fill({ color: 0x0000ff, alpha: 0.5 });
  context.rect(16, 0, 2, 2).fill({ texture: BatchTexture.EMPTY, color: 0x0000ff, alpha: 0.5 });
  context.moveTo(20, 0).lineTo(20, 2).stroke({ color: 0x0000ff, alpha: 0.5, pixelLine: true });
  context.rect(24, 0, 2, 2).fill({ color: 0xff0000 });
  const { batches, geometryData: data } = buildBatches(context);
  assert.equal(batches.length, 6);
  assert.deepEqual(
    batches.map((batch) => batch.baseColor),
    [0xff0000, 0x0000ff, 0x0000ff, 0x0000ff, 0x0000ff, 0xff0000],
  );
  assert.deepEqual(
    batches.map((batch) => batch.alpha),
    [1, 1, 0.5, 0.5, 0.5, 1],
  );
  assert.equal(batches[3].texture, BatchTexture.EMPTY);
  assert.equal(batches[4].topology, "line-list");
  assert.equal(batches[5].topology, "triangle-list");
  let vertices = 0;
  let indices = 0;
  for (const batch of batches) {
    assert.equal(batch.attributeOffset, vertices);
    assert.equal(batch.indexOffset, indices);
    vertices += batch.attributeSize;
    indices += batch.indexSize;
  }

  assert.equal(vertices * 2, data.vertices.length);
  assert.equal(indices, data.indices.length);
  context.destroy();
});

test("adjacent texture quads keep the same UVs and indices when coalesced", () => {
  const context = new BatchGraphicsContext();
  context.texture(BatchTexture.EMPTY, 0xffffff, 3, 4, 2, 3);
  context.texture(BatchTexture.EMPTY, 0xffffff, 8, 9, 4, 5);
  const actual = buildBatches(context);
  const vertices: number[] = [];
  const indices: number[] = [];
  const uvs: number[] = [];
  for (const [x, y, w, h] of [
    [3, 4, 2, 3],
    [8, 9, 4, 5],
  ]) {
    const single = new BatchGraphicsContext();
    single.texture(BatchTexture.EMPTY, 0xffffff, x, y, w, h);
    const data = buildBatches(single).geometryData;
    const offset = vertices.length / 2;
    vertices.push(...Array.from(data.vertices));
    uvs.push(...Array.from(data.uvs));
    indices.push(...Array.from(data.indices, (n) => n + offset));
    single.destroy();
  }
  assert.equal(actual.batches.length, 1);
  assert.deepEqual(Array.from(actual.geometryData.vertices), vertices);
  assert.deepEqual(Array.from(actual.geometryData.indices), indices);
  assert.deepEqual(Array.from(actual.geometryData.uvs), uvs);
  context.destroy();
});
