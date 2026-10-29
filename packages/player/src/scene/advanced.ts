// Advanced anti-aliasing (Saffron) in the renderer: a text's glyphs as one
// geometry of quads (text/saffron.ts' GlyphQuads), which the backend's
// glyph program covers pixel by pixel from the glyphs' outlines. A field's quads lie
// in its own pixels, a StaticText's in its definition's, under its matrix.
// The view keeps each text's quads while what they were made of holds
// (AdvancedTexts).
import { IDENTITY, type Matrix } from "@swf2es/format";
import type { Geometries, GeometryData, GeometryHandle } from "@swf2es/render";
import type { DisplayObject } from "../display/displayobject.js";
import { type StaticTextObject, TextObject } from "../display/textobjects.js";
import { csmTables } from "../text/csm.js";
import { GUTTER, shownLines } from "../text/layout.js";
import {
  GlyphQuads,
  quadIndices,
  reserveAll,
  STRIDE,
  store as saffronStore,
} from "../text/saffron.js";

/** gridFitType's values, in the order the shader and CSMTextSettings number them. */
const GRIDS = ["none", "pixel", "subpixel"];

const NO_COLORS = new Uint32Array(0);

/**
 * A text's glyphs as Saffron draws them: the geometry of their quads, null
 * for none, and those of its glyphs, counted in the order its items have
 * them (scene/text.ts), drawn as normal text: those whose tables find no
 * room.
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

/** A text's glyph quads as Saffron draws them (AdvancedTexts.advancedText), and what they were made of. */
interface AdvancedText {
  source: unknown;
  scale: number;
  resets: number;
  scrollV: number;
  scrollH: number;
  left: number;
  top: number;
  height: number;
  grid: string;
  thickness: number;
  sharpness: number;
  glyphs: AdvancedGlyphs | null;
  handle: GeometryHandle | null;
}

/** Texts' glyph quads as the view draws them, made again only as what they were made of changes. */
export class AdvancedTexts {
  /** Each advanced text's glyph quads, and what they were made of (advancedText); BitmapData.draw's apart. */
  private readonly advancedTexts = new WeakMap<DisplayObject, AdvancedText>();
  private readonly drawnAdvanced = new WeakMap<DisplayObject, AdvancedText>();

  constructor(private readonly geometries: Geometries) {}

  /**
   * A text's glyphs as Saffron draws them, of its glyphs' quads made again
   * as its layout, scroll or place in its field, its settings, its scale
   * in Flash's pixels or the outlines' store change: their geometry, in the
   * field's pixels or the StaticText's definition's, and what places them
   * there in the text's space. Null where it cannot be drawn so, which is
   * kept too.
   */
  advancedText(
    o: TextObject | StaticTextObject,
    a: number,
    b: number,
    c: number,
    d: number,
    target: { scale: number; pixel: number },
    drawing: boolean,
  ): { handle: GeometryHandle | null; normal: number[]; m: Matrix } | null {
    const field = o instanceof TextObject ? o : null;
    const m = field ? IDENTITY : staticMatrix(o as StaticTextObject);
    // Flash's pixels a pixel of the text: the target's pixels a stage pixel over a pixel of Flash's.
    // Kept in steps of a square root of two, the step down: the quads reach out as far as at the
    // scale itself or further, and their cost counts as at most twice less, so that a text that
    // grows or shrinks makes its quads again only now and then.
    const exact =
      Math.sqrt(Math.abs((a * d - b * c) * (m.a * m.d - m.b * m.c))) *
      (target.scale / target.pixel);
    const scale =
      exact > 0 && Number.isFinite(exact) ? Math.SQRT2 ** Math.floor(Math.log2(exact) * 2) : 1;
    const source = field ? field.layout : (o as StaticTextObject).glyphs;
    // The stage's and BitmapData.draw's apart, as they draw it at scales of their own.
    const texts = drawing ? this.drawnAdvanced : this.advancedTexts;
    let kept = texts.get(o);
    if (
      kept &&
      kept.source === source &&
      kept.scale === scale &&
      kept.resets === saffronStore.resets &&
      (!field ||
        (kept.scrollV === field.scrollV &&
          kept.scrollH === field.scrollH &&
          kept.left === field.left &&
          kept.top === field.top &&
          kept.height === field.height &&
          kept.grid === field.gridFitType &&
          kept.thickness === field.thickness &&
          kept.sharpness === field.sharpness)) &&
      (!kept.handle || this.geometries.alive(kept.handle))
    ) {
      return kept.glyphs ? { handle: kept.handle, normal: kept.glyphs.normal, m } : null;
    }

    if (kept?.handle && this.geometries.alive(kept.handle)) {
      this.geometries.remove(kept.handle.id);
    }

    const glyphs = field ? fieldQuads(field, scale) : staticQuads(o as StaticTextObject, scale);
    kept = {
      source,
      scale,
      resets: saffronStore.resets,
      scrollV: field?.scrollV ?? 0,
      scrollH: field?.scrollH ?? 0,
      left: field?.left ?? 0,
      top: field?.top ?? 0,
      height: field?.height ?? 0,
      grid: field?.gridFitType ?? "",
      thickness: field?.thickness ?? 0,
      sharpness: field?.sharpness ?? 0,
      glyphs,
      handle: glyphs?.geometry ? this.geometries.add(glyphs.geometry) : null,
    };
    texts.set(o, kept);
    return glyphs ? { handle: kept.handle, normal: glyphs.normal, m } : null;
  }
}

/** A StaticText's matrix, from its definition's space to its own pixels. */
function staticMatrix(o: StaticTextObject): Matrix {
  const m = o.definition.definition.matrix;
  return { a: m.a, b: m.b, c: m.c, d: m.d, tx: m.tx / 20, ty: m.ty / 20 };
}
