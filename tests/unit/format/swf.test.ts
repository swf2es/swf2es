import assert from "node:assert/strict";
import { test } from "node:test";
import {
  backgroundColor,
  isAs3,
  readFilters,
  readMorphShape,
  readPlace,
  readRemove,
  readSceneData,
  readShape,
  readSprite,
  readStaticText,
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

test("scene data reads its scenes and labels, and stops at the tag's end", () => {
  const data = w.sceneData(
    [
      [0, "Intro"],
      [200, "Main"],
    ],
    [[3, "go"]],
  );
  const swf = readSwf(
    w.swf({ width: 1, height: 1, frameRate: 1, frameCount: 1, tags: [data, w.end()] }),
  );
  const tag = swf.tags.find((t) => t.code === tags.DefineSceneAndFrameLabelData);
  assert.ok(tag);
  assert.deepEqual(readSceneData(swf.bytes, tag), {
    scenes: [
      { frame: 0, name: "Intro" },
      { frame: 200, name: "Main" },
    ],
    labels: [{ frame: 3, name: "go" }],
  });

  // Cut inside "Main": a count past the bytes there are reads what there is.
  const cut = { ...tag, length: tag.length - 8 };
  assert.deepEqual(readSceneData(swf.bytes, cut), {
    scenes: [{ frame: 0, name: "Intro" }],
    labels: [],
  });
});

test("a morph shape's paired styles and both ends' records read as written", () => {
  const morph = w.morphShape({
    id: 4,
    version: 2,
    startBounds: [0, 400, 0, 400],
    endBounds: [0, 800, 0, 400],
    fills: [
      {
        type: 0x10,
        startMatrix: { a: 0.5, d: 0.5 },
        endMatrix: { a: 0.5, d: 0.5, tx: 200 },
        stops: [
          [0, 0xffff0000, 10, 0x80ff0000],
          [255, 0xff0000ff, 200, 0xff00ff00],
        ],
      },
    ],
    lines: [{ startWidth: 20, endWidth: 60, startColor: 0xff000000, endColor: 0xffffffff }],
    start: [
      {
        fill0: 1,
        line: 1,
        commands: [{ move: [0, 0] }, { line: [400, 0] }, { line: [400, 400] }, { line: [0, 0] }],
      },
    ],
    end: [
      [{ move: [0, 100] }, { curve: [400, 0, 800, 100] }, { line: [800, 400] }, { line: [0, 100] }],
    ],
  });
  const swf = readSwf(
    w.swf({ width: 100, height: 50, frameRate: 12, frameCount: 1, tags: [morph, w.end()] }),
  );
  const t = swf.tags[0];
  assert.equal(t.code, tags.DefineMorphShape2);

  const m = readMorphShape(swf.bytes, t.code, t.offset, t.length);
  assert.equal(m.id, 4);
  assert.deepEqual(m.endBounds, { xMin: 0, xMax: 800, yMin: 0, yMax: 400 });
  assert.deepEqual(m.endEdgeBounds, m.endBounds);
  assert.equal(m.truncated, false);
  const { start, end } = m.fills[0];
  assert.equal(start.type, "linear");
  assert.equal(end.type, "linear");
  if (start.type !== "linear" || end.type !== "linear") {
    return;
  }

  assert.deepEqual(start.gradient.stops, [
    { ratio: 0, color: 0xffff0000 },
    { ratio: 255, color: 0xff0000ff },
  ]);
  assert.deepEqual(end.gradient.stops, [
    { ratio: 10, color: 0x80ff0000 },
    { ratio: 200, color: 0xff00ff00 },
  ]);
  assert.equal(end.gradient.matrix.tx, 200);
  assert.deepEqual(
    m.lines.map((l) => [l.start.width, l.start.color, l.end.width, l.end.color]),
    [[20, 0xff000000, 60, 0xffffffff]],
  );
  assert.deepEqual(m.start, [
    { type: "style", moveTo: { x: 0, y: 0 }, fill0: 1, fill1: 0, line: 1, styles: null },
    { type: "line", dx: 400, dy: 0 },
    { type: "line", dx: 0, dy: 400 },
    { type: "line", dx: -400, dy: -400 },
  ]);
  assert.deepEqual(m.end, [
    { type: "style", moveTo: { x: 0, y: 100 }, fill0: null, fill1: null, line: null, styles: null },
    { type: "curve", cx: 400, cy: -100, ax: 400, ay: 100 },
    { type: "line", dx: 0, dy: 300 },
    { type: "line", dx: -800, dy: -300 },
  ]);
});

/** A DefineMorphShape of one solid fill from bounds, offset and the bytes after the offset field. */
function morphTag(offset: number, rest: Uint8Array): Uint8Array {
  const w8 = new w.BitWriter();
  w8.u16(1);
  w.rect(w8, 0, 400, 0, 400);
  w.rect(w8, 0, 400, 0, 400);
  w8.u32(offset).raw(rest);
  return w.tag(tags.DefineMorphShape, w8.done(), true);
}

/**
 * Records of one fill's square from (0, 0), with or without the end record;
 * `moveBits` sets where the last byte's padding starts.
 */
function squareRecords(fillBits: number, closed: boolean, moveBits = 1): Uint8Array {
  const r = new w.BitWriter();
  r.ub(4, fillBits).ub(4, 0);
  // A style change: move to (0, 0) and, with fill bits, fill0 1.
  r.ub(1, 0)
    .ub(5, fillBits ? 3 : 1)
    .ub(5, moveBits)
    .sb(moveBits, 0)
    .sb(moveBits, 0);
  if (fillBits) {
    r.ub(fillBits, 1);
  }

  for (const [dx, dy] of [
    [400, 0],
    [0, 400],
    [-400, 0],
    [0, -400],
  ]) {
    r.ub(1, 1).ub(1, 1).ub(4, 8).ub(1, 1).sb(10, dx).sb(10, dy);
  }

  if (closed) {
    r.ub(1, 0).ub(5, 0);
  }

  return r.done();
}

const styles = new w.BitWriter().u8(1).u8(0).u32(0xff0000ff).u32(0xff00ff00).u8(0).done();

function readMorph(tag: Uint8Array) {
  const swf = readSwf(w.swf({ width: 20, height: 20, frameRate: 12, frameCount: 1, tags: [tag] }));
  return readMorphShape(swf.bytes, swf.tags[0].code, swf.tags[0].offset, swf.tags[0].length);
}

test("a morph's start records stop at the end's offset, though they lack their end record", () => {
  // Four bits of padding, then the end's header of 8 fill bits: read on,
  // they make a fill0 change, not an end record.
  const start = squareRecords(1, false, 2);
  const end = squareRecords(8, true);
  const m = readMorph(
    morphTag(styles.length + start.length, new Uint8Array([...styles, ...start, ...end])),
  );
  assert.equal(m.start.length, 5);
  assert.equal(m.end.length, 5);
});

test("an offset back among a morph's styles is not followed: the end's records come after the start's", () => {
  const m = readMorph(
    morphTag(1, new Uint8Array([...styles, ...squareRecords(1, true), ...squareRecords(0, true)])),
  );
  assert.equal(m.start.length, 5);
  assert.equal(m.end.length, 5);
  assert.equal(m.truncated, false);
});

test("static text's records read as written, each setting only what its flags say", () => {
  const text = w.staticText({
    id: 7,
    version: 2,
    bounds: [0, 800, -400, 200],
    matrix: { tx: 100 },
    records: [
      {
        font: 3,
        height: 400,
        color: 0x80112233,
        x: 10,
        y: -20,
        glyphs: [
          [2, 300],
          [0, -40],
        ],
      },
      { y: 200, glyphs: [[5, 120]] },
    ],
  });
  const swf = readSwf(
    w.swf({ width: 100, height: 50, frameRate: 12, frameCount: 1, tags: [text] }),
  );
  const t = swf.tags[0];
  assert.equal(t.code, tags.DefineText2);

  const s = readStaticText(swf.bytes, t);
  assert.equal(s.id, 7);
  assert.equal(s.matrix.tx, 100);
  assert.deepEqual(s.records, [
    {
      font: 3,
      color: 0x80112233,
      x: 10,
      y: -20,
      height: 400,
      glyphs: [
        { index: 2, advance: 300 },
        { index: 0, advance: -40 },
      ],
    },
    {
      font: null,
      color: null,
      x: null,
      y: 200,
      height: null,
      glyphs: [{ index: 5, advance: 120 }],
    },
  ]);
});
