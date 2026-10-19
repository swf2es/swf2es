import assert from "node:assert/strict";
import { test } from "node:test";
import { readSwf } from "../../packages/format/dist/index.js";
import { BitmapStore } from "../../packages/player/dist/bitmap/bitmap.js";
import {
  BitmapObject,
  Container,
  ShapeObject,
  TextObject,
} from "../../packages/player/dist/display/display.js";
import { Drawing } from "../../packages/player/dist/display/drawing.js";
import { filterDefaults } from "../../packages/player/dist/display/filters.js";
import { readLibrary } from "../../packages/player/dist/display/timeline.js";
import { swf } from "../swf-writer.ts";
import { readSharedLibrary, SceneLibraries, shareLibrary } from "./scene/libraries.ts";
import { SceneMirror, SceneSnapshot } from "./scene/scene.ts";
import { sceneFixture } from "./scene-fixture.ts";

test("decoded text, drawing paths, filter arrays and bitmap pixels survive frame-buffer reuse", () => {
  const library = readLibrary(readSwf(swf({ width: 100, height: 100, frameCount: 1, tags: [] })));
  const source = new Container();
  source.matrix.tx = 13;
  source.filters = [filterDefaults("colorMatrix")];
  const bitmap = new BitmapObject(new BitmapStore(2, 2, true, 0xff336699));
  const text = new TextObject(null);
  text.model.setText("owned\uD800 pixels");
  const shape = new ShapeObject(null),
    drawing = new Drawing();
  shape.drawing = drawing;
  drawing.beginFill({ type: "solid", color: 0xffaa3355 });
  drawing.moveTo(1, 2);
  drawing.lineTo(20, 2);
  drawing.lineTo(20, 30);
  drawing.lineTo(1, 2);
  drawing.endFill();
  source.addChildAt(bitmap, 0);
  source.addChildAt(text, 1);
  source.addChildAt(shape, 2);
  const bytes = new Uint8Array(new SharedArrayBuffer(65536));
  const writer = new SceneSnapshot(library),
    mirror = new SceneMirror(library);
  const root = mirror.apply(bytes.subarray(0, writer.encode(source, bytes)));
  assert.ok(root instanceof Container);
  const actualBitmap = root.children[0] as BitmapObject,
    actualText = root.children[1] as TextObject,
    actualShape = root.children[2] as ShapeObject;
  assert.ok(actualBitmap.store);
  assert.ok(actualShape.drawing);
  const saved = {
    matrix: { ...root.matrix },
    filters: structuredClone(root.filters),
    pixels: actualBitmap.store.readable.slice(),
    text: actualText.model.text,
    layout: structuredClone(actualText.layout),
    drawing: structuredClone(actualShape.drawing.layers),
  };
  bytes.fill(0xee);
  assert.deepEqual(root.matrix, saved.matrix);
  assert.deepEqual(root.filters, saved.filters);
  assert.deepEqual(actualBitmap.store.readable, saved.pixels);
  assert.equal(actualText.model.text, saved.text);
  assert.deepEqual(actualText.layout, saved.layout);
  assert.deepEqual(actualShape.drawing.layers, saved.drawing);
});

test("complete scenes preserve aliases, library namespaces, layout and retained ordering", () => {
  const fixture = sceneFixture();
  const assets = new SceneLibraries();
  for (const entry of fixture.libraries) {
    assets.add(entry.id, readSharedLibrary(shareLibrary(entry.bytes, entry.library)));
  }
  const encoder = new SceneSnapshot(fixture.assets),
    mirror = new SceneMirror(assets);
  const bytes = new Uint8Array(new SharedArrayBuffer(131072));
  let retained: Container | undefined;
  for (let frame = 0; frame < 20; frame++) {
    fixture.step(frame);
    const length = encoder.encode(fixture.root, bytes);
    const root = mirror.apply(bytes.subarray(0, length));
    assert.ok(root instanceof Container);
    retained ??= root;
    assert.equal(root, retained);
    const group = root.children[0] as Container;
    for (let i = 0; i < group.children.length; i++) {
      const actual = group.children[i] as ShapeObject,
        source = fixture.group.children[i] as ShapeObject;
      assert.deepEqual(actual.matrix, source.matrix);
      assert.equal(actual.visible, source.visible);
      assert.equal(actual.shape?.id, 1);
      const library = source.shape === fixture.libraries[0].library.characters.get(1) ? 1 : 2;
      assert.equal(actual.shape, assets.character(library, 1));
    }
    assert.deepEqual(group.filters, fixture.group.filters);
    assert.deepEqual(group.colorTransform, fixture.group.colorTransform);
    assert.deepEqual(group.scroll, fixture.group.scroll);
    assert.equal(group.cachedAsBitmap, fixture.group.cachedAsBitmap);
    const text = root.children[3] as TextObject;
    assert.equal(text.model.text, fixture.text.model.text);
    assert.deepEqual(
      text.layout.lines.map((line) => [
        line.width,
        line.ascent,
        line.descent,
        line.chars.map((char) => char.x),
      ]),
      fixture.text.layout.lines.map((line) => [
        line.width,
        line.ascent,
        line.descent,
        line.chars.map((char) => char.x),
      ]),
    );
    assert.equal(text.layout.lines[0].chars[0].font, assets.font(1, 3));
    assert.equal(text.anchor, fixture.text.anchor);
    assert.equal(text.caret, fixture.text.caret);
    const first = root.children[4] as BitmapObject,
      second = root.children[5] as BitmapObject;
    assert.ok(first.store);
    assert.equal(first.store, second.store);
    assert.deepEqual(first.store.readable, fixture.store.readable);
    const graphic = root.children[6];
    assert.equal(graphic.mask, frame % 2 ? root.children[7] : null);
    const content = text.model.text,
      layout = structuredClone(text.layout);
    bytes.fill(0xee);
    assert.equal(text.model.text, content);
    assert.deepEqual(text.layout, layout);
    assert.deepEqual(first.store.readable, fixture.store.readable);
  }
});

test("a rejected complete frame leaves retained content intact and the next frame recovers", () => {
  const fixture = sceneFixture(),
    encoder = new SceneSnapshot(fixture.assets),
    mirror = new SceneMirror(fixture.assets);
  const bytes = new Uint8Array(new SharedArrayBuffer(131072));
  const packet = () => bytes.subarray(0, encoder.encode(fixture.root, bytes));
  const root = mirror.apply(packet());
  assert.ok(root instanceof Container);
  const before = root.children.slice();
  const text = root.children[3] as TextObject;
  const saved = text.model.text;
  fixture.step(1);
  const bad = packet();
  new Float64Array(bad.buffer)[2 + 27 + 1] = 99999;
  assert.throws(() => mirror.apply(bad), /invalid scene snapshot node/);
  assert.deepEqual(root.children, before);
  assert.equal(text.model.text, saved);
  assert.equal(mirror.apply(packet()), root);
  assert.equal(text.model.text, fixture.text.model.text);
  assert.throws(() => mirror.apply(packet().subarray(0, 24)), /invalid scene snapshot length/);
  fixture.graphics.setMask(new ShapeObject(null));
  assert.throws(() => encoder.encode(fixture.root, bytes), /masks inside its scene/);
  fixture.graphics.setMask(null);
  assert.equal(mirror.apply(packet()), root);
});

test("a snapshot subtree may be a leaf rather than a container", () => {
  const fixture = sceneFixture(),
    encoder = new SceneSnapshot(fixture.assets);
  const bytes = new Uint8Array(new SharedArrayBuffer(131072));
  for (const source of [fixture.bitmap, fixture.graphics, fixture.text, fixture.animated]) {
    const mirror = new SceneMirror(fixture.assets);
    const actual = mirror.apply(bytes.subarray(0, encoder.encode(source, bytes)));
    assert.equal(actual instanceof Container, false);
    assert.deepEqual(actual.matrix, source.matrix);
    if (source instanceof BitmapObject) {
      assert.ok(actual instanceof BitmapObject);
      assert.ok(actual.store);
      assert.deepEqual(actual.store.readable, fixture.store.readable);
    } else if (source instanceof TextObject) {
      assert.ok(actual instanceof TextObject);
      assert.equal(actual.model.text, source.model.text);
    } else {
      assert.ok(actual instanceof ShapeObject);
    }
    mirror.dispose();
  }
});
