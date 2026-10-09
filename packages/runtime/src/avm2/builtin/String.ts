// String: its natives, held to String.decl.ts. `this` is the string, and
// a String parameter's argument is a string or null (see bind.ts).

import type { Value } from "../descriptors.js";
import type { ClassHook } from "../hooks.js";
import { lowerCase, upperCase } from "../natives/case.js";
import { conversion } from "../natives/define.js";
import { compile, matchArray, replacement as replacementOf } from "../natives/regexp.js";
import type { Runtime } from "../runtime.js";
import { bindNatives } from "./bind.js";
import { StringDecl } from "./String.decl.js";

/** A String argument as avmplus' natives read one: null as "null". */
const stringArg = (s: string | null): string => s ?? "null";

function replace(rt: Runtime, s: string, pattern: Value, replacement: Value): string {
  const p = pattern?.$re instanceof RegExp ? pattern.$re : rt.toString(pattern);
  if (replacement !== null && typeof replacement === "object" && replacement.$f) {
    // The function gets the match, its groups, its position and the string.
    return s.replace(p, (...a: Value[]) => {
      const args = typeof a[a.length - 1] === "object" ? a.slice(0, -1) : a;
      return rt.toString(rt.callValue(replacement, null, args, null));
    });
  }

  const text = rt.toString(replacement);
  return s.replace(p, p instanceof RegExp ? replacementOf(p, text) : text);
}

// A string pattern is a RegExp's, as avmplus makes one of it.
function search(rt: Runtime, s: string, pattern: Value): number {
  return s.search(pattern?.$re instanceof RegExp ? pattern.$re : compile(rt.toString(pattern), ""));
}

function match(rt: Runtime, s: string, pattern: Value): Value {
  const re: RegExp =
    pattern?.$re instanceof RegExp ? pattern.$re : compile(rt.toString(pattern), "");
  if (!re.global) {
    const m = s.match(re);
    return m ? matchArray(rt, m) : null;
  }

  // As RegExpObject::match: each match from where the last ended, until
  // one fails or is empty, so none is an empty Array; lastIndex is then
  // where the last try ended, 0 for a failed one, one on if it was there.
  const old = re.lastIndex;
  const found: string[] = [];
  let at = 0;
  for (;;) {
    re.lastIndex = at;
    const m = re.exec(s);
    const last = at;
    at = m ? m.index + m[0].length : 0;
    if (!m || at === last) {
      break;
    }

    found.push(m[0]);
  }

  re.lastIndex = at === old ? at + 1 : at;
  return rt.array(found);
}

function split(rt: Runtime, s: string, delimiter: Value, limit: number): Value {
  // The empty string splits to itself, whatever the delimiter, as avmplus has it.
  if (s === "") {
    return rt.array(limit === 0 ? [] : [""]);
  }

  if (delimiter?.$re instanceof RegExp) {
    return rt.array(s.split(delimiter.$re, limit >= 0 ? limit : undefined));
  }

  const parts = s.split(rt.toString(delimiter));
  return rt.array(limit >= 0 && limit < parts.length ? parts.slice(0, limit) : parts);
}

export const stringNatives = bindNatives(
  StringDecl,
  (rt) =>
    class StringNatives {
      // Its class hook makes new String(x) the string: this never runs on one.
      String() {}

      static "AS3::fromCharCode"(...codes: Value[]) {
        return String.fromCharCode(...codes.map((c) => rt.toUint(c) & 0xffff));
      }

      static "private::_replace"(s: string | null, pattern: Value, replacement: Value) {
        return replace(rt, stringArg(s), pattern, replacement);
      }

      static "private::_search"(s: string | null, pattern: Value) {
        return search(rt, stringArg(s), pattern);
      }

      static "private::_match"(s: string | null, pattern: Value) {
        return match(rt, stringArg(s), pattern);
      }

      static "private::_split"(s: string | null, delimiter: Value, limit: number) {
        return split(rt, stringArg(s), delimiter, limit);
      }

      get length(): number {
        return (this as unknown as string).length;
      }

      "AS3::charAt"(this: string, i: number) {
        return this.charAt(i);
      }

      "AS3::charCodeAt"(this: string, i: number) {
        return this.charCodeAt(i);
      }

      "AS3::indexOf"(this: string, s: string | null, i: number) {
        return this.indexOf(stringArg(s), i);
      }

      // As String::lastIndexOf, from INTCLAMP: from before the start nothing matches.
      "AS3::lastIndexOf"(this: string, s: string | null, i: number) {
        return i <= -1 ? -1 : this.lastIndexOf(stringArg(s), i);
      }

      // As String::Compare: the first difference of their character codes,
      // else which is longer.
      "AS3::localeCompare"(this: string, other: Value) {
        const o = rt.toString(other);
        const n = Math.min(this.length, o.length);
        for (let i = 0; i < n; i++) {
          const d = this.charCodeAt(i) - o.charCodeAt(i);
          if (d) {
            return d;
          }
        }

        return Math.sign(this.length - o.length);
      }

      "AS3::slice"(this: string, start: number, end: number) {
        return this.slice(start, end);
      }

      "AS3::substring"(this: string, start: number, end: number) {
        return this.substring(start, end);
      }

      "AS3::substr"(this: string, start: number, length: number) {
        return this.substr(start, length);
      }

      "AS3::toLowerCase"(this: string) {
        return lowerCase(this);
      }

      "AS3::toUpperCase"(this: string) {
        return upperCase(this);
      }

      "private::_indexOf"(this: string, s: string | null, i: number) {
        return this.indexOf(stringArg(s), i);
      }

      "private::_lastIndexOf"(this: string, s: string | null, i: number) {
        return i < 0 ? -1 : this.lastIndexOf(stringArg(s), i);
      }

      "private::_slice"(this: string, start: number, end: number) {
        return this.slice(start, end);
      }

      "private::_substring"(this: string, start: number, end: number) {
        return this.substring(start, end);
      }

      "private::_substr"(this: string, start: number, length: number) {
        return this.substr(start, length);
      }

      // Each argument as String() converts it, after the string.
      "AS3::concat"(this: string, ...args: Value[]) {
        let s = this;
        for (const a of args) {
          s += rt.toString(a);
        }

        return s;
      }

      "AS3::match"(this: string, pattern: Value) {
        return match(rt, this, pattern);
      }

      "AS3::replace"(this: string, pattern: Value, replacement: Value) {
        return replace(rt, this, pattern, replacement);
      }

      "AS3::search"(this: string, pattern: Value) {
        return search(rt, this, pattern);
      }

      // An undefined or null limit is none.
      "AS3::split"(this: string, delimiter: Value, limit: Value) {
        const n = limit === undefined || limit === null ? 0xffffffff : rt.toUint(limit);
        return split(rt, this, delimiter, n);
      }

      "AS3::toLocaleLowerCase"(this: string) {
        return lowerCase(this);
      }

      "AS3::toLocaleUpperCase"(this: string) {
        return upperCase(this);
      }

      "AS3::toString"(this: string) {
        return this;
      }

      "AS3::valueOf"(this: string) {
        return this;
      }
    },
);

export const stringHooks: Record<string, ClassHook> = {
  String: conversion((rt, args) => (args.length ? rt.toString(args[0]) : "")),
};
