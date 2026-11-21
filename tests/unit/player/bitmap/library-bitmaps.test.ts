// A SWF's lossless bitmaps (timeline.ts' losslessPixels, BitmapStore's
// `source`): read without inflating them, inflated when first wanted, let
// go of once a texture holds them, and inflated again, the same pixels,
// when they are read after, a lost context's texture made again among
// them. A store a script writes is its own, and never let go of.
import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { decodeLossless, readSwf, zlibCompress } from "@swf2es/format";
import {
  BitmapStore,
  characterStore,
  rgbaOf,
  symbolStore,
} from "../../../../packages/player/dist/bitmap/bitmap.js";
import {
  type BitmapCharacter,
  heldPixels,
  keptPixels,
  readLibrary,
} from "../../../../packages/player/dist/display/timeline.js";
import { Paints } from "../../../../packages/player/dist/scene/paints.js";
import { Textures } from "../../../../packages/render/dist/index.js";
import * as w from "../../../swf-writer.ts";

setFlagsFromString("--expose-gc");
const gc: () => void = runInNewContext("gc");

const WIDTH = 3;
const HEIGHT = 2;
/** Premultiplied ARGB, as DefineBitsLossless2 holds it. */
const ARGB = [0xff102030, 0x80402010, 0x00000000, 0xffffffff, 0x40201008, 0xff0a0b0c];

/** A SWF of one DefineBitsLossless2, its id `id`, its pixels ARGB with `salt` in the last blue. */
function movie(id = 1, salt = 0): Uint8Array {
  const raw = ARGB.flatMap((p, i) => [
    p >>> 24,
    (p >>> 16) & 0xff,
    (p >>> 8) & 0xff,
    (i === ARGB.length - 1 ? p + salt : p) & 0xff,
  ]);
  const body = [id & 0xff, id >> 8, 5, WIDTH, 0, HEIGHT, 0, ...zlibCompress(Uint8Array.from(raw))];
  return w.swf({
    width: 100,
    height: 100,
    frameCount: 1,
    tags: [w.tag(36, Uint8Array.from(body), true), w.showFrame(), w.end()],
  });
}

function bitmapIn(bytes: Uint8Array, id = 1): BitmapCharacter {
  const character = readLibrary(readSwf(bytes)).characters.get(id);
  assert.ok(character?.type === "bitmap");
  return character;
}

function definitionOf(character: BitmapCharacter) {
  const definition = character.definition;
  assert.ok(definition.type === "lossless");
  return definition;
}

/** What the backend does as it renders: each pending texture's bytes taken, copied, as it uploads them. */
function upload(textures: Textures): Map<number, number[]> {
  const uploaded = new Map<number, number[]>();
  for (const id of textures.pending) {
    const data = textures.get(id);
    if (data?.pixels) {
      uploaded.set(id, [...data.pixels]);
      data.pixels = null;
    }
  }

  textures.pending.length = 0;
  textures.endFrame();
  return uploaded;
}

/** Collections till `held` lets go, or ten went by. */
async function collect(held: () => unknown): Promise<void> {
  for (let i = 0; i < 10 && held(); i++) {
    await setImmediate();
    gc();
  }
}

test("a lossless bitmap is read without inflating it, and inflated as it is first wanted", () => {
  const character = bitmapIn(movie(1, 1));
  const definition = definitionOf(character);
  assert.equal(heldPixels(definition), null, "not inflated as the SWF is read");

  const pixels = character.pixels;
  assert.ok(pixels);
  assert.deepEqual([pixels.width, pixels.height, pixels.transparent], [WIDTH, HEIGHT, true]);
  assert.deepEqual(
    [...pixels.pixels],
    ARGB.map((p, i) => (i === ARGB.length - 1 ? p + 1 : p) >>> 0),
  );
  // Asked again while held, the same pixels, not inflated again.
  assert.equal(character.pixels?.pixels, pixels.pixels);
  assert.equal(heldPixels(definition), pixels.pixels);
});

test("a bitmap's store lets go of its pixels once uploaded, and inflates them again, the same, as they are read", async () => {
  const character = bitmapIn(movie(1, 2));
  const definition = definitionOf(character);
  const expected = [...(decodeLossless(definition)?.pixels ?? [])];
  assert.equal(heldPixels(definition), null, "nothing holds them till a store is made");

  const textures = new Textures();
  const paints = new Paints(textures);
  const store = characterStore(character);
  assert.ok(store);
  assert.equal(characterStore(character), store);
  const handle = paints.storeTexture(store);
  const texels = upload(textures).get(handle.id);
  assert.deepEqual(texels, [...rgbaOf(Uint32Array.from(expected))]);
  assert.equal(store.releasedPixels, true, "let go of once the texture holds them");

  await collect(() => heldPixels(definition));
  assert.equal(heldPixels(definition), null, "and collected, held by nothing else");

  // Drawn again, the texture is the same: nothing is inflated or uploaded.
  assert.equal(paints.storeTexture(store), handle);
  assert.equal(textures.pending.length, 0);
  assert.equal(heldPixels(definition), null);

  // Read, as a draw or getPixel reads them: inflated again, the same pixels, and kept from then
  // on, wanted again after they went.
  assert.equal(keptPixels(definition), false);
  assert.deepEqual([...store.readable], expected);
  assert.equal(store.releasedPixels, false);
  assert.equal(keptPixels(definition), true);
  const fresh = BitmapStore.of({
    width: WIDTH,
    height: HEIGHT,
    transparent: true,
    pixels: Uint32Array.from(expected),
  });
  assert.equal(store.getPixel32(1, 0), fresh.getPixel32(1, 0));

  // A lost context: the texture made again of the same texels, the pixels held since the read.
  textures.lost();
  let again = paints.storeTexture(store);
  assert.deepEqual(upload(textures).get(again.id), texels);
  assert.equal(store.releasedPixels, true);

  // And again once the store let go of them: kept, the same.
  await collect(() => !heldPixels(definition));
  assert.deepEqual([...(heldPixels(definition) ?? [])], expected);
  textures.lost();
  again = paints.storeTexture(store);
  assert.deepEqual(upload(textures).get(again.id), texels);
  assert.equal(store.releasedPixels, true);
});

test("a BitmapData of a bitmap symbol reads its pixels after they were let go of, and writes a copy of its own", async () => {
  const character = bitmapIn(movie(1, 3));
  const definition = definitionOf(character);
  const textures = new Textures();
  const paints = new Paints(textures);

  // As Bitmap.bitmapData of the symbol is made (symbols.ts' bitmapDataOf).
  const data = symbolStore(character);
  const expected = [...data.readable];
  paints.storeTexture(data);
  upload(textures);
  assert.equal(data.releasedPixels, true);
  await collect(() => heldPixels(definition));
  assert.equal(heldPixels(definition), null);

  assert.equal(data.getPixel32(0, 0), 0xff102030);
  assert.deepEqual([...data.readable], expected);

  // Written, the pixels are its own: uploaded, never let go of.
  data.setPixel32(0, 0, 0xff00ff00);
  paints.storeTexture(data);
  upload(textures);
  assert.equal(data.releasedPixels, false);
  assert.equal(data.getPixel32(0, 0), 0xff00ff00);
  // The library's are as they were, for the next store made of them.
  assert.deepEqual([...symbolStore(character).readable], expected);

  // AVM1's loadBitmap reports it transparent whatever it is, and lets go alike.
  const loaded = symbolStore(character, character.pixels, true);
  assert.equal(loaded.transparent, true);
  paints.storeTexture(loaded);
  upload(textures);
  assert.equal(loaded.releasedPixels, true);
  assert.deepEqual([...loaded.readable], expected);
});

test("a store a script made is never let go of", () => {
  const textures = new Textures();
  const paints = new Paints(textures);
  const store = new BitmapStore(4, 4, true, 0x80402010);
  store.setPixel32(1, 1, 0xff102030);
  paints.storeTexture(store);
  upload(textures);
  assert.equal(store.releasedPixels, false);
  assert.equal(store.getPixel32(1, 1), 0xff102030);

  // Nor one of pixels nothing makes again, as a decoded image's are.
  const image = BitmapStore.of({
    width: 1,
    height: 1,
    transparent: false,
    pixels: Uint32Array.of(0xff112233),
  });
  paints.storeTexture(image);
  upload(textures);
  assert.equal(image.releasedPixels, false);
});

test("a bitmap Flash cannot read is told as it is inflated, 0 by 0, and its store keeps nothing", () => {
  const bytes = movie();
  // The zlib stream's checksum broken: read as lossless, inflated to nothing.
  const swf = readSwf(bytes);
  const tag = swf.tags[0];
  swf.bytes[tag.offset + tag.length - 1] ^= 0xff;
  const character = readLibrary(swf).characters.get(1);
  assert.ok(character?.type === "bitmap");
  assert.equal(character.definition.type, "lossless");
  assert.deepEqual([character.pixels?.width, character.pixels?.height], [0, 0]);
  const store = symbolStore(character);
  assert.deepEqual([store.width, store.height], [0, 0]);

  // Its fills draw from a store of nothing, as they did when it was read to nothing.
  const textures = new Textures();
  const paints = new Paints(textures);
  const fill = characterStore(character);
  assert.ok(fill);
  assert.deepEqual([fill.width, fill.height], [0, 0]);
  paints.storeTexture(fill);
  upload(textures);
  assert.equal(fill.releasedPixels, false);
});

test("a bitmap that inflated once and fails to again throws, rather than empty a store of its size", async () => {
  const character = bitmapIn(movie(1, 5));
  const definition = definitionOf(character);
  const textures = new Textures();
  const paints = new Paints(textures);
  const store = symbolStore(character);
  const expected = [...store.readable];
  paints.storeTexture(store);
  upload(textures);
  await collect(() => heldPixels(definition));
  assert.equal(heldPixels(definition), null);

  // Its stream broken after it inflated, as memory running out fails an inflation.
  const last = definition.data.length - 1;
  definition.data[last] ^= 0xff;
  assert.throws(() => store.readable, RangeError);
  assert.throws(() => symbolStore(character), RangeError);
  assert.deepEqual([store.width, store.height], [WIDTH, HEIGHT]);

  // Not taken for a bitmap Flash cannot read: once it inflates again, the same pixels.
  definition.data[last] ^= 0xff;
  assert.deepEqual([...store.readable], expected);
  assert.deepEqual([...symbolStore(character).readable], expected);
});

test("a symbol's store drawn into on the GPU after letting go of its pixels reads the drawing, its own", async () => {
  const character = bitmapIn(movie(1, 6));
  const definition = definitionOf(character);
  const drawn = Uint8Array.from({ length: WIDTH * HEIGHT * 4 }, (_, i) => [1, 2, 3, 255][i % 4]);
  let lost = false;
  const textures = new Textures();
  const paints = new Paints(textures, {
    read: () => (lost ? null : drawn.slice()),
    fill: () => false,
    copy: () => false,
  });
  const expected = [...symbolStore(character).readable];

  const store = symbolStore(character);
  paints.storeTexture(store);
  upload(textures);
  assert.equal(store.releasedPixels, true);
  paints.drawn(store);
  assert.deepEqual([...store.readable], new Array(WIDTH * HEIGHT).fill(0xff010203));
  // Its own now: changed and uploaded, never let go of.
  store.setPixel32(0, 0, 0xff00ff00);
  paints.storeTexture(store);
  upload(textures);
  assert.equal(store.releasedPixels, false);

  // A drawing lost with its context: the bitmap's pixels as they were, the library's still.
  const other = symbolStore(character);
  paints.storeTexture(other);
  upload(textures);
  paints.drawn(other);
  lost = true;
  await collect(() => heldPixels(definition));
  assert.deepEqual([...other.readable], expected);
  // Made again for a lost context, not for being wanted: not kept.
  assert.equal(keptPixels(definition), false);
  other.setPixel32(0, 0, 0xff00ff00);
  assert.equal(other.getPixel32(0, 0), 0xff00ff00);
  assert.deepEqual([...symbolStore(character).readable], expected);
});

test("a bitmap's texture let go of for going undrawn is made again of the same texels", async () => {
  const character = bitmapIn(movie(1, 7));
  const definition = definitionOf(character);
  const textures = new Textures();
  const paints = new Paints(textures);
  const store = characterStore(character);
  assert.ok(store);
  const handle = paints.storeTexture(store, 2);
  const texels = upload(textures).get(handle.id);
  for (let i = 0; i < 4; i++) {
    upload(textures);
  }

  assert.equal(textures.alive(handle), false);
  await collect(() => heldPixels(definition));
  assert.equal(heldPixels(definition), null);
  const again = paints.storeTexture(store);
  assert.deepEqual(upload(textures).get(again.id), texels);
  assert.equal(store.releasedPixels, true);

  // Made again for a texture alone: not kept.
  assert.equal(keptPixels(definition), false);

  // A symbol made again after a collection is wanted again: kept, and made over and over after,
  // it inflates no more.
  await collect(() => heldPixels(definition));
  symbolStore(character);
  assert.equal(keptPixels(definition), true);
  const kept = heldPixels(definition);
  for (let i = 0; i < 3; i++) {
    const spawned = symbolStore(character);
    paints.storeTexture(spawned);
    upload(textures);
    await collect(() => false);
    assert.equal(heldPixels(definition), kept);
  }
});

test("a texture made again for a lost context inflates its bitmap without keeping it", async () => {
  const character = bitmapIn(movie(1, 8));
  const definition = definitionOf(character);
  const textures = new Textures();
  const paints = new Paints(textures);
  const store = characterStore(character);
  assert.ok(store);
  const handle = paints.storeTexture(store);
  const texels = upload(textures).get(handle.id);
  assert.ok(texels);
  await collect(() => heldPixels(definition));
  assert.equal(heldPixels(definition), null);

  for (let i = 0; i < 2; i++) {
    textures.lost();
    const again = paints.storeTexture(store);
    assert.deepEqual(upload(textures).get(again.id), texels);
    assert.equal(store.releasedPixels, true);
    assert.equal(keptPixels(definition), false);
    await collect(() => heldPixels(definition));
    assert.equal(heldPixels(definition), null, "let go of again after each");
  }
});

test("SWFs that define a lossless bitmap alike share one store and one inflation", () => {
  const first = bitmapIn(movie(1, 4));
  const second = bitmapIn(movie(1, 4).slice());
  assert.equal(second.definition, first.definition);
  assert.equal(characterStore(second), characterStore(first));
});
