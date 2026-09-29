// The Vectors: one implementation, over their element conversions.
import { type AsObject, arrayIndex, type ClassHook, type Runtime, type Value } from "../runtime.js";
import { AS3, eachElement, elements, type Natives, plain, withStorage } from "./define.js";
import { sort } from "./sort.js";

const VEC = "__AS3__.vec";

export const vectorNatives: Natives = {};
export const vectorHooks: Record<string, ClassHook> = {
  [`${VEC}::Vector`]: {
    apply: (rt, _factory, params) => vectorOf(rt, params[0] ?? null),
  },
};

// The Vectors: one implementation, over their element conversions.
const VECTORS: [string, (rt: Runtime, cls: AsObject, v: Value) => Value, Value][] = [
  ["Vector$int", (rt, _cls, v) => rt.toInt(v), 0],
  ["Vector$uint", (rt, _cls, v) => rt.toUint(v), 0],
  ["Vector$double", (rt, _cls, v) => rt.toNumber(v), 0],
  ["Vector$object", (rt, cls, v) => rt.coerce(v, cls.$param ?? null), null],
];

for (const [kind] of VECTORS) {
  const c = `${VEC}::${kind}`;
  const own = `${VEC}:${kind}`;
  vectorNatives[`${c}#get:length`] = plain(function (this: AsObject) {
    return this.$a.length;
  });
  vectorNatives[`${c}#set:length`] = (rt) =>
    function (this: AsObject, n: Value) {
      if (this.$fixed) {
        throw rt.error("RangeError", 1126);
      }

      const length = rt.toUint(n);
      const a: Value[] = this.$a;
      if (length === 0) {
        // A new array: V8 empties one by a call into its runtime.
        this.$a = [];
      } else if (length < a.length) {
        a.length = length;
      } else if (length > a.length) {
        // Pushed, not a length set then filled, so that V8 keeps it packed.
        const fill = this.$traits.cls.$fill;
        while (a.length < length) {
          a.push(fill);
        }
      }
    };
  vectorNatives[`${c}#get:fixed`] = plain(function (this: AsObject) {
    return this.$fixed;
  });
  vectorNatives[`${c}#set:fixed`] = plain(function (this: AsObject, fixed: Value) {
    this.$fixed = !!fixed;
  });
  vectorNatives[`${c}#${AS3}::push`] = (rt) =>
    function (this: AsObject, ...args: Value[]) {
      if (this.$fixed) {
        throw rt.error("RangeError", 1126);
      }

      // Each at the length there is before it, set as an element: after
      // its conversion, which can run AS3 that changes the Vector.
      const cls = this.$traits.cls;
      const convert = cls.$convert;
      for (let k = 0; k < args.length; k++) {
        const i: number = this.$a.length;
        const x = convert(rt, cls, args[k]);
        const a: Value[] = this.$a;
        if (i > a.length || (i === a.length && this.$fixed)) {
          throw rt.error("RangeError", 1125, i, a.length);
        }

        a[i] = x;
      }

      return this.$a.length;
    };
  vectorNatives[`${c}#${AS3}::pop`] = (rt) =>
    function (this: AsObject) {
      if (this.$fixed) {
        throw rt.error("RangeError", 1126);
      }

      return this.$a.length ? this.$a.pop() : empty(this);
    };
  vectorNatives[`${c}#${AS3}::shift`] = (rt) =>
    function (this: AsObject) {
      if (this.$fixed) {
        throw rt.error("RangeError", 1126);
      }

      return this.$a.length ? this.$a.shift() : empty(this);
    };
  vectorNatives[`${c}#${AS3}::unshift`] = (rt) =>
    function (this: AsObject, ...args: Value[]) {
      if (this.$fixed) {
        throw rt.error("RangeError", 1126);
      }

      // Room made first, then each converted and written in its place.
      const cls = this.$traits.cls;
      this.$a.unshift(...args.map(() => cls.$fill));
      args.forEach((v, k) => {
        writeElement(this, k, cls.$convert(rt, cls, v));
      });
      return this.$a.length;
    };
  vectorNatives[`${c}#${own}::newThisType`] = (rt) =>
    function (this: AsObject) {
      return rt.constructClass(this.$traits.cls, []);
    };
  vectorNatives[`${c}#${own}::_reverse`] = plain(function (this: AsObject) {
    this.$a.reverse();
    return this;
  });
  vectorNatives[`${c}#${own}::_spliceHelper`] = (rt) =>
    function (
      this: AsObject,
      insert: Value,
      insertCount: Value,
      deleteCount: Value,
      args: Value,
      offset: Value,
    ) {
      // As unshift: room made, then each item converted, as the Vector's
      // type does, and written in its place.
      const cls = this.$traits.cls;
      const at = rt.toUint(insert);
      const count = rt.toUint(insertCount);
      const from = rt.toUint(offset);
      const items: Value[] = args?.$a ?? [];
      this.$a.splice(at, rt.toUint(deleteCount), ...new Array(count).fill(cls.$fill));
      for (let k = 0; k < count; k++) {
        writeElement(this, at + k, cls.$convert(rt, cls, items[from + k]));
      }
    };
  vectorNatives[`${c}.${own}::_sort`] = (rt) => (o: AsObject, args: Value) =>
    sort(rt, o, elements(args));
  vectorNatives[`${c}.${own}::_every`] = (rt) => (o: AsObject, f: Value, receiver: Value) =>
    eachElement(rt, o, f, receiver, (result) => (result === true ? undefined : false)) ?? true;
  vectorNatives[`${c}.${own}::_some`] = (rt) => (o: AsObject, f: Value, receiver: Value) =>
    eachElement(rt, o, f, receiver, (result) => (result === true ? true : undefined)) ?? false;
  vectorNatives[`${c}.${own}::_forEach`] = (rt) => (o: AsObject, f: Value, receiver: Value) => {
    eachElement(rt, o, f, receiver, () => undefined);
  };
  // As TypedVectorObject's _map and _filter: a new Vector of the same type.
  vectorNatives[`${c}#${own}::_map`] = (rt) =>
    function (this: AsObject, f: Value, receiver: Value) {
      const cls = this.$traits.cls;
      const r = rt.constructClass(cls, [this.$a.length]);
      let i = 0;
      eachElement(rt, this, f, receiver, (result) => {
        r.$a[i++] = cls.$convert(rt, cls, result);
      });
      return r;
    };
  vectorNatives[`${c}#${own}::_filter`] = (rt) =>
    function (this: AsObject, f: Value, receiver: Value) {
      const r = rt.constructClass(this.$traits.cls, []);
      eachElement(rt, this, f, receiver, (result, element) => {
        if (result === true) {
          r.$a.push(element);
        }
      });
      return r;
    };
}

for (const [kind, convert, fill] of VECTORS) {
  vectorHooks[`${VEC}::${kind}`] = {
    create: withStorage,
    // As VectorBaseObject: any name but an index is refused, 1069 or 1056.
    refusesNames: true,
    getIndex: (o, i, rt) => {
      if (i >= o.$a.length) {
        throw rt.error("RangeError", 1125, i, o.$a.length);
      }

      return o.$a[i];
    },
    hasIndex: (o, i) => i < o.$a.length,
    // As VectorBaseObject::getVectorIndex: a name starting with a digit or
    // "-" that is a number is an index, and must be a whole one from 0 up.
    index: (o, name, rt) => {
      const i = arrayIndex(name);
      if (i >= 0) {
        return i;
      }

      const c = name.charCodeAt(0);
      if (name.length === 0 || !((c >= 0x30 && c <= 0x39) || c === 0x2d)) {
        return -1;
      }

      const d = rt.toNumber(name);
      if (Number.isNaN(d)) {
        return -1;
      }

      if ((d | 0) === d && d >= 0) {
        return d;
      }

      throw rt.error("RangeError", 1125, rt.toString(d), o.$a.length);
    },
    setIndex: (o, i, v, rt) => rt.setElement(o, i, convert(rt, o.$traits.cls, v)),
    construct: (rt, cls, args) => {
      prepareVector(rt, cls, convert, fill);
      const o = cls.$it.instance();
      const length = args.length ? rt.toUint(args[0]) : 0;
      o.$a = new Array(length).fill(fill);
      o.$fixed = !!args[1];
      return o;
    },
    call: (rt, cls, args) => {
      prepareVector(rt, cls, convert, fill);
      const source = args[0];
      if (source?.$a === undefined) {
        throw rt.error("TypeError", 1034, rt.describe(source), cls.$it.name);
      }

      // Each element as a get of the source's, as its conversion may change
      // the source: past a Vector's end, a RangeError.
      const o = cls.$it.instance();
      const length: number = source.$a.length;
      const a: Value[] = [];
      for (let i = 0; i < length; i++) {
        a.push(convert(rt, cls, rt.getProperty(source, rt.publicName(i))));
      }

      o.$a = a;
      return o;
    },
  };
}

/**
 * Element i of Vector o written as unshift and splice write what they
 * insert, into the elements it has after the conversion, grown to it with
 * the fill value if the conversion shrank them.
 */
function writeElement(o: AsObject, i: number, x: Value): void {
  const a: Value[] = o.$a;
  while (a.length <= i) {
    a.push(o.$traits.cls.$fill);
  }

  a[i] = x;
}

/**
 * What pop and shift give of an empty Vector, as TypedVectorConstants'
 * undefinedValue: undefined for objects, else the fill value, 0.
 */
const empty = (v: AsObject): Value =>
  v.$traits.cls.$fill === null ? undefined : v.$traits.cls.$fill;

/** A Vector class's element conversion and fill value, kept on the class for its natives. */
function prepareVector(
  rt: Runtime,
  cls: AsObject,
  convert: (rt: Runtime, cls: AsObject, v: Value) => Value,
  fill: Value,
): void {
  if (!cls.$convert) {
    cls.$convert = convert;
    cls.$fill = fill;
    cls.$rt = rt;
  }
}

/** Vector.<T>: the specialized classes for int, uint and Number, else Vector$object's for T; made once each. */
function vectorOf(rt: Runtime, param: AsObject | null): AsObject {
  const made = rt.vectorClasses.get(param);
  if (made) {
    return made;
  }

  const cls = makeVector(rt, param);
  rt.vectorClasses.set(param, cls);
  return cls;
}

function makeVector(rt: Runtime, param: AsObject | null): AsObject {
  const kind =
    param === null
      ? "Vector$object"
      : param.$it.name === "int"
        ? "Vector$int"
        : param.$it.name === "uint"
          ? "Vector$uint"
          : param.$it.name === "Number"
            ? "Vector$double"
            : "Vector$object";
  // The specialized classes are internal to their package.
  const base = rt.resolve(rt.cls(rt.ns(1, VEC), kind));
  const [, convert, fill] = VECTORS.find(([k]) => k === kind) ?? VECTORS[3];
  prepareVector(rt, base, convert, fill);
  if (kind !== "Vector$object" || param === null) {
    return base;
  }

  let cls = rt.specialized.get(param);
  if (!cls) {
    cls = rt.specializeVector(base, param);
    prepareVector(rt, cls, convert, fill);
    rt.specialized.set(param, cls);
  }

  return cls;
}
