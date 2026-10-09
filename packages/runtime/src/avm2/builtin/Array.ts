// Array: its natives, held to its declaration (Array.decl.ts) by type,
// and its instances' element storage. The AS3 methods and the private
// static ones the prototype's functions call share each operation, which
// takes any receiver: an Array directly, anything else through its
// length and index properties, as avmplus' generic_ functions do.

import type { AsObject, Value } from "../descriptors.js";
import type { ClassHook } from "../hooks.js";
import { eachElement, elements, withStorage } from "../natives/define.js";
import { sort, sortOn } from "../natives/sort.js";
import { type Runtime, SEALED_ELEMENTS } from "../runtime.js";
import { ArrayDecl } from "./Array.decl.js";
import { bindNatives } from "./bind.js";

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

/** As the array's length set: nothing for a sealed subclass's instance. */
function setLength(rt: Runtime, o: AsObject, n: number): void {
  if (!sealed(rt, o, 0)) {
    o.$a.length = n;
  }
}

/**
 * Whether `o` is an Array itself, not a subclass's instance: only its
 * length is surely its elements', since a subclass may override the
 * accessor, which avmplus' AS3 reads as a property.
 */
function plainArray(rt: Runtime, o: Value): boolean {
  return isObject(o) && o.$traits === rt.builtinClass("Array").$it;
}

/** As _join: each element but undefined and null, added to a string as AS3's + adds, between separators. */
function join(rt: Runtime, o: Value, sep: Value): string {
  const s = sep === undefined ? "," : rt.toString(sep);
  const a = arrayElements(rt, o);
  const g = a ? null : new Generic(rt, o);
  const n = a && plainArray(rt, o) ? a.length : (g ?? new Generic(rt, o)).length;
  let out = "";
  for (let i = 0; i < n; i++) {
    const x = a ? a[i] : (g as Generic).get(i);
    if (x !== undefined && x !== null) {
      out = typeof x === "string" ? out + x : rt.add(out, x);
    }

    if (i + 1 < n) {
      out += s;
    }
  }

  return out;
}

function pop(rt: Runtime, o: Value): Value {
  if (!arrayElements(rt, o)) {
    return isObject(o) ? genericPop(new Generic(rt, o)) : undefined;
  }

  return sealed(rt, o, 0) ? undefined : o.$a.pop();
}

function shift(rt: Runtime, o: Value): Value {
  if (!arrayElements(rt, o)) {
    return isObject(o) ? genericShift(new Generic(rt, o)) : undefined;
  }

  return sealed(rt, o, 0) ? undefined : o.$a.shift();
}

function reverse(rt: Runtime, o: Value): Value {
  const a = arrayElements(rt, o);
  if (a) {
    a.reverse();
  } else if (isObject(o)) {
    genericReverse(new Generic(rt, o));
  }

  return o;
}

/**
 * As generic_concat: what is not an Array is left out as the receiver,
 * and is one element as an argument.
 */
function concat(rt: Runtime, o: Value, args: Value[]): AsObject {
  const out = arrayElements(rt, o)?.slice() ?? [];
  for (const a of args) {
    const from = arrayElements(rt, a);
    if (from) {
      out.push(...from);
    } else {
      out.push(a);
    }
  }

  return rt.array(out);
}

function slice(rt: Runtime, o: Value, start: number, end: number): AsObject | null {
  const a = arrayElements(rt, o);
  if (a) {
    return rt.array(a.slice(start, end));
  }

  if (!isObject(o)) {
    return null;
  }

  const g = new Generic(rt, o);
  const length = g.length;
  const from = clampIndex(start, length);
  const to = Math.max(from, clampIndex(end, length));
  const out: Value[] = [];
  for (let i = from; i < to; i++) {
    out.push(g.get(i));
  }

  return rt.array(out);
}

function splice(rt: Runtime, o: Value, args: Value[]): AsObject | null {
  if (args.length === 0) {
    return rt.array([]);
  }

  if (!arrayElements(rt, o)) {
    return isObject(o) ? genericSplice(rt, new Generic(rt, o), args) : null;
  }

  if (sealed(rt, o, args.length - 2)) {
    return rt.array([]);
  }

  const start = rt.toNumber(args[0]);
  const count = args.length > 1 ? rt.toNumber(args[1]) : o.$a.length;
  return rt.array(o.$a.splice(start, count, ...args.slice(2)));
}

/** As generic_indexOf: by strict equality, from the start clamped. */
function indexOf(rt: Runtime, o: Value, v: Value, from: number): number {
  const a = arrayElements(rt, o);
  if (a) {
    return a.indexOf(v, from);
  }

  if (!isObject(o)) {
    return -1;
  }

  const g = new Generic(rt, o);
  const length = g.length;
  for (let i = clampIndexInt(from, length); i < length; i++) {
    if (rt.strictEquals(g.get(i), v)) {
      return i;
    }
  }

  return -1;
}

function lastIndexOf(rt: Runtime, o: Value, v: Value, from: number): number {
  const a = arrayElements(rt, o);
  if (a) {
    return a.lastIndexOf(v, from);
  }

  if (!isObject(o)) {
    return -1;
  }

  const g = new Generic(rt, o);
  const length = g.length;
  let start = clampIndexInt(from, length);
  if (start === length) {
    start--;
  }

  for (let i = start | 0; i >= 0; i--) {
    if (rt.strictEquals(g.get(i), v)) {
      return i;
    }
  }

  return -1;
}

const every = (rt: Runtime, o: Value, f: Value, receiver: Value): boolean =>
  eachElement(rt, o, f, receiver, (result) => (result === true ? undefined : false)) ?? true;

const some = (rt: Runtime, o: Value, f: Value, receiver: Value): boolean =>
  eachElement(rt, o, f, receiver, (result) => (result === true ? true : undefined)) ?? false;

function forEach(rt: Runtime, o: Value, f: Value, receiver: Value): void {
  eachElement(rt, o, f, receiver, () => undefined);
}

function filter(rt: Runtime, o: Value, f: Value, receiver: Value): AsObject {
  const out: Value[] = [];
  eachElement(rt, o, f, receiver, (result, element) => {
    if (result === true) {
      out.push(element);
    }
  });
  return rt.array(out);
}

function map(rt: Runtime, o: Value, f: Value, receiver: Value): AsObject {
  const out: Value[] = [];
  eachElement(rt, o, f, receiver, (result) => {
    out.push(result);
  });
  return rt.array(out);
}

/** How Array differs from other classes (see hooks.ts). */
const arrayHook: ClassHook = {
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
};

export const ArrayBuiltin = bindNatives(
  ArrayDecl,
  (rt) => {
    // As `length = n` in AS3: a subclass's accessor, if it overrides it.
    const length = (o: AsObject, n: number) => {
      if (plainArray(rt, o)) {
        setLength(rt, o, n);
      } else {
        rt.setProperty(o, rt.publicName("length"), n);
      }
    };

    return class ArrayNatives {
      // One number is a length, which must be a uint; any other arguments are the elements.
      Array(this: AsObject, ...args: Value[]) {
        if (args.length === 1 && typeof args[0] === "number") {
          const n = rt.toUint(args[0]);
          if (n !== args[0]) {
            throw rt.error("RangeError", 1005, args[0]);
          }

          length(this, n);
          return;
        }

        length(this, args.length);
        if (!sealed(rt, this, args.length)) {
          for (let i = 0; i < args.length; i++) {
            this.$a[i] = args[i];
          }
        }
      }

      static "private::_join"(o: Value, sep: Value) {
        return join(rt, o, sep);
      }

      static "private::_pop"(o: Value) {
        return pop(rt, o);
      }

      static "private::_reverse"(o: Value) {
        return reverse(rt, o);
      }

      static "private::_concat"(o: Value, args: Value) {
        return concat(rt, o, elements(args));
      }

      static "private::_shift"(o: Value) {
        return shift(rt, o);
      }

      static "private::_slice"(o: Value, start: number, end: number) {
        return slice(rt, o, start, end);
      }

      static "private::_unshift"(o: AsObject, args: Value) {
        const a = elements(args);
        return sealed(rt, o, a.length) ? 0 : o.$a.unshift(...a);
      }

      static "private::_splice"(o: Value, args: Value) {
        return splice(rt, o, elements(args));
      }

      static "private::_sort"(o: Value, args: Value) {
        return sort(rt, o, elements(args));
      }

      static "private::_sortOn"(o: Value, names: Value, options: Value) {
        return sortOn(rt, o, names, options);
      }

      static "private::_indexOf"(o: Value, v: Value, from: number) {
        return indexOf(rt, o, v, from);
      }

      static "private::_lastIndexOf"(o: Value, v: Value, from: number) {
        return lastIndexOf(rt, o, v, from);
      }

      static "private::_every"(o: Value, f: Value, receiver: Value) {
        return every(rt, o, f, receiver);
      }

      static "private::_filter"(o: Value, f: Value, receiver: Value) {
        return filter(rt, o, f, receiver);
      }

      static "private::_forEach"(o: Value, f: Value, receiver: Value) {
        forEach(rt, o, f, receiver);
      }

      static "private::_map"(o: Value, f: Value, receiver: Value) {
        return map(rt, o, f, receiver);
      }

      static "private::_some"(o: Value, f: Value, receiver: Value) {
        return some(rt, o, f, receiver);
      }

      "AS3::insertAt"(this: AsObject, i: number, v: Value) {
        if (!sealed(rt, this, 1)) {
          this.$a.splice(i, 0, v);
        }
      }

      "AS3::removeAt"(this: AsObject, i: number) {
        return sealed(rt, this, 0) ? undefined : this.$a.splice(i, 1)[0];
      }

      get length(): number {
        return (this as AsObject).$a.length;
      }

      set length(n: number) {
        setLength(rt, this, n);
      }

      // A length that is not a uint is a RangeError (bugzilla 661330).
      "private::set_length"(this: AsObject, n: Value, _alt: number) {
        if (!rt.isInstanceOf(n, rt.builtinClass("uint").$it)) {
          throw rt.error("RangeError", 2108, n);
        }

        setLength(rt, this, n);
      }

      "AS3::join"(this: AsObject, sep: Value) {
        return join(rt, this, sep);
      }

      "AS3::pop"(this: AsObject) {
        return sealed(rt, this, 0) ? undefined : this.$a.pop();
      }

      "AS3::push"(this: AsObject, ...args: Value[]) {
        return sealed(rt, this, args.length) ? 0 : this.$a.push(...args);
      }

      "AS3::reverse"(this: AsObject) {
        return reverse(rt, this);
      }

      "AS3::concat"(this: AsObject, ...args: Value[]) {
        return concat(rt, this, args);
      }

      "AS3::shift"(this: AsObject) {
        return shift(rt, this);
      }

      "AS3::slice"(this: AsObject, start: Value, end: Value) {
        return slice(rt, this, rt.toNumber(start), rt.toNumber(end));
      }

      "AS3::unshift"(this: AsObject, ...args: Value[]) {
        return sealed(rt, this, args.length) ? 0 : this.$a.unshift(...args);
      }

      "AS3::splice"(this: AsObject, ...args: Value[]) {
        return args.length ? splice(rt, this, args) : undefined;
      }

      "AS3::sort"(this: AsObject, ...args: Value[]) {
        return sort(rt, this, args);
      }

      "AS3::sortOn"(this: AsObject, names: Value, options: Value) {
        return sortOn(rt, this, names, options);
      }

      "AS3::indexOf"(this: AsObject, v: Value, from: Value) {
        return indexOf(rt, this, v, rt.toInt(from));
      }

      "AS3::lastIndexOf"(this: AsObject, v: Value, from: Value) {
        return lastIndexOf(rt, this, v, rt.toInt(from));
      }

      "AS3::every"(this: AsObject, f: Value, receiver: Value) {
        return every(rt, this, f, receiver);
      }

      "AS3::filter"(this: AsObject, f: Value, receiver: Value) {
        return filter(rt, this, f, receiver);
      }

      "AS3::forEach"(this: AsObject, f: Value, receiver: Value) {
        forEach(rt, this, f, receiver);
      }

      "AS3::map"(this: AsObject, f: Value, receiver: Value) {
        return map(rt, this, f, receiver);
      }

      "AS3::some"(this: AsObject, f: Value, receiver: Value) {
        return some(rt, this, f, receiver);
      }
    };
  },
  arrayHook,
);
