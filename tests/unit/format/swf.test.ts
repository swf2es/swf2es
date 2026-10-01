import assert from "node:assert/strict";
import { test } from "node:test";
import {
  backgroundColor,
  isAs3,
  readPlace,
  readRemove,
  readShape,
  readSprite,
  readSwf,
  readSymbolClass,
  tags,
} from "@swf2es/format";
import * as w from "../../player/swf-writer.ts";

const square = w.shape({
  id: 1,
  bounds: [0, 400, 0, 400],
  fills: [0xff0000],
  lines: [{ width: 20, color: 0x000000 }],
  paths: [
    {
      fill1: 1,
      line: 1,
      commands: [
        { move: [0, 0] },
        { line: [400, 0] },
        { curve: [500, 200, 400, 400] },
        { line: [0, 400] },
        { line: [0, 0] },
      ],
    },
  ],
});

const movie = w.swf({
  width: 100,
  height: 50,
  frameRate: 12.5,
  frameCount: 2,
  tags: [
    w.fileAttributes(false),
    w.backgroundColor(0x336699),
    square,
    w.place({ depth: 1, character: 1, matrix: { tx: 200, ty: -40, a: 2, d: 0.5 }, name: "sq" }),
    w.showFrame(),
    w.place({ depth: 1, move: true, matrix: { tx: 300, ty: 0, b: 0.25, c: -0.25 } }),
    w.remove(2),
    w.sprite(5, 1, [w.showFrame(), w.end()]),
    w.symbolClass([
      [0, "Main"],
      [5, "pkg.Thing"],
    ]),
    w.showFrame(),
    w.end(),
  ],
});

test("a SWF's header and tags read as written", () => {
  const swf = readSwf(movie);
  assert.equal(swf.header.compression, "none");
  assert.deepEqual(swf.frameSize, { xMin: 0, xMax: 2000, yMin: 0, yMax: 1000 });
  assert.equal(swf.frameRate, 12.5);
  assert.equal(swf.frameCount, 2);
  assert.equal(swf.truncated, false);
  assert.deepEqual(
    swf.tags.map((t) => t.code),
    [
      tags.FileAttributes,
      tags.SetBackgroundColor,
      tags.DefineShape,
      tags.PlaceObject2,
      tags.ShowFrame,
      tags.PlaceObject2,
      tags.RemoveObject2,
      tags.DefineSprite,
      tags.SymbolClass,
      tags.ShowFrame,
      tags.End,
    ],
  );
  assert.equal(backgroundColor(swf), 0x336699);
});

test("a shape's styles and edges read as written", () => {
  const swf = readSwf(movie);
  const t = swf.tags[2];
  const s = readShape(swf.bytes, t.code, t.offset, t.length);
  assert.equal(s.id, 1);
  assert.deepEqual(s.bounds, { xMin: 0, xMax: 400, yMin: 0, yMax: 400 });
  assert.deepEqual(s.fills, [{ type: "solid", color: 0xffff0000 }]);
  assert.equal(s.lines.length, 1);
  assert.equal(s.lines[0].width, 20);
  assert.equal(s.lines[0].color, 0xff000000);
  assert.equal(s.truncated, false);
  assert.deepEqual(s.records, [
    { type: "style", moveTo: { x: 0, y: 0 }, fill0: 0, fill1: 1, line: 1, styles: null },
    { type: "line", dx: 400, dy: 0 },
    { type: "curve", cx: 100, cy: 200, ax: -100, ay: 200 },
    { type: "line", dx: -400, dy: 0 },
    { type: "line", dx: 0, dy: -400 },
  ]);
});

test("places, removes, sprites and symbols read as written", () => {
  const swf = readSwf(movie);
  const first = readPlace(swf.bytes, swf.tags[3]);
  assert.equal(first.depth, 1);
  assert.equal(first.move, false);
  assert.equal(first.character, 1);
  assert.equal(first.name, "sq");
  assert.deepEqual(first.matrix, { a: 2, b: 0, c: 0, d: 0.5, tx: 200, ty: -40 });

  const moved = readPlace(swf.bytes, swf.tags[5]);
  assert.equal(moved.move, true);
  assert.equal(moved.character, null);
  assert.deepEqual(moved.matrix, { a: 1, b: 0.25, c: -0.25, d: 1, tx: 300, ty: 0 });

  assert.equal(readRemove(swf.bytes, swf.tags[6]), 2);

  const sprite = readSprite(swf.bytes, swf.tags[7]);
  assert.equal(sprite.id, 5);
  assert.equal(sprite.frameCount, 1);
  assert.deepEqual(
    sprite.tags.map((t) => t.code),
    [tags.ShowFrame, tags.End],
  );

  assert.deepEqual(
    [...readSymbolClass(swf.bytes, swf.tags[8])],
    [
      [0, "Main"],
      [5, "pkg.Thing"],
    ],
  );
});

test("a tag past the file's end is cut there, and marked", () => {
  const cut = movie.slice(0, movie.length - 10);
  new DataView(cut.buffer).setUint32(4, cut.length, true);
  const swf = readSwf(cut);
  assert.equal(swf.truncated, true);
  const last = swf.tags[swf.tags.length - 1];
  assert.ok(last.offset + last.length <= cut.length);
});

const frame = (...tags: Uint8Array[]) =>
  w.swf({
    width: 10,
    height: 10,
    frameRate: 1,
    frameCount: 1,
    tags: [...tags, w.showFrame(), w.end()],
  });

test("FileAttributes tells ActionScript 3 from an AVM1 movie", () => {
  assert.equal(isAs3(readSwf(movie)), false);
  assert.equal(isAs3(readSwf(frame(w.fileAttributes(true)))), true);
});
