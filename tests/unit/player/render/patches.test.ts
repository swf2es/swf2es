// What the player keeps of a context once Pixi has built it: its
// tessellation in typed arrays, its paths' shapes without their commands;
// and that it builds the same again from that.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import "../../../../packages/player/dist/render/patches.js";

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
  instructions: { data: { path: { instructions: unknown[] } } }[];
  moveTo(x: number, y: number): Context;
  lineTo(x: number, y: number): Context;
  closePath(): Context;
  fill(style: unknown): Context;
  unload(): void;
};
const { GraphicsContext, GraphicsContextSystem, Texture } = (await import(pixi)) as {
  GraphicsContext: new () => Context;
  GraphicsContextSystem: new (
    renderer: unknown,
  ) => {
    updateGpuContext(context: Context): { isBatchable: boolean; geometryData: Tessellated };
  };
  Texture: { WHITE: unknown; EMPTY: unknown };
};

function system() {
  const hashes: { items: Record<number, unknown> }[] = [];
  return new GraphicsContextSystem({
    uid: 1,
    gc: {
      now: 0,
      addResourceHash: (hash: { items: Record<number, unknown> }) => hashes.push(hash),
    },
    limits: { maxBatchableTextures: 16 },
  });
}

/** A star of `points` points, many enough to be compacted. */
function star(points: number, mode: string, texture?: unknown): Context {
  const context = new GraphicsContext();
  context.batchMode = mode;
  context.moveTo(100, 0);
  for (let i = 1; i < points * 2; i++) {
    const r = i % 2 ? 40 : 100;
    const a = (i * Math.PI) / points;
    context.lineTo(r * Math.cos(a) + 0.1, r * Math.sin(a) + 0.3);
  }

  context.closePath().fill(texture ? { texture, color: 0xffffff } : { color: 0xff0000 });
  return context;
}

const plain = (data: Tessellated) => ({
  vertices: Array.from(data.vertices),
  uvs: Array.from(data.uvs),
  indices: Array.from(data.indices),
});

test("a context drawn alone keeps 32-bit positions, zeros for UVs and 16-bit indices", () => {
  const contexts = system();
  const context = star(40, "no-batch");
  const bounds = { ...context.bounds };

  const gpu = contexts.updateGpuContext(context);
  const data = gpu.geometryData;
  assert.equal(gpu.isBatchable, false);
  assert.ok(data.vertices instanceof Float32Array);
  assert.ok(data.uvs instanceof Float32Array);
  assert.ok(data.indices instanceof Uint16Array);
  assert.equal(data.uvs.length, data.vertices.length);
  assert.ok(Array.from(data.uvs).every((uv) => uv === 0));
  assert.deepEqual(context.instructions[0].data.path.instructions, []);

  // Its bounds, and a build anew, as Pixi's collection or a change has it, come from the shapes.
  const first = plain(data);
  (context as unknown as { _boundsDirty: boolean })._boundsDirty = true;
  assert.deepEqual({ ...context.bounds }, bounds);
  context.dirty = true;
  assert.deepEqual(plain(contexts.updateGpuContext(context).geometryData), first);
  context.unload();
  assert.deepEqual(plain(contexts.updateGpuContext(context).geometryData), first);
});

test("a batched context keeps its positions as 64-bit floats, and a textured one its UVs", () => {
  const contexts = system();
  const batched = contexts.updateGpuContext(star(40, "batch"));
  assert.equal(batched.isBatchable, true);
  assert.ok(batched.geometryData.vertices instanceof Float64Array);
  assert.equal(batched.geometryData.vertices[2], 40 * Math.cos(Math.PI / 40) + 0.1);

  const textured = contexts.updateGpuContext(star(40, "no-batch", Texture.EMPTY));
  assert.ok(textured.geometryData.uvs instanceof Float32Array);
  assert.ok(Array.from(textured.geometryData.uvs).some((uv) => uv !== 0));
});

test("a small context stays as Pixi built it", () => {
  const gpu = system().updateGpuContext(star(3, "no-batch"));
  assert.ok(Array.isArray(gpu.geometryData.vertices));
});

test("a batch's textures cleared leave no IDs behind", async () => {
  const { BatchTextureArray } = (await import(pixi)) as {
    BatchTextureArray: new () => {
      ids: Record<number, number>;
      textures: { uid: number }[];
      count: number;
      clear(): void;
    };
  };
  const batch = new BatchTextureArray();
  for (let round = 0; round < 3; round++) {
    for (let i = 0; i < 4; i++) {
      const uid = 1000 * round + i * 37;
      batch.ids[uid] = batch.count;
      batch.textures[batch.count++] = { uid };
    }

    assert.equal(batch.ids[1000 * round + 37], 1);
    batch.clear();
    assert.deepEqual(Object.keys(batch.ids), []);
    assert.equal(batch.count, 0);
  }
});
