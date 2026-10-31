// A store's texture (scene/paints.ts): its pixels as the RGBA bytes a
// texture holds, and a store that changes uploaded again from the same
// bytes rather than from new ones every frame.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BitmapStore, rgbaInto, rgbaOf } from "../../../../packages/player/dist/bitmap/bitmap.js";
import { Paints } from "../../../../packages/player/dist/scene/paints.js";
import { Textures } from "../../../../packages/render/dist/index.js";

/** rgbaOf a byte at a time, as the texture reads it. */
function bytewise(pixels: Uint32Array): number[] {
  return [...pixels].flatMap((p) => [(p >>> 16) & 0xff, (p >>> 8) & 0xff, p & 0xff, p >>> 24]);
}

test("a pixel's bytes are red, green, blue and alpha, written whole or a byte at a time", () => {
  const pixels = new Uint32Array([0x80402010, 0xff000000, 0x00000000, 0xffffffff, 0x7f7f0080]);
  assert.deepEqual([...rgbaOf(pixels)], bytewise(pixels));

  // Bytes that start off a word take them a byte at a time.
  const shifted = new Uint8Array(pixels.length * 4 + 1).subarray(1);
  rgbaInto(pixels, shifted);
  assert.deepEqual([...shifted], bytewise(pixels));
});

test("a store that changes is uploaded again from the same bytes", () => {
  const textures = new Textures();
  const paints = new Paints(textures);
  const store = new BitmapStore(3, 2, true, 0x80402010);
  const handle = paints.storeTexture(store);
  const first = textures.get(handle.id)?.pixels;
  assert.deepEqual([...(first ?? [])], bytewise(store.pixels));

  // The backend takes the pixels as it uploads them.
  const upload = () => {
    const data = textures.get(handle.id);
    const pixels = data?.pixels ?? null;
    if (data) {
      data.pixels = null;
    }

    textures.pending.length = 0;
    return pixels;
  };

  upload();
  store.fillRect({ x: 0, y: 0, width: 1, height: 1 }, 0xff112233);
  assert.equal(paints.storeTexture(store), handle);
  const again = upload();
  assert.deepEqual([...(again ?? [])], bytewise(store.pixels));

  store.setPixel32(2, 1, 0xff445566);
  paints.storeTexture(store);
  const third = upload();
  assert.equal(third, again, "the same bytes");
  assert.deepEqual([...(third ?? [])], bytewise(store.pixels));

  // Unchanged, nothing is uploaded.
  paints.storeTexture(store);
  assert.equal(textures.pending.length, 0);
});
