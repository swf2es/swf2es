// A store's texture (scene/paints.ts) and the bytes textures are uploaded
// from (render's Textures): a store's pixels as the RGBA bytes a texture
// holds; a store that changes uploaded again from the same bytes rather
// than from new ones every frame; and those bytes lent again after an idle
// texture or a lost context let them go, and let go of once they stop
// changing. A store still of the one colour it was made is cleared to it
// on the GPU instead, with no pixels made or uploaded.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BitmapStore, rgbaInto, rgbaOf } from "../../../../packages/player/dist/bitmap/bitmap.js";
import { Paints } from "../../../../packages/player/dist/scene/paints.js";
import { KEEP_FRAMES, Textures } from "../../../../packages/render/dist/index.js";

/** rgbaOf a byte at a time, as the texture reads it. */
function bytewise(pixels: Uint32Array, opaque = false): number[] {
  return [...pixels].flatMap((p) => [
    (p >>> 16) & 0xff,
    (p >>> 8) & 0xff,
    p & 0xff,
    opaque ? 255 : p >>> 24,
  ]);
}

/** What the backend does as it renders: each pending texture's pixels uploaded and let go of. */
function upload(textures: Textures): Map<number, Uint8Array | Float32Array> {
  const uploaded = new Map<number, Uint8Array | Float32Array>();
  for (const id of textures.pending) {
    const data = textures.get(id);
    if (data?.pixels) {
      uploaded.set(id, data.pixels);
      data.pixels = null;
    }
  }

  textures.pending.length = 0;
  return uploaded;
}

/** A frame drawn: the texture used, uploaded, and the frame ended. */
function frame(textures: Textures, id = -1): Map<number, Uint8Array | Float32Array> {
  if (id >= 0) {
    textures.use(id);
  }

  const uploaded = upload(textures);
  textures.endFrame();
  return uploaded;
}

test("a pixel's bytes are red, green, blue and alpha, written whole or a byte at a time", () => {
  const pixels = new Uint32Array([0x80402010, 0xff000000, 0x00000000, 0xffffffff, 0x7f7f0080]);
  assert.deepEqual([...rgbaOf(pixels)], bytewise(pixels));

  // Bytes that start off a word take them a byte at a time.
  const shifted = new Uint8Array(pixels.length * 4 + 1).subarray(1);
  rgbaInto(pixels, shifted);
  assert.deepEqual([...shifted], bytewise(pixels));

  // Opaque, every alpha 255, either way.
  const opaque = new Uint8Array(pixels.length * 4);
  rgbaInto(pixels, opaque, true);
  assert.deepEqual([...opaque], bytewise(pixels, true));
  rgbaInto(pixels, shifted, true);
  assert.deepEqual([...shifted], bytewise(pixels, true));

  // Too few bytes are refused alike, aligned or not, and none written.
  const short = new Uint8Array(pixels.length * 4 - 4);
  assert.throws(() => rgbaInto(pixels, short), RangeError);
  assert.throws(() => rgbaInto(pixels, shifted.subarray(0, 8)), RangeError);
  assert.deepEqual([...short], new Array(short.length).fill(0));
});

test("a store that changes is uploaded again from the same bytes", () => {
  const textures = new Textures();
  const paints = new Paints(textures);
  const store = new BitmapStore(3, 2, true, 0x80402010);
  store.setPixel32(1, 0, 0x40ff8000);
  const handle = paints.storeTexture(store);
  const first = frame(textures, handle.id).get(handle.id);
  assert.ok(first);
  assert.deepEqual([...(first ?? [])], bytewise(store.pixels));

  store.fillRect({ x: 0, y: 0, width: 1, height: 1 }, 0xff112233);
  assert.equal(paints.storeTexture(store), handle);
  const again = frame(textures, handle.id).get(handle.id);
  assert.equal(again, first, "the bytes the first upload let go of");
  assert.deepEqual([...(again ?? [])], bytewise(store.pixels));

  store.setPixel32(2, 1, 0xff445566);
  paints.storeTexture(store);
  const third = frame(textures, handle.id).get(handle.id);
  assert.equal(third, first, "the same bytes");
  assert.deepEqual([...(third ?? [])], bytewise(store.pixels));

  // Unchanged, nothing is uploaded.
  paints.storeTexture(store);
  assert.equal(textures.pending.length, 0);
});

test("an opaque store holding alpha is uploaded opaque, from its own pixels", () => {
  const textures = new Textures();
  const paints = new Paints(textures);
  const store = new BitmapStore(2, 2, false, 0xff336699);
  store.pixels[1] = 0x40102030;
  store.holdsAlpha = true;
  store.changed();
  const handle = paints.storeTexture(store);
  const bytes = frame(textures, handle.id).get(handle.id) as Uint8Array;
  assert.deepEqual([...bytes], bytewise(store.drawable));
  assert.equal(bytes[7], 255);
});

test("a texture added again after a lost context or going idle takes the bytes it let go of", () => {
  const textures = new Textures();
  const paints = new Paints(textures);
  const store = new BitmapStore(4, 4, true, 0x80402010);
  store.setPixel32(3, 3, 0xff102030);
  let handle = paints.storeTexture(store);
  const bytes = frame(textures, handle.id).get(handle.id);
  assert.ok(bytes);

  // A lost context takes every texture; the store's is added again, from the same bytes.
  textures.lost();
  handle = paints.storeTexture(store);
  assert.equal(frame(textures, handle.id).get(handle.id), bytes);

  // Undrawn for its idle frames, the texture goes, and its bytes come back to the next.
  const idle = paints.storeTexture(store, 2);
  assert.equal(idle, handle);
  for (let i = 0; i < 4; i++) {
    frame(textures);
  }

  assert.equal(textures.alive(handle), false, "let go of after the 2 idle frames asked for");
  handle = paints.storeTexture(store);
  assert.equal(frame(textures, handle.id).get(handle.id), bytes);
});

test("a store of one colour as made is cleared to it, with no bytes, till it is written", () => {
  const textures = new Textures();
  const paints = new Paints(textures);
  for (const [transparent, fill, pixel] of [
    [true, 0x80402010, 0x80201008],
    [true, 0, 0],
    [false, 0x00336699, 0xff336699],
  ] as const) {
    const store = new BitmapStore(5, 3, transparent, fill);
    assert.equal(store.solidPixel, pixel);
    const handle = paints.storeTexture(store);
    const data = textures.get(handle.id);
    assert.deepEqual(
      { pixels: data?.pixels, fill: data?.fill, width: data?.width, height: data?.height },
      { pixels: null, fill: pixel, width: 5, height: 3 },
    );
    assert.equal(frame(textures, handle.id).size, 0, "no bytes uploaded");
    assert.equal(store.solidPixel, pixel, "still unmade");

    // Written, it is uploaded from its pixels, made of the colour first.
    store.setPixel32(0, 0, 0xff000000);
    assert.equal(store.solidPixel, null);
    assert.equal(paints.storeTexture(store), handle);
    const bytes = frame(textures, handle.id).get(handle.id) as Uint8Array;
    const expected = new Uint32Array(15).fill(pixel);
    expected[0] = 0xff000000;
    assert.deepEqual([...bytes], bytewise(expected));
  }

  // An opaque store said to hold alpha is uploaded from its pixels, as drawn.
  const holding = new BitmapStore(2, 2, false, 0xff336699);
  holding.holdsAlpha = true;
  const handle = paints.storeTexture(holding);
  assert.equal(textures.get(handle.id)?.fill, null);
  assert.deepEqual(
    [...(frame(textures, handle.id).get(handle.id) as Uint8Array)],
    bytewise(new Uint32Array(4).fill(0xff336699)),
  );
});

test("bytes a texture set again keeps go once it stops changing, and spare ones after them", () => {
  const textures = new Textures();
  const lent = textures.bytes(64);
  const handle = textures.add(4, 4, lent);
  frame(textures, handle.id);

  // Set again, it keeps its bytes; at another size, it takes others and spares those.
  const again = textures.bytes(64, handle.id);
  assert.equal(again, lent);
  textures.set(handle.id, 4, 4, again);
  frame(textures, handle.id);
  const larger = textures.bytes(256, handle.id);
  assert.notEqual(larger, lent);
  textures.set(handle.id, 8, 8, larger);
  frame(textures, handle.id);
  assert.equal(textures.heldBytes, 256 + 64);
  assert.equal(textures.bytes(64), lent, "the spare bytes of that length");

  // Unchanged for KEEP_FRAMES, and spare for as long after, they are let go of.
  for (let i = 0; i < 2 * KEEP_FRAMES + 2; i++) {
    frame(textures, handle.id);
  }

  assert.equal(textures.heldBytes, 0);
  assert.notEqual(textures.bytes(256, handle.id), larger);
});
