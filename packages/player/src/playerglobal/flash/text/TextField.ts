// flash.text.TextField and TextFormat: a field's text and formats as a
// TextModel (text.ts), its properties as adl reports them; a TextFormat's
// values stored as Flash converts them, null for one it does not set.
import { avm2 } from "@swf2es/runtime";
import { CONTENT, type TextObject } from "../../../display.js";
import type { Scripting } from "../../../scripting.js";
import { applied, emptyFormat, type PartialFormat } from "../../../text.js";
import { GUTTER, lineOf, shownLines } from "../../../text-layout.js";
import { useSheet } from "./StyleSheet.js";

type AsObject = avm2.AsObject;
type Value = avm2.Value;

const ALIGNS = ["left", "center", "right", "justify", "start", "end"];

/** A number Flash keeps as an int: rounded, a half to even (12.7 is 13, -3.5 is -4, 10.5 is 10, 11.5 is 12). */
function rounded(v: number): number {
  // What is no number is the int nearest none, as x86's conversion gives (the corpus's `stylesheet_transform`).
  if (!Number.isFinite(v)) {
    return -2147483648;
  }

  const r = Math.round(v);
  return r - v === 0.5 && r % 2 !== 0 ? r - 1 : r;
}

/** The line a point in the field is on, by the lines' tops and heights: -1 for none. */
function lineAtPoint(field: TextObject, x: number, y: number): number {
  const layout = field.layout;
  if (x < 0 || x > field.width * 20) {
    return -1;
  }

  for (const [i, line] of layout.lines.entries()) {
    if (y >= line.y && y < line.y + line.ascent + line.descent + line.leading) {
      return i;
    }
  }

  return -1;
}

/** The last first line a scroll can show: the lines after it fit the field's height. */
function maxScrollV(field: TextObject): number {
  const lines = field.layout.lines;
  const room = field.height * 20 - 2 * GUTTER;
  let used = 0;
  let first = lines.length;
  while (first > 0) {
    const line = lines[first - 1];
    const next = used + line.ascent + line.descent + (first < lines.length ? line.leading : 0);
    if (next > room && first < lines.length) {
      break;
    }

    used = next;
    first--;
  }

  return Math.max(1, first + 1);
}

/** The start and length of the paragraph `i` is in, as Flash gives them (Ruffle's edit_text.rs); [-1, -1] outside the text. */
function paragraphAt(text: string, i: number): [number, number] {
  if (i < 0 || i > text.length) {
    return [-1, -1];
  }

  let start = i;
  while (start > 0 && text[start - 1] !== "\r" && text[start - 1] !== "\n") {
    start--;
  }

  if (i === text.length) {
    return [start, text.length - start + 1];
  }

  let end = i;
  while (end < text.length && text[end] !== "\r" && text[end] !== "\n") {
    end++;
  }

  return [start, Math.min(end + 1, text.length) - start];
}

export function textFieldNatives(s: Scripting): avm2.Natives {
  const natives: avm2.Natives = {};
  const formatOf = (o: AsObject): PartialFormat => {
    o.$format ??= emptyFormat();
    return o.$format;
  };
  /** A TextFormat object of `values`. */
  const textFormat = (values: PartialFormat): AsObject => {
    const o = s.rt.construct(s.rt.classNamed("flash.text::TextFormat")) as AsObject;
    o.$format = { ...values, tabStops: values.tabStops ? [...values.tabStops] : null };
    return o;
  };
  /** The text or the field changed: drawn again, and fitted to its text under autoSize. */
  const changed = (o: { $display: TextObject }) => {
    o.$display.invalidate(CONTENT);
    o.$display.fit();
  };
  /** A line's index, or RangeError 2006 past the lines. */
  const lineAt = (field: TextObject, v: Value): number => {
    const i = s.rt.toInt(v);
    if (i < 0 || i >= field.layout.lines.length) {
      throw s.rt.error("RangeError", 2006);
    }

    return i;
  };

  /** [begin, end) as getTextFormat and setTextFormat take them: -1 for the start or the end; RangeError 2006 past them. */
  const range = (field: TextObject, begin: Value, end: Value): [number, number] => {
    const length = field.model.text.length;
    const b = begin === undefined || s.rt.toInt(begin) === -1 ? 0 : s.rt.toInt(begin);
    const e = end === undefined || s.rt.toInt(end) === -1 ? length : s.rt.toInt(end);
    if (b < 0 || e < b || e > length) {
      throw s.rt.error("RangeError", 2006);
    }

    return [b, e];
  };
  const choice = (v: Value, allowed: string[], name: string): string => {
    const value = s.rt.toString(v);
    if (!allowed.includes(value)) {
      throw s.rt.error("ArgumentError", 2008, name);
    }

    return value;
  };

  class TextFormatNatives {
    declare $format: PartialFormat | undefined;

    get font(): Value {
      return formatOf(this).font;
    }
    set font(v: Value) {
      formatOf(this).font = v === null || v === undefined ? null : s.rt.toString(v);
    }
    get size(): Value {
      return formatOf(this).size;
    }
    set size(v: Value) {
      formatOf(this).size = v === null || v === undefined ? null : rounded(s.rt.toNumber(v));
    }
    get color(): Value {
      return formatOf(this).color;
    }
    set color(v: Value) {
      formatOf(this).color = v === null || v === undefined ? null : rounded(s.rt.toNumber(v));
    }
    get bold(): Value {
      return formatOf(this).bold;
    }
    set bold(v: Value) {
      formatOf(this).bold = v === null || v === undefined ? null : !!v;
    }
    get italic(): Value {
      return formatOf(this).italic;
    }
    set italic(v: Value) {
      formatOf(this).italic = v === null || v === undefined ? null : !!v;
    }
    get underline(): Value {
      return formatOf(this).underline;
    }
    set underline(v: Value) {
      formatOf(this).underline = v === null || v === undefined ? null : !!v;
    }
    get url(): Value {
      return formatOf(this).url;
    }
    set url(v: Value) {
      formatOf(this).url = v === null || v === undefined ? null : s.rt.toString(v);
    }
    get target(): Value {
      return formatOf(this).target;
    }
    set target(v: Value) {
      formatOf(this).target = v === null || v === undefined ? null : s.rt.toString(v);
    }
    get align(): Value {
      return formatOf(this).align;
    }
    set align(v: Value) {
      formatOf(this).align = v === null || v === undefined ? null : choice(v, ALIGNS, "align");
    }
    get leftMargin(): Value {
      return formatOf(this).leftMargin;
    }
    set leftMargin(v: Value) {
      formatOf(this).leftMargin = v === null || v === undefined ? null : rounded(s.rt.toNumber(v));
    }
    get rightMargin(): Value {
      return formatOf(this).rightMargin;
    }
    set rightMargin(v: Value) {
      formatOf(this).rightMargin = v === null || v === undefined ? null : rounded(s.rt.toNumber(v));
    }
    get indent(): Value {
      return formatOf(this).indent;
    }
    set indent(v: Value) {
      formatOf(this).indent = v === null || v === undefined ? null : rounded(s.rt.toNumber(v));
    }
    get leading(): Value {
      return formatOf(this).leading;
    }
    set leading(v: Value) {
      formatOf(this).leading = v === null || v === undefined ? null : rounded(s.rt.toNumber(v));
    }
    get blockIndent(): Value {
      return formatOf(this).blockIndent;
    }
    set blockIndent(v: Value) {
      formatOf(this).blockIndent = v === null || v === undefined ? null : rounded(s.rt.toNumber(v));
    }
    get letterSpacing(): Value {
      return formatOf(this).letterSpacing;
    }
    set letterSpacing(v: Value) {
      formatOf(this).letterSpacing = v === null || v === undefined ? null : s.rt.toNumber(v);
    }
    get kerning(): Value {
      return formatOf(this).kerning;
    }
    set kerning(v: Value) {
      formatOf(this).kerning = v === null || v === undefined ? null : !!v;
    }
    get bullet(): Value {
      return formatOf(this).bullet;
    }
    set bullet(v: Value) {
      formatOf(this).bullet = v === null || v === undefined ? null : !!v;
    }
    get tabStops(): Value {
      const stops = formatOf(this).tabStops;
      return stops === null ? null : s.rt.array(stops);
    }
    set tabStops(v: Value) {
      const values = ((v as AsObject | null)?.$a as Value[] | undefined) ?? null;
      formatOf(this).tabStops =
        values === null ? null : values.map((n) => rounded(s.rt.toNumber(n)));
    }
    // An unknown display is null, as adl leaves it.
    get display(): Value {
      return formatOf(this).display;
    }
    set display(v: Value) {
      const value = v === null || v === undefined ? null : s.rt.toString(v);
      formatOf(this).display =
        value === "block" || value === "inline" || value === "none" ? value : null;
    }
  }

  class TextFieldNatives {
    declare $display: TextObject;

    get text(): string {
      return this.$display.model.text;
    }
    set text(v: Value) {
      if (v === null || v === undefined) {
        throw s.rt.error("TypeError", 2007, "value");
      }

      // Under a sheet, text is read as HTML too, as adl reads it.
      if (this.$display.styleSheet) {
        setStyledHtml(this.$display, s.rt.toString(v));
      } else {
        this.$display.model.setText(s.rt.toString(v));
      }

      changed(this);
    }
    get htmlText(): string {
      const field = this.$display;
      return field.styleSheet && field.htmlSource !== null
        ? field.htmlSource
        : field.model.toHtml();
    }
    set htmlText(v: Value) {
      if (v === null || v === undefined) {
        throw s.rt.error("TypeError", 2007, "value");
      }

      // Under a sheet, the HTML it has set again is not read again.
      if (this.$display.styleSheet) {
        const html = s.rt.toString(v);
        if (html !== this.$display.htmlSource) {
          setStyledHtml(this.$display, html);
          changed(this);
        }

        return;
      }

      this.$display.model.setHtml(
        s.rt.toString(v),
        this.$display.multiline,
        s.trimTrailingHtmlBreak,
      );
      changed(this);
    }
    get length(): number {
      return this.$display.model.text.length;
    }
    getRawText(): string {
      return this.$display.model.text;
    }
    appendText(v: Value): void {
      const model = this.$display.model;
      model.replace(model.text.length, model.text.length, s.rt.toString(v));
      changed(this);
    }
    replaceText(begin: Value, end: Value, v: Value): void {
      if (this.$display.styleSheet) {
        throw s.rt.error("Error", 2009);
      }

      const model = this.$display.model;
      const b = Math.max(0, Math.min(model.text.length, s.rt.toInt(begin)));
      const e = Math.max(b, Math.min(model.text.length, s.rt.toInt(end)));
      model.replace(b, e, s.rt.toString(v));
      changed(this);
    }
    get textColor(): number {
      const model = this.$display.model;
      return (model.formats[0] ?? model.defaultFormat).color >>> 0;
    }
    /** Every character's colour and the default's, as adl sets them. */
    set textColor(v: Value) {
      const color = s.rt.toUint(v);
      const model = this.$display.model;
      model.defaultFormat = { ...model.defaultFormat, color };
      const change = emptyFormat();
      change.color = color;
      model.setFormat(change, 0, model.text.length);
      changed(this);
    }
    get defaultTextFormat(): Value {
      return textFormat(this.$display.model.defaultFormat);
    }
    set defaultTextFormat(v: Value) {
      if (v === null || v === undefined) {
        throw s.rt.error("TypeError", 2007, "format");
      }

      const model = this.$display.model;
      model.defaultFormat = applied(model.defaultFormat, formatOf(v as AsObject));
    }
    getTextFormat(begin: Value = -1, end: Value = -1): Value {
      const field = this.$display;
      const [b, e] = range(field, begin, end);
      return textFormat(field.model.formatOf(b, e));
    }
    setTextFormat(format: Value, begin: Value = -1, end: Value = -1): void {
      if (format === null || format === undefined) {
        throw s.rt.error("TypeError", 2007, "format");
      }

      const field = this.$display;
      const [b, e] = range(field, begin, end);
      field.model.setFormat(formatOf(format as AsObject), b, e);
      changed(this);
    }

    get type(): string {
      return this.$display.type;
    }
    set type(v: Value) {
      this.$display.type = choice(v, ["dynamic", "input"], "type");
    }
    get autoSize(): string {
      return this.$display.autoSize;
    }
    set autoSize(v: Value) {
      this.$display.autoSize = choice(v, ["none", "left", "right", "center"], "autoSize");
      this.$display.fit();
    }
    get antiAliasType(): string {
      return this.$display.antiAliasType;
    }
    // An unknown one is left as it was, as adl leaves it.
    set antiAliasType(v: Value) {
      const value = s.rt.toString(v);
      if (value === "normal" || value === "advanced") {
        this.$display.antiAliasType = value;
      }
    }
    get gridFitType(): string {
      return this.$display.gridFitType;
    }
    // An unknown one is none, as adl makes it.
    set gridFitType(v: Value) {
      const value = s.rt.toString(v);
      this.$display.gridFitType = value === "pixel" || value === "subpixel" ? value : "none";
    }

    get border(): boolean {
      return this.$display.border;
    }
    set border(v: Value) {
      this.$display.border = !!v;
      changed(this);
    }
    get borderColor(): number {
      return this.$display.borderColor;
    }
    set borderColor(v: Value) {
      this.$display.borderColor = s.rt.toUint(v) & 0xffffff;
      changed(this);
    }
    get background(): boolean {
      return this.$display.background;
    }
    set background(v: Value) {
      this.$display.background = !!v;
      changed(this);
    }
    get backgroundColor(): number {
      return this.$display.backgroundColor;
    }
    set backgroundColor(v: Value) {
      this.$display.backgroundColor = s.rt.toUint(v) & 0xffffff;
      changed(this);
    }
    get multiline(): boolean {
      return this.$display.multiline;
    }
    set multiline(v: Value) {
      this.$display.multiline = !!v;
      changed(this);
    }
    get wordWrap(): boolean {
      return this.$display.wordWrap;
    }
    set wordWrap(v: Value) {
      this.$display.wordWrap = !!v;
      changed(this);
    }
    get embedFonts(): boolean {
      return this.$display.embedFonts;
    }
    set embedFonts(v: Value) {
      this.$display.embedFonts = !!v;
      changed(this);
    }
    get selectable(): boolean {
      return this.$display.selectable;
    }
    set selectable(v: Value) {
      this.$display.selectable = !!v;
    }
    get displayAsPassword(): boolean {
      return this.$display.displayAsPassword;
    }
    set displayAsPassword(v: Value) {
      this.$display.displayAsPassword = !!v;
      changed(this);
    }
    get condenseWhite(): boolean {
      return this.$display.condenseWhite;
    }
    set condenseWhite(v: Value) {
      this.$display.condenseWhite = !!v;
    }
    get maxChars(): number {
      return this.$display.maxChars;
    }
    set maxChars(v: Value) {
      this.$display.maxChars = s.rt.toInt(v);
    }
    get restrict(): Value {
      return this.$display.restrict;
    }
    set restrict(v: Value) {
      this.$display.restrict = v === null || v === undefined ? null : s.rt.toString(v);
    }
    get sharpness(): number {
      return this.$display.sharpness;
    }
    set sharpness(v: Value) {
      this.$display.sharpness = s.rt.toNumber(v);
    }
    get thickness(): number {
      return this.$display.thickness;
    }
    set thickness(v: Value) {
      this.$display.thickness = s.rt.toNumber(v);
    }
    get mouseWheelEnabled(): boolean {
      return this.$display.mouseWheelEnabled;
    }
    set mouseWheelEnabled(v: Value) {
      this.$display.mouseWheelEnabled = !!v;
    }
    get alwaysShowSelection(): boolean {
      return this.$display.alwaysShowSelection;
    }
    set alwaysShowSelection(v: Value) {
      this.$display.alwaysShowSelection = !!v;
    }
    get useRichTextClipboard(): boolean {
      return this.$display.useRichTextClipboard;
    }
    set useRichTextClipboard(v: Value) {
      this.$display.useRichTextClipboard = !!v;
    }

    get textWidth(): number {
      return this.$display.layout.width / 20;
    }
    get textHeight(): number {
      return this.$display.layout.height / 20;
    }
    // Laid out now: adl's count can lag a relayout until the next.
    get numLines(): number {
      return this.$display.layout.lines.length;
    }
    getLineMetrics(lineIndex: Value): Value {
      const line = this.$display.layout.lines[lineAt(this.$display, lineIndex)];
      return s.rt.construct(
        s.rt.classNamed("flash.text::TextLineMetrics"),
        line.x / 20,
        line.width / 20,
        (line.ascent + line.descent + line.leading) / 20,
        line.ascent / 20,
        line.descent / 20,
        line.leading / 20,
      );
    }
    getLineLength(lineIndex: Value): number {
      const line = this.$display.layout.lines[lineAt(this.$display, lineIndex)];
      return line.end - line.start;
    }
    getLineOffset(lineIndex: Value): number {
      return this.$display.layout.lines[lineAt(this.$display, lineIndex)].start;
    }
    getLineText(lineIndex: Value): string {
      const line = this.$display.layout.lines[lineAt(this.$display, lineIndex)];
      return this.$display.model.text.slice(line.start, line.end);
    }
    getLineIndexOfChar(charIndex: Value): number {
      const i = s.rt.toInt(charIndex);
      const field = this.$display;
      if (i < 0 || i >= field.model.text.length) {
        return -1;
      }

      return lineOf(field.layout, i);
    }
    /** Where a character is, in the field: null for one past the text, a newline, or one its font lacks. */
    getCharBoundaries(charIndex: Value): Value {
      const i = s.rt.toInt(charIndex);
      const field = this.$display;
      if (i < 0 || i >= field.model.text.length) {
        return null;
      }

      const line = field.layout.lines[lineOf(field.layout, i)];
      const c = line.chars[i - line.start];
      if (!c?.shown) {
        return null;
      }

      return s.rt.construct(
        s.rt.classNamed("flash.geom::Rectangle"),
        c.x / 20,
        line.y / 20,
        c.advance / 20,
        (line.ascent + line.descent) / 20,
      );
    }
    getLineIndexAtPoint(x: Value, y: Value): number {
      return lineAtPoint(this.$display, s.rt.toNumber(x) * 20, s.rt.toNumber(y) * 20);
    }
    getCharIndexAtPoint(x: Value, y: Value): number {
      const field = this.$display;
      const px = s.rt.toNumber(x) * 20;
      const i = lineAtPoint(field, px, s.rt.toNumber(y) * 20);
      if (i < 0) {
        return -1;
      }

      for (const c of field.layout.lines[i].chars) {
        if (c.shown && px >= c.x && px < c.x + c.advance) {
          return c.index;
        }
      }

      return -1;
    }
    get scrollV(): number {
      return this.$display.scrollV;
    }
    set scrollV(v: Value) {
      const field = this.$display;
      field.scrollV = Math.max(1, Math.min(s.rt.toInt(v), maxScrollV(field)));
      changed(this);
    }
    get maxScrollV(): number {
      return maxScrollV(this.$display);
    }
    get bottomScrollV(): number {
      const field = this.$display;
      return field.scrollV + shownLines(field, field.scrollV - 1) - 1;
    }
    get scrollH(): number {
      return this.$display.scrollH;
    }
    set scrollH(v: Value) {
      this.$display.scrollH = Math.max(0, s.rt.toInt(v));
      this.$display.invalidate(CONTENT);
    }
    get maxScrollH(): number {
      return 0;
    }
    get selectionBeginIndex(): number {
      return this.$display.selection[0];
    }
    get selectionEndIndex(): number {
      return this.$display.selection[1];
    }
    get caretIndex(): number {
      return this.$display.caret;
    }
    setSelection(begin: Value, end: Value): void {
      this.$display.select(s.rt.toInt(begin), s.rt.toInt(end));
    }
    /** The selection replaced, as typing would, and the caret after what came in. */
    replaceSelectedText(v: Value): void {
      if (this.$display.styleSheet) {
        throw s.rt.error("Error", 2009);
      }

      const field = this.$display;
      const [begin, end] = field.selection;
      const text = s.rt.toString(v);
      field.model.replace(begin, end, text);
      field.select(begin + text.length, begin + text.length);
      changed(this);
    }
    /** The runs of [begin, end) in one format each, as TextRuns. */
    getTextRuns(begin: Value = 0, end: Value = 0x7fffffff): Value {
      const model = this.$display.model;
      const b = Math.max(0, s.rt.toInt(begin));
      const e = Math.min(model.text.length, s.rt.toInt(end));
      const runs: Value[] = [];
      for (const [from, to] of model.runs(b, e)) {
        runs.push(
          s.rt.construct(
            s.rt.classNamed("flash.text::TextRun"),
            from,
            to,
            textFormat(model.formatOf(from, to)),
          ),
        );
      }

      return s.rt.array(runs);
    }
    /** The first index of the paragraph `charIndex` is in; the text's length counts as in its last. */
    getFirstCharInParagraph(charIndex: Value): number {
      return paragraphAt(this.$display.model.text, s.rt.toInt(charIndex))[0];
    }
    /** That paragraph's length, its line end in it; at the text's length, one past the last's. */
    getParagraphLength(charIndex: Value): number {
      return paragraphAt(this.$display.model.text, s.rt.toInt(charIndex))[1];
    }
    /** A desktop player's: no touch selection. */
    get textInteractionMode(): string {
      return "normal";
    }
    get styleSheet(): Value {
      return this.$display.styleSheet;
    }
    /**
     * A sheet styles the HTML set from then on, and a change to the sheet
     * styles it again; the HTML set keeps its source for htmlText. Taken
     * off, the text keeps the styles it had (the corpus's `edittext_stylesheet`).
     */
    set styleSheet(v: Value) {
      const field = this.$display;
      const sheet = (v as AsObject | null | undefined) ?? null;
      field.styleSheet = sheet;
      if (!sheet) {
        field.htmlSource = null;
        field.restyle = null;
        return;
      }

      // adl styles the HTML again on a change to the sheet only for a field
      // that had HTML from a sheet when given this one (`edittext_stylesheet`).
      if (field.htmlSource === null) {
        field.restyle = null;
        return;
      }

      useSheet(sheet, field);
      field.restyle = () => {
        if (field.htmlSource !== null) {
          setStyledHtml(field, field.htmlSource);
          changed({ $display: field });
        }
      };
    }
  }

  /** `html` as the field's text, styled by its sheet's TextFormats by selector. */
  const setStyledHtml = (field: TextObject, html: string): void => {
    // Its private _styles, which StyleSheet's natives keep.
    const styles = ((field.styleSheet as AsObject).$styles as AsObject | null | undefined) ?? null;
    field.htmlSource = html;
    field.model.setHtml(html, field.multiline, s.trimTrailingHtmlBreak, (selector) => {
      const style = styles ? s.rt.getProperty(styles, s.rt.publicName(selector)) : null;
      return style && typeof style === "object" ? formatOf(style as AsObject) : null;
    });
  };

  avm2.registerNativeClass(natives, "flash.text::TextFormat", TextFormatNatives);
  avm2.registerNativeClass(natives, "flash.text::TextField", TextFieldNatives);
  return natives;
}
