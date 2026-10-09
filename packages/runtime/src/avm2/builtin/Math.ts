// Math: its functions, which Number has copies of, as natives held to
// Math.decl.ts. Each gets its arguments as Numbers already (see bind.ts).

import type { Value } from "../descriptors.js";
import type { Runtime } from "../runtime.js";
import { bindNatives } from "./bind.js";
import { MathDecl } from "./Math.decl.js";

/** As MathUtils::round, floor(x + 0.5): never -0, as JavaScript's is for -0.5 to -0. */
function round(x: number): number {
  const r = Math.round(x);
  return r === 0 ? 0 : r;
}

/** Math.max's and Math.min's: of two declared parameters, and any more, coerced as they are. */
function extreme(
  rt: Runtime,
  f: (...values: number[]) => number,
  x: number,
  y: number,
  rest: Value[],
): number {
  return rest.length ? f(x, y, ...rest.map((v) => rt.toNumber(v))) : f(x, y);
}

/** Math's natives for runtime `rt`; Number's copies of its functions are taken from them. */
export function mathClass(rt: Runtime) {
  // biome-ignore lint/complexity/noStaticOnlyClass: Math's natives are all static
  return class MathNatives {
    static abs(x: number) {
      return Math.abs(x);
    }

    static acos(x: number) {
      return Math.acos(x);
    }

    static asin(x: number) {
      return Math.asin(x);
    }

    static atan(x: number) {
      return Math.atan(x);
    }

    static ceil(x: number) {
      return Math.ceil(x);
    }

    static cos(x: number) {
      return Math.cos(x);
    }

    static exp(x: number) {
      return Math.exp(x);
    }

    static floor(x: number) {
      return Math.floor(x);
    }

    static log(x: number) {
      return Math.log(x);
    }

    static round(x: number) {
      return round(x);
    }

    static sin(x: number) {
      return Math.sin(x);
    }

    static sqrt(x: number) {
      return Math.sqrt(x);
    }

    static tan(x: number) {
      return Math.tan(x);
    }

    static atan2(y: number, x: number) {
      return Math.atan2(y, x);
    }

    static pow(x: number, y: number) {
      return x ** y;
    }

    static max(x: number, y: number, ...rest: Value[]) {
      return extreme(rt, Math.max, x, y, rest);
    }

    static min(x: number, y: number, ...rest: Value[]) {
      return extreme(rt, Math.min, x, y, rest);
    }

    static random() {
      return Math.random();
    }

    static "private::_max"(x: number, y: number) {
      return Math.max(x, y);
    }

    static "private::_min"(x: number, y: number) {
      return Math.min(x, y);
    }
  };
}

export const MathBuiltin = bindNatives(MathDecl, mathClass);
