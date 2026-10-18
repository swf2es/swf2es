// Advanced text's layout: the pen in fractions of a twip, truncated only
// where a character lands. The numbers are adl's, for the font of bars
// the player case text-advanced draws (tests/player/cases.ts).
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFont, tags } from "../../../../packages/format/dist/index.js";
import { TextObject } from "../../../../packages/player/dist/display/display.js";
import { FontSet } from "../../../../packages/player/dist/text/fonts.js";
import { stemFont } from "../../../player/cases.ts";

function field(antiAliasType: string, gridFitType: string, size: number, text: string): TextObject {
  const bytes = stemFont(1);
  const fonts = new FontSet();
  fonts.add(
    readFont(bytes, { code: tags.DefineFont3, offset: 6, length: bytes.length - 6, long: true }),
  );
  const o = new TextObject(null);
  o.fonts = fonts;
  o.embedFonts = true;
  o.antiAliasType = antiAliasType;
  o.gridFitType = gridFitType;
  o.model.defaultFormat = { ...o.model.defaultFormat, font: "Stem", size };
  o.model.setText(text);
  return o;
}

/** Each character's advance, as getCharBoundaries gives its width, in twips. */
const widths = (o: TextObject) => o.layout.lines[0].chars.map((c) => c.advance);

// adl's getCharBoundaries widths and textWidth of "lmalmaW 1ll2".
const ADL: Record<string, [number[], number]> = {
  "normal 10": [[44, 175, 104, 44, 175, 104, 195, 48, 58, 44, 44, 58], 1093],
  "normal 12": [[53, 210, 125, 53, 210, 125, 234, 58, 70, 53, 53, 70], 1314],
  "normal 14": [[62, 246, 146, 62, 246, 146, 273, 68, 82, 62, 62, 82], 1537],
  "normal 20": [[89, 351, 209, 89, 351, 209, 390, 97, 117, 89, 89, 117], 2197],
  "normal 24": [[107, 421, 251, 107, 421, 251, 468, 117, 140, 107, 107, 140], 2637],
  "advanced 10": [[44, 176, 105, 45, 176, 105, 195, 49, 58, 45, 45, 59], 1102],
  "advanced 12": [[53, 211, 126, 54, 211, 126, 234, 59, 70, 54, 54, 70], 1322],
  "advanced 14": [[62, 246, 147, 63, 246, 147, 274, 68, 82, 63, 63, 82], 1543],
  "advanced 20": [[89, 352, 210, 90, 351, 210, 390, 98, 117, 90, 90, 117], 2204],
  "advanced 24": [[107, 422, 252, 108, 422, 251, 469, 117, 141, 108, 108, 140], 2645],
};

test("normal text truncates each advance to twips, advanced text only where each character lands", () => {
  for (const [key, [expected, width]] of Object.entries(ADL)) {
    const [aa, size] = key.split(" ");
    for (const fit of aa === "normal" ? ["pixel"] : ["none", "pixel", "subpixel"]) {
      const o = field(aa, fit, Number(size), "lmalmaW 1ll2");
      assert.deepEqual(widths(o), expected, `${key} ${fit}`);
      assert.equal(o.layout.width, width, `${key} ${fit}`);
    }
  }
});

test("advanced text wraps by where its characters land", () => {
  const text = "lma 1lm 2am3 lll4 mm5 al6 lmaml 13 am2m lamla m4m5 6lam l2l3 malm";
  // adl: two lines either way, 170.9 and 172.1 pixels at the widest.
  for (const [aa, width] of [
    ["normal", 3418],
    ["advanced", 3442],
  ] as const) {
    const o = field(aa, "pixel", 12, text);
    o.wordWrap = true;
    o.width = 196;
    assert.equal(o.layout.lines.length, 2, aa);
    assert.equal(o.layout.width, width, aa);
  }
});

test("antiAliasType lays a field's text out again", () => {
  const o = field("normal", "pixel", 10, "llllllll");
  assert.equal(o.layout.width, 8 * 44);
  o.antiAliasType = "advanced";
  // 230 of 1024 at 10 pixels, 44.92 twips each: the eighth lands at 359.
  assert.equal(o.layout.width, 359);
});

/** A field of `text` in the given format changes, set before the text. */
function formatted(aa: string, size: number, text: string, format: object): TextObject {
  const o = field(aa, "none", size, "");
  o.model.defaultFormat = { ...o.model.defaultFormat, ...format };
  o.model.setText(text);
  return o;
}

test("advanced text's letter spacing lands where adl puts it", () => {
  const spaced = (aa: string, spacing: number) =>
    widths(formatted(aa, 12, "lmalmaW 1ll2", { letterSpacing: spacing }));
  assert.deepEqual(spaced("normal", 0.3), [59, 216, 131, 59, 216, 131, 240, 64, 76, 59, 59, 76]);
  assert.deepEqual(spaced("advanced", 0.3), [59, 217, 132, 60, 217, 132, 240, 65, 76, 60, 60, 76]);
  assert.deepEqual(spaced("advanced", -0.6), [41, 199, 114, 42, 199, 114, 222, 47, 58, 42, 42, 58]);
});

test("a kerned advance is summed with its pair's adjustment in the font's units, then truncated", () => {
  // "a" then "l" kern by -77 units: 230 - 77 at 11 pixels is 32 twips, not 49 - 16.
  const kerned = (aa: string, size: number) =>
    widths(formatted(aa, size, "lmal", { kerning: true }));
  assert.deepEqual(kerned("normal", 11), [49, 193, 115, 32]);
  assert.deepEqual(kerned("advanced", 11), [49, 193, 116, 33]);
  assert.deepEqual(kerned("advanced", 22), [98, 387, 231, 66]);
});

test("a run of another size starts where the last one's text landed", () => {
  const html = "<font size='10'>lma</font><font size='13'>lma</font><font size='17'>lmW</font>";
  for (const [aa, expected, width] of [
    ["normal", [44, 175, 104, 58, 228, 136, 76, 298, 332], 1451],
    ["advanced", [44, 176, 105, 58, 228, 137, 76, 299, 332], 1455],
  ] as const) {
    const o = field(aa, "none", 12, "");
    o.model.setHtml(html, false);
    assert.deepEqual(widths(o), expected, aa);
    assert.equal(o.layout.width, width, aa);
  }
});

test("a pen a negative spacing takes left of 0 lands at 0, not -0", () => {
  // 44.92 twips less 45 a character: the first lands at -0.08.
  const o = formatted("advanced", 10, "ll", { letterSpacing: -2.27 });
  for (const c of o.layout.lines[0].chars) {
    assert.ok(!Object.is(c.x, -0) && !Object.is(c.advance, -0));
  }
});
