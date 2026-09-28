// Number, int, uint and Boolean, and Math, whose functions Number has
// copies of.
import { convertDoubleToString, convertDoubleToStringRadix, DTOSTR_PRECISION } from "../numbers.js";
import type { ClassHook, Runtime, Value } from "../runtime.js";
import { conversion, type Natives, plain } from "./define.js";

export const numberNatives: Natives = {
  // As NumberClass::_numberToString: another radix writes the integer part only.
  "Number.Number::_numberToString": (rt) => (n: number, radix: number) => {
    if (radix === 10 || !Number.isFinite(n)) {
      return convertDoubleToString(n);
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

    return convertDoubleToString(n, mode, precision);
  },
  "Number.Number::_minValue": plain(() => Number.MIN_VALUE),
};

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
  "round",
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
