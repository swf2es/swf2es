// Number, int, uint and Boolean, and Math, whose functions Number has
// copies of.

import type { Value } from "../descriptors.js";
import type { ClassHook } from "../hooks.js";
import {
  convertDoubleToString,
  convertDoubleToStringRadix,
  DTOSTR_EXPONENTIAL,
  DTOSTR_FIXED,
  DTOSTR_PRECISION,
} from "../numbers.js";
import { numberToString, type Runtime } from "../runtime.js";
import { conversion, type Natives, plain } from "./define.js";

export const numberNatives: Natives = {
  // As NumberClass::_numberToString: another radix writes the integer part only.
  "Number.Number::_numberToString": (rt) => (n: number, radix: number) => {
    if (radix === 10 || !Number.isFinite(n)) {
      return numberToString(n);
    }

    if (radix < 2 || radix > 36) {
      throw rt.error("RangeError", 1003, radix);
    }

    return convertDoubleToStringRadix(n, radix);
  },
  // As NumberClass::_convert: toFixed, toPrecision and toExponential.
  "Number.Number::_convert": (rt) => (n: number, precision: number, mode: number) => {
    const [min, max] = mode === DTOSTR_PRECISION ? [1, 21] : [0, 20];
    if (precision < min || precision > max) {
      throw rt.error("RangeError", 1002, precision, min, max);
    }

    switch (mode) {
      case DTOSTR_FIXED:
        return numberToFixed(n, precision);
      case DTOSTR_PRECISION:
        return numberToPrecision(n, precision);
      default:
        return numberToExponential(n, precision);
    }
  },
  "Number.Number::_minValue": plain(() => Number.MIN_VALUE),
};

// toFixed, toPrecision and toExponential write avmplus' text, which is not
// JavaScript's, though JavaScript's methods give it for most numbers at a
// fraction of the cost. avmplus takes the digits D of a number x from its
// D2A, the shortest within half an ulp of x narrowed by 10^precision, in
// exact arithmetic. Scaled so that the last place written is 1, x is some y
// and D is within y * 2^-53 of it. toFixed and toPrecision then round D
// half up there, as JavaScript rounds x itself; toExponential truncates D,
// since avmplus rounds only on D2A's fast path, which no 53-bit mantissa
// takes. So where y is clear of the point where the rounding (or the
// truncation) changes, both write the same digits. The guards scale x by
// a power of ten up to 1e22, which doubles hold exactly, so f is within
// y * 2^-53 of y, and take JavaScript's text only where f is more than
// f * 2^-50 from those points. Elsewhere avmplus goes its own way: toFixed
// writes zeros, unrounded, for a number below its last place (0.006 to
// "0.00"); toPrecision never writes an exponent below 1, and keeps the
// exponent it had before rounding carried ("10.0" for 9.99 to 2 digits,
// "0.e+5" for 99999.9); toExponential leaves out "e+0", and writes 0 as
// "0.00e-16". tests/unit/runtime/numbers.test.ts checks every precision.

const powersOfTen = Array.from({ length: 23 }, (_, i) => Number(`1e${i}`));

/** x * 10^k, rounded once, for k from -22 to 22. */
function scaled(x: number, k: number): number {
  return k >= 0 ? x * powersOfTen[k] : x / powersOfTen[-k];
}

/** As Number.toFixed. */
export function numberToFixed(n: number, digits: number): string {
  // NaN, infinities and f past 2^49, where the tolerance reaches 0.5, fail every test.
  const f = (n < 0 ? -n : n) * powersOfTen[digits];
  const tolerance = f / 2 ** 50;
  const half = f - Math.floor(f) - 0.5;
  if ((half > tolerance || half < -tolerance) && (f < 0.5 || f > 1 + tolerance)) {
    return n.toFixed(digits);
  }

  return convertDoubleToString(n, DTOSTR_FIXED, digits);
}

/** As Number.toPrecision. */
export function numberToPrecision(n: number, digits: number): string {
  // log10 may be one off next to a power of ten: the bounds on f catch that.
  const x = n < 0 ? -n : n;
  const exponent = Math.floor(Math.log10(x));
  const k = digits - 1 - exponent;
  if (exponent >= -6 && k >= -22 && k <= 22) {
    const f = scaled(x, k);
    const tolerance = f / 2 ** 50;
    const half = f - Math.floor(f) - 0.5;
    const clear = half > tolerance || half < -tolerance;
    if (clear && f >= powersOfTen[digits - 1] + tolerance && f < powersOfTen[digits] - 0.5) {
      return n.toPrecision(digits);
    }
  }

  return convertDoubleToString(n, DTOSTR_PRECISION, digits);
}

/**
 * As Number.toExponential: JavaScript's digits to one place more, the last
 * dropped, which truncates as avmplus does where rounding that place does
 * not carry.
 */
export function numberToExponential(n: number, digits: number): string {
  const x = n < 0 ? -n : n;
  const exponent = Math.floor(Math.log10(x));
  const k = digits - exponent;
  if (k >= -22 && k <= 22) {
    const f = scaled(x, k);
    const fraction = f - Math.floor(f);
    const inRange = f >= powersOfTen[digits] && f < powersOfTen[digits + 1];
    if (fraction > f / 2 ** 50 && fraction < 0.9 && inRange) {
      const text = x.toExponential(digits + 1);
      const e = text.indexOf("e");
      const mantissa = text.slice(0, digits === 0 ? 1 : e - 1);
      const written = exponent === 0 ? mantissa : mantissa + text.slice(e);
      return n < 0 ? `-${written}` : written;
    }
  }

  return convertDoubleToString(n, DTOSTR_EXPONENTIAL, digits);
}

// Math, and Number's copies of it.
for (const name of [
  "abs",
  "acos",
  "asin",
  "atan",
  "ceil",
  "cos",
  "exp",
  "floor",
  "log",
  "sin",
  "sqrt",
  "tan",
]) {
  const f = (Math as unknown as Record<string, (x: number) => number>)[name];
  const native = (rt: Runtime) => (x: Value) => f(rt.toNumber(x));
  numberNatives[`Math.${name}`] = native;
  numberNatives[`Number.${name}`] = native;
}

for (const prefix of ["Math", "Number"]) {
  // As MathUtils::round, floor(x + 0.5): never -0, as JavaScript's is for -0.5 to -0.
  numberNatives[`${prefix}.round`] = (rt) => (x: Value) => {
    const r = Math.round(rt.toNumber(x));
    return r === 0 ? 0 : r;
  };
  numberNatives[`${prefix}.atan2`] = (rt) => (y: Value, x: Value) =>
    Math.atan2(rt.toNumber(y), rt.toNumber(x));
  numberNatives[`${prefix}.pow`] = (rt) => (x: Value, y: Value) => rt.toNumber(x) ** rt.toNumber(y);
  numberNatives[`${prefix}.random`] = plain(() => Math.random());
  // Of two declared parameters, and any more, so that their length is 2.
  numberNatives[`${prefix}.max`] = (rt) =>
    function (x: Value, y: Value) {
      // biome-ignore lint/complexity/noArguments: all of them, however many
      const args = arguments;
      if (args.length === 2) {
        return Math.max(rt.toNumber(x), rt.toNumber(y));
      }

      return Math.max(...Array.from(args, (a: Value) => rt.toNumber(a)));
    };
  numberNatives[`${prefix}.min`] = (rt) =>
    function (x: Value, y: Value) {
      // biome-ignore lint/complexity/noArguments: all of them, however many
      const args = arguments;
      if (args.length === 2) {
        return Math.min(rt.toNumber(x), rt.toNumber(y));
      }

      return Math.min(...Array.from(args, (a: Value) => rt.toNumber(a)));
    };
}

numberNatives["Math.Math::_max"] = plain((x: number, y: number) => Math.max(x, y));
numberNatives["Math.Math::_min"] = plain((x: number, y: number) => Math.min(x, y));

export const numberHooks: Record<string, ClassHook> = {
  int: conversion((rt, args) => (args.length ? rt.toInt(args[0]) : 0)),
  uint: conversion((rt, args) => (args.length ? rt.toUint(args[0]) : 0)),
  Number: conversion((rt, args) => (args.length ? rt.toNumber(args[0]) : 0)),
  Boolean: conversion((_rt, args) => !!args[0]),
};
