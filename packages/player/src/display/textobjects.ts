// The text display objects: a StaticText's placed glyphs, and a
// TextField's model, rectangle, layout and selection.
import type { avm2 } from "@swf2es/runtime";
import type { FontSet } from "../text/fonts.js";
import {
  GUTTER,
  layoutText,
  maxScrollH,
  roomH,
  shownLines,
  type TextLayout,
  TWIPS,
} from "../text/layout.js";
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

/** The fields whose fit a set size left pending, for the frame to settle before it is drawn. */
const pendingFits = new Set<TextObject>();

/** Every pending fit applied, as Flash applies them before it draws. */
export function settleFits(): void {
  for (const field of pendingFits) {
    field.settle();
  }

  pendingFits.clear();
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
  /**
   * A script set the text, the size or the autoSize of a field that fits
   * itself: as in Flash, the fit waits for its size to be asked, its
   * transform to change or the frame to be drawn, and is by the autoSize it
   * has by then; a wordWrap set meanwhile wraps at the size the field has
   * (adl).
   */
  private fitPending = false;
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
  /**
   * How far the text is scrolled sideways, in twips: as a script or the
   * caret left it, and no further than new text scrolls, though a change of
   * type or size leaves it (adl).
   */
  private scrollX = 0;
  /** The text's revision the scroll was last kept within. */
  private scrolledRevision = -1;
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
    const csm = definition.csm;
    if (csm) {
      this.antiAliasType = csm.useFlashType ? "advanced" : "normal";
      this.gridFitType = ["none", "pixel", "subpixel"][csm.gridFit] ?? "none";
      this.thickness = csm.thickness;
      this.sharpness = csm.sharpness;
    }

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

    this.keepScroll();
    return this.laid.layout;
  }

  /** The scroll kept within new text's maxScrollH, as Flash keeps it as the text changes. */
  private keepScroll(): void {
    if (this.scrolledRevision !== this.model.revision) {
      this.scrolledRevision = this.model.revision;
      this.scrollX = Math.min(this.scrollX, maxScrollH(this));
    }
  }

  /** How far the text is scrolled sideways, in pixels to the twip. */
  get scrollH(): number {
    this.keepScroll();
    return this.scrollX / TWIPS;
  }

  set scrollH(pixels: number) {
    this.scrollX = Math.max(0, Math.round(pixels * TWIPS));
  }

  /**
   * Fit the field to its text, as autoSize does: its height to the text's
   * and the gutters, and its width too unless it wraps, keeping its left,
   * centre or right edge where it was.
   */
  fit(): void {
    if (this.autoSize === "none" || this.fitPending) {
      return;
    }

    const layout = this.layout;
    const height = (layout.height + 2 * GUTTER) / 20;
    if (!this.wordWrap) {
      // An input field is a little wider, by its default size, so that a caret
      // at its text's end is in view (adl: 97 twips at 20 points).
      const room =
        this.type === "input"
          ? Math.trunc((Math.max(0, this.model.defaultFormat.size) * TWIPS * 250) / 1024)
          : 0;
      const width = (layout.width + 2 * GUTTER + room) / 20;
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

  /** A script set its text, its size or its autoSize: under autoSize, the fit waits (fitPending). */
  deferFit(): void {
    if (this.autoSize !== "none" && !this.fitPending) {
      this.fitPending = true;
      pendingFits.add(this);
    }
  }

  /**
   * The fit left pending, applied: as its position, size or bounds are
   * asked, its transform is set, or the frame is drawn; not as its scale,
   * its rotation or its text metrics are asked, or its alpha set (adl).
   */
  settle(): void {
    if (this.fitPending) {
      this.fitPending = false;
      this.fit();
    }
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

  /**
   * Select from `anchor` to `caret`, each kept within the text; a focused
   * field shows its caret there, and scrolls to show `shown`, the caret
   * unless told otherwise, or nothing for null: as Flash Player's does for
   * setSelection and the caret's moves, but not for a script's text, nor
   * in a field without the focus (adl scrolls that too), which scrolls to
   * its caret as it takes the focus.
   */
  select(anchor: number, caret: number, shown: number | null = caret): void {
    const length = this.model.text.length;
    const [a, c] = [Math.max(0, Math.min(length, anchor)), Math.max(0, Math.min(length, caret))];
    // A drag selects on every move, mostly what it had: redraw only for a
    // change. The same selection again scrolls nowhere either (adl).
    if (a === this.anchor && c === this.caret) {
      return;
    }

    this.anchorAt = a;
    this.caretAt = c;
    if (shown !== null && this.focused) {
      this.scrollTo(shown);
    }

    this.invalidate(CONTENT);
  }

  /**
   * Scroll so that the place before character `index` is in view, as Flash
   * scrolls to its caret (adl): down or up by the fewest lines, and
   * sideways by steps of a quarter of the room inside the gutters, from
   * where the field was scrolled, as few as bring it in: a caret at the
   * room's right edge is out of it.
   */
  scrollTo(index: number): void {
    // By the size a pending fit gives it, as Flash scrolls an autoSize field.
    this.settle();
    const lines = this.layout.lines;
    if (lines.length === 0) {
      return;
    }

    const i = Math.max(0, Math.min(this.model.text.length, index));
    let at = lines.length - 1;
    for (let l = 0; l < lines.length; l++) {
      if (i < lines[l].end) {
        at = l;
        break;
      }
    }

    let first = Math.max(0, Math.min(this.scrollV - 1, lines.length - 1));
    if (at < first) {
      first = at;
    } else {
      while (first < at && first + shownLines(this, first) - 1 < at) {
        first++;
      }
    }

    const line = lines[at];
    let x = line.x;
    const c = line.chars[i - line.start];
    if (c) {
      x = c.x;
    } else {
      for (let k = line.chars.length - 1; k >= 0; k--) {
        if (line.chars[k].shown) {
          x = line.chars[k].x + line.chars[k].advance;
          break;
        }
      }
    }

    // In twips, from the text's left edge inside the gutter.
    const place = x - GUTTER;
    const room = roomH(this);
    const step = Math.floor(room / 4);
    let scroll = this.scrollX;
    if (place < scroll) {
      scroll = step > 0 ? scroll - Math.ceil((scroll - place) / step) * step : place;
    } else if (place >= scroll + room) {
      scroll =
        step > 0 ? scroll + (Math.floor((place - scroll - room) / step) + 1) * step : place - room;
    }

    scroll = Math.max(0, Math.min(scroll, maxScrollH(this)));
    if (first + 1 !== this.scrollV || scroll !== this.scrollX) {
      this.scrollV = first + 1;
      this.scrollX = scroll;
      this.invalidate(CONTENT);
    }
  }
}

const NO_OFFSET: readonly [number, number] = [0, 0];

/**
 * Where a text field's x and y are from its origin, in twips: its box's
 * corner, its DefineEditText bounds' corner scaled, as Flash and Ruffle
 * read and set a field's position, in AS3 and AVM1 alike. A box authored
 * inset from its origin so moves to where a script puts it. The offset is
 * whole twips, cut toward zero as Ruffle's is, and none for a NaN scale;
 * none for any other display object.
 */
export function fieldOffset(d: DisplayObject): readonly [number, number] {
  // Shared: every clip's _x and _y ask, the AVM1 hot path.
  if (!(d instanceof TextObject)) {
    return NO_OFFSET;
  }

  const twips = (v: number) => Math.trunc(v) || 0;
  return [twips(d.scaleX * d.left * 20), twips(d.scaleY * d.top * 20)];
}
