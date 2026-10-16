// The global functions and ASnative, as Ruffle's
// (https://github.com/ruffle-rs/ruffle) core/src/avm1/globals.rs and
// globals/asnative.rs have them: MIT OR Apache-2.0, Copyright (c)
// 2018-2022 Ruffle LLC and Ruffle contributors. Where adl parts from
// Ruffle, adl decides (docs/avm1.md, "The global functions").
//
// ASnative(category, index) gives a new function of Flash's table of
// natives each call; ASSetNative and ASSetNativeAccessor set an object's
// methods and properties from it, a version prefixed to a name hiding it
// from earlier SWFs.

import { parseFloatAvm1 } from "../numbers.js";
import {
  Avm1Function,
  type Native,
  set,
  VERSION_6,
  VERSION_7,
  VERSION_8,
  VERSION_9,
  VERSION_10,
} from "../objects.js";
import type { Realm } from "../realm.js";
import { stringOf, toNumber, type Value } from "../values.js";
import { timerFunctions } from "./timers.js";

const HEX = "0123456789ABCDEF";

// The web's and node's alike, though not ECMAScript's.
declare const TextEncoder: new () => { encode(s: string): Uint8Array };
const encoder = new TextEncoder();

/** A string's bytes: up to SWF 5 its characters, each a byte; from 6 its UTF-8. */
function bytesOf(s: string, version: number): ArrayLike<number> {
  if (version >= 6) {
    return encoder.encode(s);
  }

  const bytes: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c <= 0xff) {
      bytes.push(c);
    } else {
      bytes.push(...encoder.encode(s[i]));
    }
  }

  return bytes;
}

/** escape: every byte but a letter or a digit as %XX. */
export function escapeAvm1(s: string, version: number): string {
  const bytes = bytesOf(s, version);
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if ((b >= 0x30 && b <= 0x39) || (b >= 0x41 && b <= 0x5a) || (b >= 0x61 && b <= 0x7a)) {
      out += String.fromCharCode(b);
    } else {
      out += `%${HEX[b >> 4]}${HEX[b & 15]}`;
    }
  }

  return out;
}

const hexValue = (c: number): number =>
  c >= 0x30 && c <= 0x39
    ? c - 0x30
    : c >= 0x41 && c <= 0x46
      ? c - 0x37
      : c >= 0x61 && c <= 0x66
        ? c - 0x57
        : -1;

/**
 * unescape: %XX the byte XX, + a space; a % before what is no hex digit
 * drops that character. The bytes are a SWF 5's string, and from SWF 6
 * read as its strings' UTF-8 is (decodeLenient).
 */
export function unescapeAvm1(s: string, version: number): string {
  const bytes = bytesOf(s, version);
  const out: number[] = [];
  let remain = 0;
  let digits = 0;
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (b === 0x25) {
      remain = 2;
      digits = 0;
      continue;
    }

    if (remain > 0) {
      const v = hexValue(b);
      if (v < 0) {
        remain = 0;
        continue;
      }

      digits = (digits << 4) | v;
      remain--;
      if (remain === 0) {
        out.push(digits);
      }

      continue;
    }

    out.push(b === 0x2b ? 0x20 : b);
  }

  if (version < 6) {
    let text = "";
    for (const b of out) {
      text += String.fromCharCode(b);
    }

    return text;
  }

  return decodeLenient(out);
}

/** What ConvertUTF.c subtracts from the sum of a sequence of 1 to 6 bytes. */
const OFFSETS = [0, 0x3080, 0xe2080, 0x3c82080, 0xfa082080, 0x82082080];

/**
 * Bytes read as UTF-8 leniently, as adl reads a SWF 6's strings
 * (codegen's avm1/emit/strings.ts): a lead byte takes as many bytes as its
 * high bits say, continuation bytes or not, summed as Unicode's old
 * ConvertUTF.c sums them; a surrogate or a code point past U+10FFFF is
 * U+FFFD, and a code point of 0, or a sequence cut short, ends the string.
 */
export function decodeLenient(bytes: ArrayLike<number>): string {
  let out = "";
  let i = 0;
  while (i < bytes.length) {
    const b = bytes[i];
    if (b === 0) {
      break;
    }

    if (b < 0x80) {
      out += String.fromCharCode(b);
      i++;
      continue;
    }

    const more = b < 0xc0 ? 0 : b < 0xe0 ? 1 : b < 0xf0 ? 2 : b < 0xf8 ? 3 : b < 0xfc ? 4 : 5;
    if (more >= bytes.length - i) {
      break;
    }

    let c = 0;
    for (let k = 0; k <= more; k++) {
      c = ((c << 6) + bytes[i + k]) >>> 0;
    }

    c = (c - OFFSETS[more]) >>> 0;
    i += more + 1;
    if (c === 0) {
      break;
    }

    out += c > 0x10ffff || (c >= 0xd800 && c <= 0xdfff) ? "�" : String.fromCodePoint(c);
  }

  return out;
}

const isSign = (c: number) => c === 0x2b || c === 0x2d;

/**
 * parseInt, as Ruffle has it and adl agrees: "0x" after a sign is NaN
 * unless the radix reads it, a leading "0x" is hex whatever the radix, a
 * leading 0 octal where every digit after it is, spaces and a sign after
 * the prefix, NaN without a digit.
 */
export function parseIntAvm1(
  s: string,
  radixValue: Value,
  hasRadix: boolean,
  version: number,
): number {
  let radix = 0;
  if (hasRadix) {
    radix = toNumber(radixValue, version) | 0;
    if (radix < 2 || radix > 36) {
      return Number.NaN;
    }
  }

  const signed = s.length > 0 && isSign(s.charCodeAt(0));
  const off = signed ? 1 : 0;
  const zero = s.charCodeAt(off) === 0x30;
  const x = s.charCodeAt(off + 1);
  const hex = zero && (x === 0x78 || x === 0x58);
  let ignoreSign = false;
  let rest = s;
  if (hex) {
    if (signed) {
      if (radix <= 33) {
        return Number.NaN;
      }

      ignoreSign = true;
    } else {
      radix ||= 16;
      rest = s.slice(2);
    }
  } else if (zero && radix === 0 && /^[0-7]*$/.test(s.slice(1))) {
    radix = 8;
  } else {
    radix ||= 10;
  }

  let i = 0;
  while (i < rest.length) {
    const c = rest.charCodeAt(i);
    if (c !== 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) {
      break;
    }

    i++;
  }

  let sign = 1;
  if (i < rest.length && isSign(rest.charCodeAt(i))) {
    if (!ignoreSign && rest.charCodeAt(i) === 0x2d) {
      sign = -1;
    }

    i++;
  }

  let result = 0;
  let empty = true;
  for (; i < rest.length; i++) {
    const c = rest.charCodeAt(i);
    const d =
      c >= 0x30 && c <= 0x39
        ? c - 0x30
        : c >= 0x61 && c <= 0x7a
          ? c - 0x57
          : c >= 0x41 && c <= 0x5a
            ? c - 0x37
            : 99;
    if (d >= radix) {
      break;
    }

    result = result * radix + d;
    empty = false;
  }

  return empty ? Number.NaN : sign * result;
}

/** The version a name's prefix says, and the name without it: `8max` is max from SWF 8. */
function versioned(name: string): [string, number] {
  switch (name.charCodeAt(0)) {
    case 0x36:
      return [name.slice(1), VERSION_6];
    case 0x37:
      return [name.slice(1), VERSION_7];
    case 0x38:
      return [name.slice(1), VERSION_8];
    case 0x39:
      return [name.slice(1), VERSION_9];
    case 0x31:
      return name.charCodeAt(1) === 0x30 ? [name.slice(2), VERSION_10] : [name.slice(1), 0];
    default:
      return [name, 0];
  }
}

/**
 * The categories Flash Player has a table of natives for, as ranges: adl
 * gives a function for any index of these, and undefined for any other.
 * Those of the classes swf2es has no natives of yet give functions of none.
 */
const CATEGORIES = [
  [1, 5],
  [9, 9],
  [11, 15],
  [100, 107],
  [110, 113],
  [200, 200],
  [250, 253],
  [300, 301],
  [400, 400],
  [500, 500],
  [600, 600],
  [666, 667],
  [700, 700],
  [800, 800],
  [900, 901],
  [1021, 1021],
  [1066, 1067],
  [1100, 1103],
  [1105, 1112],
  [1999, 1999],
  [2100, 2102],
  [2104, 2104],
  [2106, 2108],
  [2150, 2151],
  [2198, 2198],
  [2200, 2201],
  [2204, 2205],
  [2341, 2341],
  [2401, 2401],
];

const isCategory = (category: number) =>
  CATEGORIES.some(([first, last]) => category >= first && category <= last);

/** ASnative(category, index): a new function of the table's native, undefined for no table. */
export function asnative(realm: Realm, category: number, index: number): Value {
  const table = realm.natives.get(category);
  if (table === undefined) {
    return isCategory(category) ? realm.method(none) : undefined;
  }

  // An index past a u16 is no native's.
  // Any index of a table is a function, one of none giving undefined.
  return realm.method(table(index > 0xffff ? 0xffff : index) ?? none);
}

/** ASSetNative (`accessor` false) and ASSetNativeAccessor. */
function setNative(realm: Realm, args: Value[], version: number, accessor: boolean): Value {
  if (args.length < 3) {
    return undefined;
  }

  const object = realm.box(args[0], version);
  const major = toNumber(args[1], version) | 0;
  const names = stringOf(args[2], version);
  let minor = args.length > 3 ? toNumber(args[3], version) | 0 : 0;
  for (const prefixed of names.split(",")) {
    const [name, flags] = versioned(prefixed);
    if (!accessor) {
      const f = asnative(realm, major, minor >>> 0);
      minor++;
      if (name !== "") {
        const had = object.own(name, version) !== undefined;
        set(object, name, f, version);
        const p = object.own(name, version);
        if (!had && p !== undefined) {
          p.flags |= flags;
        }
      }

      continue;
    }

    const getter = asnative(realm, major, minor >>> 0);
    const setter = asnative(realm, major, (minor + 1) >>> 0);
    minor += 2;
    if (name !== "" && getter instanceof Avm1Function) {
      const p = object.own(name, version) ?? object.add(name, undefined, 0);
      p.get = getter;
      p.set = setter instanceof Avm1Function ? setter : null;
      p.flags |= flags;
    }
  }

  return undefined;
}

/** The global functions, defined on `_global` in Flash's order by `define`. */
export function globalFunctions(realm: Realm, define: (name: string, native: Native) => void) {
  const escapeFn: Native = (_, args, version) =>
    args.length > 0 ? escapeAvm1(stringOf(args[0], version), version) : undefined;
  const unescapeFn: Native = (_, args, version) =>
    args.length > 0 ? unescapeAvm1(stringOf(args[0], version), version) : undefined;
  const parseIntFn: Native = (_, args, version) =>
    args.length > 0
      ? parseIntAvm1(stringOf(args[0], version), args[1], args.length > 1, version)
      : undefined;
  const parseFloatFn: Native = (_, args, version) =>
    args.length > 0 ? parseFloatAvm1(stringOf(args[0], version), false) : undefined;
  // _global.trace: undefined is "" up to SWF 6, as any string conversion has it.
  // Flash's authoring tool shows it, where Flash Player's log and adl's do
  // not; the log is for debugging, so it writes, as Ruffle's does.
  const traceFn: Native = (_, args, version) => {
    realm.current?.host.trace(stringOf(args.length > 0 ? args[0] : undefined, version));
    return undefined;
  };
  const setNativeFn: Native = (_, args, version) => setNative(realm, args, version, false);
  const setAccessorFn: Native = (_, args, version) => setNative(realm, args, version, true);

  realm.natives.set(
    100,
    (i) => [escapeFn, unescapeFn, parseIntFn, parseFloatFn, traceFn][i] ?? none,
  );
  realm.natives.set(4, (i) => [setNativeFn, setAccessorFn][i] ?? none);

  define("ASSetNative", setNativeFn);
  define("ASSetNativeAccessor", setAccessorFn);
  define("escape", escapeFn);
  define("unescape", unescapeFn);
  define("parseInt", parseIntFn);
  define("parseFloat", parseFloatFn);
  define("trace", traceFn);
  define("updateAfterEvent", () => undefined);
  define("isNaN", (_, args, version) =>
    args.length > 0 ? Number.isNaN(toNumber(args[0], version)) : true,
  );
  define("isFinite", (_, args, version) =>
    args.length > 0 ? Number.isFinite(toNumber(args[0], version)) : false,
  );
  for (const [name, native] of timerFunctions(realm)) {
    define(name, native);
  }
}

/** A table's native for an index it has none at: undefined. */
const none: Native = () => undefined;
