import assert from "node:assert/strict";
import { test } from "node:test";
import { readShape, readSwf } from "@swf2es/format";
import { shapeLayers } from "../../../../packages/player/dist/display/shapes.js";
import { readLibrary } from "../../../../packages/player/dist/display/timeline.js";
import { placeGlyphs } from "../../../../packages/player/dist/text/static.js";
import * as w from "../../../swf-writer.ts";

test("unlabelled, silent timelines allocate their public maps only when requested", () => {
  const library = readLibrary(
    readSwf(
      w.swf({
        width: 10,
        height: 10,
        frameCount: 1,
        tags: [w.sprite(1, 1, [w.showFrame(), w.end()]), w.showFrame(), w.end()],
      }),
    ),
  );
  const root = library.root;
  const sprite = library.characters.get(1);
  assert.ok(sprite?.type === "sprite");
  const child = sprite.timeline;
  assert.ok(Object.getOwnPropertyDescriptor(child, "frameLabels")?.get);
  assert.ok(Object.getOwnPropertyDescriptor(child, "sounds")?.get);
  const descriptors = Object.defineProperties(
    {},
    Object.getOwnPropertyDescriptors(root),
  ) as typeof root;
  root.frameLabels.set(1, "root");
  assert.equal(descriptors.frameLabels.get(1), "root");
  const sounds = new Map([[1, []]]);
  root.sounds = sounds;
  assert.equal(root.sounds, sounds);

  const copy = { ...child };
  assert.equal(copy.sounds, child.sounds);
  assert.equal(copy.frameLabels, child.frameLabels);
  assert.equal(copy.sounds.size, 0);
  assert.equal(copy.frameLabels.size, 0);
  copy.sounds = sounds;
  assert.equal(copy.sounds, sounds);
  assert.notEqual(child.sounds, sounds);

  const replaced = new Map([[1, "replacement"]]);
  Object.defineProperty(root, "frameLabels", { value: replaced });
  assert.equal(root.frameLabels, replaced);
});

test("frame labels and sound tags allocate their maps independently", () => {
  const library = readLibrary(
    readSwf(
      w.swf({
        width: 10,
        height: 10,
        frameCount: 1,
        tags: [
          w.frameLabel("first"),
          w.frameLabel("alias"),
          w.sprite(1, 1, [w.startSound(2), w.startSound2("Tone"), w.showFrame(), w.end()]),
          w.showFrame(),
          w.end(),
        ],
      }),
    ),
  );
  const sprite = library.characters.get(1);
  assert.ok(sprite?.type === "sprite");
  assert.ok(Object.getOwnPropertyDescriptor(library.root, "sounds")?.get);
  assert.equal(new Proxy(library.root, {}).frameLabels.get(1), "first");
  assert.equal(Object.create(library.root).frameLabels, library.root.frameLabels);
  const frozen = sprite.timeline;
  Object.freeze(frozen);
  const proxy = new Proxy(frozen, {});
  assert.equal(proxy.sounds, frozen.sounds);
  assert.throws(() => {
    Object.create(frozen).frameLabels = new Map();
  }, TypeError);
  proxy.frameLabels.set(1, "nested");
  assert.equal(frozen.frameLabels.get(1), "nested");
  assert.throws(() => {
    proxy.frameLabels = new Map();
  }, TypeError);
  assert.ok(Object.getOwnPropertyDescriptor(sprite.timeline, "frameLabels")?.get);
  assert.deepEqual(
    sprite.timeline.sounds.get(1)?.map((s) => s.className ?? s.id),
    [2, "Tone"],
  );
});

test("legacy fonts receive names, styles and character mappings after text has referenced them", () => {
  const library = readLibrary(
    readSwf(
      w.swf({
        version: 6,
        width: 100,
        height: 100,
        frameCount: 1,
        tags: [
          w.font1(1, [
            { char: "A", advance: 0, boxes: [[0, -700, 500, 0]] },
            { char: "Ω", advance: 0, boxes: [[0, -700, 700, 0]] },
          ]),
          w.staticText({
            id: 2,
            bounds: [0, 1000, -700, 0],
            records: [
              {
                font: 1,
                height: 400,
                color: 0xff0000,
                glyphs: [
                  [0, 200],
                  [1, 300],
                ],
              },
            ],
          }),
          w.fontInfo(1, "Legacy", [65, 0x3a9], { bold: true, italic: true }),
          w.fontInfo(99, "Missing", [65]),
          w.showFrame(),
          w.end(),
        ],
      }),
    ),
  );
  const font = library.characters.get(1);
  const text = library.characters.get(2);
  assert.ok(font?.type === "font");
  assert.ok(text?.type === "static");
  assert.equal(font.name, "Legacy");
  assert.equal(font.font.name, font.name);
  assert.equal(font.bold, true);
  assert.equal(font.font.bold, true);
  assert.equal(font.italic, true);
  assert.equal(font.font.italic, true);
  assert.equal(library.fonts.find("Legacy", true, true), font.font);
  const placed = placeGlyphs(text, library.characters);
  assert.equal(placed.text, "AΩ");
  assert.equal(placed.glyphs.length, 2);
  assert.equal(placed.glyphs[1].x, 200);
  assert.equal(placed.glyphs[1].font.em, 1024);
});

function movie(fill: number | w.BitmapFill): Uint8Array {
  return w.swf({
    width: 100,
    height: 100,
    frameRate: 24,
    frameCount: 1,
    tags: [
      w.fileAttributes(false),
      w.shape({
        id: 1,
        bounds: [0, 400, 0, 400],
        fills: [fill],
        lines: [{ width: 20, color: 0x000000 }],
        paths: [
          {
            fill1: 1,
            line: 1,
            commands: [
              { move: [0, 0] },
              { line: [400, 0] },
              { line: [400, 400] },
              { line: [0, 0] },
            ],
          },
        ],
      }),
      w.place({ depth: 1, character: 1 }),
      w.showFrame(),
      w.end(),
    ],
  });
}

const shapeIn = (bytes: Uint8Array) => readLibrary(readSwf(bytes)).characters.get(1);

test("a SWF read again shares its shapes with the first, and only the shapes alike", () => {
  const red = movie(0xff0000);
  const first = shapeIn(red);
  assert.equal(first?.type, "shape");

  // Read again, from a copy of its bytes, as a second load would be.
  assert.equal(shapeIn(red.slice()), first);

  // Another colour is another shape.
  assert.notEqual(shapeIn(movie(0x00ff00)), first);
});

test("a shape filled with a bitmap keeps to its SWF", () => {
  const filled = movie({ bitmap: 7, type: 0x41, matrix: { a: 20, d: 20 } });
  assert.notEqual(shapeIn(filled), shapeIn(filled.slice()));
});

test("a shape is drawn into layers when first asked for, as it was at once", () => {
  const bytes = movie(0x0000ff);
  const swf = readSwf(bytes);
  const shape = readLibrary(swf).characters.get(1);
  assert.equal(shape?.type, "shape");
  if (shape?.type !== "shape") {
    return;
  }

  // An accessor, not layers made as the SWF was read.
  assert.equal(typeof Object.getOwnPropertyDescriptor(shape, "layers")?.get, "function");
  assert.deepEqual(Object.keys(shape.shape).sort(), ["bounds", "edgeBounds"]);

  const tag = swf.tags.find((t) => t.code === 2 || t.code === 22 || t.code === 32 || t.code === 83);
  assert.ok(tag);
  const eager = shapeLayers(readShape(swf.bytes, tag.code, tag.offset, tag.length));
  assert.deepEqual(shape.layers, eager);
  assert.equal(shape.layers, shape.layers);
});
