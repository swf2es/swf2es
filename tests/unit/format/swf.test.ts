import assert from "node:assert/strict";
import { test } from "node:test";
import {
  backgroundColor,
  isAs3,
  readFilters,
  readPlace,
  readRemove,
  readShape,
  readSprite,
  readSwf,
  readSymbolClass,
  tags,
} from "@swf2es/format";
import * as w from "../../swf-writer.ts";

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

test("PlaceObject3's class name, visibility and background read as Flash does", () => {
  const swf = readSwf(
    frame(
      w.place({ depth: 1, hasImage: true, className: "pkg.Image", matrix: { tx: 20 } }),
      w.place({ depth: 2, character: 1, visible: false, name: "hidden" }),
      w.place({ depth: 3, character: 1, opaqueBackground: 0x80112233 }),
    ),
  );
  // No character: the class name is implied by HasImage, before the matrix.
  const image = readPlace(swf.bytes, swf.tags[0]);
  assert.equal(image.className, "pkg.Image");
  assert.equal(image.character, null);
  assert.deepEqual(image.matrix, { a: 1, b: 0, c: 0, d: 1, tx: 20, ty: 0 });

  const hidden = readPlace(swf.bytes, swf.tags[1]);
  assert.equal(hidden.name, "hidden");
  assert.equal(hidden.visible, false);
  assert.equal(hidden.opaqueBackground, null);

  const backed = readPlace(swf.bytes, swf.tags[2]);
  assert.equal(backed.visible, null);
  assert.equal(backed.opaqueBackground, 0x80112233);
});

test("a string's malformed bytes stand for themselves, as avmplus reads them", () => {
  // A PlaceObject2 with only a name: "é" as UTF-8, as the Latin-1 byte, an
  // overlong NUL, and a four-byte value past U+10FFFF, which must not throw.
  const name = [0xc3, 0xa9, 0xe9, 0xc0, 0x80, 0xf7, 0xbf, 0xbf, 0xbf, 0];
  const swf = readSwf(frame(w.tag(26, new Uint8Array([0x20, 1, 0, ...name]))));
  assert.equal(readPlace(swf.bytes, swf.tags[0]).name, "\u00e9\u00e9\u00c0\u0080\udbbf\udfff");
});

test("FileAttributes tells ActionScript 3 from an AVM1 movie", () => {
  assert.equal(isAs3(readSwf(movie)), false);
  assert.equal(isAs3(readSwf(frame(w.fileAttributes(true)))), true);
});

test("a FILTERLIST reads its blur, glow and bevel, the bevel's highlight first as adl has it", () => {
  const b = new w.BitWriter().u8(3);
  // Blur: 16.16 blurs, then passes in the top five bits.
  b.u8(1)
    .u32(5 << 16)
    .u32(0x00028000)
    .u8(2 << 3);
  // Glow: RGBA, blurs, 8.8 strength, inner | knockout | composite | passes.
  b.u8(2)
    .u8(0x11)
    .u8(0x22)
    .u8(0x33)
    .u8(0x80)
    .u32(6 << 16)
    .u32(6 << 16)
    .u16(0x0280)
    .u8(0x80 | 0x20 | 3);
  // Bevel: highlight, shadow, blurs, angle, distance, strength, flags with on top.
  b.u8(3).u8(0xff).u8(0xff).u8(0xff).u8(0xff).u8(0).u8(0).u8(0).u8(0x40);
  b.u32(4 << 16)
    .u32(4 << 16)
    .u32(0)
    .u32(4 << 16)
    .u16(0x0100)
    .u8(0x10 | 1);
  const filters = readFilters(b.done());
  assert.deepEqual(filters[0], { type: "blur", blurX: 5, blurY: 2.5, passes: 2 });
  assert.deepEqual(filters[1], {
    type: "glow",
    color: { rgb: 0x112233, alpha: 0x80 },
    blurX: 6,
    blurY: 6,
    strength: 2.5,
    inner: true,
    knockout: false,
    composite: true,
    passes: 3,
  });
  const bevel = filters[2] as { colors: unknown[]; onTop: boolean; passes: number };
  assert.deepEqual(bevel.colors, [
    { rgb: 0, alpha: 0x40 },
    { rgb: 0xffffff, alpha: 0xff },
  ]);
  assert.deepEqual([bevel.onTop, bevel.passes], [true, 1]);
});
