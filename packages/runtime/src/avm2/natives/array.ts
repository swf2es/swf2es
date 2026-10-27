// Array: its natives, and its instances' element storage.

import type { AsObject, Value } from "../descriptors.js";
import { FloatValue } from "../float.js";
import type { ClassHook } from "../hooks.js";
import { type Runtime, SEALED_ELEMENTS } from "../runtime.js";
import {
  AS3,
  eachElement,
  elements,
  getElement,
  isObject,
  LENGTH,
  lengthOf,
  type Natives,
  plain,
  withStorage,
} from "./define.js";
import { sort, sortOn } from "./sort.js";

/**
 * Whether `o` is a sealed Array subclass's instance, which has no elements:
 * one added fails as a sealed object's property does, ReferenceError 1056.
 */
function sealed(rt: Runtime, o: AsObject, adding: number): boolean {
  if (o.$a !== SEALED_ELEMENTS) {
    return false;
  }

  if (adding > 0) {
    throw rt.error("ReferenceError", 1056, "0", o.$traits.name);
  }

  return true;
}

/** As ArrayClass::toArray: the elements of an Array or of a subclass's instance, else null. */
function arrayElements(rt: Runtime, o: Value): Value[] | null {
  if (!isObject(o) || o.$a === undefined) {
    return null;
  }

  return rt.traitsOf(o).isSubtypeOf(rt.builtinClass("Array").$it) ? o.$a : null;
}

/**
 * The elements of an Array whose length, as the natives that walk to
 * getLengthProperty read it, is their count: else null, for the generic
 * path, as for a subclass that overrides its length getter.
 */
function arrayElementsOf(rt: Runtime, o: AsObject, length: number): Value[] | null {
  const a = arrayElements(rt, o);
  return a !== null && a.length === length ? a : null;
}

/** As AvmCore::toInteger: a number, truncated, NaN as 0. */
function toInteger(rt: Runtime, v: Value): number {
  const n = rt.toNumber(v);
  return Number.isNaN(n) ? 0 : Math.trunc(n);
}

/**
 * What Array's generic functions see of an object that is not an Array, a
 * Vector or a ByteArray among them, or of an Array whose length getter is
 * overridden: its length property, as a uint, and its elements.
 */
class Generic {
  constructor(
    readonly rt: Runtime,
    readonly o: AsObject,
  ) {}

  get length(): number {
    return this.rt.toUint(this.rt.getProperty(this.o, LENGTH));
  }

  set length(n: number) {
    this.rt.setProperty(this.o, LENGTH, n);
  }

  get(i: number): Value {
    return getElement(this.rt, this.o, i);
  }

  set(i: number, v: Value): void {
    this.rt.setProperty(this.o, this.rt.publicName(i), v);
  }

  delete(i: number): void {
    this.rt.deleteProperty(this.o, this.rt.publicName(i));
  }
}

/** As NativeObjectHelpers::ClampIndex: a relative index, from the end if negative, within the length. */
function clampIndex(i: number, length: number): number {
  if (i < 0) {
    return i + length < 0 ? 0 : Math.trunc(i + length);
  }

  if (i > length) {
    return length;
  }

  return Number.isNaN(i) ? 0 : Math.trunc(i);
}

/** As ClampIndexInt, whose length is an int: one past 2^31 is negative. */
function clampIndexInt(i: number, length: number): number {
  const signed = length | 0;
  if (i < 0) {
    return i + signed < 0 ? 0 : (i + length) >>> 0;
  }

  return i > signed ? length : i;
}

/** As ArrayClass::generic_pop for what is not an Array. */
function genericPop(g: Generic): Value {
  const length = g.length;
  if (length === 0) {
    g.length = 0;
    return undefined;
  }

  const last = g.get(length - 1);
  g.delete(length - 1);
  g.length = length - 1;
  return last;
}

/** As generic_shift: every element moved down one. */
function genericShift(g: Generic): Value {
  const length = g.length;
  if (length === 0) {
    g.length = 0;
    return undefined;
  }

  const first = g.get(0);
  for (let i = 0; i < length - 1; i++) {
    g.set(i, g.get(i + 1));
  }

  g.delete(length - 1);
  g.length = length - 1;
  return first;
}

/** As generic_reverse: from both ends inward. */
function genericReverse(g: Generic): void {
  let j = g.length;
  let i = 0;
  if (j) {
    j--;
  }

  while (i < j) {
    const front = g.get(i);
    const back = g.get(j);
    g.set(i++, back);
    g.set(j--, front);
  }
}

/** As generic_splice: where to splice, and how many to delete, within the length. */
function spliceRange(rt: Runtime, length: number, args: Value[]): [number, number] {
  const at = clampIndex(toInteger(rt, args[0]), length);
  const wanted = args.length > 1 ? toInteger(rt, args[1]) : length - at;
  return [at, Math.min(wanted < 0 ? 0 : Math.trunc(wanted), length - at)];
}

/** As generic_splice: the deleted elements out, the rest moved, the inserted set, then the length. */
function genericSplice(
  rt: Runtime,
  g: Generic,
  length: number,
  at: number,
  deleted: number,
  args: Value[],
): AsObject {
  const end = at + deleted;
  const inserted = args.length > 2 ? args.length - 2 : 0;
  const shift = inserted - deleted;
  const out: Value[] = [];
  for (let i = 0; i < deleted; i++) {
    out.push(g.get(i + at));
  }

  if (shift < 0) {
    for (let i = end; i < length; i++) {
      g.set(i + shift, g.get(i));
    }

    for (let i = length + shift; i < length; i++) {
      g.delete(i);
    }
  } else {
    for (let i = length; i > end; ) {
      i--;
      g.set(i + shift, g.get(i));
    }
  }

  for (let i = 0; i < inserted; i++) {
    g.set(at + i, args[i + 2]);
  }

  g.length = length + shift;
  return rt.array(out);
}

/**
 * As array_concat reads an Array: its elements up to its length as
 * getLengthProperty reads it; its own storage, not to be changed, when
 * that is their count.
 */
function concatElements(rt: Runtime, o: AsObject): Value[] {
  const length = lengthOf(rt, o);
  const a = arrayElementsOf(rt, o, length);
  if (a) {
    return a;
  }

  const out: Value[] = [];
  for (let i = 0; i < length; i++) {
    out.push(getElement(rt, o, i));
  }

  return out;
}

export const arrayNatives: Natives = {
  // Array
  "Array#get:length": plain(function (this: AsObject) {
    return this.$a.length;
  }),
  "Array#set:length": (rt) =>
    function (this: AsObject, n: Value) {
      if (!sealed(rt, this, 0)) {
        this.$a.length = rt.toUint(n);
      }
    },
  [`Array#${AS3}::push`]: (rt) =>
    function (this: AsObject, ...args: Value[]) {
      return sealed(rt, this, args.length) ? 0 : this.$a.push(...args);
    },
  [`Array#${AS3}::pop`]: (rt) =>
    function (this: AsObject) {
      return sealed(rt, this, 0) ? undefined : this.$a.pop();
    },
  [`Array#${AS3}::unshift`]: (rt) =>
    function (this: AsObject, ...args: Value[]) {
      return sealed(rt, this, args.length) ? 0 : this.$a.unshift(...args);
    },
  [`Array#${AS3}::insertAt`]: (rt) =>
    function (this: AsObject, i: Value, v: Value) {
      if (!sealed(rt, this, 1)) {
        this.$a.splice(rt.toInt(i), 0, v);
      }
    },
  [`Array#${AS3}::removeAt`]: (rt) =>
    function (this: AsObject, i: Value) {
      return sealed(rt, this, 0) ? undefined : this.$a.splice(rt.toInt(i), 1)[0];
    },
  "Array.Array::_pop": (rt) => (o: Value) => {
    if (!arrayElements(rt, o)) {
      return isObject(o) ? genericPop(new Generic(rt, o)) : undefined;
    }

    return sealed(rt, o, 0) ? undefined : o.$a.pop();
  },
  "Array.Array::_shift": (rt) => (o: Value) => {
    if (!arrayElements(rt, o)) {
      return isObject(o) ? genericShift(new Generic(rt, o)) : undefined;
    }

    return sealed(rt, o, 0) ? undefined : o.$a.shift();
  },
  "Array.Array::_reverse": (rt) => (o: Value) => {
    const a = arrayElements(rt, o);
    if (a) {
      a.reverse();
    } else if (isObject(o)) {
      genericReverse(new Generic(rt, o));
    }

    return o;
  },
  "Array.Array::_unshift": (rt) => (o: AsObject, args: Value) => {
    // As generic_unshift: the length after is getLengthProperty's.
    const a = elements(args);
    if (sealed(rt, o, a.length)) {
      return 0;
    }

    o.$a.unshift(...a);
    return lengthOf(rt, o);
  },
  // As generic_concat: what is not an Array is left out as the receiver,
  // and is one element as an argument.
  "Array.Array::_concat": (rt) => (o: Value, args: Value) => {
    const out = arrayElements(rt, o) ? concatElements(rt, o).slice() : [];
    for (const a of elements(args)) {
      if (arrayElements(rt, a)) {
        out.push(...concatElements(rt, a));
      } else {
        out.push(a);
      }
    }

    return rt.array(out);
  },
  "Array.Array::_slice": (rt) => (o: Value, start: Value, end: Value) => {
    if (!isObject(o)) {
      return null;
    }

    const length = lengthOf(rt, o);
    const a = arrayElementsOf(rt, o, length);
    if (a) {
      return rt.array(a.slice(rt.toNumber(start), rt.toNumber(end)));
    }

    const g = new Generic(rt, o);
    const from = clampIndex(rt.toNumber(start), length);
    const to = Math.max(from, clampIndex(rt.toNumber(end), length));
    const out: Value[] = [];
    for (let i = from; i < to; i++) {
      out.push(g.get(i));
    }

    return rt.array(out);
  },
  "Array.Array::_splice": (rt) => (o: Value, args: Value) => {
    const a = elements(args);
    if (a.length === 0) {
      return rt.array([]);
    }

    if (!isObject(o)) {
      return null;
    }

    // As generic_splice: the range within the length getLengthProperty
    // reads, spliced in an Array's storage where the storage holds it
    // (ArrayObject::try_splice), else element by element.
    const length = lengthOf(rt, o);
    const storage = arrayElements(rt, o);
    if (storage !== null && sealed(rt, o, a.length - 2)) {
      return rt.array([]);
    }

    const [at, deleted] = spliceRange(rt, length, a);
    if (storage !== null && at + deleted <= storage.length) {
      return rt.array(storage.splice(at, deleted, ...a.slice(2)));
    }

    return genericSplice(rt, new Generic(rt, o), length, at, deleted, a);
  },
  "Array.Array::_indexOf": (rt) => (o: Value, v: Value, from: Value) => {
    if (!isObject(o)) {
      return -1;
    }

    const length = lengthOf(rt, o);
    const a = arrayElementsOf(rt, o, length);
    if (a) {
      const start = rt.toInt(from);
      if (v instanceof FloatValue) {
        for (let i = clampIndexInt(start, a.length); i < a.length; i++) {
          if (rt.strictEquals(a[i], v)) {
            return i;
          }
        }

        return -1;
      }

      return a.indexOf(v, start);
    }

    // As generic_indexOf: by strict equality, from the start clamped.
    const g = new Generic(rt, o);
    for (let i = clampIndexInt(rt.toInt(from), length); i < length; i++) {
      if (rt.strictEquals(g.get(i), v)) {
        return i;
      }
    }

    return -1;
  },
  "Array.Array::_lastIndexOf": (rt) => (o: Value, v: Value, from: Value) => {
    if (!isObject(o)) {
      return -1;
    }

    const length = lengthOf(rt, o);
    const a = arrayElementsOf(rt, o, length);
    if (a) {
      const start = rt.toInt(from);
      if (v instanceof FloatValue) {
        const at = start < 0 ? a.length + start : Math.min(start, a.length - 1);
        for (let i = at; i >= 0; i--) {
          if (rt.strictEquals(a[i], v)) {
            return i;
          }
        }

        return -1;
      }

      return a.lastIndexOf(v, start);
    }

    const g = new Generic(rt, o);
    let start = clampIndexInt(rt.toInt(from), length);
    if (start === length) {
      start--;
    }

    for (let i = start | 0; i >= 0; i--) {
      if (rt.strictEquals(g.get(i), v)) {
        return i;
      }
    }

    return -1;
  },
  "Array.Array::_sort": (rt) => (o: Value, args: Value) => sort(rt, o, elements(args)),
  "Array.Array::_sortOn": (rt) => (o: Value, names: Value, options: Value) =>
    sortOn(rt, o, names, options),
  "Array.Array::_every": (rt) => (o: Value, f: Value, receiver: Value) =>
    eachElement(rt, o, f, receiver, (result) => (result === true ? undefined : false)) ?? true,
  "Array.Array::_some": (rt) => (o: Value, f: Value, receiver: Value) =>
    eachElement(rt, o, f, receiver, (result) => (result === true ? true : undefined)) ?? false,
  "Array.Array::_forEach": (rt) => (o: Value, f: Value, receiver: Value) => {
    eachElement(rt, o, f, receiver, () => undefined);
  },
  "Array.Array::_filter": (rt) => (o: Value, f: Value, receiver: Value) => {
    const out: Value[] = [];
    eachElement(rt, o, f, receiver, (result, element) => {
      if (result === true) {
        out.push(element);
      }
    });
    return rt.array(out);
  },
  // As generic_map, which alone of them lets a method closure have any receiver.
  "Array.Array::_map": (rt) => (o: Value, f: Value, receiver: Value) => {
    const out: Value[] = [];
    eachElement(
      rt,
      o,
      f,
      receiver,
      (result) => {
        out.push(result);
      },
      true,
    );
    return rt.array(out);
  },
};

export const arrayHooks: Record<string, ClassHook> = {
  Array: {
    // A subclass that is not dynamic has no elements from SWF 13 (avmplus'
    // bugzilla 654807); before, it keeps them, as here.
    create: (traits, rt) => {
      const o = withStorage(traits);
      if (!traits.dynamic && rt.swfVersion >= 13) {
        o.$a = SEALED_ELEMENTS;
      }

      return o;
    },
    // Array.prototype is an Array, empty.
    prototype: (_rt, cls) => cls.$it.instance(),
    call: (rt, cls, args) => rt.constructClass(cls, args),
    created: (rt, cls) => rt.noteArrayClass(cls),
  },
};
