// Static text's glyphs placed, and its text as StaticText.text reads it.
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFont, readStaticText, readSwf } from "../../../../packages/format/dist/index.js";
import type {
  Character,
  StaticTextCharacter,
} from "../../../../packages/player/dist/display/timeline.js";
import { placeGlyphs } from "../../../../packages/player/dist/text/static.js";
import { probeFont } from "../../../player/cases.ts";
import * as w from "../../../swf-writer.ts";

/** The text's character, and the SWF's characters with Probe, whose glyphs are " ", "W", "a", "b", "c". */
function read(records: w.TextRecordSpec[]): [StaticTextCharacter, Map<number, Character>] {
  const swf = readSwf(
    w.swf({
      width: 100,
      height: 50,
      frameRate: 12,
      frameCount: 1,
      tags: [w.staticText({ id: 1, bounds: [0, 100, 0, 100], records }), probeFont(5)],
    }),
  );
  const definition = readStaticText(swf.bytes, swf.tags[0]);
  const font = readFont(swf.bytes, swf.tags[1]);
  const characters = new Map<number, Character>([
    [5, { type: "font", id: 5, name: font.name, bold: false, italic: false, font }],
  ]);
  return [{ type: "static", id: 1, definition }, characters];
}

test("a record keeps the font, height, colour and pen of the one before, and advances the pen", () => {
  const [text, characters] = read([
    {
      font: 5,
      height: 400,
      color: 0x0000cc,
      x: 10,
      y: 20,
      glyphs: [
        [2, 300],
        [3, 100],
      ],
    },
    { y: 600, glyphs: [[1, 50]] },
  ]);
  const { glyphs, text: chars } = placeGlyphs(text, characters);
  assert.equal(chars, "ab\nW");
  assert.deepEqual(
    glyphs.map((g) => [String.fromCharCode(g.glyph.code), g.x, g.y, g.height, g.color]),
    [
      ["a", 10, 20, 400, 0xff0000cc],
      ["b", 310, 20, 400, 0xff0000cc],
      ["W", 410, 600, 400, 0xff0000cc],
    ],
  );
});

test("its text is null where a glyph has no font or one the SWF lacks, or where there are none", () => {
  const text = (records: w.TextRecordSpec[]) => placeGlyphs(...read(records)).text;
  assert.equal(text([{ glyphs: [[2, 0]] }, { font: 5, height: 100, glyphs: [[3, 0]] }]), null);
  assert.equal(text([{ font: 9, height: 100, glyphs: [[2, 0]] }]), null);
  assert.equal(text([{ font: 5, height: 100, glyphs: [] }]), null);
  assert.equal(
    text([
      {
        font: 5,
        height: 0,
        glyphs: [
          [4, 0],
          [0, 0],
        ],
      },
    ]),
    "c ",
  );

  const [, characters] = read([]);
  const missing = read([
    { font: 9, height: 100, glyphs: [[2, 0]] },
    { font: 5, glyphs: [[3, 0]] },
  ]);
  assert.deepEqual(
    placeGlyphs(missing[0], characters).glyphs.map((g) => String.fromCharCode(g.glyph.code)),
    ["b"],
  );
});

test("a record on the same line adds no line feed; one on another line does, by the rule adl showed going down", () => {
  const text = (records: w.TextRecordSpec[]) => placeGlyphs(...read(records)).text;
  assert.equal(
    text([
      { font: 5, height: 100, y: 0, glyphs: [[2, 50]] },
      { x: 400, glyphs: [[3, 0]] },
    ]),
    "ab",
  );
  assert.equal(
    text([
      { font: 5, height: 100, y: 0, glyphs: [[2, 0]] },
      { y: 600, glyphs: [] },
      { y: 1200, glyphs: [[3, 0]] },
      { y: 0, glyphs: [[4, 0]] },
    ]),
    "a\nb\nc",
  );
});

test("a text that sets no colour is transparent, and a glyph past its font moves no pen", () => {
  const { glyphs, text } = placeGlyphs(
    ...read([
      {
        font: 5,
        height: 400,
        glyphs: [
          [2, 300],
          [40, 600],
          [3, 0],
        ],
      },
    ]),
  );
  assert.equal(text, null);
  assert.deepEqual(
    glyphs.map((g) => [String.fromCharCode(g.glyph.code), g.x, g.color]),
    [
      ["a", 0, 0],
      ["b", 300, 0],
    ],
  );
});
