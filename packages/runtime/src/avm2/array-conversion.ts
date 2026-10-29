// Number(array) without formatting and parsing, for the Arrays whose
// conversion is still the builtins'.

import { type AsObject, NOT_FOUND, type Value } from "./descriptors.js";
import { numberReadBack, stringToNumber } from "./number-strings.js";
import type { Traits } from "./traits.js";

/**
 * What Number(array) runs unless a script replaced it: Array's traits,
 * Array.prototype, its toString and Object.prototype.valueOf, as the
 * script defining Object leaves them, before any other script runs.
 */
export class ArrayConversion {
  private arrayClass: AsObject | null = null;
  arrayTraits: Traits | null = null;
  private arrayPrototype: AsObject | null = null;
  private arrayToString: Value = NOT_FOUND;
  private objectValueOf: Value = NOT_FOUND;

  /** Notes the builtin Array class, once its static initializer has run. */
  noteArrayClass(cls: AsObject): void {
    this.arrayClass = cls;
  }

  /**
   * Notes Array's builtin conversion functions, once the script defining
   * Object, and Array beside it, has set its prototypes' functions.
   */
  noteConversions(): void {
    const cls = this.arrayClass;
    if (cls === null) {
      return;
    }

    const prototype: AsObject = cls.$prototype;
    const objectPrototype: AsObject | null = prototype.$p;
    const toStringFn = prototype.$d.get("toString");
    const valueOfFn = objectPrototype?.$d.get("valueOf");
    if (toStringFn?.$f && valueOfFn?.$f) {
      this.arrayTraits = cls.$it;
      this.arrayPrototype = prototype;
      this.arrayToString = toStringFn;
      this.objectValueOf = valueOfFn;
    }
  }

  /**
   * Number(a) for an Array whose conversion is still the builtins': its
   * valueOf returns it, and its toString joins its elements with commas,
   * which then read back as a number. Without formatting and parsing, for
   * the Arrays whose result is plain: none or one primitive element, or
   * only primitives, whose join holds a comma and so is NaN, unless a NUL
   * ends the number before it. Undefined for any other, which takes the
   * general path, as does one with a hole, whose element the prototypes
   * give.
   */
  arrayToNumber(o: AsObject): number | undefined {
    const traits = this.arrayTraits;
    if (traits === null || o.$traits !== traits) {
      return undefined;
    }

    const prototype = this.arrayPrototype as AsObject;
    const d: Map<string, Value> | null = o.$d;
    const pd: Map<string, Value> = prototype.$d;
    if (
      (d !== null && (d.has("valueOf") || d.has("toString"))) ||
      pd.has("valueOf") ||
      pd.get("toString") !== this.arrayToString ||
      (prototype.$p as AsObject).$d.get("valueOf") !== this.objectValueOf
    ) {
      return undefined;
    }

    const a: Value[] = o.$a;
    const length = a.length;
    if (length === 0) {
      return 0;
    }

    if (length === 1) {
      if (!(0 in a)) {
        return undefined;
      }

      const v = a[0];
      switch (typeof v) {
        case "number":
          return numberReadBack(v);
        case "string":
          return stringToNumber(v);
        case "boolean":
          return Number.NaN;
        case "undefined":
          return 0;
        default:
          return v === null ? 0 : undefined;
      }
    }

    for (let i = 0; i < length; i++) {
      if (!(i in a)) {
        return undefined;
      }

      const v = a[i];
      if (v !== null && typeof v === "object") {
        return undefined;
      }

      if (typeof v === "string" && v.includes("\0")) {
        return undefined;
      }
    }

    return Number.NaN;
  }
}
