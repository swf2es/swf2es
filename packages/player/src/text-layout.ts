// A field's text laid out as Flash lays it out (docs/architecture.md,
// "Text"): lines, and each character's place on them, in twips, which the
// metrics, the line and character queries, autoSize and the renderer all
// read. adl sets the rules, with fonts of rectangles from the tests' SWF
// writer.
import { type Font, type Glyph, glyphOf } from "@swf2es/format";
import { deviceMetrics, type FontSet } from "./fonts.js";
import type { CharFormat } from "./text.js";

const TWIPS = 20;
/** The gutter: 2 pixels between the field's edge and its text, each side. */
export const GUTTER = 2 * TWIPS;
const BULLET = 36 * TWIPS;

/** A character laid out: where it starts on its line and how far it advances, in twips. */
export interface LaidChar {
  index: number;
  x: number;
  advance: number;
  /** Its pair's kerning, which shortens its advance and, drawn, moves it: its boundaries stay where they were. */
  kern: number;
  /** Its embedded font and glyph; null for a device font's character, or one the font lacks. */
  font: Font | null;
  glyph: Glyph | null;
  /** Whether it has boundaries: not a newline, nor a character an embedded font lacks. */
  shown: boolean;
  format: CharFormat;
}

export interface Line {
  /** Its characters, [start, end) of the text, a newline that ends it included. */
  start: number;
  end: number;
  /** Its left and top in the field, gutter, margins, indent and alignment in, and its width. */
  x: number;
  y: number;
  width: number;
  ascent: number;
  descent: number;
  leading: number;
  chars: LaidChar[];
}

export interface TextLayout {
  lines: Line[];
  /** textWidth and textHeight, in twips. */
  width: number;
  height: number;
}

/** What a field gives its layout. */
export interface LayoutField {
  text: string;
  formats: readonly CharFormat[];
  defaultFormat: CharFormat;
  /** The field's width, in pixels. */
  width: number;
  wordWrap: boolean;
  embedFonts: boolean;
  fonts: FontSet | null;
  /** Whether its type is "input": the empty line a final newline leaves then counts in its height. */
  input: boolean;
}

/** A character's measure in its format: its font and glyph, its advance and the line height it asks, in twips. */
interface Measure {
  font: Font | null;
  glyph: Glyph | null;
  advance: number;
  kern: number;
  ascent: number;
  descent: number;
  shown: boolean;
}

/** Font units, or pixels for `em` 1, to twips at `size`, truncated as Flash does. */
function twips(units: number, size: number, em: number): number {
  return Math.trunc((units * size * TWIPS) / em);
}

/** A whole-pixel size, as a TextFormat keeps it; 0 for none. */
function sizeOf(format: CharFormat): number {
  return Math.max(0, format.size);
}

/** The line height a format asks, with no character: its font's ascent and descent. */
function heightOf(field: LayoutField, format: CharFormat): { ascent: number; descent: number } {
  const size = sizeOf(format);
  if (field.embedFonts) {
    const font = field.fonts?.find(format.font, format.bold, format.italic) ?? null;
    return font?.layout
      ? { ascent: twips(font.ascent, size, font.em), descent: twips(font.descent, size, font.em) }
      : { ascent: 0, descent: 0 };
  }

  const m = deviceMetrics(format.font, size, format.bold, format.italic);
  return { ascent: twips(m.ascent, size, size), descent: twips(m.descent, size, size) };
}

function measure(field: LayoutField, code: number, format: CharFormat, previous: number): Measure {
  const size = sizeOf(format);
  const spacing = Math.trunc(format.letterSpacing * TWIPS);
  if (field.embedFonts) {
    const font = field.fonts?.find(format.font, format.bold, format.italic) ?? null;
    if (!font?.layout) {
      return { font, glyph: null, advance: 0, kern: 0, ascent: 0, descent: 0, shown: false };
    }

    const ascent = twips(font.ascent, size, font.em);
    const descent = twips(font.descent, size, font.em);
    const glyph = glyphOf(font, code);
    if (!glyph) {
      return { font, glyph: null, advance: 0, kern: 0, ascent, descent, shown: false };
    }

    // A pair's kerning shortens the second character, as adl has it.
    const pair = format.kerning && previous >= 0 ? font.kerning.get((previous << 16) | code) : 0;
    const kern = pair ? twips(pair, size, font.em) : 0;
    const advance = twips(glyph.advance, size, font.em) + spacing + kern;
    return { font, glyph, advance, kern, ascent, descent, shown: true };
  }

  const m = deviceMetrics(format.font, size, format.bold, format.italic);
  return {
    font: null,
    glyph: null,
    advance: twips(m.advance(String.fromCharCode(code)), size, size) + spacing,
    kern: 0,
    ascent: twips(m.ascent, size, size),
    descent: twips(m.descent, size, size),
    shown: true,
  };
}

/**
 * The field's text in lines: broken at each newline, and with word wrap
 * before a word that does not fit without its trailing spaces (one that
 * ends at the room's edge fits), or between the characters of a
 * word longer than the line.
 */
export function layoutText(field: LayoutField): TextLayout {
  const { text, formats } = field;
  const lines: Line[] = [];
  let y = GUTTER;
  let start = 0;
  do {
    let end = text.indexOf("\r", start);
    const newline = end >= 0;
    end = newline ? end : text.length;
    const format = formats[start] ?? field.defaultFormat;
    const measures: Measure[] = [];
    for (let i = start; i < end; i++) {
      const glyphs = measures[i - start - 1];
      const previous = i > start && glyphs?.shown ? text.charCodeAt(i - 1) : -1;
      measures.push(measure(field, text.charCodeAt(i), formats[i], previous));
    }

    // The paragraph's lines: [from, to) of its characters each.
    // A bullet's paragraph is set in 36 pixels, as adl sets it.
    const bullet = format.bullet ? BULLET : 0;
    const room =
      Math.trunc(field.width * TWIPS) -
      2 * GUTTER -
      bullet -
      Math.trunc((format.leftMargin + format.rightMargin + format.blockIndent) * TWIPS);
    // A negative indent, a hanging one, moves the first line left, as far
    // as the gutter, and gives it no more room, as adl lays it out.
    const indent = Math.trunc(format.indent * TWIPS);
    const firstRoom = room - Math.max(0, indent);
    const margin = Math.trunc((format.leftMargin + format.blockIndent) * TWIPS);
    const breaks: [number, number][] = [];
    let from = 0;
    while (from < measures.length || breaks.length === 0) {
      let to = measures.length;
      if (field.wordWrap) {
        to = wrap(text, start, measures, from, breaks.length === 0 ? firstRoom : room);
      }

      breaks.push([from, to]);
      from = to;
      if (from >= measures.length) {
        break;
      }
    }

    for (const [k, [a, b]] of breaks.entries()) {
      const chars: LaidChar[] = [];
      let x = 0;
      let ascent = 0;
      let descent = 0;
      for (let i = a; i < b; i++) {
        const m = measures[i];
        chars.push({
          index: start + i,
          x,
          advance: m.advance,
          kern: m.kern,
          font: m.font,
          glyph: m.glyph,
          shown: m.shown,
          format: formats[start + i],
        });
        x += m.advance;
        ascent = Math.max(ascent, m.ascent);
        descent = Math.max(descent, m.descent);
      }

      if (a === b) {
        ({ ascent, descent } = heightOf(field, formats[start + a] ?? format));
      }

      const last = k === breaks.length - 1;
      const lineEnd = last && newline ? end + 1 : start + b;
      if (last && newline) {
        chars.push({
          index: end,
          x,
          advance: 0,
          kern: 0,
          font: null,
          glyph: null,
          shown: false,
          format: formats[end],
        });
      }

      const left = GUTTER + bullet + (k === 0 ? Math.max(0, margin + indent) : margin);
      const lineRoom = k === 0 ? firstRoom : room;
      const space = lineRoom - x;
      // Justified, a wrapped line but the paragraph's last has its inner
      // spaces share the room left, its trailing spaces out.
      if (format.align === "justify" && !last) {
        x = justify(text, chars, lineRoom);
      }

      // Centred in the room left; right-aligned, one twip further left, as adl places it.
      const align =
        format.align === "center"
          ? Math.trunc(space / 2)
          : format.align === "right"
            ? space - 1
            : 0;
      const lineX = left + Math.max(0, align);
      for (const c of chars) {
        c.x += lineX;
      }

      const leading = Math.trunc(format.leading * TWIPS);
      lines.push({
        start: start + a,
        end: lineEnd,
        x: lineX,
        y,
        width: x,
        ascent,
        descent,
        leading,
        chars,
      });
      y += ascent + descent + leading;
    }

    start = end + 1;
    if (!newline) {
      break;
    }

    // A newline at the end leaves an empty line after it.
    if (start === text.length) {
      const f = formats[end] ?? field.defaultFormat;
      const { ascent, descent } = heightOf(field, f);
      lines.push({
        start,
        end: start,
        x:
          GUTTER +
          Math.max(
            0,
            Math.trunc((f.leftMargin + f.blockIndent) * TWIPS) + Math.trunc(f.indent * TWIPS),
          ),
        y,
        width: 0,
        ascent,
        descent,
        leading: Math.trunc(f.leading * TWIPS),
        chars: [],
      });
      break;
    }
  } while (start <= text.length);

  return { lines, width: textWidth(lines), height: textHeight(text, lines, field.input) };
}

/** A justified line's characters placed: its inner spaces widened alike to fill `room`; its width. */
function justify(text: string, chars: LaidChar[], room: number): number {
  let end = chars.length;
  while (end > 0 && text[chars[end - 1].index] === " ") {
    end--;
  }

  let width = 0;
  let spaces = 0;
  for (let i = 0; i < end; i++) {
    width += chars[i].advance;
    if (text[chars[i].index] === " ") {
      spaces++;
    }
  }

  if (spaces > 0 && room > width) {
    const extra = Math.trunc((room - width) / spaces);
    for (let i = 0; i < end; i++) {
      if (text[chars[i].index] === " ") {
        chars[i].advance += extra;
      }
    }
  }

  let x = 0;
  for (const c of chars) {
    c.x = x;
    x += c.advance;
  }

  return x;
}

/** The end, exclusive, of a wrapped line from `from` with `room` twips. */
function wrap(
  text: string,
  start: number,
  measures: Measure[],
  from: number,
  room: number,
): number {
  let width = 0;
  let i = from;
  while (i < measures.length) {
    // The next word, measured only until it runs past the room: a word
    // longer than many lines is not measured again for each of them.
    let wordEnd = i;
    let wordWidth = width;
    while (wordEnd < measures.length && text[start + wordEnd] !== " ") {
      wordWidth += measures[wordEnd].advance;
      if (wordWidth > room) {
        // On a line of its own, it breaks before the character that runs past, one at least.
        return i > from ? i : Math.max(wordEnd, from + 1);
      }

      wordEnd++;
    }

    width = wordWidth;
    i = wordEnd;
    while (i < measures.length && text[start + i] === " ") {
      width += measures[i].advance;
      i++;
    }
  }

  return measures.length;
}

function textWidth(lines: Line[]): number {
  let width = 0;
  for (const line of lines) {
    width = Math.max(width, line.width);
  }

  return width;
}

/**
 * The lines' heights, leading and all, but for the last one's leading
 * where there are two lines or more, as adl counts them; an empty field
 * counts nothing, and the empty line a final newline leaves counts only
 * in an input field, where the caret can stand on it.
 */
function textHeight(text: string, lines: Line[], input: boolean): number {
  if (text.length === 0) {
    return 0;
  }

  const counted = text.endsWith("\r") && !input ? lines.slice(0, -1) : lines;
  let height = 0;
  for (const line of counted) {
    height += line.ascent + line.descent + line.leading;
  }

  return counted.length > 1 ? height - counted[counted.length - 1].leading : height;
}

/** The line a character is on: the last one starting at or before it. */
export function lineOf(layout: TextLayout, index: number): number {
  let lo = 0;
  let hi = layout.lines.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (layout.lines[mid].start <= index) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }

  return lo;
}

/** The lines of a field's layout that fit its height from line `first`: one at least. */
export function shownLines(field: { layout: TextLayout; height: number }, first: number): number {
  const lines = field.layout.lines;
  const room = field.height * TWIPS - 2 * GUTTER;
  let n = 0;
  let used = 0;
  for (let i = first; i < lines.length; i++) {
    used += lines[i].ascent + lines[i].descent;
    if (n > 0 && used > room) {
      break;
    }

    used += lines[i].leading;
    n++;
  }

  return Math.max(1, n);
}
