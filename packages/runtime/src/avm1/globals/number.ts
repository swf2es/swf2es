// Number and Boolean, as Ruffle's (https://github.com/ruffle-rs/ruffle)
// core/src/avm1/globals/number.rs and boolean.rs have them: MIT OR
// Apache-2.0, Copyright (c) 2018-2022 Ruffle LLC and Ruffle contributors.
// Where adl parts from Ruffle, adl decides (docs/avm1.md, "Number, Boolean
// and Math").
//
// Their methods take `this` unboxed, and give undefined for anything but
// their own kind of value, a primitive or its object.

import { numberToString } from "../numbers.js";
import { Avm1Object, DONT_DELETE, DONT_ENUM, type RawNative, READ_ONLY } from "../objects.js";
import { clampInt } from "../operators.js";
import type { Class, Realm } from "../realm.js";
import { toBoolean, toNumber, type Value } from "../values.js";

/** `this` as a Number's number, undefined for anything else. */
const numberOf = (self: Value): number | undefined =>
  typeof self === "number"
    ? self
    : self instanceof Avm1Object && typeof self.primitive === "number"
      ? self.primitive
      : undefined;

/** `this` as a Boolean's boolean, undefined for anything else. */
const booleanOf = (self: Value): boolean | undefined =>
  typeof self === "boolean"
    ? self
    : self instanceof Avm1Object && typeof self.primitive === "boolean"
      ? self.primitive
      : undefined;

/** A double cast to an int as Rust's `as` casts it: saturated, NaN 0. */
const saturated = (n: number): number =>
  Number.isNaN(n) ? 0 : Math.trunc(Math.max(-2147483648, Math.min(2147483647, n)));

/**
 * `n` in base `radix`, as Flash writes it: the number cast to an int, so
 * that a fraction is cut, and NaN, the infinities and anything out of range
 * are -2^31, whose digits Flash writes as the remainders it takes, each
 * negative: `(1e20).toString(16)` is "-(0000000".
 */
export function toRadix(n: number, radix: number): string {
  let v = clampInt(n);
  if (v === 0) {
    return "0";
  }

  const negative = v < 0;
  if (negative) {
    v = -v | 0;
  }

  let digits = "";
  while (v !== 0) {
    const d = v % radix;
    v = Math.trunc(v / radix);
    digits = String.fromCharCode(d < 10 ? 0x30 + d : 0x61 + d - 10) + digits;
  }

  return negative ? `-${digits}` : digits;
}

export function numberClass(realm: Realm): Class {
  const proto = new Avm1Object();
  const constr = realm.classOf(
    proto,
    (self, args, version) => {
      self.primitive = args.length > 0 ? toNumber(args[0], version) : 0;
      return self;
    },
    (_, args, version) => (args.length > 0 ? toNumber(args[0], version) : 0),
  );
  proto.define("__proto__", realm.objectProto, DONT_ENUM | DONT_DELETE);

  const constant = DONT_ENUM | DONT_DELETE | READ_ONLY;
  constr.define("NaN", Number.NaN, constant);
  constr.define("POSITIVE_INFINITY", Number.POSITIVE_INFINITY, constant);
  constr.define("NEGATIVE_INFINITY", Number.NEGATIVE_INFINITY, constant);
  constr.define("MIN_VALUE", Number.MIN_VALUE, constant);
  constr.define("MAX_VALUE", Number.MAX_VALUE, constant);

  const define = (name: string, native: RawNative) =>
    proto.define(name, realm.rawMethod(native), DONT_ENUM | DONT_DELETE);
  define("valueOf", (self) => numberOf(self));
  define("toString", (self, args, version) => {
    const n = numberOf(self);
    if (n === undefined) {
      return undefined;
    }

    const radix = args.length > 0 ? saturated(toNumber(args[0], version)) : 10;
    return radix < 2 || radix > 36 || radix === 10 ? numberToString(n) : toRadix(n, radix);
  });

  return { constr, proto };
}

export function booleanClass(realm: Realm): Class {
  const proto = new Avm1Object();
  const constr = realm.classOf(
    proto,
    (self, args, version) => {
      self.primitive = args.length > 0 && toBoolean(args[0], version);
      return self;
    },
    // Boolean() of nothing is undefined.
    (_, args, version) => (args.length > 0 ? toBoolean(args[0], version) : undefined),
  );
  proto.define("__proto__", realm.objectProto, DONT_ENUM | DONT_DELETE);

  const define = (name: string, native: RawNative) =>
    proto.define(name, realm.rawMethod(native), DONT_ENUM | DONT_DELETE);
  define("valueOf", (self) => booleanOf(self));
  define("toString", (self) => {
    const b = booleanOf(self);
    return b === undefined ? undefined : String(b);
  });

  return { constr, proto };
}
