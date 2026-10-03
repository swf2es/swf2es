// The global functions, bugzilla, and Error.

import { formatClassName } from "../names.js";
import { errorMessages } from "../player-messages.js";
import type { ClassHook, Runtime, Value } from "../runtime.js";
import { type Natives, plain } from "./define.js";
import { qualifiedClassName } from "./object.js";

/** A String argument as avmplus has it: null, as undefined coerced to String is, as "null". */
const text = (rt: Runtime, s: Value): string =>
  s === null || s === undefined ? "null" : rt.toString(s);

/**
 * A native of one String argument whose default is "undefined", as the URI
 * functions and escape and unescape declare it: none given is the default,
 * where an undefined given is coerced to null. A function, not an arrow,
 * for `arguments`, and so that its length is 1.
 */
const ofText = (f: (rt: Runtime, s: string) => string) => (rt: Runtime) =>
  function (s: Value): string {
    // biome-ignore lint/complexity/noArguments: how many were given, which a rest parameter would make its length 0
    return f(rt, arguments.length === 0 ? "undefined" : text(rt, s));
  };

/**
 * As Toplevel's URI functions, which are ECMAScript 3's, as JavaScript's
 * are (bugzilla 609416, the fix for surrogate pairs, in effect as avmshell
 * runs): JavaScript's own, with URIError 1052, naming the function, for a
 * malformed URI.
 */
const uri = (name: string, f: (s: string) => string) =>
  ofText((rt, s) => {
    try {
      return f(s);
    } catch (e) {
      if (!(e instanceof URIError)) {
        throw e;
      }

      const decoded = f === decodeURI || f === decodeURIComponent ? surrogates(s, f) : null;
      if (decoded === null) {
        throw rt.error("URIError", 1052, name);
      }

      return decoded;
    }
  });

/** A UTF-8 encoded surrogate, which JavaScript's decoding refuses. */
const ENCODED_SURROGATE = /%[eE][dD]%[aAbB][0-9a-fA-F]%[89aAbB][0-9a-fA-F]/g;

/**
 * As Toplevel::decode, which decodes a surrogate's code point as any other
 * (Utf8ToUcs4): the parts between them JavaScript's, or null if one fails.
 */
function surrogates(s: string, f: (s: string) => string): string | null {
  const out: string[] = [];
  let at = 0;
  for (const m of s.matchAll(ENCODED_SURROGATE)) {
    const b1 = Number.parseInt(m[0].slice(4, 6), 16);
    const b2 = Number.parseInt(m[0].slice(7, 9), 16);
    out.push(s.slice(at, m.index), String.fromCharCode(0xd000 | ((b1 & 0x3f) << 6) | (b2 & 0x3f)));
    at = m.index + m[0].length;
  }

  if (at === 0) {
    return null;
  }

  out.push(s.slice(at));
  try {
    return out.map((part, i) => (i % 2 === 0 ? f(part) : part)).join("");
  } catch {
    return null;
  }
}

export const toplevelNatives: Natives = {
  // Global functions
  isNaN: (rt) => (v: Value) => Number.isNaN(rt.toNumber(v)),
  isFinite: (rt) => (v: Value) => Number.isFinite(rt.toNumber(v)),
  parseInt: (rt) => (s: Value, radix: Value) => Number.parseInt(rt.toString(s), rt.toInt(radix)),
  parseFloat: (rt) => (s: Value) => Number.parseFloat(rt.toString(s)),
  decodeURI: uri("decodeURI", decodeURI),
  decodeURIComponent: uri("decodeURIComponent", decodeURIComponent),
  encodeURI: uri("encodeURI", encodeURI),
  encodeURIComponent: uri("encodeURIComponent", encodeURIComponent),
  // As Toplevel::escape and unescape, which are ECMAScript's B.2.1 and B.2.2,
  // as JavaScript's are: the same unescaped set, %XX and %uXXXX.
  escape: ofText((_rt, s) => escape(s)),
  unescape: ofText((_rt, s) => unescape(s)),
  "avmplus::getQualifiedClassName": (rt) => (v: Value) => qualifiedClassName(rt, v),
  "avmplus::getQualifiedSuperclassName": (rt) => (v: Value) => {
    // null's and void's traits have no base.
    if (v === null || v === undefined) {
      return null;
    }

    const cls = v !== null && typeof v === "object" && v.$it ? v : rt.traitsOf(v).cls;
    const base = cls?.$base;
    return base ? formatClassName(base.$it.name) : null;
  },

  // As Toplevel::bugzilla: the bug fixes the builtins' AS3 asks about, all
  // in effect at the latest SWF version, as avmshell runs.
  bugzilla: plain((n: number) => n === 504525 || n === 574600 || n === 661330),

  // Error
  // Error.throwError fills in the template's %n: in debugger mode it has some.
  // The debugger player writes the template as it is, %1 and all; an id it has no text for is the number alone.
  "Error.getErrorMessage": (rt) => (id: number) =>
    rt.debugger && errorMessages[id] ? `Error #${id}: ${errorMessages[id]}` : `Error #${id}`,
  "Error#getStackTrace": plain(() => null),
};

/**
 * The native error classes, which construct an error when called, as
 * ErrorClass::call does: Error("x") is new Error("x"), not a coercion.
 * flash.errors' are AS3 classes, and coerce.
 */
const constructs: ClassHook = { call: (rt, cls, args) => rt.constructClass(cls, args) };

export const errorHooks: Record<string, ClassHook> = Object.fromEntries(
  [
    "Error",
    "DefinitionError",
    "EvalError",
    "RangeError",
    "ReferenceError",
    "SecurityError",
    "SyntaxError",
    "TypeError",
    "URIError",
    "VerifyError",
    "UninitializedError",
    "ArgumentError",
  ].map((name) => [name, constructs]),
);
