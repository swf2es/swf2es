// The global functions, bugzilla, and Error.
import { messages } from "../messages.js";
import type { Value } from "../runtime.js";
import { type Natives, plain } from "./define.js";
import { qualifiedClassName } from "./object.js";

export const toplevelNatives: Natives = {
  // Global functions
  isNaN: (rt) => (v: Value) => Number.isNaN(rt.toNumber(v)),
  isFinite: (rt) => (v: Value) => Number.isFinite(rt.toNumber(v)),
  parseInt: (rt) => (s: Value, radix: Value) => Number.parseInt(rt.toString(s), rt.toInt(radix)),
  parseFloat: (rt) => (s: Value) => Number.parseFloat(rt.toString(s)),
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
