// DefineFont through DefineFont3: a font's glyphs, the outlines a field that
// embeds it draws, and its layout, the advances, kerning, ascent and
// descent a field's text is laid out by.
import { readString, utf8 } from "./display.js";
import { readRecords, type ShapeRecord } from "./shape.js";
import { type Rect, SwfReader, type Tag } from "./swf.js";
import { DefineFont, DefineFont3, DefineFontInfo2 } from "./tags.js";
import { type FontName, readFontName } from "./text.js";

export interface Glyph {
  /** The character, a UTF-16 code unit, or -1 before a legacy font has a character table. */
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
  /** Units to the em: 1024 for DefineFont and DefineFont2, 20480 for DefineFont3. */
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
  /**
   * DefineFontAlignZones' CSM hint, how much advanced anti-aliasing
   * thickens its stems: 0 thin, 1 medium, 2 thick; none without the tag.
   */
  csmHint?: number;
}

/** DefineFont4's CFF data, when embedded; a tag without it still has a name and style. */
export interface Font4 {
  id: number;
  name: string;
  bold: boolean;
  italic: boolean;
  data: Uint8Array | null;
}

/** DefineFont4 (91): a name, style, and optional OpenType CFF bytes. */
export function readFont4(bytes: Uint8Array, tag: Tag): Font4 {
  const r = new SwfReader(bytes, tag.offset, tag.offset + tag.length);
  const id = r.u16();
  const flags = r.u8();
  const name = readString(r);

  return {
    id,
    name,
    bold: (flags & 1) !== 0,
    italic: (flags & 2) !== 0,
    data: flags & 4 ? bytes.subarray(r.pos, r.end) : null,
  };
}

/** DefineFont (10), whose first offset gives the glyph count; its name and codes come separately. */
function readFont1(bytes: Uint8Array, tag: Tag): Font {
  const r = new SwfReader(bytes, tag.offset, tag.offset + tag.length);
  const font: Font = {
    id: r.u16(),
    name: "",
    bold: false,
    italic: false,
    em: 1024,
    glyphs: [],
    layout: false,
    ascent: 0,
    descent: 0,
    leading: 0,
    kerning: new Map(),
  };
  const table = r.pos;
  const first = r.u16();
  if (r.overrun || first < 2 || first % 2 !== 0 || table + first > r.end) {
    return font;
  }

  const offsets = [first];
  for (let i = 1; i < first / 2; i++) {
    const offset = r.u16();
    if (offset < offsets[i - 1] || table + offset > r.end) {
      return font;
    }

    offsets.push(offset);
  }

  offsets.push(r.end - table);
  for (let i = 0; i < offsets.length - 1; i++) {
    const start = offsets[i];
    const end = offsets[i + 1];
    const records = readRecords(new SwfReader(bytes, table + start, table + end), 1).records;
    font.glyphs.push({ code: -1, records, advance: 0, bounds: null });
  }

  return font;
}

/** A legacy font's name, style and glyph-to-character mapping, supplied after its outlines. */
export interface FontInfo extends FontName {
  codes: number[];
}

/** DefineFontInfo (13) or DefineFontInfo2 (62); the latter has a language byte before its codes. */
export function readFontInfo(bytes: Uint8Array, tag: Tag): FontInfo {
  const r = new SwfReader(bytes, tag.offset, tag.offset + tag.length);
  const id = r.u16();
  const length = r.u8();
  const name = utf8(bytes.subarray(r.pos, Math.min(r.pos + length, r.end))).replace(/\0+$/, "");
  r.pos += length;
  const flags = r.u8();
  if (tag.code === DefineFontInfo2) {
    r.u8();
  }

  const codes: number[] = [];
  const size = flags & 1 ? 2 : 1;
  while (r.pos + size <= r.end) {
    codes.push(size === 2 ? r.u16() : r.u8());
  }

  return { id, name, bold: (flags & 2) !== 0, italic: (flags & 4) !== 0, codes };
}

/** DefineFont (10), DefineFont2 (48) or DefineFont3 (75), as far as the tag goes. */
export function readFont(bytes: Uint8Array, tag: Tag): Font {
  if (tag.code === DefineFont) {
    return readFont1(bytes, tag);
  }

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

/** DefineFontAlignZones (73): the font it is for and its CSM hint; the zones themselves are not read. */
export function readFontAlignZones(bytes: Uint8Array, tag: Tag): { id: number; csmHint: number } {
  const r = new SwfReader(bytes, tag.offset, tag.offset + tag.length);
  const id = r.u16();
  return { id, csmHint: r.u8() >> 6 };
}
