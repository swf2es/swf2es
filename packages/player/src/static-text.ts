// Static text (DefineText): its records' glyphs placed where the authoring
// tool put them, in the fonts of the SWF that defines it. A font is found
// when the text is shown, as Flash finds it: a SWF may define it after the
// text that uses it (the corpus's statictext_text).
import type { Font, Glyph } from "@swf2es/format";
import type { Character, StaticTextCharacter } from "./timeline.js";

/** A glyph of static text: its font and glyph, its baseline origin and height in twips, its colour 0xAARRGGBB. */
export interface PlacedGlyph {
  font: Font;
  glyph: Glyph;
  x: number;
  y: number;
  height: number;
  color: number;
}

/**
 * The text's glyphs as placed, each record keeping what the one before set,
 * black and at the origin until one sets it; a glyph of a font the SWF
 * lacks, or of none, is not drawn. `text` is the glyphs' characters, null
 * where one has no font or there are none, as StaticText.text reads.
 */
export function placeGlyphs(
  character: StaticTextCharacter,
  characters: Map<number, Character>,
): { glyphs: PlacedGlyph[]; text: string | null } {
  const glyphs: PlacedGlyph[] = [];
  const codes: number[] = [];
  let unknown = false;
  let font: Font | null = null;
  let color = 0xff000000;
  let height = 0;
  let x = 0;
  let y = 0;
  for (const record of character.definition.records) {
    if (record.font !== null) {
      const c = characters.get(record.font);
      font = c?.type === "font" ? c.font : null;
      height = record.height ?? height;
    }

    color = record.color ?? color;
    x = record.x ?? x;
    y = record.y ?? y;
    for (const { index, advance } of record.glyphs) {
      const glyph = font?.glyphs[index];
      if (font && glyph) {
        glyphs.push({ font, glyph, x, y, height, color });
        codes.push(glyph.code);
      } else {
        unknown = true;
      }

      x += advance;
    }
  }

  const text = unknown || codes.length === 0 ? null : String.fromCharCode(...codes);
  return { glyphs, text };
}
