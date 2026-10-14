// What the player lets go of in a context once Pixi has built it: its
// paths' commands, flattened to shapes by then, and that it measures and
// builds the same again from those; or, for a view's own, its paths
// whole, a copy made anew from what made it.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import {
  copyContext,
  forgetCommands,
  remakeable,
} from "../../../../packages/player/dist/render/tessellate.js";

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
