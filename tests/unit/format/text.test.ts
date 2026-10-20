import assert from "node:assert/strict";
import test from "node:test";
import {
  glyphOf,
  readCsmTextSettings,
  readEditText,
  readFont,
  readFont4,
  readFontAlignZones,
  readFontInfo,
  readTags,
  tags,
} from "../../../packages/format/dist/index.js";
import { BitWriter, font1, font3, fontAlignZones, fontInfo, rect } from "../../swf-writer.ts";

test("DefineFont infers its glyph count from the first offset and reads 1024-unit outlines", () => {
  const bytes = font1(7, [
    { char: "b", advance: 0, boxes: [[50, -700, 600, 0]] },
    { char: "a", advance: 0, boxes: [] },
  ]);
  const font = readFont(bytes, readTags(bytes, 0, bytes.length).tags[0]);
  assert.equal(font.id, 7);
  assert.equal(font.em, 1024);
  assert.equal(font.layout, false);
  assert.equal(font.glyphs.length, 2);
  assert.equal(font.glyphs[0].records.length, 0);
  assert.deepEqual(font.glyphs[1].records, [
    { type: "style", moveTo: { x: 50, y: -700 }, fill0: 1, fill1: null, line: null, styles: null },
    { type: "line", dx: 550, dy: 0 },
    { type: "line", dx: 0, dy: 700 },
    { type: "line", dx: -550, dy: 0 },
    { type: "line", dx: 0, dy: -700 },
  ]);
  assert.equal(font.name, "");
  assert.deepEqual(
    font.glyphs.map((g) => [g.code, g.advance, g.bounds]),
    [
      [-1, 0, null],
      [-1, 0, null],
    ],
  );
});

test("DefineFont keeps malformed offset tables and glyphs within their tag", () => {
  const read = (body: number[], length = body.length) =>
    readFont(new Uint8Array([...body, 0xff, 0xff]), {
      code: tags.DefineFont,
      offset: 0,
      length,
      long: false,
    });
  for (const body of [
    [7, 0],
    [7, 0, 0xff, 0xff],
    [7, 0, 3, 0, 0],
  ]) {
    assert.equal(read(body).glyphs.length, 0);
  }

  assert.equal(read([7, 0, 4, 0, 4, 0], 5).glyphs.length, 0);
  assert.equal(read([7, 0, 4, 0, 3, 0]).glyphs.length, 0);
  assert.equal(read([7, 0, 4, 0, 99, 0]).glyphs.length, 0);
  assert.deepEqual(read([7, 0, 2, 0, 0x10]).glyphs[0].records, []);
});

test("legacy font info reads narrow and wide codes, style flags, UTF-8 names and the language byte", () => {
  for (const version of [1, 2] as const) {
    for (const wide of [false, true]) {
      const codes = wide || version === 2 ? [65, 0x3a9] : [65, 90];
      const bytes = fontInfo(7, "Épreuve", codes, { version, wide, bold: true, italic: true });
      const tag = readTags(bytes, 0, bytes.length).tags[0];
      assert.deepEqual(readFontInfo(bytes, tag), {
        id: 7,
        name: "Épreuve",
        bold: true,
        italic: true,
        codes,
      });
      const cut = { ...tag, length: tag.length - 1 };
      assert.deepEqual(readFontInfo(bytes, cut).codes, [65]);
    }
  }
});

test("DefineEditText reads conditional fields before the variable and initial text", () => {
  const w = new BitWriter().u16(17);
  rect(w, 20, 2020, 40, 440);
  w.u8(0x87).u8(0xa2); // text, color, max length, font, font class, layout, HTML
  w.u16(13).string("ui.Font").u16(240);
  w.u32(0x80402010).u16(32);
  w.u8(2).u16(10).u16(20).u16(30).u16(0xfffe);
  w.string("caption").string("Loading");
  const bytes = w.done();
  const edit = readEditText(bytes, {
    code: tags.DefineEditText,
    offset: 0,
    length: bytes.length,
    long: false,
  });

  assert.equal(edit.id, 17);
  assert.deepEqual(edit.bounds, { xMin: 20, xMax: 2020, yMin: 40, yMax: 440 });
  assert.equal(edit.fontId, 13);
  assert.equal(edit.fontClass, "ui.Font");
  assert.equal(edit.fontHeight, 240);
  assert.equal(edit.color, 0x80402010);
  assert.equal(edit.maxLength, 32);
  assert.equal(edit.align, 2);
  assert.equal(edit.leading, -2);
  assert.equal(edit.variable, "caption");
  assert.equal(edit.text, "Loading");
  assert.equal(edit.html, true);
});

test("DefineEditText without initial text still reads its variable", () => {
  const w = new BitWriter().u16(9);
  rect(w, 0, 1000, 0, 200);
  w.u8(0).u8(0).string("status");
  const bytes = w.done();
  const edit = readEditText(bytes, {
    code: tags.DefineEditText,
    offset: 0,
    length: bytes.length,
    long: false,
  });

  assert.equal(edit.variable, "status");
  assert.equal(edit.text, "");
  assert.equal(edit.fontHeight, null);
});

test("DefineFont3 reads its glyphs in code order, their outlines, and the layout", () => {
  const tag = font3({
    id: 4,
    name: "Probe",
    bold: true,
    ascent: 800,
    descent: 200,
    leading: 100,
    glyphs: [
      { char: "b", advance: 700, boxes: [[50, -750, 650, 0]] },
      { char: "a", advance: 500, boxes: [[50, -500, 450, 0]] },
      { char: " ", advance: 250, boxes: [] },
    ],
    kerning: [["a", "b", -100]],
  });
  // The tag's header: a long one, code 75.
  const font = readFont(tag, {
    code: tags.DefineFont3,
    offset: 6,
    length: tag.length - 6,
    long: true,
  });
  assert.deepEqual(
    [font.id, font.name, font.bold, font.italic, font.em],
    [4, "Probe", true, false, 20480],
  );
  assert.deepEqual(
    font.glyphs.map((g) => [String.fromCharCode(g.code), g.advance]),
    [
      [" ", 5000],
      ["a", 10000],
      ["b", 14000],
    ],
  );
  assert.deepEqual(
    [font.layout, font.ascent, font.descent, font.leading],
    [true, 16000, 4000, 2000],
  );
  assert.equal(font.kerning.get((97 << 16) | 98), -2000);
  assert.deepEqual(font.glyphs[1].bounds, { xMin: 1000, xMax: 9000, yMin: -10000, yMax: 0 });
  // A rectangle: a move and four edges.
  assert.deepEqual(
    font.glyphs[1].records.map((r) => r.type),
    ["style", "line", "line", "line", "line"],
  );
  assert.equal(font.glyphs[0].records.length, 0);
  assert.equal(glyphOf(font, 98)?.advance, 14000);
  assert.equal(glyphOf(font, 99), null);
});

test("DefineFont4 reads its style and optional CFF bytes", () => {
  const embedded = new BitWriter()
    .u16(7)
    .u8(7)
    .string("CFF")
    .raw(new Uint8Array([1, 2, 3]))
    .done();
  const surrounded = new Uint8Array([0xff, ...embedded, 0xff]);
  const named = new BitWriter().u16(8).u8(3).string("Named CFF").done();

  assert.deepEqual(
    readFont4(surrounded, {
      code: tags.DefineFont4,
      offset: 1,
      length: embedded.length,
      long: false,
    }),
    {
      id: 7,
      name: "CFF",
      bold: true,
      italic: true,
      data: new Uint8Array([1, 2, 3]),
    },
  );
  assert.deepEqual(
    readFont4(named, { code: tags.DefineFont4, offset: 0, length: named.length, long: false }),
    {
      id: 8,
      name: "Named CFF",
      bold: true,
      italic: true,
      data: null,
    },
  );
});

test("DefineFontAlignZones gives its font and CSM hint", () => {
  // A long header: two bytes of code and length, four of length.
  const bytes = fontAlignZones(7, 2, 3);
  const zones = readFontAlignZones(bytes, {
    code: tags.DefineFontAlignZones,
    offset: 6,
    length: bytes.length - 6,
    long: true,
  });
  assert.deepEqual(zones, { id: 7, csmHint: 2 });
});

test("CSMTextSettings reads its flags and its little-endian floats", () => {
  const bytes = new Uint8Array(12);
  const view = new DataView(bytes.buffer);
  view.setUint16(0, 9, true);
  // Advanced (01), gridFit subpixel (010), reserved.
  bytes[2] = 0b01_010_000;
  view.setFloat32(3, -150, true);
  view.setFloat32(7, 250.5, true);
  const tag = { code: tags.CSMTextSettings, offset: 0, length: 12, long: false };
  assert.deepEqual(readCsmTextSettings(bytes, tag), {
    id: 9,
    useFlashType: true,
    gridFit: 2,
    thickness: -150,
    sharpness: 250.5,
  });
  bytes[2] = 0b00_001_000;
  assert.equal(readCsmTextSettings(bytes, tag).useFlashType, false);
  assert.equal(readCsmTextSettings(bytes, tag).gridFit, 1);
});
