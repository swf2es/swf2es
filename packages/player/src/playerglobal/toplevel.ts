// playerglobal's toplevel functions: trace, as Flash Player writes it to its
// log, and flash.utils' getDefinitionByName, getTimer and the multi-byte
// escapes, whose rules are what Flash traces in Ruffle's escape_multi_byte.
import type { avm2 } from "@swf2es/runtime";
import type { Scripting } from "../scripting.js";

type Value = avm2.Value;

/** "pkg.Name" or "pkg::Name" as "pkg::Name", as getDefinitionByName takes either. */
export function qualify(name: string): string {
  if (name.includes("::")) {
    return name;
  }

  const i = name.lastIndexOf(".");
  return i < 0 ? name : `${name.slice(0, i)}::${name.slice(i + 1)}`;
}

/** The errors definitionNamed throws for a Vector of a definition that is not a class. */
const notClasses = new WeakSet<object>();

/** Whether `e` is definitionNamed's error for a Vector of a definition that is not a class, which Flash's hasDefinition counts as defined. */
export function isVectorOfNotAClass(e: unknown): boolean {
  return typeof e === "object" && e !== null && notClasses.has(e);
}

/**
 * What `name` names in `domain`, as getDefinitionByName and
 * ApplicationDomain's lookups take a name: "pkg.Name" or "pkg::Name", or a
 * Vector, "Vector.<T>" with or without its package, T named either way or
 * a Vector too; `find` looks a plain name up. As Flash's, T is looked up
 * as any definition, * among those not defined (#1065), and one that is
 * not a class makes the Vector corrupt (#1107).
 */
export function definitionNamed(
  rt: avm2.Runtime,
  name: string,
  find: (qualified: string) => avm2.Value,
): avm2.Value {
  const vector = /^(?:__AS3__\.vec(?:::|\.))?Vector\.<(.+)>$/.exec(name);
  if (vector) {
    const param = definitionNamed(rt, vector[1], find);
    if (!param?.$it) {
      const error = rt.error("VerifyError", 1107);
      notClasses.add(error);
      throw error;
    }

    return rt.applyType(rt.classNamed("__AS3__.vec::Vector"), [param]);
  }

  return find(qualify(name));
}

const UTF8 = new TextEncoder();

export function toplevelNatives(s: Scripting): avm2.Natives {
  return {
    trace:
      (rt) =>
      (...args: Value[]) => {
        rt.print(args.map((v) => rt.toString(v)).join(" "));
      },
    // Looked up in the domain of the code that asks, as Flash's.
    "flash.utils::getDefinitionByName": (rt) => (name: Value) =>
      definitionNamed(rt, rt.toString(name), (q) => rt.definitionNamed(q, s.codeDomain())),
    // The alias registerClassAlias gave the value's class, which describeType writes; null for none.
    "flash.utils::getAliasName": (rt) => (v: Value) => {
      if (v === null || v === undefined) {
        return null;
      }

      const alias = rt.aliasOf(v.$it ? v.$it : rt.traitsOf(v));
      return alias === "" ? null : alias;
    },
    // Milliseconds since the start, by the host's real clock or the frame clock (Scripting.timer).
    "flash.utils::getTimer": () => () => s.timer(),
    "flash.utils::escapeMultiByte": (rt) => (text: Value) => escapeMultiByte(rt.toString(text)),
    "flash.utils::unescapeMultiByte": (rt) => (text: Value) => unescapeMultiByte(rt.toString(text)),
  };
}

/** Every byte of the UTF-8 but the alphanumerics as %XX, up to a NUL; a lone surrogate is U+FFFD, as the encoder has it. */
function escapeMultiByte(text: string): string {
  const nul = text.indexOf("\0");
  const bytes = UTF8.encode(nul < 0 ? text : text.slice(0, nul));
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    const alphanumeric =
      (b >= 0x30 && b <= 0x39) || (b >= 0x41 && b <= 0x5a) || (b >= 0x61 && b <= 0x7a);
    out += alphanumeric
      ? String.fromCharCode(b)
      : `%${b.toString(16).toUpperCase().padStart(2, "0")}`;
  }

  return out;
}

const HEX = /^[0-9a-fA-F]$/;

/**
 * The bytes of %XX escapes and the rest as given, up to a NUL not behind a
 * %, decoded as UTF-8 the lenient way: a % takes the next character, and
 * one more if the first is a hex digit, and gives a byte only when both
 * are; an encoded surrogate stands; an incomplete or invalid sequence
 * leaves its bytes as characters of their own.
 */
function unescapeMultiByte(text: string): string {
  const bytes: number[] = [];
  for (let i = 0; i < text.length; ) {
    const c = text[i++];
    if (c === "\0") {
      break;
    }

    if (c !== "%") {
      for (const b of UTF8.encode(c)) {
        bytes.push(b);
      }

      continue;
    }

    const first = text[i++];
    if (first === undefined || !HEX.test(first)) {
      continue;
    }

    const second = text[i++];
    if (second !== undefined && HEX.test(second)) {
      bytes.push(Number.parseInt(first + second, 16));
    }
  }

  let out = "";
  for (let i = 0; i < bytes.length; ) {
    const b = bytes[i];
    const length =
      b < 0x80
        ? 1
        : b >= 0xc0 && b < 0xe0
          ? 2
          : b >= 0xe0 && b < 0xf0
            ? 3
            : b >= 0xf0 && b < 0xf8
              ? 4
              : 0;
    let code = length === 1 ? b : length === 2 ? b & 0x1f : length === 3 ? b & 0x0f : b & 0x07;
    let ok = length > 0 && i + length <= bytes.length;
    for (let k = 1; ok && k < length; k++) {
      const next = bytes[i + k];
      ok = (next & 0xc0) === 0x80;
      code = (code << 6) | (next & 0x3f);
    }

    if (!ok) {
      out += String.fromCharCode(b);
      i++;
      continue;
    }

    out += String.fromCodePoint(code);
    i += length;
  }

  return out;
}
