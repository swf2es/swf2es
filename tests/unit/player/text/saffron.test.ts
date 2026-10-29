// What the renderer draws advanced text from (text/saffron.ts): glyphs'
// outlines, what a text asks of the shader and when it is drawn as normal
// text instead, the outline store's resets and lifetime, and its layout as
// the renderer's glyph program reads it.
import assert from "node:assert/strict";
import { test } from "node:test";
import { type Glyph, readFont, tags } from "../../../../packages/format/dist/index.js";
import {
  allowResets,
  chordsOf,
  ENTRIES,
  FIELD_BUDGET,
  GLYPH_MOST,
  GlyphQuads,
  holdSegments,
  MOST,
  ROW,
  resetSegments,
  STRIDE,
  segmentsUsed,
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
const TABLES = [TABLE, TABLE] as const;
const [box] = glyphs([{ char: "a", advance: 500, boxes: [[0, -700, 400, 0]] }]);
const builder = (scale = 1) => new GlyphQuads(0, 0, 0, scale);

/** A glyph of a curve: a box whose top is a quadratic `bend` units high, in DefineFont3's units. */
function curved(bend: number): Glyph {
  const [top] = glyphs([{ char: "c", advance: 500, boxes: [[0, -700, 400, 0]] }]);
  const records: Glyph["records"] = top.records.filter((r) => r.type === "style");
  // From the top left corner, clockwise: a curve to the top right, then down, left and up.
  records.push(
    { type: "curve", cx: 4000, cy: -bend, ax: 4000, ay: bend },
    { type: "line", dx: 0, dy: 14000 },
    { type: "line", dx: -8000, dy: 0 },
    { type: "line", dx: 0, dy: -14000 },
  );
  return { ...top, records };
}

test("a glyph of boxes is its edges, a curve its chords, fewer as the tolerance grows", () => {
  assert.equal(chordsOf(box, 1).length / 4, 4);

  const glyph = curved(4000);
  const fine = chordsOf(glyph, 1024 / 8192).length / 4 - 3;
  const coarse = chordsOf(glyph, 1024 / 2048).length / 4 - 3;
  assert.ok(fine > coarse && coarse >= 1, `${fine} chords fine, ${coarse} coarse`);
  // Each a nth of the curve, n the least whose chords stray by the tolerance at most.
  const bend = Math.hypot(0, 2 * 200) / 1;
  assert.equal(coarse, Math.ceil(Math.sqrt(bend / (4 * 0.5))));
});

test("a glyph of more segments than the shader may go through is drawn as normal text", () => {
  resetSegments();
  // A zigzag of more edges than that, closed.
  const [plain] = glyphs([{ char: "z", advance: 500, boxes: [[0, -700, 400, 0]] }]);
  const records: Glyph["records"] = plain.records.filter((r) => r.type === "style");
  for (let i = 0; i < GLYPH_MOST + 1000; i++) {
    records.push({ type: "line", dx: 1, dy: i % 2 ? 40 : -40 });
  }

  records.push({ type: "line", dx: -(GLYPH_MOST + 1000), dy: 0 });
  const many: Glyph = { ...plain, records };

  const b = builder();
  assert.equal(b.reserve(many, 20480, 20, TABLES), false);
  assert.equal(segmentsUsed(), 0);
  // Known: not cut again.
  assert.equal(b.reserve(many, 20480, 20, TABLES), false);
  assert.equal(segmentsUsed(), 0);
  assert.equal(b.reserve(box, 20480, 20, TABLES), true);
});

test("a field that would ask more of the shader than its budget is drawn as normal text", () => {
  // A box of 4 segments at 20 pixels, scaled up until its quad's pixels past the budget.
  assert.equal(builder(1).reserve(box, 20480, 20, TABLES), true);
  const side = Math.sqrt(FIELD_BUDGET / 4);
  assert.equal(builder(side / 10).reserve(box, 20480, 20, TABLES), false);

  // Or many glyphs together.
  const b = builder(4);
  let fits = 0;
  while (fits < 100000 && b.reserve(box, 20480, 20, TABLES)) {
    fits++;
  }
  assert.ok(fits > 10 && fits < 100000, `${fits} glyphs fit`);
});

test("tables take their places in the uniforms, coded as first entry plus 64 times their entries", () => {
  const b = builder();
  const other = [10, 0.5, -0.5];
  assert.equal(b.code(TABLE), 0 + 2 * 64);
  assert.equal(b.code(other), 2 + 1 * 64);
  assert.equal(b.code(TABLE), 0 + 2 * 64);
  // 48 entries at most.
  const big = Array.from({ length: 46 * 3 }, (_, i) => i);
  assert.equal(b.code(big), -1);
  assert.equal(b.code(big.slice(0, 45 * 3)), 3 + 45 * 64);
});

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
