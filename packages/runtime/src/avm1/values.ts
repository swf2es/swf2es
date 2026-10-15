// AVM1's values and their conversions, by the version of the SWF whose
// code converts them, as Ruffle's (https://github.com/ruffle-rs/ruffle)
// core/src/avm1/value.rs has them (as_bool, coerce_to_f64,
// coerce_to_string, to_primitive): MIT OR Apache-2.0, Copyright (c)
// 2018-2022 Ruffle LLC and Ruffle contributors.
import { NotYet } from "./errors.js";
import { numberToString, stringToNumber } from "./numbers.js";

export type Primitive = undefined | null | boolean | number | string;

/**
 * An AVM1 value: a JavaScript primitive, a number always a double, as
 * AVM1 has no int, or an object, which the objects' step (docs/avm1.md,
 * step 6) makes an `Avm1Object`.
 */
export type Value = Primitive | object;

/**
 * What converting an object asks of it, by calling its `valueOf` or
 * `toString`, which the step that brings objects (6) and the one that
 * brings their classes (9) give; until then each throws NotYet, ending the
 * block, as an action not done yet does. They are set once, on this
 * object, never per version: the version is an argument.
 */
export interface ObjectConversions {
  /**
   * `valueOf()`, as ToNumber, Less2 and Equals2 call it: the object itself
   * where it gives no primitive.
   */
  valueOf(object: object, version: number): Value;
  /**
   * Add2's: `valueOf()`, but a Date's `toString()` from SWF 6; the object
   * itself where neither gives a primitive.
   */
  toPrimitive(object: object, version: number): Value;
  /**
   * `toString()`, a clip's path, or "[type Object]" or "[type Function]"
   * where it gives no string.
   */
  toString(object: object, version: number): string;
  /** "object", "function" or "movieclip". */
  typeOf(object: object): string;
}

const notYet = (what: string) => (): never => {
  throw new NotYet(what);
};

export const objects: ObjectConversions = {
  valueOf: notYet("valueOf of an object"),
  toPrimitive: notYet("an object to a primitive"),
  toString: notYet("toString of an object"),
  typeOf: notYet("typeof of an object"),
};

export const isPrimitive = (value: Value): value is Primitive =>
  value === null || (typeof value !== "object" && typeof value !== "function");

/**
 * A value as a condition: a string by its number up to SWF 6 ("0" and "a"
 * are false), by its length from SWF 7; an object is true.
 */
export function toBoolean(value: Value, version: number): boolean {
  switch (typeof value) {
    case "boolean":
      return value;
    case "number":
      return value !== 0 && !Number.isNaN(value);
    case "string": {
      if (version >= 7) {
        return value.length > 0;
      }

      const n = stringToNumber(value, version);
      return n !== 0 && !Number.isNaN(n);
    }
    case "undefined":
      return false;
    default:
      return value !== null;
  }
}

/**
 * A primitive as a number: undefined and null are 0 up to SWF 6 and NaN
 * from 7, and an object a `valueOf` left is 0 up to SWF 4 and NaN after.
 */
export function primitiveToNumber(value: Value, version: number): number {
  switch (typeof value) {
    case "number":
      return value;
    case "boolean":
      return value ? 1 : 0;
    case "string":
      return stringToNumber(value, version);
    case "undefined":
      return version < 7 ? 0 : Number.NaN;
    default:
      if (value === null) {
        return version < 7 ? 0 : Number.NaN;
      }

      return version < 5 ? 0 : Number.NaN;
  }
}

/** A value as a number, an object by its `valueOf`. */
export function toNumber(value: Value, version: number): number {
  return isPrimitive(value)
    ? primitiveToNumber(value, version)
    : primitiveToNumber(objects.valueOf(value, version), version);
}

/** A value as a string: undefined is "" up to SWF 6, and a boolean 1 or 0 up to SWF 4. */
export function stringOf(value: Value, version: number): string {
  switch (typeof value) {
    case "undefined":
      return version >= 7 ? "undefined" : "";
    case "boolean":
      if (version < 5) {
        return value ? "1" : "0";
      }

      return value ? "true" : "false";
    case "number":
      return numberToString(value);
    case "string":
      return value;
    default:
      return value === null ? "null" : objects.toString(value, version);
  }
}

/** `typeof`, the same in every version. */
export function typeOf(value: Value): string {
  switch (typeof value) {
    case "undefined":
    case "number":
    case "boolean":
    case "string":
      return typeof value;
    default:
      return value === null ? "null" : objects.typeOf(value);
  }
}
