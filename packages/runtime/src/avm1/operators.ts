// AVM1's arithmetic, comparison, logical, bitwise and string actions, by
// the version of the SWF whose code runs them, as Ruffle's
// (https://github.com/ruffle-rs/ruffle) core/src/avm1/activation.rs and
// value.rs (abstract_eq, abstract_lt) have them: MIT OR Apache-2.0,
// Copyright (c) 2018-2022 Ruffle LLC and Ruffle contributors. Where adl
// parts from Ruffle, adl decides (docs/avm1.md, "Version-dependent
// semantics").
//
// add2 takes its operands as the module's code pops them, the top first;
// lessThan and looselyEquals take theirs in reading order, `a < b`. Each
// converts them in Ruffle's order, which only an object's valueOf can tell.
import {
  isPrimitive,
  objects,
  primitiveToNumber,
  stringOf,
  toNumber,
  type Value,
} from "./values.js";

/** Add2: strings concatenate where either side is one after valueOf, else numbers add. */
export function add2(a: Value, b: Value, version: number): Value {
  const pa = isPrimitive(a) ? a : objects.toPrimitive(a, version);
  const pb = isPrimitive(b) ? b : objects.toPrimitive(b, version);
  if (typeof pa === "string" || typeof pb === "string") {
    return stringOf(pb, version) + stringOf(pa, version);
  }

  return toNumber(pb, version) + toNumber(pa, version);
}

/** A value as Less2 and Equals2 see it: an object by its valueOf, which may give the object. */
function primitiveOf(value: Value, version: number): Value {
  return isPrimitive(value) ? value : objects.valueOf(value, version);
}

/**
 * Whether `a < b`, as Less2 and Greater compare: strings by their code
 * units, but the empty string after every other, anything else as
 * numbers, undefined where either is NaN; an object whose valueOf gives
 * no primitive is never less, nor greater.
 */
export function lessThan(a: Value, b: Value, version: number): boolean | undefined {
  const pa = primitiveOf(a, version);
  if (!isPrimitive(pa)) {
    return false;
  }

  const pb = primitiveOf(b, version);
  if (!isPrimitive(pb)) {
    return false;
  }

  if (typeof pa === "string" && typeof pb === "string") {
    // adl has the empty string after every other.
    if (pa === "" || pb === "") {
      return pb === "" && pa !== "";
    }

    return pa < pb;
  }

  const x = primitiveToNumber(pa, version);
  const y = primitiveToNumber(pb, version);
  if (Number.isNaN(x) || Number.isNaN(y)) {
    return undefined;
  }

  return x < y;
}

/**
 * Equals2, ECMA-262's abstract equality as Flash has it: NaN equals NaN
 * (Flash Player 7's, whatever the version), and up to SWF 5 both sides go
 * through valueOf first, so two objects compare by what it gives.
 */
export function looselyEquals(a: Value, b: Value, version: number): boolean {
  if (version <= 5) {
    a = primitiveOf(a, version);
    b = primitiveOf(b, version);
  }

  return abstractEquals(a, b, version);
}

function abstractEquals(a: Value, b: Value, version: number): boolean {
  const aNull = a === undefined || a === null;
  const bNull = b === undefined || b === null;
  if (aNull || bNull) {
    // null and undefined equal each other, and an object whose valueOf gives either.
    if (aNull && bNull) {
      return true;
    }

    const object = aNull ? b : a;
    if (isPrimitive(object)) {
      return false;
    }

    const p = objects.valueOf(object, version);
    return p === undefined || p === null;
  }

  const ta = typeof a;
  const tb = typeof b;
  if (ta === "number" && tb === "number") {
    return a === b || (Number.isNaN(a) && Number.isNaN(b));
  }

  if (ta === tb && (ta === "boolean" || ta === "string")) {
    return a === b;
  }

  if (!isPrimitive(a) && !isPrimitive(b)) {
    return a === b;
  }

  if (ta === "boolean") {
    return abstractEquals(b, a ? 1 : 0, version);
  }

  if (tb === "boolean") {
    return abstractEquals(a, b ? 1 : 0, version);
  }

  // A number and a string: "NaN" is not NaN.
  if (ta === "number" && tb === "string") {
    return a === primitiveToNumber(b, version);
  }

  if (ta === "string" && tb === "number") {
    return b === primitiveToNumber(a, version);
  }

  // An object and a primitive: the object by its valueOf.
  if (!isPrimitive(a)) {
    const p = objects.valueOf(a, version);
    return isPrimitive(p) && abstractEquals(b, p, version);
  }

  const p = objects.valueOf(b as object, version);
  return isPrimitive(p) && abstractEquals(a, p, version);
}

/** StrictEquals: the same type and value, NaN equal to NaN. */
export function strictlyEquals(a: Value, b: Value): boolean {
  if (typeof a === "number" && typeof b === "number") {
    return a === b || (Number.isNaN(a) && Number.isNaN(b));
  }

  return a === b;
}

/** ToInt32, as the bitwise actions and ToInteger take a value: NaN and the infinities 0. */
export const toInt32 = (value: Value, version: number): number => toNumber(value, version) | 0;

/** The first code unit of a string, an unpaired surrogate as U+FFFD, 0 for none. */
export function firstCode(s: string): number {
  if (s.length === 0) {
    return 0;
  }

  const c = s.charCodeAt(0);
  return c >= 0xd800 && c <= 0xdfff ? 0xfffd : c;
}

/** A code unit as a string: none for 0, a surrogate as U+FFFD where `replace`. */
export function charOf(code: number, replace: boolean): string {
  if (code === 0) {
    return "";
  }

  if (replace && code >= 0xd800 && code <= 0xdfff) {
    return "�";
  }

  return String.fromCharCode(code);
}

/**
 * StringExtract and MBStringExtract: `count` units from the 1-based
 * `index`, a start below 1 the first, a count below 0 or past the end the
 * rest. The start is `index - 1` in 32 bits, as adl takes it: an index of
 * -2^31 wraps past the end.
 */
export function extract(s: string, index: number, count: number): string {
  const from = (index - 1) | 0;
  const start = from < 0 ? 0 : from;
  const end = count < 0 || start + count > s.length ? s.length : start + count;
  return s.slice(Math.min(start, end), end);
}

const unpaired = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

/**
 * An extract from SWF 6 on, where each half of a surrogate pair it cuts
 * is U+FFFD, as adl compares, joins and measures it: the halves of "😀"
 * extracted apart and joined again are "\ufffd\ufffd". (adl's trace of a
 * cut low half itself writes three U+FFFD, the bytes it keeps, not one.)
 */
export const wellFormed = (s: string): string =>
  surrogate.test(s) ? s.replace(unpaired, "\ufffd") : s;

const surrogate = /[\ud800-\udfff]/;
