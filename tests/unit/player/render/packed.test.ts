// What Pixi packs of a context drawn alone: let go of on the CPU as a
// frame ends, and packed again the same when the GPU's copy is gone or
// the transform table's atlas is to copy it in.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { packedOnCpu } from "../../../../packages/player/dist/render/packed.js";
import "../../../../packages/player/dist/render/patches.js";

const cjs = createRequire(new URL("../../../../packages/player/package.json", import.meta.url));
const pixi = pathToFileURL(cjs.resolve("pixi.js").replace(/\.js$/, ".mjs")).href;
type Buffer = {
  data: Float32Array | Uint16Array;
  _updateID: number;
  _gpuData: Record<number, { buffer: object; updateID: number } | null>;
};
type RenderData = {
  $dropped?: boolean;
  batcher: {
    attributeSize: number;
    indexSize: number;
    attributeBuffer: { float32View: Float32Array };
    indexBuffer: Uint16Array | Uint32Array;
    geometry: { buffers: Buffer[]; indexBuffer: Buffer };
  };
};
type Context = {
  batchMode: string;
  moveTo(x: number, y: number): Context;
  lineTo(x: number, y: number): Context;
  closePath(): Context;
  fill(style: unknown): Context;
};
const { DOMAdapter, GraphicsContext, GraphicsContextSystem } = (await import(pixi)) as {
  DOMAdapter: { get(): object; set(adapter: object): void };
  GraphicsContext: new () => Context;
  GraphicsContextSystem: new (
    renderer: unknown,
  ) => {
    updateGpuContext(context: Context): unknown;
    getContextRenderData(context: Context): RenderData;
  };
};

const UID = 3;
// Node has no canvas, whose WebGL Pixi asks the batchers' shader's precision of: one without a context.
DOMAdapter.set({ ...DOMAdapter.get(), createCanvas: () => ({ getContext: () => null }) });

function setUp() {
  let postrender = () => {};
  const renderer = {
    uid: UID,
    type: 1,
    gc: { now: 0, addResourceHash() {} },
    limits: { maxBatchableTextures: 16 },
    runners: {
      postrender: {
        add: (runner: { postrender(): void }) => (postrender = () => runner.postrender()),
      },
    },
  };
  const contexts = new GraphicsContextSystem(renderer);
  Object.assign(renderer, { graphicsContext: contexts });
  return { renderer, contexts, endFrame: () => postrender() };
}

function star(): Context {
  const context = new GraphicsContext();
  context.batchMode = "no-batch";
  context.moveTo(100, 0);
  for (let i = 1; i < 80; i++) {
    const r = i % 2 ? 40 : 100;
    const a = (i * Math.PI) / 40;
    context.lineTo(r * Math.cos(a), r * Math.sin(a));
  }

  return context.closePath().fill({ color: 0x3366cc });
}

/** As WebGL does once it drew `data`: its buffers uploaded. */
function upload(data: RenderData): void {
  const { buffers, indexBuffer } = data.batcher.geometry;
  for (const buffer of [buffers[0], indexBuffer]) {
    buffer._gpuData[UID] = { buffer: {}, updateID: buffer._updateID };
  }
}

const packing = (data: RenderData) => ({
  attributes: Array.from(
    data.batcher.attributeBuffer.float32View.subarray(0, data.batcher.attributeSize),
  ),
  indices: Array.from(data.batcher.indexBuffer.subarray(0, data.batcher.indexSize)),
});

test("what a frame packed is let go of as it ends, and drawn from the GPU while it holds it", () => {
  const { contexts, endFrame } = setUp();
  const context = star();
  contexts.updateGpuContext(context);
  const data = contexts.getContextRenderData(context);
  const packed = packing(data);
  const type = data.batcher.indexBuffer.constructor;
  upload(data);

  endFrame();
  assert.equal(data.$dropped, true);
  assert.equal(data.batcher.attributeBuffer.float32View.length, 0);
  assert.equal(data.batcher.indexBuffer.length, 0);
  assert.equal(data.batcher.indexBuffer.constructor, type, "a draw reads the index type");
  assert.equal(data.batcher.geometry.indexBuffer.data, data.batcher.indexBuffer);
  assert.equal(contexts.getContextRenderData(context), data);

  // The GPU's copy gone, as a lost context leaves it: packed again, the same.
  data.batcher.geometry.buffers[0]._gpuData[UID] = null;
  const again = contexts.getContextRenderData(context);
  assert.equal(again.$dropped, false);
  assert.deepEqual(packing(again), packed);

  // For the atlas, packed again though the GPU holds it.
  upload(again);
  endFrame();
  assert.equal(again.$dropped, true);
  const copied = packedOnCpu(setUpRenderer(contexts), context as never) as RenderData;
  assert.deepEqual(packing(copied), packed);
});

function setUpRenderer(contexts: unknown) {
  return { uid: UID, graphicsContext: contexts } as unknown as Parameters<typeof packedOnCpu>[0];
}
