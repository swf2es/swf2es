// What the natives share: how a native is made, and helpers several
// families of builtins use.

import type { AsObject, Method, Value } from "../descriptors.js";
import type { ClassHook } from "../hooks.js";
import type { Runtime, Traits } from "../runtime.js";

/** Natives by the names the compiler gives them, each made for a runtime. */
export type Natives = Record<string, (rt: Runtime) => Method>;

export const AS3 = "http://adobe.com/AS3/2006/builtin";

/** `f` as a native, whatever the runtime. */
export const plain =
  (f: Method) =>
  (_rt: Runtime): Method =>
    f;

/** A class written to hold natives: its members are them (see registerNativeClass). */
export type NativeClass = { prototype: object };

// What every prototype, and every function, has of its own: not natives.
// A prototype's `name` is a getter a class may well define, as DisplayObject's.
const PROTOTYPE_OWN = new Set(["constructor"]);
const FUNCTION_OWN = new Set(["length", "name", "prototype"]);

/**
 * Register the members of `Class` as the natives of the AS3 class
 * `qualified`, by the names the compiler binds them with: its prototype's
 * own getters, setters and methods as "Class#get:x", "Class#set:x" and
 * "Class#method", its own static ones as "Class.get:x" and "Class.method".
 * A computed member name carries a name the convention cannot spell, such
 * as `[\`${AS3}::push\`]`. The class is only how the natives are written:
 * nothing makes an instance of it, the AS3 objects' prototypes are not
 * touched, and each function is registered as plain() registers one, so it
 * runs with the AS3 object as `this`. Its descriptors are read, never a
 * getter run. A name registered twice is an error, not a replacement.
 */
export function registerNativeClass(natives: Natives, qualified: string, Class: NativeClass): void {
  const sides: [string, Members, Set<string>][] = [
    [`${qualified}#`, Class.prototype as Members, PROTOTYPE_OWN],
    [`${qualified}.`, Class as unknown as Members, FUNCTION_OWN],
  ];
  for (const [prefix, members, skip] of sides) {
    // Descriptors, not values: a getter must not run here.
    for (const name of Object.getOwnPropertyNames(members)) {
      if (skip.has(name)) {
        continue;
      }

      const d = Object.getOwnPropertyDescriptor(members, name);
      if (!d) {
        continue;
      }

      if (d.get) {
        add(natives, `${prefix}get:${name}`, d.get as Method);
      }

      if (d.set) {
        add(natives, `${prefix}set:${name}`, d.set as Method);
      }

      if (typeof d.value === "function") {
        add(natives, `${prefix}${name}`, d.value as Method);
      }
    }
  }
}

type Members = Record<string, unknown>;

/** A native under `key`; a second one for the same key is a mistake, not a replacement. */
function add(natives: Natives, key: string, fn: Method): void {
  if (key in natives) {
    throw new Error(`native ${key} is registered twice`);
  }

  natives[key] = plain(fn);
}

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
