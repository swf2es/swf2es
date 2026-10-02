// DefineFont2 and DefineFont3: a font's glyphs, the outlines a field that
// embeds it draws, and its layout, the advances, kerning, ascent and
// descent a field's text is laid out by.
import { readRecords, type ShapeRecord } from "./shape.js";
import { type Rect, SwfReader, type Tag } from "./swf.js";
import { DefineFont3 } from "./tags.js";
import { readFontName } from "./text.js";

export interface Glyph {
  /** The character, a UTF-16 code unit. */
  code: number;
  /** Its outline: shape records of one fill, in the font's units, y down from the baseline. */
  records: ShapeRecord[];
  /** The advance and bounds from the layout, in the font's units; 0 and null without one. */
  advance: number;
  bounds: Rect | null;
}

export interface Font {
  id: number;
  name: string;
  bold: boolean;
  italic: boolean;
  /** Units to the em: 1024 for DefineFont2, which is in twips, 20480 for DefineFont3. */
  em: number;
  /** In the order of the code table, which is by code. */
  glyphs: Glyph[];
  /** Whether the tag has a layout: without one a field cannot lay text out in it. */
  layout: boolean;
  ascent: number;
  descent: number;
  leading: number;
  /** Kerning adjustments by pair, `first << 16 | second`, in the font's units. */
  kerning: Map<number, number>;
}

/** DefineFont2 (48) or DefineFont3 (75), as far as the tag goes: a short one gives the glyphs it has. */
export function readFont(bytes: Uint8Array, tag: Tag): Font {
  const named = readFontName(bytes, tag);
  const r = new SwfReader(bytes, tag.offset, tag.offset + tag.length);
  r.u16();
  const flags = r.u8();
  r.u8();
  r.pos += 1 + r.u8();
  const hasLayout = (flags & 0x80) !== 0;
  const wideOffsets = (flags & 0x08) !== 0;
  const wideCodes = (flags & 0x04) !== 0;
  const count = r.u16();
  const table = r.pos;
  const offset = () => (wideOffsets ? r.u32() : r.u16());
  const offsets: number[] = [];
  for (let i = 0; i < count; i++) {
    offsets.push(offset());
  }

  const codeTable = count > 0 ? offset() : 0;
  const glyphs: Glyph[] = [];
  for (let i = 0; i < count; i++) {
    const shape = new SwfReader(bytes, table + offsets[i], tag.offset + tag.length);
    glyphs.push({ code: 0, records: readRecords(shape, 1).records, advance: 0, bounds: null });
  }

  const font: Font = {
    ...named,
    em: tag.code === DefineFont3 ? 20480 : 1024,
    glyphs,
    layout: false,
    ascent: 0,
    descent: 0,
    leading: 0,
    kerning: new Map(),
  };
  if (count > 0) {
    r.pos = table + codeTable;
  }

  const code = () => (wideCodes ? r.u16() : r.u8());
  for (const glyph of glyphs) {
    glyph.code = code();
  }

  if (!hasLayout || r.overrun) {
    return font;
  }

  font.ascent = r.u16();
  font.descent = r.u16();
  font.leading = r.s16();
  for (const glyph of glyphs) {
    glyph.advance = r.s16();
  }

  for (const glyph of glyphs) {
    glyph.bounds = r.rect();
  }

  const pairs = r.u16();
  for (let i = 0; i < pairs && !r.overrun; i++) {
    const first = code();
    const second = code();
    font.kerning.set((first << 16) | second, r.s16());
  }

  font.layout = !r.overrun;
  return font;
}

/** The glyph for a character, by a binary search of the code table, as Flash finds it: null for one the font lacks. */
export function glyphOf(font: Font, code: number): Glyph | null {
  let lo = 0;
  let hi = font.glyphs.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const c = font.glyphs[mid].code;
    if (c === code) {
      return font.glyphs[mid];
    }

    if (c < code) {
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }

  return null;
}
