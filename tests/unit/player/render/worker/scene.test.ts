import assert from "node:assert/strict";
import { test } from "node:test";
import { type Container, Player } from "../../../../../packages/player/dist/index.js";
import {
  VectorMirror,
  VectorSnapshot,
  vectorFrameBytes,
} from "../../../../../packages/player/dist/render/worker/scene.js";
import { workerScene } from "../../../../player/worker-scene.ts";

test("complete vector snapshots preserve mirror identity, reparenting, order and removals", () => {
  const p = new Player(workerScene());
  const mirror = new VectorMirror(new Player(workerScene()).library);
  const encoder = new VectorSnapshot(p.library);
  const bytes = new Uint8Array(vectorFrameBytes(32));
  const apply = () => mirror.apply(bytes.subarray(0, encoder.encode(p.root, bytes)));
  const root = apply();
  const a = root.children[0] as Container;
  const b = root.children[1] as Container;
  const sourceA = p.root.children[0] as Container;
  const sourceB = p.root.children[1] as Container;
  const moved = a.children[0];

  sourceB.addChildAt(sourceA.children[0], 1);
  sourceB.children[1].visible = false;
  p.root.addChildAt(sourceB, 0);
  assert.equal(apply(), root);
  assert.equal(root.children[0], b);
  assert.equal(b.children[1], moved);
  assert.equal(moved.visible, false);
  assert.equal(a.children.length, 1);

  p.root.removeChild(sourceA);
  apply();
  assert.equal(root.children.length, 1);
  assert.equal(a.parent, null);
});

test("unsupported content and oversized snapshots fail without changing the source's dirty flags", () => {
  const p = new Player(workerScene());
  const encoder = new VectorSnapshot(p.library);
  const bytes = new Uint8Array(vectorFrameBytes(32));
  const dirty = p.root.dirty;
  assert.throws(() => encoder.encode(p.root, new Uint8Array(vectorFrameBytes(1))), /capacity/);
  p.root.blendMode = "multiply";
  assert.throws(() => encoder.encode(p.root, bytes), /plain vector/);
  p.root.blendMode = "normal";
  assert.ok(encoder.encode(p.root, bytes) > 0);
  assert.equal(p.root.dirty, dirty);
});

test("a rejected vector snapshot leaves the existing mirror intact", () => {
  const p = new Player(workerScene());
  const mirror = new VectorMirror(p.library);
  const encoder = new VectorSnapshot(p.library);
  const bytes = new Uint8Array(vectorFrameBytes(32));
  const frame = bytes.subarray(0, encoder.encode(p.root, bytes));
  const root = mirror.apply(frame);
  const child = root.children[0];
  const data = new Float64Array(frame.buffer, 0, frame.length / 8);
  data[2 + 18 + 1] = 99;
  assert.throws(() => mirror.apply(frame), /snapshot node/);
  assert.equal(root.children[0], child);
  assert.throws(() => mirror.apply(frame.subarray(0, frame.length - 1)), /length/);
  encoder.encode(p.root, bytes);
  // Zero is the container sentinel, even in a malformed SWF that defines shape 0.
  const shape = p.library.characters.get(1);
  assert.ok(shape);
  p.library.characters.set(0, shape);
  data[2 + 3 * 18 + 2] = 0;
  assert.throws(() => mirror.apply(frame), /snapshot node/);
});
