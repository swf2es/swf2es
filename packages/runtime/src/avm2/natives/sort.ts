// Array's and Vector's sort and sortOn, as avmplus' ArraySort does them:
// its own quicksort, not stable, so that elements that compare equal end
// up in the order avmplus leaves them; undefined elements after the
// others, and missing ones last; and its options and comparisons, with the
// bug compatibility of the latest SWF version (bugzillas 524122, 532454).
//
// Translated from avmplus' core/ArrayClass.cpp, this file is subject to the
// Mozilla Public License, v. 2.0: http://mozilla.org/MPL/2.0/.

import type { AsObject, Value } from "../descriptors.js";
import { FloatValue } from "../float.js";
import { publicQname } from "../names.js";
import { type Runtime, SEALED_ELEMENTS } from "../runtime.js";
import { lowerCase } from "./case.js";
import { getElement, isObject, lengthOf } from "./define.js";
import { FloatVector } from "./float-vector.js";

const kCaseInsensitive = 1;
const kDescending = 2;
const kUniqueSort = 4;
const kReturnIndexedArray = 8;
const kNumeric = 16;

type Compare = (x: Value, y: Value) => number;

interface Field {
  name: string;
  options: number;
}

function stringCompare(rt: Runtime, lower: boolean): Compare {
  return (x, y) => {
    let a = rt.toString(x);
    let b = rt.toString(y);
    if (lower) {
      a = lowerCase(a);
      b = lowerCase(b);
    }

    return a < b ? -1 : a > b ? 1 : 0;
  };
}

function numericCompare(rt: Runtime): Compare {
  return (x, y) => {
    const a = rt.toNumber(x);
    const b = rt.toNumber(y);
    const diff = a - b;
    if (!Number.isNaN(diff)) {
      return diff < 0 ? -1 : diff > 0 ? 1 : 0;
    }

    return !Number.isNaN(b) ? 1 : !Number.isNaN(a) ? -1 : 0;
  };
}

/** The comparison options name, without a compare function. */
function compareOf(rt: Runtime, options: number): Compare {
  const compare =
    options & kNumeric ? numericCompare(rt) : stringCompare(rt, (options & kCaseInsensitive) !== 0);
  return options & kDescending ? (x, y) => compare(y, x) : compare;
}

/** As ArrayClass::generic_sort: sort(), sort(compare), sort(options) or sort(compare, options). */
export function sort(rt: Runtime, d: Value, args: Value[]): Value {
  if (!isObject(d)) {
    return undefined;
  }

  let compare: Compare | null = null;
  let options = 0;
  let numeric = false;
  if (args.length >= 1) {
    const arg0 = args[0];
    if (isObject(arg0)) {
      if (!arg0.$f) {
        throw rt.error("TypeError", 1034, rt.describe(arg0), "Function");
      }

      // The comparator's result counts by its sign, as a Number. Its arguments go in one pair for
      // the sort, not one a comparison: the comparator has $f, which callValue calls with apply,
      // and apply copies the pair into the call's own parameters, rest or arguments, a native's
      // as an AS3 method's, keeping no reference to it. A comparator that sorts inside itself has
      // its own sort's pair.
      const pair: Value[] = [undefined, undefined];
      compare = (x, y) => {
        pair[0] = x;
        pair[1] = y;
        const result = rt.toNumber(rt.callValue(arg0, d, pair, null));
        return result > 0 ? 1 : result < 0 ? -1 : 0;
      };
      if (args.length >= 2) {
        if (typeof args[1] !== "number" && !(args[1] instanceof FloatValue)) {
          throw rt.error("TypeError", 1034, rt.describe(args[1]), "Number");
        }

        options = rt.toInt(args[1]);
      }
    } else if (typeof arg0 === "number" || (arg0 as unknown) instanceof FloatValue) {
      options = rt.toInt(arg0);
    } else {
      throw rt.error("TypeError", 1034, rt.describe(arg0), "Function");
    }
  }

  if (compare === null) {
    numeric = (options & kNumeric) !== 0;
    compare = compareOf(rt, options);
  } else if (options & kDescending) {
    const ascending = compare;
    compare = (x, y) => ascending(y, x);
  }

  return sortWith(rt, d, options, compare, numeric, null);
}

/** As ArrayClass::generic_sortOn: by one field or several, each with its options. */
export function sortOn(rt: Runtime, d: Value, names: Value, optionsIn: Value): Value {
  if (!isObject(d)) {
    return undefined;
  }

  const fields: Field[] = [];
  let options = 0;
  if (typeof names === "string") {
    options = rt.toInt(optionsIn);
    fields.push({ name: names, options });
  } else if (names?.$a && names.$traits.name === "Array") {
    for (const n of names.$a as Value[]) {
      fields.push({ name: rt.toString(n), options: 0 });
    }

    if (optionsIn?.$a && optionsIn.$traits.name === "Array") {
      const list: Value[] = optionsIn.$a;
      if (list.length === fields.length) {
        options = rt.toInt(list[0]);
        fields.forEach((f, i) => {
          f.options = rt.toInt(list[i]);
        });
      }
    } else {
      options = rt.toInt(optionsIn);
      for (const f of fields) {
        f.options = options;
      }
    }
  }

  // One field sorts by its values (sortWith), which needs no comparison of the elements.
  const compare = fields.length === 1 ? unused : fieldCompare(rt, fields, options);
  return sortWith(rt, d, options, compare, false, fields);
}

/** No comparison: sortWith makes its own where it is given this. */
const unused: Compare = () => 0;

/** As ArraySort::FieldCompare: by each field in turn, until one differs. */
function fieldCompare(rt: Runtime, fields: Field[], options: number): Compare {
  // Each field's name and comparison made once for the sort, not for each comparison.
  const names = fields.map((field) => publicQname(field.name, rt.userVersions));
  const compares = fields.map((field) =>
    field.options & kNumeric
      ? numericCompare(rt)
      : stringCompare(rt, (field.options & kCaseInsensitive) !== 0),
  );
  return (j, k) => {
    let opt = options;
    let result = 0;
    const objJ = isObject(j) ? j : null;
    const objK = isObject(k) ? k : null;
    if (!(objJ && objK)) {
      result = objK ? 1 : objJ ? -1 : 0;
      return opt & kDescending ? -result : result;
    }

    for (let f = 0; f < fields.length; f++) {
      const name = names[f];
      opt = fields[f].options;
      const x = rt.getProperty(objJ, name);
      const y = rt.getProperty(objK, name);
      const defX = x !== undefined;
      const defY = y !== undefined;
      if (!(defX && defY)) {
        if (defY) {
          result = 1;
        } else if (defX) {
          result = -1;
        } else {
          const hasX = rt.hasProperty(objJ, name);
          const hasY = rt.hasProperty(objK, name);
          result = !hasX && hasY ? 1 : hasX && !hasY ? -1 : 0;
        }
      } else {
        result = compares[f](x, y);
      }

      if (result !== 0) {
        break;
      }
    }

    return opt & kDescending ? -result : result;
  };
}

/**
 * As ArraySort's constructor: split the elements into defined, undefined
 * and missing ones, quicksort the defined, then write them back, or
 * return their order.
 */
function sortWith(
  rt: Runtime,
  d: AsObject,
  options: number,
  compareIn: Compare,
  numeric: boolean,
  fields: Field[] | null,
): Value {
  // The length as getLengthProperty reads it: an Array subclass may
  // override its getter. An Array's or a Vector's elements are in their
  // storage; anything else's are its properties.
  const len = lengthOf(rt, d);
  const storage: Value[] | undefined = d.$a;
  const a = storage !== undefined && storage !== SEALED_ELEMENTS ? storage : null;
  // As ArraySort, which leaves what it cannot index unsorted.
  if (len === 0 || len >= 0x10000000) {
    return d;
  }

  const index: number[] = new Array(len);
  const atoms: Value[] = new Array(len);
  let fieldAtoms: Value[] | null = null;
  let compare = compareIn;
  let j = len;
  let newlen = len;

  // An element that sorts after the others: undefined ones next, then missing ones.
  const partition = (i: number) => {
    j--;
    const temp = index[i];
    index[i] = index[j];
    // As hasUintProperty: a Proxy is asked through its hasProperty.
    if (!(a !== null ? i in a : rt.in(i, d))) {
      newlen--;
      index[j] = index[newlen];
      index[newlen] = temp;
    } else {
      index[j] = temp;
    }
  };

  if (fields && fields.length === 1) {
    // One field: sort by its values, then write back the elements.
    fieldAtoms = new Array(len);
    const name = publicQname(fields[0].name, rt.userVersions);
    for (let i = len - 1; i >= 0; i--) {
      index[i] = i;
      const v = getElement(rt, d, i);
      fieldAtoms[i] = v;
      if (isObject(v)) {
        atoms[i] = rt.getProperty(v, name);
      } else {
        partition(i);
      }
    }

    compare = compareOf(rt, fields[0].options);
  } else {
    for (let i = len - 1; i >= 0; i--) {
      index[i] = i;
      // As getUintProperty: a hole finds the prototype's element.
      atoms[i] = getElement(rt, d, i);
      if (
        numeric &&
        typeof atoms[i] !== "number" &&
        !(atoms[i] instanceof FloatValue) &&
        Number.isNaN(rt.toNumber(atoms[i]))
      ) {
        throw rt.error("TypeError", 1034, rt.describe(atoms[i]), "Number");
      }

      if (atoms[i] === undefined) {
        partition(i);
      }
    }
  }

  const cmp = (l: number, r: number) => compare(atoms[index[l]], atoms[index[r]]);
  const swap = (l: number, r: number) => {
    const t = index[l];
    index[l] = index[r];
    index[r] = t;
  };

  if (j > 1) {
    qsort(0, j - 1, cmp, swap);
  }

  if (options & kUniqueSort) {
    for (let i = 0; i < len - 1; i++) {
      if (cmp(i, i + 1) === 0) {
        return 0;
      }
    }
  }

  if (options & kReturnIndexedArray) {
    return rt.array(index.slice());
  }

  // Into the elements as they are now: a comparison may have set a
  // Vector's length, which gives it a new array. Read through the order from
  // the sort's own copy of them.
  const source = fieldAtoms ?? atoms;
  const target: Value[] | undefined = d.$a;
  if (target === undefined || target === SEALED_ELEMENTS) {
    // As setUintProperty and delUintProperty: the length is left as it is.
    for (let i = 0; i < newlen; i++) {
      rt.setProperty(d, rt.publicName(i), source[index[i]]);
    }

    for (let i = newlen; i < len; i++) {
      rt.deleteProperty(d, rt.publicName(i));
    }

    return d;
  }

  if (target instanceof FloatVector) {
    if (target.length < newlen) {
      target.length = newlen;
    }

    for (let i = 0; i < newlen; i++) {
      target.data[i] = rt.toNumber(source[index[i]]);
    }

    return d;
  }

  for (let i = 0; i < newlen; i++) {
    target[i] = source[index[i]];
  }

  for (let i = newlen; i < len; i++) {
    delete target[i];
  }

  return d;
}

/** As ArraySort::qsort: iterative, the middle element as pivot, the smaller partition first. */
function qsort(
  loIn: number,
  hiIn: number,
  compare: (l: number, r: number) => number,
  swap: (l: number, r: number) => void,
): void {
  let lo = loIn;
  let hi = hiIn;
  // Each frame's lo and hi, flat: a pair for each was garbage of the sort.
  const stack: number[] = [];
  if (lo >= hi) {
    return;
  }

  for (;;) {
    const size = hi - lo + 1;
    if (size < 4) {
      if (size === 3) {
        if (compare(lo, lo + 1) > 0) {
          swap(lo, lo + 1);
          if (compare(lo + 1, lo + 2) > 0) {
            swap(lo + 1, lo + 2);
            if (compare(lo, lo + 1) > 0) {
              swap(lo, lo + 1);
            }
          }
        } else if (compare(lo + 1, lo + 2) > 0) {
          swap(lo + 1, lo + 2);
          if (compare(lo, lo + 1) > 0) {
            swap(lo, lo + 1);
          }
        }
      } else if (size === 2 && compare(lo, lo + 1) > 0) {
        swap(lo, lo + 1);
      }
    } else {
      swap(lo + Math.floor(size / 2), lo);
      let left = lo;
      let right = hi + 1;
      for (;;) {
        do {
          left++;
        } while (left <= hi && compare(left, lo) <= 0);

        do {
          right--;
        } while (right > lo && compare(right, lo) >= 0);

        if (right < left) {
          break;
        }

        swap(left, right);
      }

      swap(lo, right);
      // Unsigned in avmplus: right - 1 - lo wraps when right is lo.
      if ((right - 1 - lo) >>> 0 >= (hi - left) >>> 0) {
        if (lo + 1 < right) {
          stack.push(lo, right - 1);
        }

        if (left < hi) {
          lo = left;
          continue;
        }
      } else {
        if (left < hi) {
          stack.push(left, hi);
        }

        if (lo + 1 < right) {
          hi = right - 1;
          continue;
        }
      }
    }

    if (stack.length === 0) {
      return;
    }

    hi = stack.pop() as number;
    lo = stack.pop() as number;
  }
}
