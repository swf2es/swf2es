// Advanced anti-aliasing (Saffron) in the renderer of swf2es's own: a
// text's glyphs as one geometry of quads (text/saffron.ts' GlyphQuads),
// which the backend's glyph program covers pixel by pixel from the glyphs'
// outlines, as the Pixi view's render/saffron.ts does. A field's quads lie
// in its own pixels, a StaticText's in its definition's, under its matrix.
import type { GeometryData } from "@swf2es/render";
import type { StaticTextObject, TextObject } from "../display/display.js";
import { csmTables } from "../text/csm.js";
import { GUTTER, shownLines } from "../text/layout.js";
import { GlyphQuads, quadIndices, reserveAll, STRIDE } from "../text/saffron.js";

/** gridFitType's values, in the order the shader and CSMTextSettings number them. */
const GRIDS = ["none", "pixel", "subpixel"];

const NO_COLORS = new Uint32Array(0);

/**
 * A text's glyphs as Saffron draws them: the geometry of their quads, null
 * for none, and those of its glyphs, counted in the order its items have
 * them (scene/text.ts), drawn as normal text, as the Pixi view draws a glyph
 * whose tables find no room.
 */
export interface AdvancedGlyphs {
  geometry: GeometryData | null;
  normal: number[];
}

/**
 * A field's embedded glyphs as quads, at `scale` of Flash's pixels to a
 * pixel of the field, of the lines it shows, each where its pen stood in
 * fractions of a twip, as adl places it; null where they cannot be drawn
 * so, a glyph or the whole asking too much of the shader, for the field to
 * be drawn as normal text, all of it alike.
 */
export function fieldQuads(o: TextObject, scale: number): AdvancedGlyphs | null {
  const layout = o.layout;
  if (!o.model.text || layout.lines.length === 0) {
    return null;
  }

  const first = Math.min(Math.max(0, o.scrollV - 1), layout.lines.length - 1);
  // The lines that fit the field from there, one at least: adl draws no line part of the way.
  const last = first + shownLines(o, first) - 1;
  const dx = o.left * 20 - o.scrollH * 20;
  const dy = o.top * 20 - (layout.lines[first].y - GUTTER);
  const quads = reserveAll(
    new GlyphQuads(GRIDS.indexOf(o.gridFitType), o.thickness, o.sharpness, scale),
    (q) => {
      for (let l = first; l <= last; l++) {
        for (const c of layout.lines[l].chars) {
          if (
            c.shown &&
            c.font &&
            c.glyph &&
            !q.reserve(c.glyph, c.font.em, Math.max(0, c.format.size), csmTables(c.font))
          ) {
            return false;
          }
        }
      }

      return true;
    },
  );
  if (!quads) {
    return null;
  }

  const normal: number[] = [];
  let glyph = 0;

  for (let l = first; l <= last; l++) {
    const line = layout.lines[l];
    const baseline = (dy + line.y + line.ascent) / 20;
    for (const c of line.chars) {
      if (!c.shown || !c.font || !c.glyph) {
        continue;
      }

      if (
        !quads.add(
          c.glyph,
          c.font.em,
          (dx + c.at + c.kern) / 20,
          baseline,
          Math.max(0, c.format.size),
          c.format.color & 0xffffff,
          1,
          csmTables(c.font),
        )
      ) {
        normal.push(glyph);
      }

      glyph++;
    }
  }

  return { geometry: geometryOf(quads), normal };
}

/**
 * A StaticText's glyphs as quads in its definition's space, at `scale` of
 * Flash's pixels to a pixel of it there; null where they cannot be drawn so.
 */
export function staticQuads(o: StaticTextObject, scale: number): AdvancedGlyphs | null {
  const csm = o.definition.csm;
  if (!csm?.useFlashType) {
    return null;
  }

  const glyphs = o.glyphs.glyphs;
  const quads = reserveAll(new GlyphQuads(csm.gridFit, csm.thickness, csm.sharpness, scale), (q) =>
    glyphs.every((placed) =>
      q.reserve(placed.glyph, placed.font.em, placed.height / 20, csmTables(placed.font)),
    ),
  );
  if (!quads) {
    return null;
  }

  const normal: number[] = [];

  for (let i = 0; i < glyphs.length; i++) {
    const placed = glyphs[i];
    if (
      !quads.add(
        placed.glyph,
        placed.font.em,
        placed.x / 20,
        placed.y / 20,
        placed.height / 20,
        placed.color & 0xffffff,
        (placed.color >>> 24) / 255,
        csmTables(placed.font),
      )
    ) {
      normal.push(i);
    }
  }

  return { geometry: geometryOf(quads), normal };
}

/** The quads added as a geometry: their positions apart, for its bounds; null for none. */
function geometryOf(quads: GlyphQuads): GeometryData | null {
  const built = quads.built();
  if (!built) {
    return null;
  }

  const count = built.glyphs * 4;
  const positions = new Float32Array(count * 2);

  for (let k = 0; k < count; k++) {
    positions[k * 2] = built.vertices[k * STRIDE];
    positions[k * 2 + 1] = built.vertices[k * STRIDE + 1];
  }

  return {
    positions,
    colors: NO_COLORS,
    indices: quadIndices(built.glyphs),
    glyphs: { vertices: built.vertices, mode: built.mode, table: built.table },
  };
}
