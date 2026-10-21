// AIR's scalar float builtin. The declarations live beside the Flash
// builtins as a separate ABC; Number's existing native paths stay separate.
import type { Value } from "../descriptors.js";
import type { ClassHook } from "../hooks.js";
import { numberToString } from "../number-strings.js";
import { convertDoubleToStringRadix } from "../numbers.js";
import { conversion, type Natives } from "./define.js";
import { numberToExponential, numberToFixed, numberToPrecision } from "./number.js";

export const floatHooks: Record<string, ClassHook> = {
  float: {
    ...conversion((rt, args) => rt.float(args.length ? args[0] : 0)),
    created: (rt, cls) => {
      const constants: Record<string, number> = {
        MAX_VALUE: 3.4028234663852886e38,
        MIN_VALUE: 1.401298464324817e-45,
        NaN,
        POSITIVE_INFINITY: Infinity,
        NEGATIVE_INFINITY: -Infinity,
        E: Math.E,
        LN10: Math.LN10,
        LN2: Math.LN2,
        LOG2E: Math.LOG2E,
        PI: Math.PI,
        SQRT1_2: Math.SQRT1_2,
        SQRT2: Math.SQRT2,
      };
      for (const [, , name, binding] of cls.$desc.static.bindings) {
        if (name in constants) {
          cls[`$${binding >> 3}`] = rt.float(constants[name]);
        }
      }
    },
  },
};

export const floatNatives: Natives = {};

floatNatives["float.float::_toString"] = (rt) => (value: Value, radix: Value) => {
  const n = rt.toNumber(value);
  const base = rt.toInt(radix);
  if (base === 10 || !Number.isFinite(n)) {
    return numberToString(n);
  }

  if (base < 2 || base > 36) {
    throw rt.error("RangeError", 1003, base);
  }

  return convertDoubleToStringRadix(n, base);
};
for (const [name, convert] of [
  ["toFixed", numberToFixed],
  ["toExponential", numberToExponential],
  ["toPrecision", numberToPrecision],
] as const) {
  floatNatives[`float.float::_${name}`] = (rt) => (value: Value, digits: Value) => {
    const n = rt.toInt(digits);
    const min = name === "toPrecision" ? 1 : 0;
    const max = name === "toPrecision" ? 21 : 20;
    if (n < min || n > max) {
      throw rt.error("RangeError", 1002, n, min, max);
    }

    return convert(rt.toNumber(value), n);
  };
}

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
  const fn = (Math as unknown as Record<string, (value: number) => number>)[name];
  floatNatives[`float.${name}`] = (rt) => (value: Value) =>
    rt.float(fn(Math.fround(rt.toNumber(value))));
}

for (const name of ["atan2", "pow"] as const) {
  const fn = Math[name];
  floatNatives[`float.${name}`] = (rt) => (a: Value, b: Value) =>
    rt.float(fn(Math.fround(rt.toNumber(a)), Math.fround(rt.toNumber(b))));
}

for (const name of ["max", "min"] as const) {
  const fn = Math[name];
  floatNatives[`float.${name}`] =
    (rt) =>
    (...args: Value[]) => {
      let result = name === "max" ? -Infinity : Infinity;
      for (const arg of args) {
        result = fn(result, Math.fround(rt.toNumber(arg)));
      }

      return rt.float(result);
    };
}

floatNatives["float.random"] = (rt) => () => rt.float(Math.random());
floatNatives["float.round"] = (rt) => (value: Value) => {
  const rounded = Math.round(Math.fround(rt.toNumber(value)));
  return rt.float(rounded === 0 ? 0 : rounded);
};
floatNatives["float.reciprocal"] = (rt) => (value: Value) =>
  rt.float(1 / Math.fround(rt.toNumber(value)));
floatNatives["float.rsqrt"] = (rt) => (value: Value) =>
  rt.float(1 / Math.sqrt(Math.fround(rt.toNumber(value))));
