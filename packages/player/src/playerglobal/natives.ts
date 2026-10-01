// Natives written as a class: its getters, setters and methods become the
// natives of the AS3 class named, by the names the compiler binds them
// with ("Class#get:x", "Class#set:x", "Class#method", and "Class.method"
// for a static). The class is only how they are written: nothing makes an
// instance of it, and the AS3 objects' prototypes are not touched. Each
// function is registered as plain() registers one, so it runs with the
// AS3 object as `this`, as the natives written by name do. A name the
// convention cannot write, such as a private native's, is registered by
// name beside the class.
import { avm2 } from "@swf2es/runtime";

const { plain } = avm2;

// What every prototype, and every function, has of its own: not natives.
// A prototype's `name` is a getter a class may well define, as DisplayObject's.
const PROTOTYPE_OWN = new Set(["constructor"]);
const FUNCTION_OWN = new Set(["length", "name", "prototype"]);

type Members = Record<string | symbol, unknown>;

/**
 * Register the members of `Class` as the natives of the AS3 class
 * `qualified`: its prototype's own getters, setters and methods as the
 * instance natives, its own static ones as the class's.
 */
export function registerNativeClass(
  natives: avm2.Natives,
  qualified: string,
  Class: { prototype: object },
): void {
  register(natives, `${qualified}#`, Class.prototype as Members, PROTOTYPE_OWN);
  register(natives, `${qualified}.`, Class as Members, FUNCTION_OWN);
}

function register(
  natives: avm2.Natives,
  prefix: string,
  members: Members,
  skip: Set<string>,
): void {
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
      add(natives, `${prefix}get:${name}`, d.get as avm2.Method);
    }

    if (d.set) {
      add(natives, `${prefix}set:${name}`, d.set as avm2.Method);
    }

    if (typeof d.value === "function") {
      add(natives, `${prefix}${name}`, d.value as avm2.Method);
    }
  }
}

/** A native under `key`; a second one for the same key is a mistake, not a replacement. */
function add(natives: avm2.Natives, key: string, fn: avm2.Method): void {
  if (key in natives) {
    throw new Error(`native ${key} is registered twice`);
  }

  natives[key] = plain(fn);
}
