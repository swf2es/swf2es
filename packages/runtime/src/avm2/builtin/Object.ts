// Object: its natives, held to Object.decl.ts, and what calling or
// constructing it does. Its static _init, which puts its functions on its
// prototype, and _dontEnumPrototype are still avmplus' AS3.

import type { AsObject, Value } from "../descriptors.js";
import type { ClassHook } from "../hooks.js";
import { formatClassName, Namespace, publicNs, qname } from "../names.js";
import { NOT_FOUND, type Runtime } from "../runtime.js";
import { bindNatives } from "./bind.js";
import { ObjectDecl } from "./Object.decl.js";

function hasOwn(rt: Runtime, o: Value, v: Value): boolean {
  const name = rt.toString(v);
  const traits = rt.traitsOf(o);
  if (traits.find(qname(publicNs, name)) !== 0) {
    return true;
  }

  // An index of a class with its own elements, a Vector's: in range or not, no RangeError.
  if (traits.hasIndex && /^(?:0|[1-9]\d*)$/.test(name) && Number(name) < 0xffffffff) {
    return traits.hasIndex(o, Number(name));
  }

  return rt.getOwn(o, name) !== NOT_FOUND;
}

function isEnumerable(rt: Runtime, o: Value, v: Value): boolean {
  const name = rt.toString(v);
  // E4X 13.2.5: a Namespace's prefix and uri are enumerable.
  if (o instanceof Namespace) {
    return name === "uri" || name === "prefix";
  }

  // A Vector's elements are not enumerable to it, in or out of range, as avmplus has it.
  if (o?.$traits?.refusesNames) {
    return false;
  }

  return rt.getOwn(o, name) !== NOT_FOUND && !o.$dontEnum?.has(name);
}

/** Whether `o` is on `v`'s prototype chain; a primitive's is its class's, as toPrototype gives it. */
function onChain(rt: Runtime, o: Value, v: Value): boolean {
  if (v === null || v === undefined) {
    return false;
  }

  for (let p = rt.protoOf(v); p; p = p.$p) {
    if (p === o) {
      return true;
    }
  }

  return false;
}

/** A class's name without its package, as its toString has it: a Vector's parameter keeps its own, "Vector.<pkg::T>". */
function shortName(qualified: string): string {
  const name = formatClassName(qualified);
  const i = name.indexOf("::");
  return i < 0 ? name : name.slice(i + 2);
}

export function qualifiedClassName(rt: Runtime, v: Value): string {
  switch (typeof v) {
    // As TypeDescriber::chooseTraits: an int is one that fits avmplus' 29-bit int atom.
    case "number":
      return (v | 0) === v && v >= -(1 << 28) && v < 1 << 28 ? "int" : "Number";
    case "string":
      return "String";
    case "boolean":
      return "Boolean";
    case "undefined":
      return "void";
    default:
      if (v === null) {
        return "null";
      }

      return formatClassName(v.$it ? v.$it.name : rt.traitsOf(v).name);
  }
}

/** Object(x) and new Object(x): x, or a new Object for null or undefined. */
const objectHook: ClassHook = {
  call: (rt, _cls, args) =>
    args[0] === null || args[0] === undefined ? rt.newObject([]) : args[0],
  construct: (rt, _cls, args) =>
    args[0] === null || args[0] === undefined ? rt.newObject([]) : args[0],
};

export const ObjectBuiltin = bindNatives(
  ObjectDecl,
  (rt) =>
    class ObjectNatives {
      Object() {}

      static "internal::init"() {}

      static "private::_hasOwnProperty"(o: Value, v: string | null) {
        return hasOwn(rt, o, v);
      }

      static "private::_propertyIsEnumerable"(o: Value, v: string | null) {
        return isEnumerable(rt, o, v);
      }

      static "staticprotected::_setPropertyIsEnumerable"(
        o: Value,
        v: string | null,
        enumerable: boolean,
      ) {
        if (typeof o !== "object" || o === null) {
          return;
        }

        const name = rt.toString(v);
        if (enumerable) {
          o.$dontEnum?.delete(name);
        } else {
          o.$dontEnum ??= new Set();
          o.$dontEnum.add(name);
        }
      }

      static "private::_isPrototypeOf"(o: Value, v: Value) {
        return onChain(rt, o, v);
      }

      static "private::_toString"(o: Value) {
        if (o !== null && typeof o === "object" && o.$it) {
          return `[class ${shortName(o.$it.name)}]`;
        }

        // As FunctionObject::implToString: its method's id.
        if (o !== null && typeof o === "object" && o.$f) {
          return `[object Function-${o.$id}]`;
        }

        return `[object ${shortName(rt.traitsOf(o).name)}]`;
      }

      "AS3::isPrototypeOf"(this: AsObject, v: Value) {
        return onChain(rt, this, v);
      }

      "AS3::hasOwnProperty"(this: AsObject, v: Value) {
        return hasOwn(rt, this, v);
      }

      "AS3::propertyIsEnumerable"(this: AsObject, v: Value) {
        return isEnumerable(rt, this, v);
      }
    },
  objectHook,
);
