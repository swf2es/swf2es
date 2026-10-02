// flash.text.TextField and TextFormat: a field's text and formats as a
// TextModel (text.ts), its properties as adl reports them; a TextFormat's
// values stored as Flash converts them, null for one it does not set.
import { avm2 } from "@swf2es/runtime";
import { CONTENT, type TextObject } from "../../../display.js";
import type { Scripting } from "../../../scripting.js";
import { applied, emptyFormat, type PartialFormat } from "../../../text.js";

type AsObject = avm2.AsObject;
type Value = avm2.Value;

const ALIGNS = ["left", "center", "right", "justify", "start", "end"];

/** A number Flash keeps as an int: rounded, a half away from zero (12.7 is 13, -3.5 is -4). */
function rounded(v: number): number {
  return Math.sign(v) * Math.round(Math.abs(v));
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
  const changed = (o: { $display: TextObject }) => o.$display.invalidate(CONTENT);
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

      this.$display.model.setText(s.rt.toString(v));
      changed(this);
    }
    get htmlText(): string {
      return this.$display.model.toHtml();
    }
    set htmlText(v: Value) {
      if (v === null || v === undefined) {
        throw s.rt.error("TypeError", 2007, "value");
      }

      this.$display.model.setHtml(s.rt.toString(v), this.$display.multiline);
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

    // Lines are the text's own, \r apart; a wrapped field's are not counted without its layout.
    get numLines(): number {
      return this.$display.model.text.split("\r").length;
    }
    get scrollV(): number {
      return this.$display.scrollV;
    }
    set scrollV(v: Value) {
      this.$display.scrollV = Math.max(1, s.rt.toInt(v));
    }
    get maxScrollV(): number {
      return 1;
    }
    get bottomScrollV(): number {
      return this.$display.model.text.split("\r").length;
    }
    get scrollH(): number {
      return this.$display.scrollH;
    }
    set scrollH(v: Value) {
      this.$display.scrollH = Math.max(0, s.rt.toInt(v));
    }
    get maxScrollH(): number {
      return 0;
    }
    get selectionBeginIndex(): number {
      return 0;
    }
    get selectionEndIndex(): number {
      return 0;
    }
    get caretIndex(): number {
      return 0;
    }
    setSelection(_begin: Value, _end: Value): void {}
    get styleSheet(): Value {
      return null;
    }
    set styleSheet(_v: Value) {}
  }

  avm2.registerNativeClass(natives, "flash.text::TextFormat", TextFormatNatives);
  avm2.registerNativeClass(natives, "flash.text::TextField", TextFieldNatives);
  return natives;
}
