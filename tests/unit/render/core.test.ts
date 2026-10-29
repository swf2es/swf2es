import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CLEAR,
  Commands,
  Geometries,
  IDLE_FRAMES,
  LAYER_END,
  LAYER_POP,
  LAYER_PUSH,
  MASK_BEGIN,
  MASK_POP,
  MASK_USE,
  MULTIPLY,
  measureLayers,
  plan,
  ROW_FLOATS,
  Rows,
  RUN,
  SceneList,
  STENCIL_POP,
  STENCIL_PUSH,
  Textures,
} from "../../../packages/render/dist/index.js";

/** The commands as [op, a, b, c] tuples. */
const ops = (commands: Commands) =>
  Array.from({ length: commands.length }, (_, k) =>
    Array.from(commands.ops.subarray(k * 4, k * 4 + 4)),
  );

test("a frame clears to the background, premultiplied, then runs each blend mode's stretch", () => {
  const scene = new SceneList();
  scene.draw(0, 0, 0);
  scene.draw(1, 0, 0);
  scene.draw(2, 1, 3);
  scene.draw(3, 2, 0);
  const commands = new Commands();
  plan(scene, 0x80ff0000, commands);
  assert.deepEqual(ops(commands), [
    [CLEAR, 0, 0, 0],
    [RUN, 0, 2, 0],
    [RUN, 2, 1, 3],
    [RUN, 3, 1, 0],
  ]);
  const half = 0x80 / 255;
  assert.deepEqual(Array.from(commands.params.subarray(0, 4)), [half, 0, 0, half].map(Math.fround));
});

test("an empty list only clears, and planning again starts afresh", () => {
  const scene = new SceneList();
  const commands = new Commands();
  scene.draw(0, 0, 0);
  plan(scene, 0xffffffff, commands);
  scene.reset();
  plan(scene, 0xffffffff, commands);
  assert.deepEqual(ops(commands), [[CLEAR, 0, 0, 0]]);
});

test("the scene list grows past its first arrays", () => {
  const scene = new SceneList();
  for (let i = 0; i < 5000; i++) {
    scene.draw(i, i, 0);
  }

  assert.equal(scene.length, 5000);
  assert.equal(scene.geometry[4999], 4999);
});

test("a row holds the transform, and the colour transform's offsets over 255", () => {
  const rows = new Rows();
  const plain = rows.add(1, 0, 0, 1, 5, 6, null);
  const tinted = rows.add(2, 0, 0, 2, 0, 0, {
    rMul: 0.5,
    gMul: 1,
    bMul: 1,
    aMul: 0.25,
    rAdd: 255,
    gAdd: 0,
    bAdd: -255,
    aAdd: 0,
  });
  assert.deepEqual([plain, tinted], [0, 1]);
  const at = (row: number) =>
    Array.from(rows.data.subarray(row * ROW_FLOATS, (row + 1) * ROW_FLOATS));
  assert.deepEqual(at(0), [1, 0, 0, 1, 5, 6, 0, 0, 1, 1, 1, 1, 0, 0, 0, 0]);
  assert.deepEqual(at(1), [2, 0, 0, 2, 0, 0, 0, 0, 0.5, 1, 1, 0.25, 1, 0, -1, 0]);
});

test("rows grow past a texture line and start again from the first", () => {
  const rows = new Rows();
  for (let i = 0; i < 1000; i++) {
    rows.add(1, 0, 0, 1, i, 0, null);
  }

  assert.equal(rows.data[999 * ROW_FLOATS + 4], 999);
  rows.reset();
  assert.equal(rows.add(1, 0, 0, 1, 0, 0, null), 0);
});

const triangle = () => ({
  positions: Float32Array.of(0, 0, 1, 0, 0, 1),
  colors: Uint32Array.of(0xff0000ff, 0xff0000ff, 0xff0000ff),
  indices: Uint32Array.of(0, 1, 2),
});

test("a geometry undrawn too long is let go of, and its handle says so", () => {
  const geometries = new Geometries();
  const kept = geometries.add(triangle());
  const idle = geometries.add(triangle());
  assert.deepEqual(geometries.added, [kept.id, idle.id]);
  for (let i = 0; i <= IDLE_FRAMES + 1; i++) {
    geometries.use(kept.id);
    geometries.endFrame();
  }

  assert.ok(geometries.alive(kept));
  assert.ok(!geometries.alive(idle));
  assert.deepEqual(geometries.removed, [idle.id]);
  assert.deepEqual(geometries.live(), [kept.id]);
});

test("a reused id is a new generation, which an old handle does not name", () => {
  const geometries = new Geometries();
  const first = geometries.add(triangle());
  geometries.remove(first.id);
  const second = geometries.add(triangle());
  assert.equal(second.id, first.id);
  assert.ok(!geometries.alive(first));
  assert.ok(geometries.alive(second));
});

test("a texture's pixels wait for the backend once set, and a lost context lets every texture go", () => {
  const textures = new Textures();
  const a = textures.add(1, 1, Uint8Array.of(255, 0, 0, 255));
  const b = textures.add(2, 1, new Uint8Array(8));
  assert.deepEqual(textures.pending, [a.id, b.id]);
  textures.pending.length = 0;
  textures.set(a.id, 2, 2, new Uint8Array(16));
  assert.deepEqual(textures.pending, [a.id]);
  assert.equal(textures.get(a.id)?.width, 2);
  textures.lost();
  assert.ok(!textures.alive(a) && !textures.alive(b));
  assert.deepEqual(textures.removed, [a.id, b.id]);
});

test("an entry names its texture and sampler, none by default", () => {
  const scene = new SceneList();
  scene.draw(0, 0, 0);
  scene.draw(1, 0, 0, 7, 3);
  assert.deepEqual([scene.texture[0], scene.sampler[0]], [-1, 0]);
  assert.deepEqual([scene.texture[1], scene.sampler[1]], [7, 3]);
});

test("a mask's own draws go to the stencil, and what it masks runs between its push and pop", () => {
  const scene = new SceneList();
  scene.draw(0, 0, 0);
  scene.marker(MASK_BEGIN);
  scene.draw(1, 1, 0);
  scene.draw(2, 1, 0);
  scene.marker(MASK_USE, 2, 2);
  scene.draw(3, 2, 0);
  scene.draw(4, 2, 0);
  scene.marker(MASK_POP, 2, 2);
  scene.draw(5, 3, 0);
  const commands = new Commands();
  plan(scene, 0xffffffff, commands);
  assert.deepEqual(ops(commands).slice(1), [
    [RUN, 0, 1, 0],
    [STENCIL_PUSH, 2, 2, 0],
    [RUN, 5, 2, 0],
    [STENCIL_POP, 2, 2, 0],
    [RUN, 8, 1, 0],
  ]);
});

test("masks nest, each popped where its marker says", () => {
  const scene = new SceneList();
  scene.marker(MASK_BEGIN);
  scene.draw(0, 0, 0);
  scene.marker(MASK_USE, 1, 1);
  scene.marker(MASK_BEGIN);
  scene.draw(1, 1, 0);
  scene.marker(MASK_USE, 4, 1);
  scene.draw(2, 2, 0);
  scene.marker(MASK_POP, 4, 1);
  scene.marker(MASK_POP, 1, 1);
  const commands = new Commands();
  plan(scene, 0xffffffff, commands);
  assert.deepEqual(ops(commands).slice(1), [
    [STENCIL_PUSH, 1, 1, 0],
    [STENCIL_PUSH, 4, 1, 0],
    [RUN, 6, 1, 0],
    [STENCIL_POP, 4, 1, 0],
    [STENCIL_POP, 1, 1, 0],
  ]);
});

test("a layer's draws run inside its push, and it composites in its mode and colour at its pop", () => {
  const scene = new SceneList();
  scene.draw(0, 0, 0);
  scene.layerBegin();
  scene.draw(1, 1, 0);
  scene.draw(2, 1, 0);
  scene.layerRect(0, 10, 20, 30, 40);
  scene.marker(LAYER_END, MULTIPLY, 7);
  scene.draw(3, 2, 0);
  const commands = new Commands();
  plan(scene, 0xffffffff, commands);
  assert.deepEqual(ops(commands).slice(1), [
    [RUN, 0, 1, 0],
    [LAYER_PUSH, 4, 0, 0],
    [RUN, 2, 2, 0],
    [LAYER_POP, MULTIPLY, 7, 0],
    [RUN, 5, 1, 0],
  ]);
  // The rectangle after the background's four, as the push names them.
  assert.deepEqual(Array.from(commands.params.subarray(4, 8)), [10, 20, 30, 40]);
});

test("a layer of no size is left out, all in it, layers inside it too", () => {
  const scene = new SceneList();
  scene.layerBegin();
  scene.draw(0, 0, 0);
  scene.layerBegin();
  scene.draw(1, 0, 0);
  scene.marker(LAYER_END, MULTIPLY, -1);
  scene.marker(LAYER_END, MULTIPLY, -1);
  scene.draw(2, 0, 0);
  scene.layerRect(1, 0, 0, 10, 10);
  const commands = new Commands();
  plan(scene, 0xffffffff, commands);
  assert.deepEqual(ops(commands).slice(1), [[RUN, 6, 1, 0]]);
});

/** A geometry of one triangle with the corners (x0, y0) and (x1, y1). */
const spanning = (
  geometries: InstanceType<typeof Geometries>,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
) =>
  geometries.add({
    positions: new Float32Array([x0, y0, x1, y0, x1, y1]),
    colors: new Uint32Array(3),
    indices: new Uint32Array([0, 1, 2]),
  }).id;

test("a layer covers its draws as their rows place them, out to whole pixels and one more", () => {
  const geometries = new Geometries();
  const rows = new Rows();
  const scene = new SceneList();
  const small = spanning(geometries, 0, 0, 10, 10);
  // Scaled twice and moved; then turned a quarter, which takes the box's other corners.
  const moved = rows.add(2, 0, 0, 2, 20.5, 30, null);
  const turned = rows.add(0, 1, -1, 0, 100, 100, null);
  scene.layerBegin();
  scene.draw(small, moved, 0);
  scene.marker(LAYER_END, MULTIPLY, -1);
  scene.layerBegin();
  scene.draw(small, turned, 0);
  scene.marker(LAYER_END, MULTIPLY, -1);
  measureLayers(scene, rows, geometries, { width: 200, height: 200, scale: 1 });
  assert.deepEqual(Array.from(scene.layers.subarray(0, 8)), [19, 29, 23, 22, 89, 99, 12, 12]);
  // At twice the pixels a stage pixel, cut to the target.
  measureLayers(scene, rows, geometries, { width: 100, height: 100, scale: 2 });
  assert.deepEqual(Array.from(scene.layers.subarray(0, 4)), [40, 59, 42, 41]);
});

test("a mask cuts what it clips in a layer to its own draws, which the layer does not cover", () => {
  const geometries = new Geometries();
  const rows = new Rows();
  const scene = new SceneList();
  const big = spanning(geometries, 0, 0, 100, 100);
  const small = spanning(geometries, 40, 40, 50, 50);
  const row = rows.add(1, 0, 0, 1, 0, 0, null);
  scene.layerBegin();
  scene.marker(MASK_BEGIN);
  scene.draw(small, row, 0);
  scene.marker(MASK_USE, 2, 1);
  // A layer inside a layer: the outer one covers the inner one's rectangle.
  scene.layerBegin();
  scene.draw(big, row, 0);
  scene.marker(LAYER_END, MULTIPLY, -1);
  scene.marker(MASK_POP, 2, 1);
  scene.marker(LAYER_END, MULTIPLY, -1);
  measureLayers(scene, rows, geometries, { width: 200, height: 200, scale: 1 });
  assert.deepEqual(Array.from(scene.layers.subarray(0, 8)), [39, 39, 12, 12, 0, 0, 101, 101]);
});
