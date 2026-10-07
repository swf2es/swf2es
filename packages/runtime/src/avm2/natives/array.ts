// Array: its natives, and its instances' element storage.

import type { AsObject, Value } from "../descriptors.js";
import { type ClassHook, type Runtime, SEALED_ELEMENTS } from "../runtime.js";
import { AS3, eachElement, elements, type Natives, plain, withStorage } from "./define.js";
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

const isObject = (v: Value): v is AsObject => v !== null && typeof v === "object";

/** As ArrayClass::toArray: the elements of an Array or of a subclass's instance, else null. */
function arrayElements(rt: Runtime, o: Value): Value[] | null {
  if (!isObject(o) || o.$a === undefined) {
    return null;
  }

  return rt.traitsOf(o).isSubtypeOf(rt.builtinClass("Array").$it) ? o.$a : null;
}

/** As AvmCore::toInteger: a number, truncated, NaN as 0. */
function toInteger(rt: Runtime, v: Value): number {
  const n = rt.toNumber(v);
  return Number.isNaN(n) ? 0 : Math.trunc(n);
}

/**
 * What Array's generic functions see of an object that is not an Array, a
 * Vector or a ByteArray among them: its length property, as a uint, and
 * its properties named by an index.
 */
class Generic {
  constructor(
    readonly rt: Runtime,
    readonly o: AsObject,
  ) {}

  get length(): number {
    return this.rt.toUint(this.rt.getProperty(this.o, this.rt.publicName("length")));
  }

  set length(n: number) {
    this.rt.setProperty(this.o, this.rt.publicName("length"), n);
  }

  get(i: number): Value {
    return this.rt.getProperty(this.o, this.rt.publicName(i));
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

/** As generic_splice: the deleted elements out, the rest moved, the inserted set, then the length. */
function genericSplice(rt: Runtime, g: Generic, args: Value[]): AsObject {
  const length = g.length;
  const at = clampIndex(toInteger(rt, args[0]), length);
  const wanted = args.length > 1 ? toInteger(rt, args[1]) : length - at;
  const deleted = Math.min(wanted < 0 ? 0 : Math.trunc(wanted), length - at);
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
    const a = elements(args);
    return sealed(rt, o, a.length) ? 0 : o.$a.unshift(...a);
  },
  // As generic_concat: what is not an Array is left out as the receiver,
  // and is one element as an argument.
  "Array.Array::_concat": (rt) => (o: Value, args: Value) => {
    const out = arrayElements(rt, o)?.slice() ?? [];
    for (const a of elements(args)) {
      const from = arrayElements(rt, a);
      if (from) {
        out.push(...from);
      } else {
        out.push(a);
      }
    }

    return rt.array(out);
  },
  "Array.Array::_slice": (rt) => (o: Value, start: Value, end: Value) => {
    const a = arrayElements(rt, o);
    if (a) {
      return rt.array(a.slice(rt.toNumber(start), rt.toNumber(end)));
    }

    if (!isObject(o)) {
      return null;
    }

    const g = new Generic(rt, o);
    const length = g.length;
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

    if (!arrayElements(rt, o)) {
      return isObject(o) ? genericSplice(rt, new Generic(rt, o), a) : null;
    }

    if (sealed(rt, o, a.length - 2)) {
      return rt.array([]);
    }

    const start = rt.toNumber(a[0]);
    const count = a.length > 1 ? rt.toNumber(a[1]) : o.$a.length;
    return rt.array(o.$a.splice(start, count, ...a.slice(2)));
  },
  "Array.Array::_indexOf": (rt) => (o: Value, v: Value, from: Value) => {
    const a = arrayElements(rt, o);
    if (a) {
      return a.indexOf(v, rt.toInt(from));
    }

    // As generic_indexOf: by strict equality, from the start clamped.
    if (!isObject(o)) {
      return -1;
    }

    const g = new Generic(rt, o);
    const length = g.length;
    for (let i = clampIndexInt(rt.toInt(from), length); i < length; i++) {
      if (rt.strictEquals(g.get(i), v)) {
        return i;
      }
    }

    return -1;
  },
  "Array.Array::_lastIndexOf": (rt) => (o: Value, v: Value, from: Value) => {
    const a = arrayElements(rt, o);
    if (a) {
      return a.lastIndexOf(v, rt.toInt(from));
    }

    if (!isObject(o)) {
      return -1;
    }

    const g = new Generic(rt, o);
    const length = g.length;
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
  "Array.Array::_sort": (rt) => (o: AsObject, args: Value) => sort(rt, o, elements(args)),
  "Array.Array::_sortOn": (rt) => (o: AsObject, names: Value, options: Value) =>
    sortOn(rt, o, names, options),
  "Array.Array::_every": (rt) => (o: AsObject, f: Value, receiver: Value) =>
    eachElement(rt, o, f, receiver, (result) => (result === true ? undefined : false)) ?? true,
  "Array.Array::_some": (rt) => (o: AsObject, f: Value, receiver: Value) =>
    eachElement(rt, o, f, receiver, (result) => (result === true ? true : undefined)) ?? false,
  "Array.Array::_forEach": (rt) => (o: AsObject, f: Value, receiver: Value) => {
    eachElement(rt, o, f, receiver, () => undefined);
  },
  "Array.Array::_filter": (rt) => (o: AsObject, f: Value, receiver: Value) => {
    const out: Value[] = [];
    eachElement(rt, o, f, receiver, (result, element) => {
      if (result === true) {
        out.push(element);
      }
    });
    return rt.array(out);
  },
  "Array.Array::_map": (rt) => (o: AsObject, f: Value, receiver: Value) => {
    const out: Value[] = [];
    eachElement(rt, o, f, receiver, (result) => {
      out.push(result);
    });
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
  },
};
