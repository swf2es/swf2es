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
  registerMembers(natives, qualified, Class, () => Class);
}

/**
 * As registerNativeClass, for natives that need their runtime: `make`
 * returns the class for a runtime, and is called once for each, when the
 * first of its natives is bound; `rt` is read inside the members. Its
 * names are read from the class made with no runtime, so `make` must only
 * return the class.
 */
export function registerNativeClassWith(
  natives: Natives,
  qualified: string,
  make: (rt: Runtime) => NativeClass,
): void {
  const made = new WeakMap<Runtime, NativeClass>();
  const of = (rt: Runtime): NativeClass => {
    let Class = made.get(rt);
    if (!Class) {
      Class = make(rt);
      made.set(rt, Class);
    }

    return Class;
  };
  registerMembers(natives, qualified, make(undefined as unknown as Runtime), of);
}

type Members = Record<string, unknown>;

function registerMembers(
  natives: Natives,
  qualified: string,
  probe: NativeClass,
  of: (rt: Runtime) => NativeClass,
): void {
  const sides: [string, (c: NativeClass) => Members, Set<string>][] = [
    [`${qualified}#`, (c) => c.prototype as Members, PROTOTYPE_OWN],
    [`${qualified}.`, (c) => c as unknown as Members, FUNCTION_OWN],
  ];
  for (const [prefix, side, skip] of sides) {
    for (const name of Object.getOwnPropertyNames(side(probe))) {
      if (skip.has(name)) {
        continue;
      }

      const d = Object.getOwnPropertyDescriptor(side(probe), name);
      if (!d) {
        continue;
      }

      // Per runtime, the same member of the class made for it.
      const member = (kind: "get" | "set" | "value") => (rt: Runtime) =>
        Object.getOwnPropertyDescriptor(side(of(rt)), name)?.[kind] as Method;
      if (d.get) {
        add(natives, `${prefix}get:${name}`, member("get"));
      }

      if (d.set) {
        add(natives, `${prefix}set:${name}`, member("set"));
      }

      if (typeof d.value === "function") {
        add(natives, `${prefix}${name}`, member("value"));
      }
    }
  }
}

/** A native under `key`; a second one for the same key is a mistake, not a replacement. */
function add(natives: Natives, key: string, native: (rt: Runtime) => Method): void {
  if (key in natives) {
    throw new Error(`native ${key} is registered twice`);
  }

  natives[key] = native;
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
