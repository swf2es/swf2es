// Synthetic scene shared by the Node ownership and browser pixel comparisons.
import { readSwf } from "../../packages/format/dist/index.js";
import { BitmapStore } from "../../packages/player/dist/bitmap/bitmap.js";
import {
  BitmapObject,
  CONTENT,
  Container,
  ShapeObject,
  StaticTextObject,
  TextObject,
  TRANSFORM,
} from "../../packages/player/dist/display/display.js";
import { Drawing } from "../../packages/player/dist/display/drawing.js";
import { filterDefaults } from "../../packages/player/dist/display/filters.js";
import { readLibrary } from "../../packages/player/dist/display/timeline.js";
import * as w from "../swf-writer.ts";
import { SceneLibraries } from "./scene/libraries.ts";

export function sceneFixture() {
  const square = (color: number) =>
    w.shape({
      id: 1,
      bounds: [0, 400, 0, 400],
      fills: [color],
      paths: [
        {
          fill1: 1,
          commands: [
            { move: [0, 0] },
            { line: [400, 0] },
            { line: [400, 400] },
            { line: [0, 400] },
            { line: [0, 0] },
          ],
        },
      ],
    });
  const first = w.swf({
    width: 128,
    height: 128,
    frameCount: 1,
    tags: [
      square(0xcc3300),
      w.morphShape({
        id: 2,
        startBounds: [0, 300, 0, 300],
        endBounds: [0, 500, 0, 300],
        fills: [{ start: 0xff22aa44, end: 0xffaa22cc }],
        start: [
          {
            fill1: 1,
            commands: [
              { move: [0, 0] },
              { line: [300, 0] },
              { line: [300, 300] },
              { line: [0, 300] },
              { line: [0, 0] },
            ],
          },
        ],
        end: [
          [
            { move: [0, 0] },
            { line: [500, 0] },
            { line: [500, 300] },
            { line: [0, 300] },
            { line: [0, 0] },
          ],
        ],
      }),
      w.font3({
        id: 3,
        name: "SceneFixture",
        ascent: 800,
        descent: 200,
        glyphs: [
          { char: "A", advance: 600, boxes: [[0, -700, 450, 0]] },
          { char: "B", advance: 600, boxes: [[0, -550, 350, 0]] },
        ],
      }),
      w.staticText({
        id: 4,
        bounds: [0, 1200, 0, 400],
        records: [
          {
            font: 3,
            height: 320,
            color: 0x663399,
            y: 300,
            glyphs: [
              [0, 200],
              [1, 200],
            ],
          },
        ],
      }),
    ],
  });
  const second = w.swf({ width: 128, height: 128, frameCount: 1, tags: [square(0x2255cc)] });
  const libraries = [first, second].map((bytes, i) => ({
    id: i + 1,
    bytes,
    library: readLibrary(readSwf(bytes)),
  }));
  const assets = new SceneLibraries();
  for (let i = 0; i < libraries.length; i++) {
    assets.add(libraries[i].id, libraries[i].library);
  }
  const a = libraries[0].library,
    b = libraries[1].library;
  const red = a.characters.get(1),
    blue = b.characters.get(1),
    morph = a.characters.get(2),
    staticText = a.characters.get(4);
  if (
    red?.type !== "shape" ||
    blue?.type !== "shape" ||
    morph?.type !== "morph" ||
    staticText?.type !== "static"
  ) {
    throw new Error("invalid synthetic scene library");
  }

  const root = new Container(),
    group = new Container(),
    left = new ShapeObject(red),
    right = new ShapeObject(blue);
  const animated = ShapeObject.ofMorph(morph),
    label = new StaticTextObject(staticText, a.characters);
  left.matrix = { a: 1, b: 0, c: 0, d: 1, tx: 4, ty: 4 };
  right.matrix = { a: 1, b: 0, c: 0, d: 1, tx: 32, ty: 4 };
  animated.matrix = { a: 1, b: 0, c: 0, d: 1, tx: 68, ty: 4 };
  label.matrix = { a: 1, b: 0, c: 0, d: 1, tx: 4, ty: 30 };
  group.addChildAt(left, 0);
  group.addChildAt(right, 1);
  root.addChildAt(group, 0);
  root.addChildAt(animated, 1);
  root.addChildAt(label, 2);
  const text = new TextObject(null);
  text.fonts = a.fonts;
  text.embedFonts = true;
  text.model.defaultFormat = {
    ...text.model.defaultFormat,
    font: "SceneFixture",
    size: 18,
    color: 0x112233,
  };
  text.width = 100;
  text.height = 24;
  text.model.setText("ABBA");
  text.matrix = { a: 1, b: 0, c: 0, d: 1, tx: 4, ty: 52 };
  root.addChildAt(text, 3);
  const store = new BitmapStore(4, 4, true, 0xff336699);
  const bitmap = new BitmapObject(store),
    sharedBitmap = new BitmapObject(store);
  bitmap.matrix = { a: 4, b: 0, c: 0, d: 4, tx: 4, ty: 84 };
  sharedBitmap.matrix = { a: 4, b: 0, c: 0, d: 4, tx: 24, ty: 84 };
  root.addChildAt(bitmap, 4);
  root.addChildAt(sharedBitmap, 5);
  const graphics = new ShapeObject(null),
    drawing = new Drawing();
  graphics.drawing = drawing;
  graphics.matrix = { a: 1, b: 0, c: 0, d: 1, tx: 48, ty: 84 };
  const mask = new ShapeObject(red);
  mask.matrix = { a: 0.75, b: 0, c: 0, d: 0.75, tx: 49, ty: 85 };
  root.addChildAt(graphics, 6);
  root.addChildAt(mask, 7);
  const step = (frame: number) => {
    left.matrix = { a: frame % 2 ? -1 : 1, b: 0, c: 0, d: 1, tx: frame % 2 ? 24 : 4, ty: 4 };
    left.invalidate(TRANSFORM);
    right.visible = frame % 3 !== 1;
    right.invalidate(TRANSFORM);
    animated.ratio = Math.round(((frame % 9) * 65535) / 8);
    animated.invalidate(CONTENT);
    text.model.setText(frame % 2 ? "BAAB" : "ABBA");
    text.select(0, frame % 4);
    text.invalidate(CONTENT);
    store.setPixel32(frame % 4, 0, 0xff000000 | (frame * 0x110011));
    drawing.clear();
    drawing.beginFill({
      type: "image",
      image: store,
      matrix: { a: 4, b: 0, c: 0, d: 4, tx: 0, ty: 0 },
      repeat: true,
      smooth: false,
    });
    drawing.moveTo(0, 0);
    drawing.lineTo(20, 0);
    drawing.lineTo(20, 20);
    drawing.lineTo(0, 20);
    drawing.lineTo(0, 0);
    drawing.endFill();
    graphics.invalidate(CONTENT);
    graphics.setMask(frame % 2 ? mask : null);
    group.filters = frame % 3 ? [filterDefaults("colorMatrix")] : [];
    group.colorTransform =
      frame % 2
        ? { rMul: 1, gMul: 0.5, bMul: 1, aMul: 0.75, rAdd: 10, gAdd: 0, bAdd: 0, aAdd: 0 }
        : null;
    group.scroll = frame % 3 ? { xMin: 0, yMin: 0, xMax: 49, yMax: 24 } : null;
    group.setCachedAsBitmap(frame % 4 === 1);
    group.invalidate(TRANSFORM);
    group.addChildAt(frame % 2 ? left : right, group.children.length);
  };
  step(0);
  return {
    root,
    assets,
    libraries,
    step,
    text,
    store,
    bitmap,
    sharedBitmap,
    graphics,
    animated,
    group,
  };
}
