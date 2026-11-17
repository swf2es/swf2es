import assert from "node:assert/strict";
import { test } from "node:test";
import { Textures } from "../../../../packages/render/dist/textures.js";
import { GpuTextures } from "../../../../packages/render/dist/webgl/gpu-textures.js";

test("video uploads reuse storage and a rejected picture cannot strand subsequent uploads", () => {
  let fail = true;
  let images = 0;
  let updates = 0;
  const packing: boolean[] = [];
  const gl = {
    createTexture: () => ({}),
    deleteTexture() {},
    pixelStorei(_key: number, value: boolean) {
      packing.push(value);
    },
    texImage2D() {
      images++;
      if (fail) {
        throw new Error("closed frame");
      }
    },
    texSubImage2D() {
      updates++;
      if (fail) {
        throw new Error("tainted frame");
      }
    },
  } as unknown as ConstructorParameters<typeof GpuTextures>[0];
  const state = {
    bindTexture() {},
    activeTexture() {},
    dropTexture() {},
  } as unknown as ConstructorParameters<typeof GpuTextures>[1];
  const gpu = new GpuTextures(gl, state);
  const textures = new Textures();
  const handle = textures.addSource(2, 2, {});
  const flush = () => gpu.uploadTextures(textures, () => {});
  assert.doesNotThrow(flush);
  assert.equal(textures.pending.length, 0);
  assert.equal(textures.get(handle.id)?.source, null);
  flush();
  assert.equal(images, 1, "failed picture was retried");
  fail = false;
  textures.setSource(handle.id, 2, 2, {});
  flush();
  assert.equal(images, 2);
  textures.setSource(handle.id, 2, 2, {});
  flush();
  assert.equal(updates, 1);
  fail = true;
  textures.setSource(handle.id, 2, 2, {});
  assert.doesNotThrow(flush);
  flush();
  assert.equal(updates, 2);
  assert.equal(packing.at(-1), false);
  fail = false;
  textures.setSource(handle.id, 3, 2, {});
  flush();
  assert.equal(images, 3);
});
