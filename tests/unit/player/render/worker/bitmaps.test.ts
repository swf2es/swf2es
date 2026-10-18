import assert from "node:assert/strict";
import { test } from "node:test";
import { BitmapStore } from "../../../../../packages/player/dist/bitmap/bitmap.js";
import { BitmapObject, Container } from "../../../../../packages/player/dist/display/display.js";
import { SceneLibraries } from "../../../../../packages/player/dist/render/worker/libraries.js";
import {
  SceneMirror,
  SceneSnapshot,
  sceneFrameBytes,
} from "../../../../../packages/player/dist/render/worker/scene.js";

test("complete bitmap frames own odd-sized pixels, share stores and release retired GPU copies", () => {
  const root = new Container();
  const store = new BitmapStore(3, 3, true, 0xffffffff);
  store.setPixel32(1, 1, 0x804080c0);
  const a = new BitmapObject(store);
  const b = new BitmapObject(store);
  root.addChildAt(a, 0);
  root.addChildAt(b, 1);
  const snapshot = new SceneSnapshot(new SceneLibraries());
  const mirror = new SceneMirror(new SceneLibraries());
  const bytes = new Uint8Array(sceneFrameBytes(16, 1024));
  const apply = () => mirror.apply(bytes.subarray(0, snapshot.encode(root, bytes)));
  assert.throws(() => snapshot.encode(root, new Uint8Array(sceneFrameBytes(3, 10))), /capacity/);
  const result = apply();
  const mirrored = result.children[0] as BitmapObject;
  const shared = result.children[1] as BitmapObject;
  const copy = mirrored.store;
  assert.ok(copy);
  assert.equal(shared.store, copy);
  let destroyed = 0;
  copy.copies.add({
    version: 0,
    read: () => copy.readable,
    copy: () => false,
    fill: () => false,
    destroy: () => {
      destroyed++;
    },
  });
  assert.deepEqual(copy.readable, store.readable);
  assert.notEqual(copy.readable.buffer, bytes.buffer);
  store.fillRect({ x: 0, y: 0, width: 3, height: 3 }, 0xff112233);
  snapshot.encode(root, bytes);
  assert.equal(copy.getPixel32(0, 0), 0xffffffff);
  apply();
  assert.equal(mirrored.store, copy);
  assert.equal(copy.getPixel32(0, 0), 0xff112233);
  b.store = new BitmapStore(1, 1, false, 0xff336699);
  apply();
  const replacement = shared.store;
  assert.ok(replacement);
  assert.notEqual(replacement, copy);
  store.dispose();
  apply();
  assert.equal(mirrored.store, null);
  assert.equal(copy.disposed, true);
  assert.equal(destroyed, 1);
  assert.equal(copy.copies.size, 0);
  root.removeChild(b);
  apply();
  assert.equal(replacement.disposed, true);
  b.store = new BitmapStore(2, 1, true, 0xff123456);
  root.addChildAt(b, 0);
  apply();
  const last = shared.store;
  assert.ok(last);
  mirror.dispose();
  assert.equal(last.disposed, true);
});
