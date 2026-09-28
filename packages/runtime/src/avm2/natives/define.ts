// What the natives share: how a native is made, and helpers several
// families of builtins use.
import type { AsObject, ClassHook, Method, Runtime, Traits, Value } from "../runtime.js";

/** Natives by the names the compiler gives them, each made for a runtime. */
export type Natives = Record<string, (rt: Runtime) => Method>;

export const AS3 = "http://adobe.com/AS3/2006/builtin";

/** `f` as a native, whatever the runtime. */
export const plain =
  (f: Method) =>
  (_rt: Runtime): Method =>
    f;

/** The elements of an Array value, for natives that take one. */
export function elements(v: Value): Value[] {
  return v?.$a ?? [];
}

/**
 * As ArrayClass's every, filter, forEach, map and some: `f` called with
 * each element, its index and the array, up to the length at the start;
 * `each` sees each result and the element, and a value it returns ends the
 * walk with that value. A method closure takes no other receiver.
 */
export function eachElement(
  rt: Runtime,
  o: AsObject,
  f: Value,
  receiver: Value,
  each: (result: Value, element: Value) => Value,
): Value {
  if (f === null || f === undefined) {
    return undefined;
  }

  if (f.$closure && receiver !== null && receiver !== undefined) {
    throw rt.error("TypeError", 1510);
  }

  // Each element as a get of its index: a hole finds the prototype's.
  const length: number = o.$a.length;
  for (let i = 0; i < length; i++) {
    const element = rt.getProperty(o, rt.publicName(i));
    const done = each(rt.callValue(f, receiver, [element, i, o], null), element);
    if (done !== undefined) {
      return done;
    }
  }

  return undefined;
}

/** A conversion of the builtin primitive classes, called or constructed. */
export const conversion = (convert: (rt: Runtime, args: Value[]) => Value): ClassHook => ({
  call: (rt, _cls, args) => convert(rt, args),
  construct: (rt, _cls, args) => convert(rt, args),
});

/** Array storage for an instance of Array or a Vector, and its subclasses'. */
export const withStorage = (traits: Traits): AsObject => {
  const o = Object.create(traits.proto);
  o.$a = [];
  o.$fixed = false;
  return o;
};
