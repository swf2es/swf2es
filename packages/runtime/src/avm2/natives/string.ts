// String: `this` is the string.
import type { ClassHook, Value } from "../runtime.js";
import { lowerCase, upperCase } from "./case.js";
import { AS3, conversion, type Natives, plain } from "./define.js";
import { compile, matchArray, replacement as replacementOf } from "./regexp.js";

export const stringNatives: Natives = {
  "String#get:length": plain(function (this: string) {
    return this.length;
  }),
  [`String.${AS3}::fromCharCode`]:
    (rt) =>
    (...codes: Value[]) => {
      return String.fromCharCode(...codes.map((c) => rt.toUint(c) & 0xffff));
    },
  [`String#${AS3}::charAt`]: (rt) =>
    function (this: string, i: Value = 0) {
      return this.charAt(rt.toNumber(i));
    },
  [`String#${AS3}::charCodeAt`]: (rt) =>
    function (this: string, i: Value = 0) {
      return this.charCodeAt(rt.toNumber(i));
    },
  [`String#${AS3}::indexOf`]: (rt) =>
    function (this: string, s: Value = "undefined", i: Value = 0) {
      return this.indexOf(rt.toString(s), rt.toNumber(i));
    },
  [`String#${AS3}::lastIndexOf`]: (rt) =>
    function (this: string, s: Value = "undefined", i: Value = 0x7fffffff) {
      // As String::lastIndexOf, from INTCLAMP: from before the start nothing matches.
      const at = rt.toNumber(i);
      return at <= -1 ? -1 : this.lastIndexOf(rt.toString(s), at);
    },
  [`String#${AS3}::localeCompare`]: (rt) =>
    function (this: string, other: Value) {
      // As String::Compare: the first difference of their character codes,
      // else which is longer.
      const o = rt.toString(other);
      const n = Math.min(this.length, o.length);
      for (let i = 0; i < n; i++) {
        const d = this.charCodeAt(i) - o.charCodeAt(i);
        if (d) {
          return d;
        }
      }

      return Math.sign(this.length - o.length);
    },
  [`String#${AS3}::slice`]: (rt) =>
    function (this: string, start: Value = 0, end: Value = 0x7fffffff) {
      return this.slice(rt.toNumber(start), rt.toNumber(end));
    },
  [`String#${AS3}::substring`]: (rt) =>
    function (this: string, start: Value = 0, end: Value = 0x7fffffff) {
      return this.substring(rt.toNumber(start), rt.toNumber(end));
    },
  [`String#${AS3}::substr`]: (rt) =>
    function (this: string, start: Value = 0, length: Value = 0x7fffffff) {
      return this.substr(rt.toNumber(start), rt.toNumber(length));
    },
  [`String#${AS3}::toLowerCase`]: plain(function (this: string) {
    return lowerCase(this);
  }),
  [`String#${AS3}::toUpperCase`]: plain(function (this: string) {
    return upperCase(this);
  }),
  "String#String::_indexOf": plain(function (this: string, s: string, i = 0) {
    return this.indexOf(s, i);
  }),
  "String#String::_lastIndexOf": plain(function (this: string, s: string, i = 0x7fffffff) {
    return i < 0 ? -1 : this.lastIndexOf(s, i);
  }),
  "String#String::_slice": plain(function (this: string, start = 0, end = 0x7fffffff) {
    return this.slice(start, end);
  }),
  "String#String::_substring": plain(function (this: string, start = 0, end = 0x7fffffff) {
    return this.substring(start, end);
  }),
  "String#String::_substr": plain(function (this: string, start = 0, length = 0x7fffffff) {
    return this.substr(start, length);
  }),
  "String.String::_replace": (rt) => (s: string, pattern: Value, replacement: Value) => {
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
  },
  // A string pattern is a RegExp's, as avmplus makes one of it.
  "String.String::_search": (rt) => (s: string, pattern: Value) =>
    s.search(pattern?.$re instanceof RegExp ? pattern.$re : compile(rt.toString(pattern), "")),
  "String.String::_match": (rt) => (s: string, pattern: Value) => {
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
  },
  "String.String::_split": (rt) => (s: string, delimiter: Value, limit: number) => {
    // The empty string splits to itself, whatever the delimiter, as avmplus has it.
    if (s === "") {
      return rt.array(limit === 0 ? [] : [""]);
    }

    if (delimiter?.$re instanceof RegExp) {
      return rt.array(s.split(delimiter.$re, limit >= 0 ? limit : undefined));
    }

    const parts = s.split(rt.toString(delimiter));
    return rt.array(limit >= 0 && limit < parts.length ? parts.slice(0, limit) : parts);
  },
};

export const stringHooks: Record<string, ClassHook> = {
  String: conversion((rt, args) => (args.length ? rt.toString(args[0]) : "")),
};
