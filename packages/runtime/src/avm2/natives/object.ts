// Object, Class, Function, Namespace and QName: their natives, and what
// calling or constructing Object, Namespace, QName or Function does.

import type { AsObject, Value } from "../descriptors.js";
import type { ClassHook } from "../hooks.js";
import { formatClassName, Namespace, prefixOf, publicNs, qname } from "../names.js";
import { NOT_FOUND, type Runtime } from "../runtime.js";
import { AS3, elements, type Natives, plain } from "./define.js";
import { constructNamespace, newNamespace } from "./xml/xml.js";

export const objectNatives: Natives = {
  // Object
  "Object.Object::_hasOwnProperty": (rt) => (o: Value, v: Value) => {
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
  },
  "Object.Object::_propertyIsEnumerable": (rt) => (o: Value, v: Value) => {
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
  },
  "Object.Object::_setPropertyIsEnumerable": (rt) => (o: Value, v: Value, enumerable: boolean) => {
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
  },
  // A primitive's prototype chain is its class's, as toPrototype gives it.
  "Object.Object::_isPrototypeOf": (rt) => (o: Value, v: Value) => {
    if (v === null || v === undefined) {
      return false;
    }

    for (let p = rt.protoOf(v); p; p = p.$p) {
      if (p === o) {
        return true;
      }
    }

    return false;
  },
  "Object.Object::_toString": (rt) => (o: Value) => {
    if (o !== null && typeof o === "object" && o.$it) {
      return `[class ${shortName(o.$it.name)}]`;
    }

    // As FunctionObject::implToString: its method's id.
    if (o !== null && typeof o === "object" && o.$f) {
      return `[object Function-${o.$id}]`;
    }

    return `[object ${shortName(rt.traitsOf(o).name)}]`;
  },

  // Class and Function
  "Class#get:prototype": plain(function (this: AsObject) {
    return this.$prototype;
  }),
  "Function#get:prototype": (rt) =>
    function (this: AsObject) {
      return rt.functionPrototype(this);
    },
  // As FunctionObject's setter: null and undefined clear it, a primitive is refused.
  "Function#set:prototype": (rt) =>
    function (this: AsObject, p: Value) {
      if (p === null || p === undefined) {
        this.$prototype = undefined;
        this.$noPrototype = true;
        return;
      }

      if (typeof p !== "object" && typeof p !== "function") {
        throw rt.error("TypeError", 1049);
      }

      this.$prototype = p;
      this.$noPrototype = false;
    },
  "Function#get:length": plain(function (this: AsObject) {
    return this.$length ?? this.$f.length;
  }),
  [`Function#${AS3}::call`]: (rt) =>
    function (this: AsObject, receiver: Value, ...args: Value[]) {
      // Not a tail call, as the runtime's calls are not (see Runtime.getProperty).
      // biome-ignore lint/style/useConst: a const is folded into a tail call (see Runtime.getProperty)
      let r: Value;
      r = rt.callValue(this, receiver, args, null);
      return r;
    },
  [`Function#${AS3}::apply`]: (rt) =>
    function (this: AsObject, receiver: Value, args: Value) {
      // Its arguments an Array, or none, as FunctionObject::AS3_apply has them.
      if (args !== null && args !== undefined && args.$a === undefined) {
        throw rt.error("TypeError", 1116);
      }

      // biome-ignore lint/style/useConst: a const is folded into a tail call (see Runtime.getProperty)
      let r: Value;
      r = rt.callValue(this, receiver, elements(args).slice(), null);
      return r;
    },

  // Namespace and QName: a QName holds its namespace, null for any, and its
  // local name, null for any.
  "Namespace#get:uri": plain(function (this: Value) {
    return this.uri ?? "";
  }),
  "QName#get:localName": plain(function (this: AsObject) {
    return this.$local ?? "*";
  }),
  "QName#get:uri": plain(function (this: AsObject) {
    return this.$ns ? this.$ns.uri : null;
  }),
  "Namespace#get:prefix": plain(function (this: Namespace) {
    return prefixOf(this);
  }),
};

/** As QNameClass::construct: QName(name) or QName(namespace, name). */
function newQName(rt: Runtime, cls: AsObject, args: Value[]): AsObject {
  if (args.length === 1 && args[0]?.$local !== undefined) {
    return args[0];
  }

  const name = args.length >= 2 ? args[1] : args[0];
  const o = cls.$it.instance();
  // With no namespace, a name is in the default XML namespace.
  let ns: Namespace | null = rt.defaultXmlNamespace.interned;
  if (args.length >= 2 && args[0] !== undefined) {
    ns =
      args[0] === null
        ? null
        : args[0] instanceof Namespace
          ? args[0].interned
          : newNamespace(rt, args[0]);
  } else if (name?.$local !== undefined) {
    ns = name.$ns;
  }

  const local =
    name === undefined ? "" : name?.$local !== undefined ? name.$local : rt.toString(name);
  // With no namespace given, the any name is in any namespace too.
  if (local === "*" && (args.length < 2 || args[0] === undefined)) {
    ns = null;
  }

  o.$ns = ns;
  o.$local = local === "*" ? null : local;
  o.$attr = false;
  return o;
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

function emptyFunction(rt: Runtime, args: Value[]): AsObject {
  if (args.length) {
    throw rt.error("EvalError", 1066);
  }

  return rt.newFunctionObject(() => undefined, null);
}

/** A class of static natives only, which cannot be instantiated: construct="none" in its declaration. */
const notInstantiated = (name: string): ClassHook => ({
  construct: (rt) => {
    throw rt.error("ArgumentError", 2012, name);
  },
});

export const objectHooks: Record<string, ClassHook> = {
  JSON: notInstantiated("JSON"),
  "flash.net::ObjectEncoding": notInstantiated("ObjectEncoding"),
  "avmplus::System": notInstantiated("System"),
  "avmplus::File": notInstantiated("File"),
  // Math is neither a function nor a constructor.
  Math: {
    call: (rt) => {
      throw rt.error("TypeError", 1075);
    },
    construct: (rt) => {
      throw rt.error("TypeError", 1076);
    },
  },
  Object: {
    call: (rt, _cls, args) =>
      args[0] === null || args[0] === undefined ? rt.newObject([]) : args[0],
    construct: (rt, _cls, args) =>
      args[0] === null || args[0] === undefined ? rt.newObject([]) : args[0],
  },
  // As NamespaceClass: Namespace(), Namespace(uri) or Namespace(prefix, uri).
  Namespace: {
    construct: (rt, _cls, args) => constructNamespace(rt, args),
    call: (rt, _cls, args) =>
      args.length === 1 && args[0] instanceof Namespace ? args[0] : constructNamespace(rt, args),
  },
  // As QNameClass::construct.
  QName: {
    construct: newQName,
    call: newQName,
  },
  // Function() and new Function(): an empty function; with a body, which
  // would be compiled at run time, EvalError 1066, as FunctionClass has it.
  Function: {
    construct: (rt, _cls, args) => emptyFunction(rt, args),
    call: (rt, _cls, args) => emptyFunction(rt, args),
    // Function.prototype is a function, that does nothing.
    prototype: (rt) => rt.newFunctionObject(() => undefined, null),
  },
};
