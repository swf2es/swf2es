// TextField.StyleSheet, AS2's, as Ruffle's (https://github.com/ruffle-rs/
// ruffle) core/src/avm1/globals/style_sheet.rs has it: MIT OR Apache-2.0,
// Copyright (c) 2018-2022 Ruffle LLC and Ruffle contributors. A sheet keeps
// each style object given it, copied, in `_css`, and the TextFormat its
// `transform` makes of it in `_styles`, both by the selector as given; and
// natively each TextFormat's format by the selector in lower case, which
// styles the HTML of a field the sheet is given to.
import { avm1 } from "@swf2es/runtime";
import { camelCase, fontList, parseCss } from "../../text/css.js";
import { emptyFormat, type PartialFormat } from "../../text/text.js";
import { formatOf, newTextFormat } from "./TextFormat.js";

type Value = avm1.Value;
type Obj = avm1.Avm1Object;

/** What the sheet needs of the movie. */
export interface StyleSheetHost {
  readonly realm: avm1.Realm;
}

const sheets = new WeakMap<Obj, Map<string, PartialFormat>>();

/** The formats of a sheet by selector in lower case; null for any other value. */
export function stylesOf(value: Value): Map<string, PartialFormat> | null {
  return value instanceof avm1.Avm1Object ? (sheets.get(value) ?? null) : null;
}

const FIXED = avm1.DONT_ENUM | avm1.DONT_DELETE | avm1.READ_ONLY | avm1.VERSION_7;

/** `TextField.StyleSheet`. */
export function styleSheetClass(host: StyleSheetHost): avm1.Avm1Function {
  const realm = host.realm;
  const proto = new avm1.Avm1Object(realm.objectProto);
  const constr = realm.classOf(
    proto,
    (self) => {
      sheets.set(self, new Map());
      return self;
    },
    () => undefined,
  );
  const method = (name: string, fn: avm1.Native) => proto.define(name, realm.method(fn), FIXED);

  /** An object's enumerable properties on a new Object; null for anything else. */
  const copy = (value: Value, version: number): Value => {
    if (!(value instanceof avm1.Avm1Object)) {
      return null;
    }

    const out = new avm1.Avm1Object(realm.objectProto);
    for (const key of avm1.keys(value, version)) {
      avm1.set(out, key, avm1.get(value, key, version), version);
    }

    return out;
  };
  /** `self[name]` as an object, an empty one for a primitive. */
  const stored = (self: Obj, name: string, version: number): Obj =>
    realm.box(avm1.get(self, name, version), version);
  const setStyle = (self: Obj, name: string, style: Value, version: number) => {
    for (const key of ["_styles", "_css"]) {
      if (!avm1.has(self, key, version)) {
        avm1.set(self, key, realm.newArray([], version), version);
      }
    }

    avm1.set(stored(self, "_css", version), name, copy(style, version), version);
    const transform = avm1.get(self, "transform", version);
    const format =
      transform instanceof avm1.Avm1Function
        ? transform.call(self, [copy(style, version)], version)
        : undefined;
    avm1.set(stored(self, "_styles", version), name, format, version);
    const change = formatOf(format);
    if (change !== null) {
      sheets.get(self)?.set(name.toLowerCase(), change);
    }
  };

  method("setStyle", (self, args, version) => {
    setStyle(self, avm1.stringOf(args[0], version), args[1], version);
    return undefined;
  });
  method("clear", (self, _, version) => {
    avm1.set(self, "_styles", realm.newArray([], version), version);
    avm1.set(self, "_css", realm.newArray([], version), version);
    return undefined;
  });
  method("getStyleNames", (self, _, version) =>
    realm.newArray(avm1.keys(stored(self, "_css", version), version), version),
  );
  // AVM1 loads nothing yet: no load starts, and false says so.
  method("load", () => false);
  method("getStyle", (self, args, version) =>
    copy(
      avm1.get(stored(self, "_css", version), avm1.stringOf(args[0], version), version),
      version,
    ),
  );
  method("transform", (_, args, version) => transform(realm, args, version));
  /** Each rule of the CSS set as a style; false for CSS Flash rejects. */
  const parse = (self: Obj, css: string, version: number): boolean => {
    const rules = parseCss(css);
    if (rules === null) {
      return false;
    }

    for (const [selector, properties] of rules) {
      if (selector === "") {
        continue;
      }

      const style = new avm1.Avm1Object(realm.objectProto);
      for (const [key, value] of properties) {
        avm1.set(style, camelCase(key), value, version);
      }

      setStyle(self, selector, style, version);
    }

    return true;
  };
  method("parseCSS", (self, args, version) =>
    parse(self, avm1.stringOf(args[0], version), version),
  );
  method("parse", (self, args, version) => parse(self, avm1.stringOf(args[0], version), version));

  return constr;
}

/** A style object's TextFormat, by the TextFormat class `_global` has now; null for none given. */
function transform(realm: avm1.Realm, args: Value[], version: number): Value {
  if (args.length === 0 || args[0] === undefined || args[0] === null) {
    return null;
  }

  const textFormat = avm1.get(realm.global, "TextFormat", version);
  const proto =
    textFormat instanceof avm1.Avm1Object ? avm1.get(textFormat, "prototype", version) : undefined;
  const format = emptyFormat();
  format.kerning = false;
  const style = args[0];
  if (style instanceof avm1.Avm1Object) {
    styleFormat(style, format, version);
  }

  return proto instanceof avm1.Avm1Object
    ? newTextFormat(proto, format)
    : newTextFormat(realm.objectProto, format);
}

/** A number as parseInt reads it, any suffix after it ignored, to an int. */
const suffixed = (value: Value, version: number): number =>
  avm1.parseIntAvm1(avm1.stringOf(value, version), undefined, false, version) | 0;

/** What a style object's CSS properties set in `format`. */
function styleFormat(style: Obj, format: PartialFormat, version: number): void {
  const get = (name: string): Value => avm1.get(style, name, version);
  // Some properties are read only where they convert to true.
  const truthy = (name: string): Value => {
    const v = get(name);
    return avm1.toBoolean(v, version) ? v : undefined;
  };

  // #RRGGBB exactly, in a string.
  const color = get("color");
  if (typeof color === "string" && /^#[0-9a-fA-F]{6}$/.test(color)) {
    format.color = Number.parseInt(color.slice(1), 16);
  }

  const display = get("display");
  if (display !== undefined) {
    const value = avm1.stringOf(display, version);
    format.display = value === "none" || value === "inline" ? value : "block";
  }

  const family = truthy("fontFamily");
  if (family !== undefined) {
    format.font = fontList(avm1.stringOf(family, version));
  }

  const size = get("fontSize");
  if (size !== undefined) {
    const n = suffixed(size, version);
    if (n > 0) {
      format.size = n;
    }
  }

  const fontStyle = avm1.stringOf(get("fontStyle"), version);
  if (fontStyle === "normal" || fontStyle === "italic") {
    format.italic = fontStyle === "italic";
  }

  const weight = avm1.stringOf(get("fontWeight"), version);
  if (weight === "normal" || weight === "bold") {
    format.bold = weight === "bold";
  }

  const kerning = get("kerning");
  if (kerning !== undefined) {
    format.kerning = kerning === "true" || suffixed(kerning, version) !== 0;
  }

  const leading = truthy("leading");
  if (leading !== undefined) {
    format.leading = suffixed(leading, version);
  }

  const spacing = truthy("letterSpacing");
  if (spacing !== undefined) {
    format.letterSpacing = avm1.parseIntAvm1(
      avm1.stringOf(spacing, version),
      undefined,
      false,
      version,
    );
  }

  const left = truthy("marginLeft");
  if (left !== undefined) {
    format.leftMargin = Math.max(0, suffixed(left, version));
  }

  const right = truthy("marginRight");
  if (right !== undefined) {
    format.rightMargin = Math.max(0, suffixed(right, version));
  }

  const align = get("textAlign");
  if (align !== undefined) {
    const value = avm1.stringOf(align, version).toLowerCase();
    if (["left", "center", "right", "justify"].includes(value)) {
      format.align = value;
    }
  }

  const decoration = get("textDecoration");
  if (decoration !== undefined) {
    const value = avm1.stringOf(decoration, version);
    if (value === "none" || value === "underline") {
      format.underline = value === "underline";
    }
  }

  const indent = truthy("textIndent");
  if (indent !== undefined) {
    format.indent = suffixed(indent, version);
  }
}
