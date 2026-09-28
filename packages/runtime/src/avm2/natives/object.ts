// Object, Class, Function, Namespace and QName: their natives, and what
// calling or constructing Object, Namespace, QName or Function does.
import { Namespace, prefixOf, publicNs, qname } from "../names.js";
import { type AsObject, type ClassHook, NOT_FOUND, type Runtime, type Value } from "../runtime.js";
import { AS3, elements, type Natives, plain } from "./define.js";
import { constructNamespace, newNamespace } from "./xml/xml.js";

export const objectNatives: Natives = {
  // Object
  "Object.Object::_hasOwnProperty": (rt) => (o: Value, v: Value) => {
    const name = rt.toString(v);
    if (rt.traitsOf(o).find(qname(publicNs, name)) !== 0) {
      return true;
    }

    return rt.getOwn(o, name) !== NOT_FOUND;
  },
  "Object.Object::_propertyIsEnumerable": (rt) => (o: Value, v: Value) => {
    const name = rt.toString(v);
    // E4X 13.2.5: a Namespace's prefix and uri are enumerable.
    if (o instanceof Namespace) {
      return name === "uri" || name === "prefix";
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
  "Object.Object::_isPrototypeOf": (rt) => (o: Value, v: Value) => {
    if (v === null || v === undefined || typeof v !== "object") {
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
  "Function#set:prototype": plain(function (this: AsObject, p: Value) {
    this.$prototype = p;
  }),
  "Function#get:length": plain(function (this: AsObject) {
    return this.$length ?? this.$f.length;
  }),
  [`Function#${AS3}::call`]: (rt) =>
    function (this: AsObject, receiver: Value, ...args: Value[]) {
      return rt.callValue(this, receiver, args, null);
    },
  [`Function#${AS3}::apply`]: (rt) =>
    function (this: AsObject, receiver: Value, args: Value) {
      return rt.callValue(this, receiver, elements(args).slice(), null);
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

function shortName(qualified: string): string {
  const i = qualified.lastIndexOf("::");
  return i < 0 ? qualified : qualified.slice(i + 2);
}

export function qualifiedClassName(rt: Runtime, v: Value): string {
  switch (typeof v) {
    case "number":
      return (v | 0) === v ? "int" : "Number";
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

      return v.$it ? v.$it.name : rt.traitsOf(v).name;
  }
}

export const objectHooks: Record<string, ClassHook> = {
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
  Function: {
    construct: (rt) => rt.newFunctionObject(() => undefined, null),
    call: (rt) => rt.newFunctionObject(() => undefined, null),
  },
};
