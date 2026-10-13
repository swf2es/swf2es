// The batchers of render groups that stay: cut back once they have long
// used little of buffers Pixi only grows, what they packed kept.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { trimBatchers } from "../../../../packages/player/dist/render/batchers.js";

const cjs = createRequire(new URL("../../../../packages/player/package.json", import.meta.url));
const pixi = pathToFileURL(cjs.resolve("pixi.js").replace(/\.js$/, ".mjs")).href;
const { Buffer, BufferUsage, ViewableBuffer } = (await import(pixi)) as {
  Buffer: new (options: {
    data: ArrayLike<number>;
    usage: number;
    shrinkToFit?: boolean;
  }) => {
    data: Float32Array | Uint16Array;
    _gpuData: Record<number, { byteLength: number } | null>;
  };
  BufferUsage: { VERTEX: number; INDEX: number; COPY_DST: number };
  ViewableBuffer: new (size: number) => { size: number; float32View: Float32Array };
};

const RENDERER_UID = 7;

/** A batcher whose buffers hold `floats` attribute floats and `indices` indices, of which it packed `used`. */
function batcher(floats: number, indices: number, used: { floats: number; indices: number }) {
  const attributeBuffer = new ViewableBuffer(floats * 4);
  attributeBuffer.float32View.forEach((_, i, a) => {
    a[i] = i;
  });
  const indexBuffer = new Uint16Array(indices).map((_, i) => i);
  const usage = BufferUsage.COPY_DST;
  const attributes = new Buffer({
    data: attributeBuffer.float32View,
    usage: usage | BufferUsage.VERTEX,
    shrinkToFit: false,
  });
  const index = new Buffer({
    data: indexBuffer,
    usage: usage | BufferUsage.INDEX,
    shrinkToFit: false,
  });
  attributes._gpuData[RENDERER_UID] = { byteLength: floats * 4 };
  return {
    attributeBuffer: Object.assign(attributeBuffer, { destroy() {} }),
    indexBuffer,
    attributeSize: used.floats,
    indexSize: used.indices,
    geometry: { buffers: [attributes], indexBuffer: index },
  };
}

function rendererWith(batchers: Record<string, object>) {
  return {
    uid: RENDERER_UID,
    type: 1,
    renderPipes: { batch: { _batchersByInstructionSet: { 3: batchers } } },
  } as unknown as Parameters<typeof trimBatchers>[0];
}

test("a batcher long under a quarter of its buffers is cut back, what it packed kept", () => {
  const large = batcher(1 << 16, 1 << 15, { floats: 600, indices: 300 });
  const busy = batcher(1 << 16, 1 << 15, { floats: 40_000, indices: 20_000 });
  const renderer = rendererWith({ default: large, color: busy });

  trimBatchers(renderer, 0);
  trimBatchers(renderer, 1000);
  assert.equal(large.attributeBuffer.size, 1 << 18, "kept while it has not been low long");

  trimBatchers(renderer, 5000);
  assert.equal(large.attributeBuffer.size, 600 * 2 * 4);
  assert.equal(large.indexBuffer.length, 600);
  assert.ok(large.indexBuffer instanceof Uint16Array);
  assert.deepEqual([...large.attributeBuffer.float32View.subarray(0, 600)], [...Array(600).keys()]);
  assert.deepEqual([...large.indexBuffer.subarray(0, 300)], [...Array(300).keys()]);
  assert.equal(large.geometry.buffers[0].data, large.attributeBuffer.float32View);
  assert.equal(large.geometry.indexBuffer.data, large.indexBuffer);
  assert.equal(
    large.geometry.buffers[0]._gpuData[RENDERER_UID]?.byteLength,
    -1,
    "WebGL's made anew",
  );

  assert.equal(
    busy.attributeBuffer.size,
    1 << 18,
    "a batcher using much of its buffers keeps them",
  );
});

test("a batcher whose use comes back above a quarter starts its wait again", () => {
  const swinging = batcher(1 << 16, 1 << 15, { floats: 600, indices: 300 });
  const renderer = rendererWith({ default: swinging });

  trimBatchers(renderer, 0);
  swinging.attributeSize = 40_000;
  trimBatchers(renderer, 2000);
  swinging.attributeSize = 600;
  trimBatchers(renderer, 4000);
  trimBatchers(renderer, 6000);
  assert.equal(swinging.attributeBuffer.size, 1 << 18);

  trimBatchers(renderer, 7001);
  assert.equal(swinging.attributeBuffer.size, 600 * 2 * 4);
});
