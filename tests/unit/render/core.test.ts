import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ALPHA,
  BLUR,
  CLEAR,
  COLOR_MATRIX,
  COMPOSITE,
  Commands,
  ERASE,
  FILTER,
  Filters,
  Geometries,
  HELD,
  HOLD_POP,
  HOLD_PUSH,
  IDLE_FRAMES,
  KEEP_IDLE_FRAMES,
  Keeps,
  LAYER_END,
  LAYER_POP,
  LAYER_PUSH,
  MASK_BEGIN,
  MASK_POP,
  MASK_USE,
  MULTIPLY,
  measureLayers,
  NORMAL,
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
    [LAYER_POP, MULTIPLY, 7, -1],
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

test("an erase or alpha layer composited onto the target itself clears it, one inside another not", () => {
  const commands = new Commands();
  const planned = (outer: number, inner: number, kept: number) => {
    const scene = new SceneList();
    scene.layerBegin();
    scene.layerBegin();
    scene.draw(0, 0, 0);
    scene.layerEnd(inner, -1);
    scene.layerEnd(outer, -1);
    scene.keptLayer(0, kept, -1, 0, 0, 10, 10);
    for (let layer = 0; layer < 2; layer++) {
      scene.layerRect(layer, 0, 0, 10, 10);
    }

    plan(scene, 0xffffffff, commands);
    return commands.clearsTarget;
  };

  assert.equal(planned(ERASE, NORMAL, NORMAL), true);
  assert.equal(planned(NORMAL, ALPHA, NORMAL), false);
  assert.equal(planned(NORMAL, ERASE, ALPHA), true);
  // Planning again starts afresh.
  assert.equal(planned(MULTIPLY, NORMAL, NORMAL), false);
});

test("a geometry changed in place is measured again and noted for the backend, a removed one not", () => {
  const geometries = new Geometries();
  const data = {
    positions: new Float32Array([0, 0, 10, 0, 10, 10]),
    colors: new Uint32Array(3),
    indices: new Uint32Array([0, 1, 2]),
  };
  const { id } = geometries.add(data);
  geometries.added.length = 0;
  data.positions.set([5, 5, 20, 5, 20, 30]);
  geometries.update(id);
  assert.deepEqual(Array.from(geometries.box.subarray(id * 4, id * 4 + 4)), [5, 5, 20, 30]);
  assert.deepEqual(geometries.updated, [id]);
  geometries.remove(id);
  geometries.update(id);
  assert.deepEqual(geometries.updated, [id]);
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
  measureLayers(scene, rows, geometries, { width: 200, height: 200, scale: 1, resolution: 1 });
  assert.deepEqual(Array.from(scene.layers.subarray(0, 8)), [19, 29, 23, 22, 89, 99, 12, 12]);
  // At twice the pixels a stage pixel, cut to the target.
  measureLayers(scene, rows, geometries, { width: 100, height: 100, scale: 2, resolution: 1 });
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
  measureLayers(scene, rows, geometries, { width: 200, height: 200, scale: 1, resolution: 1 });
  assert.deepEqual(Array.from(scene.layers.subarray(0, 8)), [39, 39, 12, 12, 0, 0, 101, 101]);
});

test("a filter list closes its filters into chains, each one's values after the last's", () => {
  const filters = new Filters();
  filters.add(BLUR, [4, 4, 1, 1]);
  filters.add(COLOR_MATRIX, new Float32Array(20).fill(0.5), 3);
  assert.equal(filters.close(), 0);
  filters.add(BLUR, [2, 2, 3, 1]);
  assert.equal(filters.close(), 1);
  assert.deepEqual(Array.from(filters.chains.subarray(0, 3)), [0, 2, 3]);
  assert.deepEqual(Array.from(filters.start.subarray(0, 4)), [0, 4, 24, 28]);
  assert.deepEqual(Array.from(filters.texture.subarray(0, 3)), [-1, 3, -1]);
  assert.deepEqual(Array.from(filters.values.subarray(24, 28)), [2, 2, 3, 1]);
  // Past its first arrays, and from the first again once reset.
  for (let i = 0; i < 100; i++) {
    filters.add(BLUR, new Float32Array(20).fill(i));
    filters.close();
  }

  assert.equal(filters.values[filters.start[102]], 99);
  filters.reset();
  filters.add(BLUR, [1, 1, 1, 1]);
  assert.equal(filters.close(), 0);
  assert.deepEqual(Array.from(filters.start.subarray(0, 2)), [0, 4]);
});

test("a filtered layer of draws alone is held: drawn before the stage, composited where it stands", () => {
  const scene = new SceneList();
  scene.draw(0, 0, 0);
  scene.layerBegin(3);
  scene.draw(0, 0, 0);
  scene.layerEnd(NORMAL, 2, 0);
  scene.layerRect(0, 1, 2, 3, 4);
  scene.draw(0, 0, 0);
  const commands = new Commands();
  plan(scene, 0xffffffff, commands);
  assert.deepEqual(ops(commands), [
    [HOLD_PUSH, 0, 0, 0],
    [RUN, 2, 1, 0],
    [HOLD_POP, 0, 0, 0],
    [CLEAR, 4, 0, 0],
    [RUN, 0, 1, 0],
    [HELD, 0, NORMAL, 2],
    [RUN, 4, 1, 0],
  ]);
  assert.deepEqual(Array.from(commands.params.subarray(0, 4)), [1, 2, 3, 4]);
});

test("a filtered layer in a layer of no size is left out with it, not held", () => {
  const scene = new SceneList();
  scene.layerBegin();
  scene.layerBegin(3);
  scene.draw(0, 0, 0);
  scene.layerEnd(NORMAL, -1, 0);
  scene.layerEnd(NORMAL, -1);
  scene.layerRect(0, 1, 2, 0, 0);
  scene.layerRect(1, 1, 2, 3, 4);
  const commands = new Commands();
  plan(scene, 0xffffffff, commands);
  assert.deepEqual(ops(commands), [[CLEAR, 0, 0, 0]]);
});

test("held layers in a held layer are drawn a level before it; a kept one is drawn in its place", () => {
  const scene = new SceneList();
  scene.layerBegin(3);
  scene.layerBegin(3);
  scene.draw(0, 0, 0);
  scene.layerEnd(NORMAL, -1, 1);
  scene.layerEnd(NORMAL, -1, 0);
  scene.layerBegin(3, 7);
  scene.draw(0, 0, 0);
  scene.layerEnd(NORMAL, -1, 2);
  for (let layer = 0; layer < 3; layer++) {
    scene.layerRect(layer, 1, 2, 3, 4);
  }

  const commands = new Commands();
  plan(scene, 0xffffffff, commands);
  assert.deepEqual(ops(commands), [
    [HOLD_PUSH, 0, 0, 0],
    [RUN, 2, 1, 0],
    [HOLD_POP, 1, 0, 0],
    [HOLD_PUSH, 4, 1, 1],
    [HELD, 0, NORMAL, -1],
    [HOLD_POP, 0, 1, 0],
    [CLEAR, 8, 0, 0],
    [HELD, 1, NORMAL, -1],
    [LAYER_PUSH, 12, 1, 0],
    [RUN, 6, 1, 0],
    [FILTER, 2, 0, 0],
    [LAYER_POP, NORMAL, -1, 7],
  ]);
});

test("a held layer erased into a held layer clears the layer's page, not the stage", () => {
  const scene = new SceneList();
  scene.layerBegin(3);
  scene.layerBegin(3);
  scene.draw(0, 0, 0);
  scene.layerEnd(ERASE, -1, 1);
  scene.layerEnd(NORMAL, -1, 0);
  scene.layerRect(0, 1, 2, 3, 4);
  scene.layerRect(1, 1, 2, 3, 4);
  const commands = new Commands();
  plan(scene, 0xffffffff, commands);
  assert.equal(commands.clearsTarget, false);
  assert.deepEqual(ops(commands)[4], [HELD, 0, ERASE, -1]);
});

test("a filtered layer with a layer in it that is not held is drawn in its place", () => {
  const scene = new SceneList();
  scene.layerBegin(3);
  scene.layerBegin();
  scene.draw(0, 0, 0);
  scene.layerEnd(MULTIPLY, -1);
  scene.layerEnd(NORMAL, -1, 0);
  scene.layerRect(0, 1, 2, 3, 4);
  scene.layerRect(1, 1, 2, 3, 4);
  const commands = new Commands();
  plan(scene, 0xffffffff, commands);
  assert.deepEqual(ops(commands), [
    [CLEAR, 0, 0, 0],
    [LAYER_PUSH, 4, 1, 0],
    [LAYER_PUSH, 8, 0, 0],
    [RUN, 2, 1, 0],
    [LAYER_POP, MULTIPLY, -1, -1],
    [FILTER, 0, 0, 0],
    [LAYER_POP, NORMAL, -1, -1],
  ]);
});

test("a filtered layer is measured as Pixi's filter system measured it, padded past the target", () => {
  const geometries = new Geometries();
  const rows = new Rows();
  const scene = new SceneList();
  const row = rows.add(1, 0, 0, 1, 0, 0, null);
  const inside = spanning(geometries, 10.5, 20.2, 30, 40.7);
  const off = spanning(geometries, 210, 0, 220, 10);
  scene.layerBegin(3);
  scene.draw(inside, row, 0);
  scene.layerEnd(NORMAL, -1, -1);
  // Off the target to its right: cut to its edge it turns inside out, which a padding of 3 does
  // not mend, and one of 10 does.
  scene.layerBegin(3);
  scene.draw(off, row, 0);
  scene.layerEnd(NORMAL, -1, -1);
  scene.layerBegin(10);
  scene.draw(off, row, 0);
  scene.layerEnd(NORMAL, -1, -1);
  // Nothing drawn, nothing filtered.
  scene.layerBegin(5);
  scene.layerEnd(NORMAL, -1, -1);
  measureLayers(scene, rows, geometries, { width: 200, height: 200, scale: 1, resolution: 1 });
  assert.deepEqual(
    Array.from(scene.layers.subarray(0, 16)),
    [7, 17, 26, 27, 0, 0, 0, 0, 200, -10, 10, 30, 0, 0, 0, 0],
  );
  // At twice the pixels a unit, the padding is twice as many of them.
  measureLayers(scene, rows, geometries, { width: 400, height: 400, scale: 2, resolution: 2 });
  assert.deepEqual(Array.from(scene.layers.subarray(0, 4)), [15, 34, 51, 54]);
});

test("a layer keeps its output as its kept output, which a later frame composites again", () => {
  const scene = new SceneList();
  scene.layerBegin(0, 5);
  scene.draw(0, 0, 0);
  scene.layerEnd(NORMAL, -1, -1);
  scene.layerRect(0, 1, 2, 3, 4);
  // Composited again in its mode and colour, unless its rectangle shows nothing.
  scene.keptLayer(5, MULTIPLY, 3, 10, 20, 30, 40);
  scene.keptLayer(6, NORMAL, -1, 10, 20, 0, 40);
  const commands = new Commands();
  plan(scene, 0xffffffff, commands);
  assert.deepEqual(ops(commands).slice(1), [
    [LAYER_PUSH, 4, 1, 0],
    [RUN, 1, 1, 0],
    [LAYER_POP, NORMAL, -1, 5],
    [COMPOSITE, 8, MULTIPLY, 3],
  ]);
  assert.deepEqual(Array.from(commands.params.subarray(8, 13)), [10, 20, 30, 40, 5]);
  // A kept output counts toward the layer it is in.
  const geometries = new Geometries();
  const rows = new Rows();
  const outer = new SceneList();
  outer.layerBegin();
  outer.keptLayer(0, NORMAL, -1, 10, 20, 30, 40);
  outer.layerEnd(MULTIPLY, -1);
  measureLayers(outer, rows, geometries, { width: 200, height: 200, scale: 1, resolution: 1 });
  assert.deepEqual(Array.from(outer.layers.subarray(0, 4)), [9, 19, 32, 42]);
});

test("a kept output goes once undrawn long enough, and a lost context takes them all", () => {
  const keeps = new Keeps();
  const used = keeps.add();
  const idle = keeps.add();
  for (let frame = 0; frame <= KEEP_IDLE_FRAMES + 1; frame++) {
    keeps.use(used.id);
    keeps.endFrame();
  }

  assert.ok(keeps.alive(used));
  assert.ok(!keeps.alive(idle));
  assert.deepEqual(keeps.removed, [idle.id]);
  const again = keeps.add();
  assert.equal(again.id, idle.id);
  assert.ok(!keeps.alive(idle));
  keeps.lost();
  assert.ok(!keeps.alive(used) && !keeps.alive(again));
});

test("each layer knows the layer it is in, a kept output too", () => {
  const scene = new SceneList();
  scene.layerBegin();
  scene.layerBegin(0, 1);
  scene.layerEnd(NORMAL, -1);
  scene.keptLayer(2, NORMAL, -1, 0, 0, 1, 1);
  scene.layerEnd(MULTIPLY, -1);
  scene.layerBegin();
  scene.layerEnd(MULTIPLY, -1);
  assert.deepEqual(Array.from(scene.parents.subarray(0, 4)), [-1, 0, 0, -1]);
  scene.reset();
  scene.layerBegin();
  assert.equal(scene.parents[0], -1);
});
