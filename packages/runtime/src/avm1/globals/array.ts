// Array, as Ruffle's (https://github.com/ruffle-rs/ruffle)
// core/src/avm1/globals/array.rs has it: MIT OR Apache-2.0, Copyright (c)
// 2018-2022 Ruffle LLC and Ruffle contributors. Where adl parts from
// Ruffle, adl decides (docs/avm1.md, "Array and String").
//
// The methods read and write an object's own elements as adl does: a read
// takes the stored value, no getter called and nothing inherited; a write
// tells the element's watcher, and an array's `length`'s watcher as it
// grows, then stores the value unless it is read-only, no setter called.
// Most writes delete the element first, so that it comes last in for..in's
// order, and its attributes go with it unless it cannot be deleted. A dense array no watcher looks at takes the same steps directly
// on its elements, without names.

import { lowerCase } from "../case.js";
import {
  Avm1Function,
  Avm1Object,
  DONT_DELETE,
  DONT_ENUM,
  growTo,
  invoke,
  lengthOf,
  type Native,
  Property,
  READ_ONLY,
  removeOwn,
  truncate,
  watched,
} from "../objects.js";
import { clampInt } from "../operators.js";
import type { Realm } from "../realm.js";
import { isPrimitive, stringOf, toNumber, type Value } from "../values.js";

// sort's and sortOn's options.
export const CASE_INSENSITIVE = 1;
export const DESCENDING = 2;
export const UNIQUE_SORT = 4;
export const RETURN_INDEXED_ARRAY = 8;
export const NUMERIC = 16;

/** Element `i`'s stored value, undefined where there is none. */
export function element(a: Avm1Object, i: number): Value {
  const elems = a.elems;
  if (elems !== null) {
    return i >= 0 && i < elems.length ? elems[i].value : undefined;
  }

  const p = a.props.get(String(i));
  return p === undefined ? undefined : p.value;
}

/**
 * Element `i` set: an array's `length` grown past it first, its watcher
 * told, then the element's, then the value stored unless it is read-only.
 */
export function setElement(a: Avm1Object, i: number, value: Value, version: number): void {
  if (a.array && i >= lengthOf(a, version)) {
    growTo(a, (i + 1) | 0, version);
  }

  const elems = a.elems;
  if (elems !== null && a.watchers === null && i >= 0 && i <= elems.length) {
    if (i < elems.length) {
      store(elems[i], value);
    } else {
      a.add(String(i), value, 0);
    }

    return;
  }

  const name = String(i);
  if (a.watchers !== null) {
    value = watched(a, name, a.exact(name)?.value, value, version);
  }

  const p = a.exact(name);
  if (p === undefined) {
    a.add(name, value, 0);
  } else {
    store(p, value);
  }
}

function store(p: Property, value: Value): void {
  if ((p.flags & READ_ONLY) === 0) {
    p.value = value;
  }
}

/** Element `i` deleted, unless it cannot be. */
function deleteElement(a: Avm1Object, i: number): void {
  const elems = a.elems;
  if (elems === null) {
    removeOwn(a, String(i), 7);
  } else if (i >= 0 && i < elems.length) {
    const p = elems[i];
    if ((p.flags & DONT_DELETE) === 0) {
      a.remove(p);
    }
  }
}

/** Element `i` deleted and set again, as most of Array's writes are: last in the order. */
function replaceElement(a: Avm1Object, i: number, value: Value, version: number): void {
  const elems = a.elems;
  if (elems !== null && a.watchers === null && i >= 0 && i < elems.length) {
    if (a.array && i >= lengthOf(a, version)) {
      growTo(a, (i + 1) | 0, version);
    }

    const p = elems[i];
    if (p.flags & DONT_DELETE) {
      store(p, value);
    } else {
      a.renew(p, value);
    }

    return;
  }

  deleteElement(a, i);
  setElement(a, i, value, version);
}

/**
 * `length` set, its watcher told, though what it gives is not kept (adl,
 * an array or not): an array's elements past it deleted.
 */
export function setLength(a: Avm1Object, length: number, version: number): void {
  const p = a.props.get("length");
  if (a.watchers !== null) {
    watched(a, "length", p === undefined ? undefined : p.value, length, version);
  }

  if (a.array && p !== undefined && typeof p.value === "number") {
    truncate(a, length, p.value | 0);
  }

  if (p === undefined) {
    a.add("length", length, 0);
  } else {
    p.value = length;
  }
}

/** An index as slice and splice take one: from the end where negative, within 0 and `length`. */
function absolute(index: number, length: number): number {
  return index < 0 ? Math.max(index + length, 0) : Math.min(index, length);
}

const toInt = (value: Value, version: number) => toNumber(value, version) | 0;

/** An element of a sort: its index before, its value, and its string for the comparisons. */
interface Item {
  index: number;
  value: Value;
  /** The value's string where it is a primitive, whose conversion calls nothing; else null. */
  text: string | null;
}

type Compare = (a: Item, b: Item) => number;

/** The class: its constructor, prototype and methods. */
export function arrayClass(realm: Realm): { constr: Avm1Function; proto: Avm1Object } {
  const proto = new Avm1Object();
  const constr = realm.classOf(
    proto,
    (self, args, version) => initArray(realm, self, args, version),
    (_, args, version) => {
      const a = realm.newArray([], version);
      return initArray(realm, a, args, version);
    },
  );
  proto.define("__proto__", realm.objectProto, DONT_ENUM | DONT_DELETE);
  for (const [name, value] of [
    ["CASEINSENSITIVE", CASE_INSENSITIVE],
    ["DESCENDING", DESCENDING],
    ["UNIQUESORT", UNIQUE_SORT],
    ["RETURNINDEXEDARRAY", RETURN_INDEXED_ARRAY],
    ["NUMERIC", NUMERIC],
  ] as const) {
    constr.define(name, value, 0);
  }

  // ASnative(252, i): Array called as a function, then the methods in the order defined.
  const table: Native[] = [constr.native];
  realm.natives.set(252, (i) => table[i] ?? null);
  const define = (name: string, native: Native) => {
    table.push(native);
    proto.define(name, realm.method(native), DONT_ENUM | DONT_DELETE);
  };

  const join = (self: Avm1Object, separator: string, version: number): string => {
    const n = lengthOf(self, version);
    let text = "";
    for (let i = 0; i < n; i++) {
      if (i > 0) {
        text += separator;
      }

      text += stringOf(element(self, i), version);
    }

    return text;
  };

  define("push", (self, args, version) => {
    // A dense array no watcher looks at takes its new elements at its end.
    const elems = self.elems;
    const p = self.props.get("length");
    if (
      elems !== null &&
      self.watchers === null &&
      self.array &&
      p !== undefined &&
      p.value === elems.length
    ) {
      const length = elems.length;
      for (let i = 0; i < args.length; i++) {
        elems.push(new Property(String(length + i), args[i], 0));
      }

      p.value = elems.length;
      return elems.length;
    }

    const length = lengthOf(self, version);
    for (let i = 0; i < args.length; i++) {
      setElement(self, length + i, args[i], version);
    }

    if (!self.array) {
      setLength(self, length + args.length, version);
    }

    return length + args.length;
  });
  define("pop", (self, _, version) => {
    const length = lengthOf(self, version);
    if (length === 0) {
      return undefined;
    }

    const last = element(self, length - 1);
    deleteElement(self, length - 1);
    if (self.array) {
      setLength(self, length - 1, version);
    }

    return last;
  });
  define("concat", (self, args, version) => {
    const values: Value[] = [];
    const spread = (o: Value, first: boolean) => {
      if (
        o instanceof Avm1Object &&
        (o.array || (first && !(o instanceof Avm1Function) && o.primitive === undefined))
      ) {
        const n = lengthOf(o, version);
        for (let i = 0; i < n; i++) {
          values.push(element(o, i));
        }
      } else {
        values.push(o);
      }
    };
    spread(self, true);
    for (const arg of args) {
      spread(arg, false);
    }

    return realm.newArray(values, version);
  });
  define("shift", (self, _, version) => {
    const length = lengthOf(self, version);
    if (length === 0) {
      return undefined;
    }

    const first = element(self, 0);
    for (let i = 1; i < length; i++) {
      replaceElement(self, i - 1, element(self, i), version);
    }

    if (self.array) {
      setLength(self, length - 1, version);
    }

    return first;
  });
  // adl: with nothing to add, nothing; else the elements moved up and
  // the first ones cleared, `length` set again, and the new ones set.
  define("unshift", (self, args, version) => {
    const length = lengthOf(self, version);
    const count = args.length;
    if (count === 0) {
      return length;
    }

    const total = length + count;
    if (length > 0) {
      if (self.array) {
        setLength(self, total, version);
      }

      for (let i = length - 1; i >= 0; i--) {
        replaceElement(self, i + count, element(self, i), version);
      }

      for (let i = 0; i < count; i++) {
        replaceElement(self, i, undefined, version);
      }
    }

    if (self.array) {
      setLength(self, total, version);
    }

    for (let i = 0; i < count; i++) {
      replaceElement(self, i, args[i], version);
    }

    return total;
  });
  define("slice", (self, args, version) => {
    const length = lengthOf(self, version);
    const start = absolute(args.length > 0 ? toInt(args[0], version) : 0, length);
    const end =
      args.length > 1 && args[1] !== undefined ? absolute(toInt(args[1], version), length) : length;
    const values: Value[] = [];
    for (let i = start; i < end; i++) {
      values.push(element(self, i));
    }

    return realm.newArray(values, version);
  });
  define("join", (self, args, version) =>
    join(self, args.length > 0 ? stringOf(args[0], version) : ",", version),
  );
  // adl rebuilds the whole array: `length` set to 0, then every element set again.
  define("splice", (self, args, version) => {
    if (args.length === 0 || args[0] === undefined) {
      return undefined;
    }

    const length = lengthOf(self, version);
    const start = absolute(toInt(args[0], version), length);
    let count = length - start;
    if (args.length > 1) {
      if (args[1] === undefined) {
        return undefined;
      }

      count = Math.min(toInt(args[1], version), length - start);
    }

    if (count < 0) {
      return undefined;
    }

    const removed: Value[] = [];
    for (let i = 0; i < count; i++) {
      removed.push(element(self, start + i));
    }

    const values: Value[] = [];
    for (let i = 0; i < start; i++) {
      values.push(element(self, i));
    }

    for (let i = 2; i < args.length; i++) {
      values.push(args[i]);
    }

    for (let i = start + count; i < length; i++) {
      values.push(element(self, i));
    }

    rebuild(self, values, version);
    return realm.newArray(removed, version);
  });
  define("toString", (self, _, version) => join(self, ",", version));
  define("sort", (self, args, version) => {
    let compare: Avm1Function | null = null;
    let options = 0;
    const a0 = args.length > 0 ? args[0] : undefined;
    if (args.length > 0) {
      if (a0 instanceof Avm1Object) {
        // adl sorts by its own order with an object that is no function.
        compare = a0 instanceof Avm1Function ? a0 : null;
        options = typeof args[1] === "number" ? toInt(args[1], version) : 0;
      } else if (typeof a0 === "number") {
        options = toInt(typeof args[1] === "number" ? args[1] : a0, version);
      } else {
        return undefined;
      }
    }

    const order: Compare =
      compare === null
        ? (x, y) => compareValues(x, y, options & ~DESCENDING, version)
        : (x, y) => {
            const n = toNumber(invoke(compare, undefined, [x.value, y.value], version), version);
            return n < 0 ? -1 : n > 0 ? 1 : 0;
          };
    return sortItems(realm, self, order, options, false, version);
  });
  define("reverse", (self, _, version) => {
    const length = lengthOf(self, version);
    for (let lower = 0; lower < length >> 1; lower++) {
      const upper = length - lower - 1;
      const low = element(self, lower);
      const high = element(self, upper);
      // Each set in turn, as a watcher of the second sees.
      replaceElement(self, lower, high, version);
      replaceElement(self, upper, low, version);
    }

    return self;
  });
  define("sortOn", (self, args, version) => {
    if (args.length === 0) {
      return undefined;
    }

    const names = args[0];
    const fields: [string, number][] = [];
    if (names instanceof Avm1Object) {
      if (!names.array) {
        return sortItems(realm, self, (x, y) => compareValues(x, y, 0, version), 0, true, version);
      }

      const n = lengthOf(names, version);
      if (n <= 0) {
        return self;
      }

      for (let i = 0; i < n; i++) {
        fields.push([stringOf(element(names, i), version), 0]);
      }

      const options = args.length > 1 ? args[1] : undefined;
      if (options instanceof Avm1Object) {
        if (options.array && lengthOf(options, version) === n) {
          for (let i = 0; i < n; i++) {
            fields[i][1] = toInt(element(options, i), version);
          }
        }
      } else if (args.length > 1) {
        const all = toInt(options, version);
        for (const f of fields) {
          f[1] = all;
        }
      }
    } else {
      fields.push([
        stringOf(names, version),
        typeof args[1] === "number" ? toInt(args[1], version) : 0,
      ]);
    }

    const main = fields[0][1];
    const order: Compare = (x, y) => {
      const a = x.value;
      const b = y.value;
      if (!(a instanceof Avm1Object && b instanceof Avm1Object)) {
        return compareValues(x, y, main, version);
      }

      for (const [name, options] of fields) {
        const r = compareValues(
          item(-1, a.own(name, version)?.value, version),
          item(-1, b.own(name, version)?.value, version),
          options,
          version,
        );
        if (r !== 0) {
          return r;
        }
      }

      return 0;
    };
    return sortItems(realm, self, order, main, true, version);
  });

  return { constr, proto };
}

/** `self` made an array of `args`, or of a length where the one argument is a number. */
export function initArray(
  realm: Realm,
  self: Avm1Object,
  args: Value[],
  version: number,
): Avm1Object {
  if (args.length === 1 && typeof args[0] === "number") {
    realm.fillArray(self, [], version);
    setLength(self, clampInt(args[0]), version);
    return self;
  }

  return realm.fillArray(self, args, version);
}

function item(index: number, value: Value, version: number): Item {
  return { index, value, text: isPrimitive(value) ? stringOf(value, version) : null };
}

/** A string lower-cased as Flash compares one ignoring case. */
function lowered(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    out += String.fromCharCode(lowerCase(s.charCodeAt(i)));
  }

  return out;
}

/**
 * The default order: numbers by value where NUMERIC is asked and both are
 * numbers, else by their strings' code units, ignoring case where asked;
 * reversed where DESCENDING is.
 */
function compareValues(x: Item, y: Item, options: number, version: number): number {
  const a = x.value;
  const b = y.value;
  let r: number;
  if (options & NUMERIC && typeof a === "number" && typeof b === "number") {
    r = a < b ? -1 : a > b ? 1 : 0;
  } else {
    let s = x.text ?? stringOf(a, version);
    let t = y.text ?? stringOf(b, version);
    if (options & CASE_INSENSITIVE) {
      s = lowered(s);
      t = lowered(t);
    }

    r = s < t ? -1 : s > t ? 1 : 0;
  }

  return options & DESCENDING ? -r : r;
}

/**
 * Flash's quicksort, as Ruffle has it: the leftmost element the pivot,
 * which the comparator's calls, a function's that a SWF traces, show.
 */
function quicksort(items: Item[], compare: Compare): void {
  if (items.length < 2) {
    return;
  }

  const stack = [0, items.length - 1];
  while (stack.length > 0) {
    const high = stack.pop() as number;
    const low = stack.pop() as number;
    if (low >= high) {
      continue;
    }

    const pivot = items[low];
    let left = low + 1;
    let right = high;
    for (;;) {
      while (left < right && compare(pivot, items[left]) > 0) {
        left++;
      }

      while (right > low && compare(pivot, items[right]) <= 0) {
        right--;
      }

      if (left >= right) {
        break;
      }

      const t = items[left];
      items[left] = items[right];
      items[right] = t;
    }

    const t = items[low];
    items[low] = items[right];
    items[right] = t;
    stack.push(right + 1, high);
    if (right > 0) {
      stack.push(low, right - 1);
    }
  }
}

/**
 * sort's and sortOn's work: the elements sorted, reversed afterwards for
 * sort's DESCENDING (sortOn's compares so), 0 for UNIQUESORT where two
 * compare equal, the indices for RETURNINDEXEDARRAY, else the elements
 * that moved set again, as adl sets them, and the array.
 */
function sortItems(
  realm: Realm,
  self: Avm1Object,
  compare: Compare,
  options: number,
  sortOn: boolean,
  version: number,
): Value {
  const length = lengthOf(self, version);
  const items: Item[] = [];
  for (let i = 0; i < length; i++) {
    items.push(item(i, element(self, i), version));
  }

  quicksort(items, compare);
  if (!sortOn && options & DESCENDING) {
    items.reverse();
  }

  if (options & UNIQUE_SORT) {
    const unique: Compare = sortOn ? compare : (x, y) => compareValues(x, y, options, version);
    for (let i = 1; i < items.length; i++) {
      if (unique(items[i - 1], items[i]) === 0) {
        return 0;
      }
    }
  }

  if (options & RETURN_INDEXED_ARRAY) {
    return realm.newArray(
      items.map((it) => it.index),
      version,
    );
  }

  for (let i = 0; i < items.length; i++) {
    if (items[i].index !== i) {
      replaceElement(self, i, items[i].value, version);
    }
  }

  return self;
}

/**
 * The elements made `values`, as adl's splice makes them: `length` set to
 * 0, then each element set in turn, a non-array's `length` after each.
 */
function rebuild(self: Avm1Object, values: Value[], version: number): void {
  const elems = self.elems;
  const p = self.props.get("length");
  if (
    elems !== null &&
    self.watchers === null &&
    self.array &&
    p !== undefined &&
    typeof p.value === "number" &&
    elems.every((e) => (e.flags & DONT_DELETE) === 0)
  ) {
    // The same steps, the elements' properties kept and renewed in order.
    const kept = elems.splice(0, elems.length);
    for (let i = 0; i < values.length; i++) {
      if (i < kept.length) {
        self.renew(kept[i], values[i]);
        elems.push(kept[i]);
      } else {
        self.add(String(i), values[i], 0);
      }
    }

    p.value = values.length;
    return;
  }

  setLength(self, 0, version);
  for (let i = 0; i < values.length; i++) {
    setElement(self, i, values[i], version);
    if (!self.array) {
      setLength(self, i + 1, version);
    }
  }
}
