import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { readShape, readSwf } from "@swf2es/format";
import { Tessellator } from "@swf2es/native/render";
import { morphAt } from "../../../../packages/player/dist/display/morph.js";
import { shapeLayers } from "../../../../packages/player/dist/display/shapes.js";
import type { MorphCharacter } from "../../../../packages/player/dist/display/timeline.js";
import { readLibrary } from "../../../../packages/player/dist/display/timeline.js";
import { LineCache } from "../../../../packages/player/dist/scene/lines.js";
import { Parts } from "../../../../packages/player/dist/scene/parts.js";
import { placeGlyphs } from "../../../../packages/player/dist/text/static.js";
import { Geometries } from "../../../../packages/render/dist/index.js";
import * as w from "../../../swf-writer.ts";
import { crossingMorphTag, movieOf } from "../scene/crossing-morph.ts";

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

test("a shared shape can build its layers after its first SWF is collected", async () => {
  setFlagsFromString("--expose-gc");
  const gc: () => void = runInNewContext("gc");

  function reload(tag: Uint8Array, source: Uint8Array) {
    source.set(tag);
    const first = shapeIn(source);
    const shared = shapeIn(tag);
    assert.ok(shared?.type === "shape");
    assert.equal(shared, first);

    return { source: new WeakRef(source.buffer), shared };
  }

  const one = movie(0x345678);
  const two = movie(0x765432);
  const shapes = [reload(one, new Uint8Array(one.length)), reload(two, Buffer.alloc(two.length))];

  await setImmediate();
  gc();
  for (const { source, shared } of shapes) {
    assert.equal(source.deref(), undefined);
    assert.equal(shared.layers[0].fills.length, 1);
  }
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

const morphIn = (bytes: Uint8Array) => {
  const morph = readLibrary(readSwf(bytes)).characters.get(1);
  assert.equal(morph?.type, "morph");
  return morph as MorphCharacter;
};

test("a SWF read again shares its morphs, and their blends, with the first, and only the morphs alike", () => {
  const bytes = movieOf(crossingMorphTag(4));
  const first = morphIn(bytes);
  const second = morphIn(bytes.slice());
  assert.equal(second, first);
  assert.equal(morphAt(second, 1000), morphAt(first, 1000));
  assert.notEqual(morphIn(movieOf(crossingMorphTag(4, 200, 0xff996633))), first);
});

test("a second load of a morph tessellates none of the blends the first drew", () => {
  const tessellator = new Tessellator();
  const geometries = new Geometries();
  let calls = 0;
  const tessellate = {
    layer: (...args: Parameters<typeof tessellator.tessellate.layer>) => {
      calls++;
      return tessellator.tessellate.layer(...args);
    },
    lines: tessellator.tessellate.lines,
  };
  const parts = new Parts(geometries, tessellate, new LineCache(geometries, tessellate));
  const ratios = [0, 21845, 43690, 65535];
  const play = (bytes: Uint8Array) => {
    const morph = morphIn(bytes);
    for (const ratio of ratios) {
      for (const layer of morphAt(morph, ratio).layers) {
        parts.partsOf(layer, 0);
      }

      geometries.endFrame();
    }

    return morph;
  };

  try {
    const bytes = movieOf(crossingMorphTag(4));
    const first = play(bytes);
    assert.equal(calls, ratios.length);
    const second = play(bytes.slice());
    assert.equal(second, first);
    assert.equal(calls, ratios.length);
  } finally {
    tessellator.dispose();
  }
});

test("a morph filled with a bitmap keeps to its SWF", () => {
  const tag = w.morphShape({
    id: 1,
    startBounds: [0, 400, 0, 400],
    endBounds: [0, 400, 0, 400],
    fills: [{ type: 0x41, bitmap: 7, startMatrix: { a: 20, d: 20 }, endMatrix: { a: 20, d: 20 } }],
    start: [
      {
        fill1: 1,
        commands: [{ move: [0, 0] }, { line: [400, 0] }, { line: [400, 400] }, { line: [0, 0] }],
      },
    ],
    end: [[{ move: [0, 0] }, { line: [400, 0] }, { line: [400, 400] }, { line: [0, 0] }]],
  });
  const bytes = movieOf(tag);
  const first = morphIn(bytes);
  assert.equal(first.morph.fills[0].start.type, "bitmap");
  assert.notEqual(morphIn(bytes.slice()), first);
});

test("a shared morph goes, with its blends, once no library holds it", async () => {
  setFlagsFromString("--expose-gc");
  const gc: () => void = runInNewContext("gc");
  const bytes = movieOf(crossingMorphTag(4));

  const load = () => {
    const morph = morphIn(bytes.slice());
    const blend = morphAt(morph, 30000);
    return { morph: new WeakRef(morph), blend: new WeakRef(blend) };
  };
  const { morph, blend } = load();
  // A load while the first's is held shares it.
  assert.equal(morphIn(bytes.slice()), morph.deref());

  for (let i = 0; i < 10 && morph.deref(); i++) {
    await setImmediate();
    gc();
  }

  assert.equal(morph.deref(), undefined);
  assert.equal(blend.deref(), undefined);
  // Read again after, a new one, whose blends are made again.
  const again = morphIn(bytes.slice());
  assert.equal(again.blends.size, 0);
});
