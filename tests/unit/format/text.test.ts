import assert from "node:assert/strict";
import test from "node:test";
import { readEditText, tags } from "../../../packages/format/dist/index.js";
import { BitWriter, rect } from "../../swf-writer.ts";

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
