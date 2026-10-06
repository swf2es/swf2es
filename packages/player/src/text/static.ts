// Static text (DefineText): its records' glyphs placed where the authoring
// tool put them, in the fonts of the SWF that defines it. A font is found
// when the text is shown, as Flash finds it: a SWF may define it after the
// text that uses it (the corpus's statictext_text).
import type { Font, Glyph } from "@swf2es/format";
import { flatten, inside, type Path, shapeLayers } from "../display/shapes.js";
import type { Character, StaticTextCharacter } from "../display/timeline.js";

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
 * transparent and at the origin until one sets it, as adl draws a text that
 * sets no colour as nothing. A glyph of a font the SWF lacks, of none, or
 * past its font's glyphs, is not drawn and does not move the pen. `text` is
 * the glyphs' characters, a line feed before a record's first where its
 * line is not the last glyph's, as adl reads it; null where a glyph has no
 * font, or there are none. (adl reads a glyph past its font as some other
 * character; the player reads the text as null.)
 */
export function placeGlyphs(
  character: StaticTextCharacter,
  characters: Map<number, Character>,
): { glyphs: PlacedGlyph[]; text: string | null } {
  const glyphs: PlacedGlyph[] = [];
  const chars: string[] = [];
  let unknown = false;
  let font: Font | null = null;
  let color = 0;
  let height = 0;
  let x = 0;
  let y = 0;
  let lineY: number | null = null;
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
      if (!font || !glyph) {
        unknown = true;
        continue;
      }

      if (lineY !== null && lineY !== y) {
        chars.push("\n");
      }

      lineY = y;
      glyphs.push({ font, glyph, x, y, height, color });
      chars.push(String.fromCharCode(glyph.code));
      x += advance;
    }
  }

  const text = unknown || glyphs.length === 0 ? null : chars.join("");
  return { glyphs, text };
}

/** A glyph's outline as contours, in the font's units over 20, as shapeLayers reads twips; cached. */
const outlines = new WeakMap<Glyph, Path[]>();

function outlineOf(glyph: Glyph): Path[] {
  let contours = outlines.get(glyph);
  if (!contours) {
    const shape = {
      id: 0,
      bounds: { xMin: 0, xMax: 0, yMin: 0, yMax: 0 },
      edgeBounds: null,
      fills: [{ type: "solid" as const, color: 0xffffffff }],
      lines: [],
      records: glyph.records,
      truncated: false,
    };
    contours = shapeLayers(shape).flatMap((layer) => layer.fills.flatMap((f) => f.contours));
    outlines.set(glyph, contours);
  }

  return contours;
}

/**
 * Whether the point (x, y), in the text's own pixels, is on one of its
 * glyphs: Flash hits static text by its glyphs' outlines, not its bounds,
 * and a glyph it draws transparent not at all, but as a mask, which clips
 * by its fills whatever their colour.
 */
export function hitsGlyph(
  character: StaticTextCharacter,
  glyphs: PlacedGlyph[],
  x: number,
  y: number,
  mask = false,
): boolean {
  const m = character.definition.matrix;
  const det = m.a * m.d - m.b * m.c;
  if (det === 0) {
    return false;
  }

  // Into the text's space, in twips, through the inverse of its matrix.
  const px = x * 20 - m.tx;
  const py = y * 20 - m.ty;
  const tx = (m.d * px - m.c * py) / det;
  const ty = (m.a * py - m.b * px) / det;
  for (const g of glyphs) {
    if ((!mask && g.color >>> 24 === 0) || g.height === 0) {
      continue;
    }

    // Into the glyph's outline: the font's units, over 20.
    const scale = g.height / g.font.em;
    const gx = (tx - g.x) / scale / 20;
    const gy = (ty - g.y) / scale / 20;
    let crossings = 0;
    for (const contour of outlineOf(g.glyph)) {
      if (inside(flatten(contour), gx, gy)) {
        crossings++;
      }
    }

    if (crossings % 2) {
      return true;
    }
  }

  return false;
}
