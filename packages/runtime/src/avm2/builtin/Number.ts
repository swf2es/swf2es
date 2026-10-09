// Number: its natives, held to Number.decl.ts, with copies of Math's
// functions, as avmplus has. int's and uint's methods are Number's.

import type { Value } from "../descriptors.js";
import type { ClassHook } from "../hooks.js";
import { conversion } from "../natives/define.js";
import {
  convertDoubleToString,
  convertDoubleToStringRadix,
  DTOSTR_EXPONENTIAL,
  DTOSTR_FIXED,
  DTOSTR_PRECISION,
} from "../numbers.js";
import { numberToString, type Runtime } from "../runtime.js";
import { bindNatives } from "./bind.js";
import { mathClass } from "./Math.js";
import { NumberDecl } from "./Number.decl.js";

/** As NumberClass::_numberToString: another radix writes the integer part only. */
function toStringRadix(rt: Runtime, n: number, radix: number): string {
  if (radix === 10 || !Number.isFinite(n)) {
    return numberToString(n);
  }

  if (radix < 2 || radix > 36) {
    throw rt.error("RangeError", 1003, radix);
  }

  return convertDoubleToStringRadix(n, radix);
}

/** As NumberClass::_convert: toFixed, toPrecision and toExponential. */
function convert(rt: Runtime, n: number, precision: number, mode: number): string {
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
}

// Number's AS3 methods, which int's and uint's are too, as Number(this)'s:
// `this` is the number, each precision converted to an int, as avmplus'
// AS3 does, and the radix to an int, as _numberToString's parameter is.

export function toStringOf(rt: Runtime, n: number, radix: Value): string {
  return toStringRadix(rt, n, rt.toInt(radix));
}

export function toExponentialOf(rt: Runtime, n: number, p: Value): string {
  return convert(rt, n, rt.toInt(p), DTOSTR_EXPONENTIAL);
}

/** An undefined or null precision writes the number as toString does. */
export function toPrecisionOf(rt: Runtime, n: number, p: Value): string {
  return p === undefined || p === null
    ? numberToString(n)
    : convert(rt, n, rt.toInt(p), DTOSTR_PRECISION);
}

export function toFixedOf(rt: Runtime, n: number, p: Value): string {
  return convert(rt, n, rt.toInt(p), DTOSTR_FIXED);
}

export const numberNatives = bindNatives(NumberDecl, (rt) => {
  const math = mathClass(rt);
  return class NumberNatives {
    // Its class hook makes new Number(x) x: this never runs on one.
    Number() {}

    // Copies of Math's functions, as avmplus has them.
    static abs = math.abs;
    static acos = math.acos;
    static asin = math.asin;
    static atan = math.atan;
    static ceil = math.ceil;
    static cos = math.cos;
    static exp = math.exp;
    static floor = math.floor;
    static log = math.log;
    static round = math.round;
    static sin = math.sin;
    static sqrt = math.sqrt;
    static tan = math.tan;
    static atan2 = math.atan2;
    static pow = math.pow;
    static max = math.max;
    static min = math.min;
    static random = math.random;

    static "private::_numberToString"(n: number, radix: number) {
      return toStringRadix(rt, n, radix);
    }

    static "private::_convert"(n: number, precision: number, mode: number) {
      return convert(rt, n, precision, mode);
    }

    static "private::_minValue"() {
      return Number.MIN_VALUE;
    }

    "AS3::toString"(this: number, radix: Value) {
      return toStringOf(rt, this, radix);
    }

    "AS3::valueOf"(this: number) {
      return this;
    }

    "AS3::toExponential"(this: number, p: Value) {
      return toExponentialOf(rt, this, p);
    }

    "AS3::toPrecision"(this: number, p: Value) {
      return toPrecisionOf(rt, this, p);
    }

    "AS3::toFixed"(this: number, p: Value) {
      return toFixedOf(rt, this, p);
    }
  };
});

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

export const numberHooks: Record<string, ClassHook> = {
  int: conversion((rt, args) => (args.length ? rt.toInt(args[0]) : 0)),
  uint: conversion((rt, args) => (args.length ? rt.toUint(args[0]) : 0)),
  Number: conversion((rt, args) => (args.length ? rt.toNumber(args[0]) : 0)),
  Boolean: conversion((_rt, args) => !!args[0]),
};
