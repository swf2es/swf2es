// The text display objects: a StaticText's placed glyphs, and a
// TextField's model, rectangle, layout and selection.
import type { avm2 } from "@swf2es/runtime";
import type { FontSet } from "../text/fonts.js";
import { GUTTER, layoutText, type TextLayout } from "../text/layout.js";
import { type PlacedGlyph, placeGlyphs } from "../text/static.js";
import { TextModel } from "../text/text.js";
import { CONTENT, DisplayObject, TRANSFORM } from "./displayobject.js";
import type { Character, StaticTextCharacter, TextCharacter } from "./timeline.js";

/** A StaticText: DefineText's glyphs, which only a timeline places; its bounds the tag's. */
export class StaticTextObject extends DisplayObject {
  private laidGlyphs: { glyphs: PlacedGlyph[]; text: string | null } | null = null;

  constructor(
    public definition: StaticTextCharacter,
    private readonly characters: Map<number, Character>,
  ) {
    super();
    this.character = definition;
  }

  /** Show another text in its place, its glyphs laid out when next asked for. */
  show(definition: StaticTextCharacter): void {
    this.definition = definition;
    this.character = definition;
    this.laidGlyphs = null;
    this.invalidate(CONTENT);
  }

  /**
   * Its glyphs as placed, and its text, found the first time they are
   * asked for: by then its SWF's fonts are all read, those defined after it
   * too.
   */
  get glyphs(): { glyphs: PlacedGlyph[]; text: string | null } {
    this.laidGlyphs ??= placeGlyphs(this.definition, this.characters);
    return this.laidGlyphs;
  }
}

/**
 * A TextField: placed by DefineEditText, or made by a script. Its text and
 * formats are a TextModel; a timeline's starts with its tag's text, read
 * as HTML if the tag says so, in the format the tag gives.
 */
export class TextObject extends DisplayObject {
  readonly model = new TextModel();
  /** The embedded fonts its text may be in: its SWF's. */
  fonts: FontSet | null = null;
  private laid: { key: string; layout: TextLayout } | null = null;
  /** The field's rectangle, in its own pixels: from (left, top), width by height. */
  left = 0;
  top = 0;
  width = 100;
  height = 100;
  border = false;
  borderColor = 0;
  background = false;
  backgroundColor = 0xffffff;
  multiline = false;
  wordWrap = false;
  type = "dynamic";
  embedFonts = false;
  autoSize = "none";
  selectable = true;
  maxChars = 0;
  displayAsPassword = false;
  condenseWhite = false;
  antiAliasType = "normal";
  gridFitType = "pixel";
  sharpness = 0;
  thickness = 0;
  restrict: string | null = null;
  mouseWheelEnabled = true;
  alwaysShowSelection = false;
  useRichTextClipboard = false;
  scrollH = 0;
  scrollV = 1;
  /** The selection, from the end it was started at to the caret, as text indices; empty, a caret alone. */
  private anchorAt = 0;
  private caretAt = 0;
  /** Whether it has the keyboard's focus, an input field then showing its caret. */
  focused = false;
  /** The StyleSheet its HTML is styled by, or null. */
  styleSheet: avm2.AsObject | null = null;
  /** Under a sheet, the HTML a script last set, which htmlText gives back as it was set. */
  htmlSource: string | null = null;
  /** Under a sheet, its HTML styled again, as a change to the sheet asks. */
  restyle: (() => void) | null = null;

  constructor(
    readonly definition: TextCharacter | null,
    initialText = true,
  ) {
    super();
    this.character = definition;
    const edit = definition?.definition;
    if (!edit) {
      return;
    }

    this.left = edit.bounds.xMin / 20;
    this.top = edit.bounds.yMin / 20;
    this.width = (edit.bounds.xMax - edit.bounds.xMin) / 20;
    this.height = (edit.bounds.yMax - edit.bounds.yMin) / 20;
    this.multiline = edit.multiline;
    this.wordWrap = edit.wordWrap;
    this.type = edit.readOnly ? "dynamic" : "input";
    this.displayAsPassword = edit.password;
    this.autoSize = edit.autoSize ? "left" : "none";
    this.selectable = edit.selectable;
    // A border in the tag is Flash's border and white background together.
    this.border = edit.border;
    this.background = edit.border;
    this.maxChars = edit.maxLength ?? 0;
    this.embedFonts = edit.useOutlines;
    const font = definition?.font;
    const color = edit.color;
    this.model.defaultFormat = {
      ...this.model.defaultFormat,
      font: font?.name ?? edit.fontClass ?? this.model.defaultFormat.font,
      bold: font?.bold ?? false,
      italic: font?.italic ?? false,
      size: edit.fontHeight === null ? 12 : edit.fontHeight / 20,
      // RGBA as the tag stores it.
      color:
        color === null ? 0 : ((color & 0xff) << 16) | (color & 0xff00) | ((color >>> 16) & 0xff),
      align: ["left", "right", "center", "justify"][edit.align] ?? "left",
      leftMargin: edit.leftMargin / 20,
      rightMargin: edit.rightMargin / 20,
      indent: edit.indent / 20,
      leading: edit.leading / 20,
    };
    if (!initialText) {
      this.model.setText("");
    } else if (edit.html) {
      this.model.setHtml(edit.text, edit.multiline);
    } else {
      this.model.setText(edit.text);
    }
  }

  /** Its text laid out, as of now: made again only when the text, its formats or the field changed. */
  get layout(): TextLayout {
    const key = `${this.model.revision}|${this.width}|${this.wordWrap}|${this.embedFonts}|${this.displayAsPassword}|${this.type}|${this.antiAliasType}`;
    if (this.laid?.key !== key) {
      const text = this.model.text;
      this.laid = {
        key,
        layout: layoutText({
          // A password's characters are laid out, and drawn, as asterisks; its lines stay.
          text: this.displayAsPassword ? text.replace(/[^\r]/g, "*") : text,
          formats: this.model.formats,
          defaultFormat: this.model.defaultFormat,
          width: this.width,
          wordWrap: this.wordWrap,
          embedFonts: this.embedFonts,
          fonts: this.fonts,
          input: this.type === "input",
          antiAliasType: this.antiAliasType,
        }),
      };
    }

    return this.laid.layout;
  }

  /**
   * Fit the field to its text, as autoSize does: its height to the text's
   * and the gutters, and its width too unless it wraps, keeping its left,
   * centre or right edge where it was.
   */
  fit(): void {
    if (this.autoSize === "none") {
      return;
    }

    const layout = this.layout;
    const height = (layout.height + 2 * GUTTER) / 20;
    if (!this.wordWrap) {
      const width = (layout.width + 2 * GUTTER) / 20;
      const moved =
        this.autoSize === "center"
          ? (this.width - width) / 2
          : this.autoSize === "right"
            ? this.width - width
            : 0;
      if (moved !== 0) {
        this.matrix = { ...this.matrix, tx: Math.round((this.matrix.tx + moved) * 20) / 20 };
        this.invalidate(TRANSFORM);
      }

      this.width = width;
    }

    this.height = height;
    this.invalidate(CONTENT);
  }

  /** The text, \r between its lines. */
  get text(): string {
    return this.model.text;
  }

  /** The alignment of its first paragraph. */
  get align(): string {
    return (this.model.formats[0] ?? this.model.defaultFormat).align;
  }

  /** The end the selection was started at, within the text as it is now, which a script may have shortened. */
  get anchor(): number {
    return Math.min(this.anchorAt, this.model.text.length);
  }

  /** The caret, within the text as it is now. */
  get caret(): number {
    return Math.min(this.caretAt, this.model.text.length);
  }

  /** The selection's first and last index, in order. */
  get selection(): [number, number] {
    const [anchor, caret] = [this.anchor, this.caret];
    return anchor <= caret ? [anchor, caret] : [caret, anchor];
  }

  /** Select from `anchor` to `caret`, each kept within the text; a focused field shows its caret there. */
  select(anchor: number, caret: number): void {
    const length = this.model.text.length;
    const [a, c] = [Math.max(0, Math.min(length, anchor)), Math.max(0, Math.min(length, caret))];
    // A drag selects on every move, mostly what it had: redraw only for a change.
    if (a === this.anchor && c === this.caret) {
      return;
    }

    this.anchorAt = a;
    this.caretAt = c;
    this.invalidate(CONTENT);
  }
}
