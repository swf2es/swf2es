import assert from "node:assert/strict";
import { test } from "node:test";
import { readSwf } from "../../../../../packages/format/dist/index.js";
import { readLibrary } from "../../../../../packages/player/dist/display/timeline.js";
import {
  readSharedLibrary,
  SceneLibraries,
  shareLibrary,
} from "../../../../../packages/player/dist/render/worker/libraries.js";
import { workerScene } from "../../../../player/worker-scene.ts";
import { library } from "./fixtures.ts";

test("library assets preserve host-decoded pixels, namespace IDs and shared shape retirement", () => {
  const extra = library();
  const bitmap = extra.target.characters.get(9);
  assert.ok(bitmap?.type === "bitmap" && bitmap.pixels);
  assert.deepEqual(
    [...bitmap.pixels.pixels],
    [0xff112233, 0x80402010, 0, 0xffffffff, 0xffaabbcc, 0xff445566],
  );
  const original = extra.source.characters.get(9);
  assert.ok(original?.type === "bitmap" && original.pixels);
  original.pixels.pixels[0] = 0;
  assert.equal(bitmap.pixels.pixels[0], 0xff112233);
  assert.throws(() => readSharedLibrary({ ...extra.asset, bitmaps: [] }), /missing/);
  assert.throws(
    () =>
      readSharedLibrary({ ...extra.asset, bitmaps: [{ ...extra.asset.bitmaps[0], width: 99 }] }),
    /invalid/,
  );
  assert.throws(
    () =>
      readSharedLibrary({
        ...extra.asset,
        bitmaps: [...extra.asset.bitmaps, extra.asset.bitmaps[0]],
      }),
    /invalid/,
  );
  const undecoded = readLibrary(readSwf(extra.bytes));
  assert.throws(() => shareLibrary(extra.bytes, undecoded), /decoded/);

  const one = readLibrary(readSwf(workerScene()));
  const same = readLibrary(readSwf(workerScene()));
  assert.equal(one.characters.get(1), same.characters.get(1));
  const source = new SceneLibraries();
  source.add(1, one);
  source.add(2, extra.source);
  source.add(3, same);
  assert.equal(source.ref(one.characters.get(1) as object).library, 1);
  source.drop(1);
  assert.equal(source.ref(one.characters.get(1) as object).library, 3);
  assert.equal(source.ref(extra.source.characters.get(1) as object).library, 2);
  assert.throws(() => source.add(1, one), /never reused/);
  source.drop(3);
  assert.throws(() => source.ref(one.characters.get(1) as object), /registered/);
});
