// TextFormat, AS2's, as Ruffle's (https://github.com/ruffle-rs/ruffle)
// core/src/avm1/globals/text_format.rs has it: MIT OR Apache-2.0,
// Copyright (c) 2018-2022 Ruffle LLC and Ruffle contributors. A TextFormat
// holds a PartialFormat (text/text.ts) natively, null for each value it
// does not set, which its properties read and write as Flash converts them.
import { avm1 } from "@swf2es/runtime";
import { TextObject } from "../../display/display.js";
import { applied, emptyFormat, type PartialFormat } from "../../text/text.js";

type Value = avm1.Value;
type Obj = avm1.Avm1Object;

const formats = new WeakMap<Obj, PartialFormat>();

/** The format a TextFormat holds; null for any other object. */
export function formatOf(value: Value): PartialFormat | null {
  return value instanceof avm1.Avm1Object ? (formats.get(value) ?? null) : null;
}

/** A number as Ruffle's round_to_even makes it an int: a half to even, what does not fit -2^31. */
function roundToEven(n: number): number {
  const r = Math.round(n);
  const even = Math.abs(n % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r;
  return Number.isFinite(even) && even <= 0x7fffffff && even >= -0x80000000 ? even : -0x80000000;
}

const unset = (v: Value) => v === undefined || v === null;

/** The most tab stops a TextFormat reads of an object. */
const MAX_TAB_STOPS = 0x10000;

/** A value of the integer kind as a SWF of `version` keeps it: to an int, wrapping, before 8; rounded from 8. */
function integer(v: Value, version: number, min: number | null): number {
  const n = avm1.toNumber(v, version);
  if (version < 8) {
    const i = n | 0;
    return min === null ? i : Math.max(min, i);
  }

  // Rust's max, which takes the other for NaN.
  return roundToEven(min === null ? n : Number.isNaN(n) ? min : Math.max(min, n));
}

/** Each property, and what it stores of a value set: undefined to leave it as it is. */
const PROPERTIES: [
  keyof PartialFormat,
  (v: Value, version: number) => PartialFormat[keyof PartialFormat] | undefined,
][] = [
  // Up to 64 characters of the name.
  ["font", (v, version) => (unset(v) ? null : avm1.stringOf(v, version).slice(0, 64))],
  ["size", (v, version) => (unset(v) ? null : integer(v, version, null))],
  ["color", (v, version) => (unset(v) ? null : avm1.toNumber(v, version) >>> 0)],
  ["url", (v, version) => (unset(v) ? null : avm1.stringOf(v, version))],
  ["target", (v, version) => (unset(v) ? null : avm1.stringOf(v, version))],
  ["bold", (v, version) => (unset(v) ? null : avm1.toBoolean(v, version))],
  ["italic", (v, version) => (unset(v) ? null : avm1.toBoolean(v, version))],
  ["underline", (v, version) => (unset(v) ? null : avm1.toBoolean(v, version))],
  // Neither nothing nor an unknown alignment changes it.
  [
    "align",
    (v, version) => {
      if (unset(v)) {
        return undefined;
      }

      const align = avm1.stringOf(v, version).toLowerCase();
      return ["left", "center", "right", "justify"].includes(align) ? align : undefined;
    },
  ],
  ["leftMargin", (v, version) => (unset(v) ? null : integer(v, version, 0))],
  ["rightMargin", (v, version) => (unset(v) ? null : integer(v, version, 0))],
  [
    "indent",
    (v, version) =>
      unset(v) ? null : version < 8 ? integer(v, version, 0) : integer(v, version, null),
  ],
  [
    "leading",
    (v, version) =>
      unset(v) ? null : version < 8 ? integer(v, version, 0) : integer(v, version, null),
  ],
  [
    "blockIndent",
    (v, version) =>
      unset(v) ? null : version < 8 ? integer(v, version, 0) : integer(v, version, null),
  ],
  // Any object's elements, by its length, at most 2^16 of them: a length a
  // script made up must not keep a native loop from the script timeout.
  [
    "tabStops",
    (v, version) => {
      if (!(v instanceof avm1.Avm1Object)) {
        return null;
      }

      const length = Math.min(
        avm1.toNumber(avm1.get(v, "length", version), version) | 0,
        MAX_TAB_STOPS,
      );
      const stops: number[] = [];
      for (let i = 0; i < length; i++) {
        stops.push(roundToEven(avm1.toNumber(avm1.get(v, String(i), version), version)));
      }

      return stops;
    },
  ],
  ["bullet", (v, version) => (unset(v) ? null : avm1.toBoolean(v, version))],
  // Nothing, or anything unknown, is a block.
  [
    "display",
    (v, version) => {
      const display = unset(v) ? "block" : avm1.stringOf(v, version);
      return display === "inline" || display === "none" ? display : "block";
    },
  ],
  ["kerning", (v, version) => (unset(v) ? null : avm1.toBoolean(v, version))],
  ["letterSpacing", (v, version) => (unset(v) ? null : avm1.toNumber(v, version))],
];

const STORES = new Map(PROPERTIES);

/** The constructor's parameters, in order: from size, the numbers are ints whatever the version. */
const PARAMETERS: (keyof PartialFormat)[] = [
  "font",
  "size",
  "color",
  "bold",
  "italic",
  "underline",
  "url",
  "target",
  "align",
  "leftMargin",
  "rightMargin",
  "indent",
  "leading",
];

/** What a TextFormat needs of the movie. */
export interface TextFormatHost {
  readonly realm: avm1.Realm;
}

/** A value of a format as a property gives it: null where it sets none, an array of tab stops. */
function propertyValue(
  format: PartialFormat,
  key: keyof PartialFormat,
  realm: avm1.Realm,
  version: number,
): Value {
  const v = format[key];
  if (v === null) {
    return null;
  }

  return Array.isArray(v) ? realm.newArray([...v], version) : v;
}

/** `_global.TextFormat`, and how to make one of a format. */
export function textFormatClass(host: TextFormatHost): {
  constr: avm1.Avm1Function;
  proto: Obj;
} {
  const realm = host.realm;
  const proto = new avm1.Avm1Object(realm.objectProto);
  const constr = realm.classOf(
    proto,
    (self, args, version) => {
      const format = emptyFormat();
      for (const [i, key] of PARAMETERS.entries()) {
        const v = args[i];
        const integral = i === 1 || i >= 9;
        const asInt = unset(v) ? null : avm1.toNumber(v, version) | 0;
        const stored = integral ? asInt : STORES.get(key)?.(v, version);
        if (stored !== undefined) {
          (format as Record<string, unknown>)[key] = stored;
        }
      }

      formats.set(self, format);
      return self;
    },
    () => undefined,
  );

  for (const [key, store] of PROPERTIES) {
    const p = proto.add(key, undefined, 0);
    p.get = realm.method((self, _, version) => {
      const format = formats.get(self);
      return format === undefined ? undefined : propertyValue(format, key, realm, version);
    });
    p.set = realm.method((self, args, version) => {
      const format = formats.get(self);
      if (format !== undefined) {
        const stored = store(args[0], version);
        if (stored !== undefined) {
          (format as Record<string, unknown>)[key] = stored;
        }
      }

      return undefined;
    });
  }

  proto.define(
    "getTextExtent",
    realm.method((self, args, version) => {
      const format = formats.get(self);
      return format === undefined ? undefined : textExtent(format, args, version);
    }),
    avm1.DONT_ENUM | avm1.DONT_DELETE,
  );

  return { constr, proto };
}

/** A TextFormat of `format`, of prototype `proto`, as a field's methods make one. */
export function newTextFormat(proto: Obj, format: PartialFormat): Obj {
  const o = new avm1.Avm1Object(proto);
  formats.set(o, { ...format, tabStops: format.tabStops === null ? null : [...format.tabStops] });
  return o;
}

/**
 * getTextExtent: `text` laid out in the format, in a field that fits it,
 * wrapped at a width where one is given: its first line's ascent and
 * descent, the text's width and height, and the field's.
 */
function textExtent(format: PartialFormat, args: Value[], version: number): Obj {
  const text = avm1.stringOf(args[0], version);
  const width = args.length > 1 && args[1] !== undefined ? avm1.toNumber(args[1], version) : null;
  const field = new TextObject(null);
  field.width = width ?? 0;
  field.wordWrap = width !== null;
  field.autoSize = "left";
  field.model.defaultFormat = applied(field.model.defaultFormat, format);
  field.model.setText(text);
  field.fit();
  const layout = field.layout;
  const first = layout.lines[0];
  const out = new avm1.Avm1Object();
  avm1.set(out, "ascent", (first?.ascent ?? 0) / 20, version);
  avm1.set(out, "descent", (first?.descent ?? 0) / 20, version);
  avm1.set(out, "width", layout.width / 20, version);
  avm1.set(out, "height", layout.height / 20, version);
  avm1.set(out, "textFieldHeight", field.height, version);
  avm1.set(out, "textFieldWidth", field.width, version);
  return out;
}
