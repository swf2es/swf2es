import assert from "node:assert/strict";
import { test } from "node:test";
import { readSwf } from "../../../../../packages/format/dist/index.js";
import { BitmapStore } from "../../../../../packages/player/dist/bitmap/bitmap.js";
import {
  BitmapObject,
  Container,
  ShapeObject,
  StaticTextObject,
  TextObject,
} from "../../../../../packages/player/dist/display/display.js";
import { filterDefaults } from "../../../../../packages/player/dist/display/filters.js";
import { readLibrary } from "../../../../../packages/player/dist/display/timeline.js";
import { Player } from "../../../../../packages/player/dist/index.js";
import { SceneLibraries } from "../../../../../packages/player/dist/render/worker/libraries.js";
import {
  SceneMirror,
  SceneSnapshot,
  sceneFrameBytes,
} from "../../../../../packages/player/dist/render/worker/scene.js";
import { workerScene } from "../../../../player/worker-scene.ts";
import { library } from "./fixtures.ts";

test("complete vector snapshots preserve mirror identity, reparenting, order and removals", () => {
  const p = new Player(workerScene());
  const mirror = new SceneMirror(new Player(workerScene()).library);
  const encoder = new SceneSnapshot(p.library);
  const bytes = new Uint8Array(sceneFrameBytes(32));
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
  const encoder = new SceneSnapshot(p.library);
  const bytes = new Uint8Array(sceneFrameBytes(32));
  const dirty = p.root.dirty;
  assert.throws(() => encoder.encode(p.root, new Uint8Array(sceneFrameBytes(1))), /capacity/);
  p.root.cachedAsBitmap = true;
  assert.throws(() => encoder.encode(p.root, bytes), /2D shapes/);
  p.root.cachedAsBitmap = false;
  assert.ok(encoder.encode(p.root, bytes) > 0);
  assert.equal(p.root.dirty, dirty);
});

test("a rejected vector snapshot leaves the existing mirror intact", () => {
  const p = new Player(workerScene());
  const mirror = new SceneMirror(p.library);
  const encoder = new SceneSnapshot(p.library);
  const bytes = new Uint8Array(sceneFrameBytes(32));
  const frame = bytes.subarray(0, encoder.encode(p.root, bytes));
  const root = mirror.apply(frame);
  const child = root.children[0];
  const data = new Float64Array(frame.buffer, 0, frame.length / 8);
  data[2 + 25 + 1] = 99;
  assert.throws(() => mirror.apply(frame), /snapshot node/);
  assert.equal(root.children[0], child);
  assert.throws(() => mirror.apply(frame.subarray(0, frame.length - 1)), /length/);
  encoder.encode(p.root, bytes);
  // Zero is the container sentinel, even in a malformed SWF that defines shape 0.
  const shape = p.library.characters.get(1);
  assert.ok(shape);
  p.library.characters.set(0, shape);
  data[2 + 3 * 25 + 2] = 0;
  assert.throws(() => mirror.apply(frame), /snapshot node/);
});

test("snapshots preserve every numeric filter kind and replace changed filter lists", () => {
  const p = new Player(workerScene());
  const mirror = new SceneMirror(p.library);
  const encoder = new SceneSnapshot(p.library);
  const bytes = new Uint8Array(sceneFrameBytes(32, 256));
  const kinds = [
    "blur",
    "glow",
    "dropShadow",
    "bevel",
    "gradientGlow",
    "gradientBevel",
    "colorMatrix",
    "convolution",
  ] as const;
  p.root.filters = kinds.map(filterDefaults);
  const gradient = p.root.filters[4];
  gradient.type = "outer";
  gradient.colors = [0xff0000, 0x00ff00];
  gradient.alphas = [0.3, 0.9];
  gradient.ratios = [0, 255];
  const apply = () => mirror.apply(bytes.subarray(0, encoder.encode(p.root, bytes)));
  const root = apply();
  assert.deepEqual(root.filters, p.root.filters);
  assert.notEqual(root.filters[4].colors, gradient.colors);
  const previous = root.filters;
  apply();
  assert.equal(root.filters, previous);
  gradient.colors[0] = 0x123456;
  apply();
  assert.equal(root.filters[4].colors[0], 0x123456);
  assert.equal(previous[4].colors[0], 0xff0000);
  p.root.filters = [];
  apply();
  assert.deepEqual(root.filters, []);
  p.root.filters = [filterDefaults("displacementMap")];
  assert.throws(apply, /displacement map/);
  p.root.filters = [filterDefaults("glow")];
  assert.throws(() => encoder.encode(p.root, new Uint8Array(sceneFrameBytes(7))), /capacity/);
});

test("snapshots preserve mask ownership, timeline depths and blend changes", () => {
  const p = new Player(workerScene());
  const mirror = new SceneMirror(p.library);
  const encoder = new SceneSnapshot(p.library);
  const bytes = new Uint8Array(sceneFrameBytes(32));
  const sourceA = p.root.children[0] as Container;
  const sourceB = p.root.children[1] as Container;
  const mask = sourceA.children[0];
  sourceB.setMask(mask);
  sourceA.children[1].clipDepth = 5;
  sourceA.children[1].blendMode = "multiply";
  const apply = () => mirror.apply(bytes.subarray(0, encoder.encode(p.root, bytes)));
  const root = apply();
  const a = root.children[0] as Container;
  const b = root.children[1] as Container;
  const mirroredMask = a.children[0];
  assert.equal(b.mask, mirroredMask);
  assert.equal(mirroredMask.maskOf, b);
  assert.equal(a.children[1].clipDepth, 5);
  assert.equal(a.children[1].depth, 2);
  assert.equal(a.children[1].blendMode, "multiply");
  p.root.addChildAt(sourceB, 0);
  sourceA.setMask(mask);
  sourceA.children[1].clipDepth = 0;
  sourceA.children[1].blendMode = "screen";
  apply();
  assert.equal(a.mask, mirroredMask);
  assert.equal(b.mask, null);
  assert.equal(mirroredMask.maskOf, a);
  assert.equal(a.children[1].clipDepth, 0);
  assert.equal(a.children[1].blendMode, "screen");
  sourceA.setMask(null);
  apply();
  assert.equal(mirroredMask.maskOf, null);
  assert.equal(a.mask, null);
  p.root.removeChild(sourceA);
  sourceB.setMask(mask);
  assert.throws(apply, /masks inside/);
});

test("bad filter tails and conflicting masks leave the mirror untouched", () => {
  const p = new Player(workerScene());
  const mirror = new SceneMirror(p.library);
  const encoder = new SceneSnapshot(p.library);
  const bytes = new Uint8Array(sceneFrameBytes(32, 256));
  p.root.filters = [filterDefaults("glow")];
  const frame = bytes.subarray(0, encoder.encode(p.root, bytes));
  const root = mirror.apply(frame);
  const original = root.filters;
  const values = new Float64Array(frame.buffer, 0, frame.length / 8);
  const tail = values[2 + 22];
  for (const [index, value] of [
    [tail, 1e9],
    [tail + 1, 99],
    [tail + 7, 3],
    [2 + 22, tail + 1],
    [2 + 21, 999],
  ]) {
    const saved = values[index];
    values[index] = value;
    assert.throws(() => mirror.apply(frame), /snapshot/);
    assert.equal(root.filters, original);
    values[index] = saved;
  }
  values[2 + 21] = 2;
  values[2 + 25 + 21] = 2;
  assert.throws(() => mirror.apply(frame), /snapshot effects/);
  assert.equal(root.children[0].mask, null);
  assert.equal(root.mask, null);
  p.root.filters = [filterDefaults("colorMatrix")];
  const matrixFrame = bytes.subarray(0, encoder.encode(p.root, bytes));
  values[values[2 + 22] + 2] = -1;
  assert.throws(() => mirror.apply(matrixFrame), /filter array/);
  assert.throws(
    () => mirror.apply(matrixFrame.subarray(0, matrixFrame.length - 8)),
    /filter array|truncated/,
  );
});

function field(assets: ReturnType<typeof library>) {
  const text = new TextObject(null);
  text.fonts = assets.source.fonts;
  text.embedFonts = true;
  text.wordWrap = true;
  text.width = 32;
  text.height = 48;
  text.model.defaultFormat = {
    ...text.model.defaultFormat,
    font: "WorkerFont",
    size: 17,
    color: 0xcc22aa,
    tabStops: [4, 12],
  };
  text.model.setText("Ab Ab\rA\ud800b");
  text.type = "input";
  text.focused = true;
  text.select(1, 4);
  text.antiAliasType = "advanced";
  text.scrollH = 2;
  return text;
}

test("loaded shapes, static text and main-thread laid glyphs survive the scene handoff", () => {
  const primary = readLibrary(readSwf(workerScene()));
  const extra = library();
  const source = new SceneLibraries();
  source.add(1, primary);
  source.add(2, extra.source);
  const target = new SceneLibraries();
  target.add(1, primary);
  const root = new Container();
  const original = primary.characters.get(1);
  const loaded = extra.source.characters.get(1);
  const staticText = extra.source.characters.get(5);
  assert.ok(
    original?.type === "shape" && loaded?.type === "shape" && staticText?.type === "static",
  );
  root.addChildAt(new ShapeObject(original), 0);
  root.addChildAt(new ShapeObject(loaded), 1);
  root.addChildAt(new StaticTextObject(staticText, extra.source.characters), 2);
  const text = field(extra);
  root.addChildAt(text, 3);
  const sourceLayout = text.layout;
  sourceLayout.lines[0].chars[0].x += 7;
  const dirty = text.dirty;
  const snapshot = new SceneSnapshot(source);
  const mirror = new SceneMirror(target);
  const bytes = new Uint8Array(sceneFrameBytes(32, 16384));
  const frame = bytes.subarray(0, snapshot.encode(root, bytes));
  assert.throws(() => mirror.apply(frame), /snapshot node/);
  target.add(2, extra.target);
  const result = mirror.apply(frame);
  const first = result.children[0] as ShapeObject;
  const second = result.children[1] as ShapeObject;
  assert.notEqual(first.shape, second.shape);
  assert.equal(second.shape, extra.target.characters.get(1));
  assert.ok(result.children[2] instanceof StaticTextObject);
  assert.equal((result.children[2] as StaticTextObject).glyphs.text, "Ab");
  const mirrored = result.children[3] as TextObject;
  assert.ok(mirrored instanceof TextObject);
  assert.deepEqual(mirrored.layout, sourceLayout);
  assert.equal(mirrored.model.text, text.model.text);
  assert.deepEqual(mirrored.selection, [1, 4]);
  assert.equal(mirrored.scrollH, 2);
  assert.notEqual(mirrored.model.defaultFormat.tabStops, text.model.defaultFormat.tabStops);
  assert.equal(text.dirty, dirty);
  assert.equal(text.layout, sourceLayout);
  const retained = mirrored.layout;
  mirror.apply(frame);
  assert.equal(mirrored.layout, retained);
  text.model.setText("bA");
  text.select(1, 1);
  mirror.apply(bytes.subarray(0, snapshot.encode(root, bytes)));
  assert.equal(result.children[3], mirrored);
  assert.equal(mirrored.text, "bA");
  assert.notEqual(mirrored.layout, retained);
});

test("malformed text and bitmap payloads leave the prior mirror intact", () => {
  const assets = library();
  const source = new SceneLibraries();
  source.add(1, assets.source);
  const target = new SceneLibraries();
  target.add(1, assets.target);
  const root = new Container();
  root.addChildAt(field(assets), 0);
  root.addChildAt(new BitmapObject(new BitmapStore(3, 3, true, 0xff112233)), 1);
  const snapshot = new SceneSnapshot(source);
  const mirror = new SceneMirror(target);
  const bytes = new Uint8Array(sceneFrameBytes(16, 8192));
  const frame = bytes.subarray(0, snapshot.encode(root, bytes));
  const result = mirror.apply(frame);
  const text = result.children[0] as TextObject;
  const bitmap = result.children[1] as BitmapObject;
  const layout = text.layout;
  const store = bitmap.store;
  const data = new Float64Array(frame.buffer, 0, frame.length / 8);
  const textAt = data[2 + 25 + 24];
  const bitmapAt = data[2 + 2 * 25 + 24];
  for (const [index, value] of [
    [2 + 25 + 24, -1],
    [textAt + 4, 2],
    [bitmapAt + 2, -1],
    [bitmapAt + 3, 0],
    [bitmapAt + 5, 1e9],
    [bitmapAt + 7, 2],
  ]) {
    const saved = data[index];
    data[index] = value;
    assert.throws(() => mirror.apply(frame), /snapshot/);
    assert.equal(text.layout, layout);
    assert.equal(bitmap.store, store);
    data[index] = saved;
  }
  assert.throws(() => mirror.apply(frame.subarray(0, frame.length - 8)), /bitmap pixels/);
  assert.throws(() => snapshot.encode(root, new Uint8Array(sceneFrameBytes(3))), /capacity/);
  target.drop(1);
  assert.throws(() => mirror.apply(frame), /font/);
  assert.equal(text.layout, layout);
  assert.equal(bitmap.store, store);
});
