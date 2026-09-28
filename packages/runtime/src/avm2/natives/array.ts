// Array: its natives, and its instances' element storage.
import type { AsObject, ClassHook, Value } from "../runtime.js";
import { AS3, eachElement, elements, type Natives, plain, withStorage } from "./define.js";
import { sort, sortOn } from "./sort.js";

export const arrayNatives: Natives = {
  // Array
  "Array#get:length": plain(function (this: AsObject) {
    return this.$a.length;
  }),
  "Array#set:length": (rt) =>
    function (this: AsObject, n: Value) {
      this.$a.length = rt.toUint(n);
    },
  [`Array#${AS3}::push`]: plain(function (this: AsObject, ...args: Value[]) {
    return this.$a.push(...args);
  }),
  [`Array#${AS3}::pop`]: plain(function (this: AsObject) {
    return this.$a.pop();
  }),
  [`Array#${AS3}::unshift`]: plain(function (this: AsObject, ...args: Value[]) {
    return this.$a.unshift(...args);
  }),
  [`Array#${AS3}::insertAt`]: (rt) =>
    function (this: AsObject, i: Value, v: Value) {
      this.$a.splice(rt.toInt(i), 0, v);
    },
  [`Array#${AS3}::removeAt`]: (rt) =>
    function (this: AsObject, i: Value) {
      return this.$a.splice(rt.toInt(i), 1)[0];
    },
  "Array.Array::_pop": plain((o: AsObject) => o.$a.pop()),
  "Array.Array::_shift": plain((o: AsObject) => o.$a.shift()),
  "Array.Array::_reverse": plain((o: AsObject) => {
    o.$a.reverse();
    return o;
  }),
  "Array.Array::_unshift": plain((o: AsObject, args: Value) => o.$a.unshift(...elements(args))),
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
    create: withStorage,
    call: (rt, cls, args) => rt.constructClass(cls, args),
  },
};
