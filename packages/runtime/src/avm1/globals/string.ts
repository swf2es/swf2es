// String, as Ruffle's (https://github.com/ruffle-rs/ruffle)
// core/src/avm1/globals/string.rs has it: MIT OR Apache-2.0, Copyright (c)
// 2018-2022 Ruffle LLC and Ruffle contributors. Where adl parts from
// Ruffle, adl decides (docs/avm1.md, "Array and String").
//
// The methods take `this` unboxed: a string's method call makes no String
// object. Up to SWF 5 a string is its bytes, each a code unit here, which
// the methods count and cut as they are. From SWF 6 they cut UTF-16 code
// units, and keep half a surrogate pair as it is, which joins its other
// half again (adl), unlike StringExtract's (operators.ts).

import { lowerCase, upperCase } from "../case.js";
import {
  type Avm1Function,
  Avm1Object,
  DONT_DELETE,
  DONT_ENUM,
  type RawNative,
} from "../objects.js";
import type { Realm } from "../realm.js";
import { stringOf, toNumber, type Value } from "../values.js";

const toInt = (value: Value, version: number) => toNumber(value, version) | 0;

/** An index as slice and substr take one: from the end where negative, within 0 and `length`. */
function wrapping(i: number, length: number): number {
  return i < 0 ? Math.max(length + i, 0) : Math.min(i, length);
}

/** An index as substring takes one: within 0 and `length`. */
const clamped = (i: number, length: number) => (i < 0 ? 0 : Math.min(i, length));

/** Each code unit of `s` mapped by `map`; up to SWF 5, a byte's mapping only to a byte. */
function mapped(s: string, map: (c: number) => number, bytes: boolean): string {
  let out = "";
  let changed = false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    let m = map(c);
    if (bytes && m > 0xff) {
      m = c;
    }

    changed ||= m !== c;
    out += String.fromCharCode(m);
  }

  return changed ? out : s;
}

/** The class: its constructor, prototype and methods. */
export function stringClass(realm: Realm): { constr: Avm1Function; proto: Avm1Object } {
  const proto = new Avm1Object();
  const constr = realm.classOf(
    proto,
    (self, args, version) => {
      const s = args.length > 0 ? stringOf(args[0], version) : "";
      self.primitive = s;
      self.define("length", s.length, DONT_ENUM | DONT_DELETE);
      return self;
    },
    (_, args, version) => (args.length > 0 ? stringOf(args[0], version) : ""),
  );
  proto.define("__proto__", realm.objectProto, DONT_ENUM | DONT_DELETE);

  /** `this` as the string the methods work on: a String's own, else what it converts to. */
  const text = (self: Value, version: number): string => {
    if (typeof self === "string") {
      return self;
    }

    const o = realm.box(self, version);
    return typeof o.primitive === "string" ? o.primitive : stringOf(o, version);
  };
  const define = (name: string, native: RawNative) =>
    proto.define(name, realm.rawMethod(native), DONT_ENUM | DONT_DELETE);

  // A String's own string, but undefined for anything else; valueOf gives
  // the object itself, as Object's would (adl; Ruffle gives undefined).
  const own = (self: Value): Value => {
    if (typeof self === "string") {
      return self;
    }

    return self instanceof Avm1Object && typeof self.primitive === "string"
      ? self.primitive
      : undefined;
  };
  define("valueOf", (self, _, version) => own(self) ?? realm.box(self, version));
  define("toString", (self) => own(self));
  define("toUpperCase", (self, _, version) => mapped(text(self, version), upperCase, version < 6));
  define("toLowerCase", (self, _, version) => mapped(text(self, version), lowerCase, version < 6));
  define("charAt", (self, args, version) => {
    const s = text(self, version);
    const i = toInt(args.length > 0 ? args[0] : undefined, version);
    if (i < 0 || i >= s.length) {
      return "";
    }

    return s[i];
  });
  define("charCodeAt", (self, args, version) => {
    const s = text(self, version);
    const i = toInt(args.length > 0 ? args[0] : undefined, version);
    if (i >= 0 && i < s.length) {
      return s.charCodeAt(i);
    }

    // A SWF 5 has 0 past the end.
    return i >= 0 && version === 5 ? 0 : Number.NaN;
  });
  define("concat", (self, args, version) => {
    let s = text(self, version);
    for (const arg of args) {
      s += stringOf(arg, version);
    }

    return s;
  });
  define("indexOf", (self, args, version) => {
    const s = text(self, version);
    if (args.length === 0) {
      return undefined;
    }

    const pattern = stringOf(args[0], version);
    const start =
      args.length > 1 && args[1] !== undefined ? Math.max(toInt(args[1], version), 0) : 0;
    return start > s.length ? -1 : s.indexOf(pattern, start);
  });
  define("lastIndexOf", (self, args, version) => {
    const s = text(self, version);
    if (args.length === 0) {
      return undefined;
    }

    const pattern = stringOf(args[0], version);
    let end = s.length;
    if (args.length > 1 && args[1] !== undefined) {
      const i = toInt(args[1], version);
      if (i < 0) {
        return -1;
      }

      end = Math.min(i + pattern.length, s.length);
    }

    const found = s.lastIndexOf(pattern, end - pattern.length);
    return found >= 0 && found + pattern.length <= end ? found : -1;
  });
  define("slice", (self, args, version) => {
    if (args.length === 0) {
      return undefined;
    }

    const s = text(self, version);
    const start = wrapping(toInt(args[0], version), s.length);
    const end =
      args.length > 1 && args[1] !== undefined
        ? wrapping(toInt(args[1], version), s.length)
        : s.length;
    return start < end ? s.slice(start, end) : "";
  });
  define("substring", (self, args, version) => {
    if (args.length === 0) {
      return undefined;
    }

    const s = text(self, version);
    let start = clamped(toInt(args[0], version), s.length);
    let end =
      args.length > 1 && args[1] !== undefined
        ? clamped(toInt(args[1], version), s.length)
        : s.length;
    if (end < start) {
      [start, end] = [end, start];
    }

    return s.slice(start, end);
  });
  define("split", (self, args, version) => {
    const s = text(self, version);
    const limitArg = args.length > 1 ? args[1] : undefined;
    const limit =
      limitArg === undefined ? Number.POSITIVE_INFINITY : Math.max(toInt(limitArg, version), 0);
    const d = args.length > 0 ? args[0] : undefined;
    const take = (parts: string[]) =>
      realm.newArray(limit < parts.length ? parts.slice(0, limit) : parts, version);
    // A SWF 5 splits at commas by default, and only at one character: an
    // empty or longer delimiter leaves the string whole (adl).
    if (version < 6) {
      const delimiter = d === undefined ? "," : stringOf(d, version);
      return take(delimiter.length === 1 ? s.split(delimiter) : [s]);
    }

    // Without a delimiter, the string whole, whatever the limit.
    if (d === undefined) {
      return realm.newArray([s], version);
    }

    const delimiter = stringOf(d, version);
    return take(delimiter === "" ? s.split("") : s.split(delimiter));
  });
  define("substr", (self, args, version) => {
    if (args.length === 0) {
      return undefined;
    }

    const s = text(self, version);
    const start = wrapping(toInt(args[0], version), s.length);
    const count = args.length > 1 && args[1] !== undefined ? toInt(args[1], version) : s.length;
    const end = wrapping(start + count, s.length);
    return start < end ? s.slice(start, end) : "";
  });

  constr.define(
    "fromCharCode",
    realm.method((_, args, version) => {
      let s = "";
      for (const arg of args) {
        const code = toNumber(arg, version) & 0xffff;
        if (code === 0) {
          break;
        }

        // A SWF 5's string is bytes: a code past 0xFF is two, the high one first.
        s +=
          version < 6 && code > 0xff
            ? String.fromCharCode(code >> 8, code & 0xff)
            : String.fromCharCode(code);
      }

      return s;
    }),
    DONT_ENUM | DONT_DELETE,
  );

  return { constr, proto };
}
