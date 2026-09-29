// The global functions, bugzilla, and Error.
import { messages } from "../messages.js";
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
      if (e instanceof URIError) {
        throw rt.error("URIError", 1052, name);
      }

      throw e;
    }
  });

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
    const cls = v !== null && typeof v === "object" && v.$it ? v : rt.traitsOf(v).cls;
    const base = cls?.$base;
    return base ? base.$it.name : null;
  },

  // As Toplevel::bugzilla: the bug fixes the builtins' AS3 asks about, all
  // in effect at the latest SWF version, as avmshell runs.
  bugzilla: plain((n: number) => n === 504525 || n === 574600 || n === 661330),

  // Error
  // Error.throwError fills in the template's %n: in debugger mode it has some.
  "Error.getErrorMessage": (rt) => (id: number) =>
    rt.debugger ? `Error #${id}: ${messages[id] ?? ""}` : `Error #${id}`,
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
