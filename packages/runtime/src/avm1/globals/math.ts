// Math, as Ruffle's (https://github.com/ruffle-rs/ruffle)
// core/src/avm1/globals/math.rs has it: MIT OR Apache-2.0, Copyright (c)
// 2018-2022 Ruffle LLC and Ruffle contributors. Where adl parts from
// Ruffle, adl decides (docs/avm1.md, "Number, Boolean and Math").
//
// Each method is ASnative(200, i), which converts its first two arguments
// whether it uses them or not, as their valueOf can tell; a SWF up to 6
// gets NaN from a method given fewer arguments than it takes.

import { Avm1Object, DONT_DELETE, DONT_ENUM, type Native, READ_ONLY } from "../objects.js";
import type { Realm } from "../realm.js";
import { toNumber } from "../values.js";

/** The methods, in the order of their ASnative indices. */
const MATH_METHODS = [
  "abs",
  "min",
  "max",
  "sin",
  "cos",
  "atan2",
  "tan",
  "exp",
  "log",
  "sqrt",
  "round",
  "random",
  "floor",
  "ceil",
  "atan",
  "asin",
  "acos",
  "pow",
] as const;

const MIN = 1;
const MAX = 2;
const ATAN2 = 5;
const RANDOM = 11;
const POW = 17;

/** A random number from 0 to 1, of the 2^31 Flash's generator gives. */
const random = () => Math.floor(Math.random() * 0x80000000) / 0x80000000;

/** Whether a SWF up to 6 runs method `index` with `count` arguments, `x` the first. */
function enough(index: number, count: number, x: number): boolean {
  switch (index) {
    case RANDOM:
      return true;
    case MIN:
    case MAX:
      return count !== 1;
    case POW:
      return count > 1 || (count === 1 && x === 1);
    case ATAN2:
      return count > 1;
    default:
      return count > 0;
  }
}

/**
 * C's pow, as Flash Player's is (the corpus's math tests): 1 to any power
 * and -1 to an infinite one are 1, where JavaScript's are NaN. adl's, AIR's
 * under Wine, is JavaScript's there, and off it elsewhere (2^0.5's last
 * bit, 1.0000001^1e9 from the ninth digit): JavaScript's precision stays.
 */
function pow(x: number, y: number): number {
  if (x === 1 || (x === -1 && (y === Number.POSITIVE_INFINITY || y === Number.NEGATIVE_INFINITY))) {
    return 1;
  }

  return x ** y;
}

function compute(index: number, x: number, y: number, count: number): number {
  switch (index) {
    case 0:
      return Math.abs(x);
    case MIN:
      return count === 0 ? Number.POSITIVE_INFINITY : Math.min(x, y);
    case MAX:
      return count === 0 ? Number.NEGATIVE_INFINITY : Math.max(x, y);
    case 3:
      return Math.sin(x);
    case 4:
      return Math.cos(x);
    case ATAN2:
      return Math.atan2(x, y);
    case 6:
      return Math.tan(x);
    case 7:
      return Math.exp(x);
    case 8:
      return Math.log(x);
    case 9:
      return Math.sqrt(x);
    // Flash rounds a half up, towards infinity.
    case 10:
      return Math.floor(x + 0.5);
    case RANDOM:
      return random();
    case 12:
      return Math.floor(x);
    case 13:
      return Math.ceil(x);
    case 14:
      return Math.atan(x);
    case 15:
      return Math.asin(x);
    case 16:
      return Math.acos(x);
    case POW:
      return pow(x, y);
    default:
      return Number.NaN;
  }
}

/** ASnative(200, index): a Math method, NaN for an index of none. */
export function mathNative(index: number): Native {
  return (_, args, version) => {
    const x = toNumber(args.length > 0 ? args[0] : undefined, version);
    const y = toNumber(args.length > 1 ? args[1] : undefined, version);
    if (version <= 6 && !enough(index, args.length, x)) {
      return Number.NaN;
    }

    return compute(index, x, y, args.length);
  };
}

/** The Math object: `constructor` and `__proto__` as an object's, its constants, then its methods. */
export function mathObject(realm: Realm): Avm1Object {
  const math = new Avm1Object();
  math.define("constructor", realm.Object, DONT_ENUM | DONT_DELETE);
  math.define("__proto__", realm.objectProto, DONT_ENUM | DONT_DELETE);
  const flags = DONT_ENUM | DONT_DELETE | READ_ONLY;
  math.define("SQRT2", Math.SQRT2, flags);
  math.define("SQRT1_2", Math.SQRT1_2, flags);
  math.define("PI", Math.PI, flags);
  math.define("LOG2E", Math.LOG2E, flags);
  math.define("LOG10E", Math.LOG10E, flags);
  math.define("LN2", Math.LN2, flags);
  math.define("LN10", Math.LN10, flags);
  math.define("E", Math.E, flags);
  for (let i = 0; i < MATH_METHODS.length; i++) {
    math.define(MATH_METHODS[i], realm.method(mathNative(i)), flags);
  }

  return math;
}
