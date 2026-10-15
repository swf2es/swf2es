// AVM1's values and their conversions, by the version of the SWF whose
// code converts them, as Ruffle's (https://github.com/ruffle-rs/ruffle)
// core/src/avm1/value.rs has them (as_bool, coerce_to_string): MIT OR
// Apache-2.0, Copyright (c) 2018-2022 Ruffle LLC and Ruffle contributors.
import { numberToString, stringToNumber } from "./numbers.js";

/**
 * An AVM1 value: a JavaScript primitive, a number always a double, as
 * AVM1 has no int. Objects come with the steps that make them.
 */
export type Value = undefined | null | boolean | number | string;

/**
 * A value as a condition: a string by its number up to SWF 6 ("0" and "a"
 * are false), by its length from SWF 7.
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
    default:
      return false;
  }
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
      return "null";
  }
}
