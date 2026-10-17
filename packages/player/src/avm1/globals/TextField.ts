// TextField, AS2's, as Ruffle's (https://github.com/ruffle-rs/ruffle)
// core/src/avm1/globals/text_field.rs has it: MIT OR Apache-2.0, Copyright
// (c) 2018-2022 Ruffle LLC and Ruffle contributors. A field's AVM1 object
// reads and writes the player's TextObject, its text and formats a
// TextModel (text/text.ts) as AS3's TextField's are; its properties are
// accessors on the prototype, which find the field each time, so that any
// other object given them reads undefined.
import { avm1 } from "@swf2es/runtime";
import { CONTENT, type DisplayObject, TextObject } from "../../display/display.js";
import { maxScrollV, shownLines } from "../../text/layout.js";
import { applied, emptyFormat, type PartialFormat } from "../../text/text.js";
import { DEPTH_BIAS } from "./MovieClip.js";
import { stylesOf } from "./StyleSheet.js";
import { formatOf, newTextFormat } from "./TextFormat.js";

type Value = avm1.Value;
type Obj = avm1.Avm1Object;

/** What TextField needs of the movie. */
export interface TextFieldHost {
  readonly realm: avm1.Realm;
  readonly version: number;
  /** removeTextField: `d` removed, where a script may remove it. */
  remove(d: DisplayObject): void;
  /** The field's text changed by a script: the variable it is bound to takes it. */
  textChanged(field: TextObject): void;
  /** The field's variable set: bound to it from now on. */
  variableChanged(field: TextObject): void;
}

/** What a field has only for AVM1, beside what the player keeps for both VMs. */
export interface FieldState {
  html: boolean;
  variable: string | null;
  /** Its tabIndex, undefined for none. */
  tabIndex: number | undefined;
  /** The object given as its styleSheet, undefined for none. */
  styleSheet: Obj | undefined;
  /** Whether it has a selection: not until it is focused or one is set, nor after it loses the focus. */
  selected: boolean;
}

const states = new WeakMap<TextObject, FieldState>();

/** `field`'s AVM1 state, at first as its DefineEditText gives it. */
export function stateOf(field: TextObject): FieldState {
  let state = states.get(field);
  if (state === undefined) {
    const edit = field.definition?.definition;
    state = {
      html: edit?.html ?? false,
      variable: edit?.variable ? edit.variable : null,
      tabIndex: undefined,
      styleSheet: undefined,
      selected: false,
    };
    states.set(field, state);
  }

  return state;
}

/** The field `self` is the AVM1 object of, where it is one's. */
function fieldOf(self: Value): TextObject | null {
  if (!(self instanceof avm1.Avm1Object) || self.display === null) {
    return null;
  }

  const d = self.display.live()?.display?.target;
  return d instanceof TextObject ? d : null;
}

/** The text or the field changed: drawn again, and fitted to its text under autoSize. */
function changed(field: TextObject): void {
  field.invalidate(CONTENT);
  field.fit();
}

/** Whether the field's text is read as HTML: an HTML field's, or one with a style sheet. */
const isHtml = (field: TextObject) => {
  const state = stateOf(field);
  return state.html || state.styleSheet !== undefined;
};

/**
 * HTML read into the field: under a style sheet, styled by it, and kept,
 * as htmlText gives it back and a new sheet styles it again.
 */
function parseHtml(field: TextObject, html: string): void {
  const styles = stylesOf(stateOf(field).styleSheet);
  if (styles === null) {
    field.model.setHtml(html, field.multiline);
    return;
  }

  field.htmlSource = html;
  field.model.setHtml(html, field.multiline, false, (selector) => styles.get(selector) ?? null);
}

/**
 * `field`'s text set: as HTML under a style sheet. The text it has already
 * changes nothing, its formats included (Ruffle's set_text).
 */
function setText(field: TextObject, text: string): void {
  if (text === field.model.text) {
    return;
  }

  if (stateOf(field).styleSheet !== undefined) {
    parseHtml(field, text);
  } else {
    field.model.setText(text);
  }

  changed(field);
}

/**
 * `field`'s text set as HTML, as htmlText and a bound variable set it, in
 * a field not HTML as its text. The HTML it has already changes nothing.
 */
export function setHtmlText(field: TextObject, html: string): void {
  if (html === htmlTextOf(field)) {
    return;
  }

  if (!isHtml(field)) {
    setText(field, html);
    return;
  }

  parseHtml(field, html);
  changed(field);
}

/** The field's text as HTML, the HTML a sheet styled as it was set, where it is HTML; else its text. */
export function htmlTextOf(field: TextObject): string {
  if (!isHtml(field)) {
    return field.model.text;
  }

  return field.htmlSource ?? field.model.toHtml();
}

/** An index as Rust's `as usize` makes a u32 of a value: wrapped to 32 bits. */
const indexOf = (v: Value, version: number) => avm1.toNumber(v, version) >>> 0;

/** A colour as Flash keeps one: 24 bits of a u32. */
const rgbOf = (v: Value, version: number) => (avm1.toNumber(v, version) >>> 0) & 0xffffff;

/** `_global.TextField`. */
export function textFieldClass(host: TextFieldHost): { constr: avm1.Avm1Function; proto: Obj } {
  const realm = host.realm;
  const proto = new avm1.Avm1Object(realm.objectProto);
  const constr = realm.classOf(
    proto,
    (self) => self,
    () => undefined,
  );

  /** `_global.TextFormat.prototype`, as it is now. */
  const formatProto = (version: number): Value => {
    const textFormat = avm1.get(realm.global, "TextFormat", version);
    return textFormat instanceof avm1.Avm1Object
      ? avm1.get(textFormat, "prototype", version)
      : undefined;
  };
  const textFormat = (format: PartialFormat, version: number): Value => {
    const p = formatProto(version);
    return p instanceof avm1.Avm1Object ? newTextFormat(p, format) : undefined;
  };

  const method = (
    name: string,
    flags: number,
    fn: (field: TextObject, args: Value[], version: number) => Value,
  ) => {
    proto.define(
      name,
      realm.method((self, args, version) => {
        const field = fieldOf(self);
        return field === null ? undefined : fn(field, args, version);
      }),
      avm1.DONT_ENUM | avm1.DONT_DELETE | flags,
    );
  };
  const property = (
    name: string,
    get: (field: TextObject, version: number) => Value,
    set: ((field: TextObject, value: Value, version: number) => void) | null,
    flags = 0,
  ) => {
    const p = proto.add(name, undefined, flags);
    p.get = realm.method((self, _, version) => {
      const field = fieldOf(self);
      return field === null ? undefined : get(field, version);
    });
    if (set !== null) {
      p.set = realm.method((self, args, version) => {
        const field = fieldOf(self);
        if (field !== null) {
          set(field, args[0], version);
        }

        return undefined;
      });
    }
  };
  const flag = (
    name: string,
    get: (field: TextObject) => boolean,
    set: (field: TextObject, value: boolean) => void,
  ) =>
    property(name, get, (field, value, version) => {
      set(field, avm1.toBoolean(value, version));
      changed(field);
    });

  // The selection replaced, at the start where there is none, the caret after what came in.
  method("replaceSel", avm1.VERSION_6, (field, args, version) => {
    const text = avm1.stringOf(args[0], version);
    const state = stateOf(field);
    const [begin, end] = state.selected ? field.selection : [0, 0];
    state.selected = true;
    field.model.replace(begin, end, text);
    field.select(begin + text.length, begin + text.length);
    changed(field);
    host.textChanged(field);
    return undefined;
  });
  // [begin, end), one character from begin, or the whole text.
  method("getTextFormat", avm1.VERSION_6, (field, args, version) => {
    const length = field.model.text.length;
    let begin = 0;
    let end = length;
    if (args.length > 0) {
      begin = indexOf(args[0], version);
      end = args.length > 1 ? indexOf(args[1], version) : begin + 1;
    }

    end = Math.min(end, length);
    if (begin >= end) {
      return textFormat(emptyFormat(), version);
    }

    return textFormat(field.model.formatOf(begin, end), version);
  });
  method("setTextFormat", avm1.VERSION_6, (field, args, version) => {
    const length = field.model.text.length;
    let begin = 0;
    let end = length;
    let format: Value;
    if (args.length >= 3) {
      begin = indexOf(args[0], version);
      end = indexOf(args[1], version);
      format = args[2];
    } else if (args.length === 2) {
      begin = indexOf(args[0], version);
      end = begin + 1;
      format = args[1];
    } else if (args.length === 1) {
      format = args[0];
    } else {
      return undefined;
    }

    const change = formatOf(format);
    end = Math.min(end, length);
    if (change !== null && begin < end) {
      field.model.setFormat(change, begin, end);
      changed(field);
    }

    return undefined;
  });
  method("removeTextField", avm1.VERSION_6, (field) => {
    host.remove(field);
    return undefined;
  });
  method("getNewTextFormat", avm1.VERSION_6, (field, _, version) =>
    textFormat(field.model.defaultFormat, version),
  );
  method("setNewTextFormat", avm1.VERSION_6, (field, args) => {
    const change = formatOf(args[0]);
    if (change !== null) {
      field.model.defaultFormat = applied(field.model.defaultFormat, change);
    }

    return undefined;
  });
  method("getDepth", avm1.READ_ONLY | avm1.VERSION_6, (field) =>
    field.depth === null ? undefined : field.depth - DEPTH_BIAS,
  );
  // The indices as Rust casts them to usize, NaN and below 0 to 0; a range backwards is none.
  method("replaceText", avm1.VERSION_7, (field, args, version) => {
    const model = field.model;
    const usize = (v: Value) => Math.max(0, Math.trunc(avm1.toNumber(v, version)) || 0);
    const from = usize(args[0]);
    const to = usize(args[1]);
    const text = avm1.stringOf(args[2], version);
    if (to < from) {
      return undefined;
    }

    model.replace(Math.min(from, model.text.length), Math.min(to, model.text.length), text);
    changed(field);
    return undefined;
  });

  // An unknown one is left as it was.
  property(
    "gridFitType",
    (field) => field.gridFitType,
    (field, value, version) => {
      const type = avm1.stringOf(value, version);
      if (type === "pixel" || type === "subpixel" || type === "none") {
        field.gridFitType = type;
      }
    },
    avm1.VERSION_8,
  );
  property(
    "antiAliasType",
    (field) => field.antiAliasType,
    (field, value, version) => {
      const type = avm1.stringOf(value, version);
      if (type === "normal" || type === "advanced") {
        field.antiAliasType = type;
      }
    },
    avm1.VERSION_8,
  );
  property(
    "thickness",
    (field) => field.thickness,
    (field, value, version) => {
      field.thickness = Math.fround(avm1.toNumber(value, version));
    },
    avm1.VERSION_8,
  );
  property(
    "sharpness",
    (field) => field.sharpness,
    (field, value, version) => {
      field.sharpness = Math.fround(avm1.toNumber(value, version));
    },
    avm1.VERSION_8,
  );
  // No AS2 filter draws yet: a field has none, and takes none.
  property(
    "filters",
    (_, version) => realm.newArray([], version),
    () => {},
    avm1.DONT_DELETE | avm1.VERSION_8,
  );
  property(
    "scroll",
    (field) => field.scrollV,
    // NaN, a negative line and one past where Flash's count overflows are the first (Ruffle).
    (field, value, version) => {
      const n = avm1.toNumber(value, version);
      const line = Number.isNaN(n) || n < 0 || n >= 767100486418433 ? 1 : Math.trunc(n);
      field.scrollV = Math.max(1, Math.min(line, maxScrollV(field)));
      field.invalidate(CONTENT);
    },
  );
  property("maxscroll", (field) => maxScrollV(field), null);
  property(
    "borderColor",
    (field) => field.borderColor,
    (field, value, version) => {
      field.borderColor = rgbOf(value, version);
      changed(field);
    },
  );
  property(
    "backgroundColor",
    (field) => field.backgroundColor,
    (field, value, version) => {
      field.backgroundColor = rgbOf(value, version);
      changed(field);
    },
  );
  // The new text's colour, and every character's.
  property(
    "textColor",
    (field) => field.model.defaultFormat.color,
    (field, value, version) => {
      const color = rgbOf(value, version);
      const model = field.model;
      const change = emptyFormat();
      change.color = color;
      model.setFormat(change, 0, model.text.length);
      model.defaultFormat = { ...model.defaultFormat, color };
      changed(field);
    },
  );
  // A u32, kept as an int; nothing is none.
  property(
    "tabIndex",
    (field) => {
      const index = stateOf(field).tabIndex;
      return index === undefined ? undefined : index >>> 0;
    },
    (field, value, version) => {
      stateOf(field).tabIndex =
        value === undefined || value === null ? undefined : avm1.toNumber(value, version) | 0;
    },
  );
  property(
    "autoSize",
    (field) => field.autoSize,
    (field, value, version) => {
      let mode = "none";
      if (typeof value === "boolean") {
        mode = value ? "left" : "none";
      } else {
        const name = avm1.stringOf(value, version).toLowerCase();
        mode = name === "left" || name === "center" || name === "right" ? name : "none";
      }

      field.autoSize = mode;
      field.fit();
    },
  );
  property(
    "text",
    (field) => field.model.text,
    (field, value, version) => {
      setText(field, avm1.stringOf(value, version));
      host.textChanged(field);
    },
  );
  // Anything but input or dynamic, in any case, leaves it.
  property(
    "type",
    (field) => field.type,
    (field, value, version) => {
      const type = avm1.stringOf(value, version).toLowerCase();
      if (type === "input" || type === "dynamic") {
        field.type = type;
        changed(field);
      }
    },
  );
  // Read as HTML only in an HTML field; it does not change a bound variable.
  property(
    "htmlText",
    (field) => htmlTextOf(field),
    (field, value, version) => setHtmlText(field, avm1.stringOf(value, version)),
  );
  // None is null.
  property(
    "variable",
    (field) => stateOf(field).variable,
    (field, value, version) => {
      const name = value === undefined || value === null ? null : avm1.stringOf(value, version);
      stateOf(field).variable = name === "" ? null : name;
      host.variableChanged(field);
    },
  );
  property(
    "hscroll",
    (field) => field.scrollH,
    (field, value, version) => {
      field.scrollH = Math.max(0, avm1.toNumber(value, version) | 0);
      field.invalidate(CONTENT);
    },
  );
  property("maxhscroll", (field) => maxHScroll(field), null);
  // None is null.
  property(
    "maxChars",
    (field) => (field.maxChars === 0 ? null : field.maxChars),
    (field, value, version) => {
      field.maxChars = avm1.toNumber(value, version) | 0;
    },
  );
  flag(
    "embedFonts",
    (field) => field.embedFonts,
    (field, v) => {
      field.embedFonts = v;
    },
  );
  property(
    "html",
    (field) => stateOf(field).html,
    (field, value, version) => {
      stateOf(field).html = avm1.toBoolean(value, version);
    },
  );
  flag(
    "border",
    (field) => field.border,
    (field, v) => {
      field.border = v;
    },
  );
  flag(
    "background",
    (field) => field.background,
    (field, v) => {
      field.background = v;
    },
  );
  flag(
    "wordWrap",
    (field) => field.wordWrap,
    (field, v) => {
      field.wordWrap = v;
    },
  );
  flag(
    "password",
    (field) => field.displayAsPassword,
    (field, v) => {
      field.displayAsPassword = v;
    },
  );
  flag(
    "multiline",
    (field) => field.multiline,
    (field, v) => {
      field.multiline = v;
    },
  );
  flag(
    "selectable",
    (field) => field.selectable,
    (field, v) => {
      field.selectable = v;
    },
  );
  property("length", (field) => field.model.text.length, null);
  property(
    "bottomScroll",
    (field) => field.scrollV + shownLines(field, field.scrollV - 1) - 1,
    null,
  );
  // In whole pixels, cut.
  property("textWidth", (field) => Math.trunc(field.layout.width / 20), null);
  property("textHeight", (field) => Math.trunc(field.layout.height / 20), null);
  // None, and an empty one, is null.
  property(
    "restrict",
    (field) => field.restrict,
    (field, value, version) => {
      const restrict = value === undefined || value === null ? "" : avm1.stringOf(value, version);
      field.restrict = restrict === "" ? null : restrict;
    },
  );
  flag(
    "condenseWhite",
    (field) => field.condenseWhite,
    (field, v) => {
      field.condenseWhite = v;
    },
  );
  flag(
    "mouseWheelEnabled",
    (field) => field.mouseWheelEnabled,
    (field, v) => {
      field.mouseWheelEnabled = v;
    },
  );
  // Any object but a clip, and nothing for anything else (Ruffle, whose clips are values of
  // their own). The HTML a sheet styled is styled again by a new one, and forgotten with
  // none (Ruffle's set_style_sheet).
  property(
    "styleSheet",
    (field) => stateOf(field).styleSheet,
    (field, value) => {
      const sheet = value instanceof avm1.Avm1Object && value.typeOf() !== "movieclip";
      stateOf(field).styleSheet = sheet ? value : undefined;
      if (stateOf(field).styleSheet === undefined) {
        field.htmlSource = null;
      } else if (field.htmlSource !== null) {
        parseHtml(field, field.htmlSource);
      }

      changed(field);
    },
  );

  return { constr, proto };
}

/** How far the text scrolls sideways: its width past the field's, in whole pixels. */
function maxHScroll(field: TextObject): number {
  if (field.wordWrap) {
    return 0;
  }

  const over = field.layout.width / 20 + 4 - field.width;
  return over > 0 ? Math.trunc(over) : 0;
}
