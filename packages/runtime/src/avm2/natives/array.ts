// Array: its natives, and its instances' element storage.
import {
  type AsObject,
  type ClassHook,
  type Runtime,
  SEALED_ELEMENTS,
  type Value,
} from "../runtime.js";
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
  "Array.Array::_pop": (rt) => (o: AsObject) => (sealed(rt, o, 0) ? undefined : o.$a.pop()),
  "Array.Array::_shift": (rt) => (o: AsObject) => (sealed(rt, o, 0) ? undefined : o.$a.shift()),
  "Array.Array::_reverse": plain((o: AsObject) => {
    o.$a.reverse();
    return o;
  }),
  "Array.Array::_unshift": (rt) => (o: AsObject, args: Value) => {
    const a = elements(args);
    return sealed(rt, o, a.length) ? 0 : o.$a.unshift(...a);
  },
  "Array.Array::_concat": (rt) => (o: AsObject, args: Value) => {
    const out = o.$a.slice();
    for (const a of elements(args)) {
      if (a?.$a && a.$traits.name === "Array") {
        out.push(...a.$a);
      } else {
        out.push(a);
      }
    }

    return rt.array(out);
  },
  "Array.Array::_slice": (rt) => (o: AsObject, start: Value, end: Value) =>
    rt.array(o.$a.slice(rt.toNumber(start), rt.toNumber(end))),
  "Array.Array::_splice": (rt) => (o: AsObject, args: Value) => {
    const a = elements(args);
    if (a.length === 0) {
      return rt.array([]);
    }

    if (sealed(rt, o, a.length - 2)) {
      return rt.array([]);
    }

    const start = rt.toNumber(a[0]);
    const count = a.length > 1 ? rt.toNumber(a[1]) : o.$a.length;
    return rt.array(o.$a.splice(start, count, ...a.slice(2)));
  },
  "Array.Array::_indexOf": (rt) => (o: AsObject, v: Value, from: Value) =>
    o.$a.indexOf(v, rt.toInt(from)),
  "Array.Array::_lastIndexOf": (rt) => (o: AsObject, v: Value, from: Value) =>
    o.$a.lastIndexOf(v, rt.toInt(from)),
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
