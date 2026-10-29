// What both views draw advanced text from (text/saffron.ts): the outline
// store's resets and lifetime, and its layout as the renderer of swf2es's
// own reads it.
import assert from "node:assert/strict";
import { test } from "node:test";
import { type Glyph, readFont, tags } from "../../../../packages/format/dist/index.js";
import {
  allowResets,
  ENTRIES,
  GlyphQuads,
  holdSegments,
  MOST,
  ROW,
  resetSegments,
  STRIDE,
  store,
} from "../../../../packages/player/dist/text/saffron.js";
import { GLYPH_FLOATS } from "../../../../packages/render/dist/index.js";
import { OUTLINE_ROW, TABLE_ENTRIES } from "../../../../packages/render/dist/webgl/programs.js";
import { font3 } from "../../../swf-writer.ts";

/** A DefineFont3 of the given glyphs, read back. */
function glyphs(spec: Parameters<typeof font3>[0]["glyphs"]): Glyph[] {
  const bytes = font3({ id: 1, name: "T", ascent: 900, descent: 250, glyphs: spec });
  return readFont(bytes, {
    code: tags.DefineFont3,
    offset: 6,
    length: bytes.length - 6,
    long: true,
  }).glyphs;
}

const TABLE = [8, 0.1, -0.8, 27, 0.35, -0.85];

test("the store's layout is the one the renderer's glyph program reads", () => {
  assert.equal(STRIDE, GLYPH_FLOATS);
  assert.equal(ENTRIES, TABLE_ENTRIES);
  assert.equal(ROW, OUTLINE_ROW);
});

test("a full store starts again as a glyph is reserved, unless resets are held off", () => {
  const [box] = glyphs([{ char: "a", advance: 500, boxes: [[0, -700, 400, 0]] }]);
  resetSegments();
  // Full, as far as reserving is concerned: no room for another outline.
  store.used = MOST;
  allowResets(false);
  try {
    const resets = store.resets;
    assert.equal(new GlyphQuads(0, 0, 0, 1).reserve(box, 20480, 12, [TABLE, TABLE]), false);
    assert.equal(store.resets, resets);
  } finally {
    allowResets(true);
  }

  const resets = store.resets;
  assert.equal(new GlyphQuads(0, 0, 0, 1).reserve(box, 20480, 12, [TABLE, TABLE]), true);
  assert.equal(store.resets, resets + 1);
  assert.ok(store.used > 0 && store.used < MOST);
});

test("the store grows without a reset, and goes back to its first size with its last holder", () => {
  resetSegments();
  const first = store.data.length;
  const release = holdSegments();
  const other = holdSegments();
  const [box] = glyphs([{ char: "a", advance: 500, boxes: [[0, -700, 400, 0]] }]);
  // Most of the store's first size used, so that the next outline grows it.
  store.used = first / 4 - 2;
  const resets = store.resets;
  const epoch = store.epoch;
  assert.equal(new GlyphQuads(0, 0, 0, 1).reserve(box, 20480, 12, [TABLE, TABLE]), true);
  assert.ok(store.data.length > first);
  assert.equal(store.resets, resets);
  assert.ok(store.epoch > epoch);

  release();
  release();
  assert.ok(store.data.length > first);
  other();
  assert.equal(store.data.length, first);
  assert.equal(store.used, 0);
});
