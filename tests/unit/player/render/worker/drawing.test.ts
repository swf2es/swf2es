import assert from "node:assert/strict";
import { test } from "node:test";
import { BitmapStore } from "../../../../../packages/player/dist/bitmap/bitmap.js";
import {
  BitmapObject,
  Container,
  PIXELS,
  ShapeObject,
} from "../../../../../packages/player/dist/display/display.js";
import { Drawing } from "../../../../../packages/player/dist/display/drawing.js";
import {
  SceneMirror,
  SceneSnapshot,
  sceneFrameBytes,
} from "../../../../../packages/player/dist/render/worker/scene.js";
import { library } from "./fixtures.ts";

test("Graphics layers own paths and pixels, retain unchanged geometry and retire shared stores", () => {
  const { source } = library();
  const mirror = new SceneMirror(source);
  const encoder = new SceneSnapshot(source);
  const root = new Container();
  const object = new ShapeObject(null);
  const drawing = new Drawing();
  const pixels = new BitmapStore(3, 3, true, 0xffffffff);
  object.drawing = drawing;
  root.addChildAt(object, 0);
  drawing.beginFill({ type: "solid", color: 0xffaa3355 });
  drawing.moveTo(3, 4);
  drawing.cubicCurveTo(10, 20, 30, 20, 40, 4);
  drawing.lineTo(3, 4);
  drawing.endFill();
  drawing.beginFill({
    type: "image",
    image: pixels,
    matrix: { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 },
    repeat: true,
    smooth: true,
  });
  drawing.drawTriangles(
    [0, 0, 30, 0, 0, 30, 30, 30],
    [0, 1, 2, 1, 2, 3],
    [0, 0, 1, 0, 0, 1, 1, 1],
    1,
  );
  const bytes = new Uint8Array(sceneFrameBytes(4, 4096));
  const apply = () => mirror.apply(bytes.subarray(0, encoder.encode(root, bytes)));
  const mirrored = apply().children[0];
  assert.ok(mirrored.drawing);
  const layers = mirrored.drawing.layers;
  assert.deepEqual(layers[0], drawing.layers[0]);
  assert.notEqual(layers[0].fills[0].contours, drawing.layers[0].fills[0].contours);
  const mesh = layers.flatMap((l) => [...(l.meshes ?? []), ...(l.mirrored?.meshes ?? [])])[0];
  assert.ok(mesh);
  assert.deepEqual(mesh.image.readable, pixels.readable);
  assert.notEqual(mesh.image, pixels);
  const retained = mirrored.drawing;
  apply();
  assert.equal(mirrored.drawing, retained);
  // These colours both occupy Float64 NaN payloads when packed with white.
  pixels.setPixel32(0, 0, 0xffeeccaa);
  apply();
  assert.equal(mesh.image.getPixel32(0, 0), 0xffeeccaa);
  assert.notEqual(mirrored.drawing, retained);
  drawing.clear();
  apply();
  assert.equal(mesh.image.disposed, true);
  assert.deepEqual(mirrored.drawing?.layers, []);
  object.drawing = null;
  apply();
  assert.equal(mirrored.drawing, null);
  mirror.dispose();
});

test("invalid Graphics paths are rejected before changing existing mirror geometry", () => {
  const { source } = library();
  const mirror = new SceneMirror(source);
  const encoder = new SceneSnapshot(source);
  const root = new Container();
  root.drawing = new Drawing();
  root.drawing.beginFill({ type: "solid", color: 0xffaa3355 });
  root.drawing.drawRect(0, 0, 20, 20);
  const bytes = new Uint8Array(sceneFrameBytes(1, 512));
  const frame = bytes.subarray(0, encoder.encode(root, bytes));
  const kept = mirror.apply(frame).drawing;
  const data = new Float64Array(bytes.buffer);
  const at = data[2 + 25];
  // culled, layer count, fill count, solid kind, colour, winding,
  // contour count, first path length, first command.
  data[at + 8] = 99;
  assert.throws(() => mirror.apply(frame), /path command/);
  assert.equal(kept, mirror.apply(bytes.subarray(0, encoder.encode(root, bytes))).drawing);
});

test("retained Graphics receives changes to a store defined by an earlier Bitmap", () => {
  const { source } = library();
  const mirror = new SceneMirror(source);
  const encoder = new SceneSnapshot(source);
  const root = new Container();
  const pixels = new BitmapStore(3, 3, true, 0xff55aacc);
  const bitmap = new BitmapObject(pixels);
  const graphic = new ShapeObject(null);
  graphic.drawing = new Drawing();
  graphic.drawing.beginFill({
    type: "image",
    image: pixels,
    matrix: { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 },
    repeat: false,
    smooth: true,
  });
  graphic.drawing.drawRect(0, 0, 20, 20);
  root.addChildAt(bitmap, 0);
  root.addChildAt(graphic, 1);
  const bytes = new Uint8Array(sceneFrameBytes(4, 512));
  const apply = () => mirror.apply(bytes.subarray(0, encoder.encode(root, bytes)));
  const result = apply();
  const node = result.children[1];
  const geometry = node.drawing;
  const store = (result.children[0] as BitmapObject).store;
  assert.ok(store);
  assert.ok(store.views.has(node.ref));
  node.dirty = 0;
  pixels.setPixel32(0, 0, 0xffcc3355);
  apply();
  assert.equal(node.drawing, geometry);
  assert.ok(node.dirty & PIXELS);
  assert.equal(store.getPixel32(0, 0), 0xffcc3355);
  pixels.dispose();
  apply();
  assert.equal(store.disposed, true);
  assert.notEqual(node.drawing, geometry);
  mirror.dispose();
});
