// The builtins' native methods, in TypeScript, bound by the names the
// compiler gives them: "Class.name" for a static method, "Class#name" for an
// instance method, the name alone for a script's function, with "get:" and
// "set:" for accessors and "uri::name" outside the public namespace. And how
// the builtin classes differ from others: how their instances hold native
// state, and what calling or constructing them does.
import { messages } from "./messages.js";
import { publicNs, qname } from "./names.js";
import {
  type AsObject,
  type ClassHook,
  type Method,
  NOT_FOUND,
  type Runtime,
  type Traits,
  type TypeRef,
  type Value,
} from "./runtime.js";

type Natives = Record<string, (rt: Runtime) => Method>;

const AS3 = "http://adobe.com/AS3/2006/builtin";
const started = Date.now();
const VEC = "__AS3__.vec";

/** `f` as a native, whatever the runtime. */
const plain =
  (f: Method) =>
  (_rt: Runtime): Method =>
    f;

/** A number's JavaScript string in `radix`, as avmplus writes it. */
function radixString(n: number, radix: number): string {
  if (radix < 2 || radix > 36) {
    return "";
  }

  return n.toString(radix);
}

/** The elements of an Array value, for natives that take one. */
function elements(v: Value): Value[] {
  return v?.$a ?? [];
}

const natives: Natives = {
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
    return this.$f.length;
  }),
  [`Function#${AS3}::call`]: (rt) =>
    function (this: AsObject, receiver: Value, ...args: Value[]) {
      return rt.callValue(this, receiver, args, null);
    },
  [`Function#${AS3}::apply`]: (rt) =>
    function (this: AsObject, receiver: Value, args: Value) {
      return rt.callValue(this, receiver, elements(args).slice(), null);
    },

  // Namespace
  "Namespace#get:uri": plain(function (this: Value) {
    return this.uri ?? "";
  }),
  "Namespace#get:prefix": plain(() => undefined),

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
  "Array.Array::_sort": (rt) => (o: AsObject, args: Value) => {
    const [compare] = elements(args);
    sortValues(rt, o.$a, compare);
    return o;
  },

  // String: `this` is the string.
  "String#get:length": plain(function (this: string) {
    return this.length;
  }),
  [`String.${AS3}::fromCharCode`]:
    (rt) =>
    (...codes: Value[]) => {
      return String.fromCharCode(...codes.map((c) => rt.toUint(c) & 0xffff));
    },
  [`String#${AS3}::charAt`]: (rt) =>
    function (this: string, i: Value = 0) {
      return this.charAt(rt.toNumber(i));
    },
  [`String#${AS3}::charCodeAt`]: (rt) =>
    function (this: string, i: Value = 0) {
      return this.charCodeAt(rt.toNumber(i));
    },
  [`String#${AS3}::indexOf`]: (rt) =>
    function (this: string, s: Value = "undefined", i: Value = 0) {
      return this.indexOf(rt.toString(s), rt.toNumber(i));
    },
  [`String#${AS3}::lastIndexOf`]: (rt) =>
    function (this: string, s: Value = "undefined", i: Value = 0x7fffffff) {
      return this.lastIndexOf(rt.toString(s), rt.toNumber(i));
    },
  [`String#${AS3}::localeCompare`]: (rt) =>
    function (this: string, other: Value) {
      const o = rt.toString(other);
      return this < o ? -1 : this > o ? 1 : 0;
    },
  [`String#${AS3}::slice`]: (rt) =>
    function (this: string, start: Value = 0, end: Value = 0x7fffffff) {
      return this.slice(rt.toNumber(start), rt.toNumber(end));
    },
  [`String#${AS3}::substring`]: (rt) =>
    function (this: string, start: Value = 0, end: Value = 0x7fffffff) {
      return this.substring(rt.toNumber(start), rt.toNumber(end));
    },
  [`String#${AS3}::substr`]: (rt) =>
    function (this: string, start: Value = 0, length: Value = 0x7fffffff) {
      return this.substr(rt.toNumber(start), rt.toNumber(length));
    },
  [`String#${AS3}::toLowerCase`]: plain(function (this: string) {
    return this.toLowerCase();
  }),
  [`String#${AS3}::toUpperCase`]: plain(function (this: string) {
    return this.toUpperCase();
  }),
  "String#String::_indexOf": plain(function (this: string, s: string, i = 0) {
    return this.indexOf(s, i);
  }),
  "String#String::_lastIndexOf": plain(function (this: string, s: string, i = 0x7fffffff) {
    return this.lastIndexOf(s, i);
  }),
  "String#String::_slice": plain(function (this: string, start = 0, end = 0x7fffffff) {
    return this.slice(start, end);
  }),
  "String#String::_substring": plain(function (this: string, start = 0, end = 0x7fffffff) {
    return this.substring(start, end);
  }),
  "String#String::_substr": plain(function (this: string, start = 0, length = 0x7fffffff) {
    return this.substr(start, length);
  }),
  "String.String::_replace": (rt) => (s: string, pattern: Value, replacement: Value) => {
    const p = pattern?.$re instanceof RegExp ? pattern.$re : rt.toString(pattern);
    if (replacement !== null && typeof replacement === "object" && replacement.$f) {
      // The function gets the match, its groups, its position and the string.
      return s.replace(p, (...a: Value[]) => {
        const args = typeof a[a.length - 1] === "object" ? a.slice(0, -1) : a;
        return rt.toString(rt.callValue(replacement, null, args, null));
      });
    }

    return s.replace(p, rt.toString(replacement));
  },
  "String.String::_search": (rt) => (s: string, pattern: Value) =>
    s.search(pattern?.$re instanceof RegExp ? pattern.$re : rt.toString(pattern)),
  "String.String::_match": (rt) => (s: string, pattern: Value) => {
    const m = s.match(pattern?.$re instanceof RegExp ? pattern.$re : rt.toString(pattern));
    return m ? matchArray(rt, m) : null;
  },
  "String.String::_split": (rt) => (s: string, delimiter: Value, limit: number) => {
    if (delimiter?.$re instanceof RegExp) {
      return rt.array(s.split(delimiter.$re, limit >= 0 ? limit : undefined));
    }

    const parts = s.split(rt.toString(delimiter));
    return rt.array(limit >= 0 && limit < parts.length ? parts.slice(0, limit) : parts);
  },

  // RegExp: `this` holds its JavaScript RegExp in $re.
  "RegExp#get:source": plain(function (this: AsObject) {
    return this.$source;
  }),
  "RegExp#get:global": plain(function (this: AsObject) {
    return this.$re.global;
  }),
  "RegExp#get:ignoreCase": plain(function (this: AsObject) {
    return this.$re.ignoreCase;
  }),
  "RegExp#get:multiline": plain(function (this: AsObject) {
    return this.$re.multiline;
  }),
  "RegExp#get:dotall": plain(function (this: AsObject) {
    return this.$re.dotAll;
  }),
  "RegExp#get:extended": plain(function (this: AsObject) {
    return this.$extended;
  }),
  "RegExp#get:lastIndex": plain(function (this: AsObject) {
    return this.$re.lastIndex;
  }),
  "RegExp#set:lastIndex": (rt) =>
    function (this: AsObject, i: Value) {
      this.$re.lastIndex = rt.toInt(i);
    },
  [`RegExp#${AS3}::exec`]: (rt) =>
    function (this: AsObject, s: Value = "") {
      const re: RegExp = this.$re;
      const m = re.exec(rt.toString(s));
      return m ? matchArray(rt, m) : null;
    },

  // Number
  "Number.Number::_numberToString": plain((n: number, radix: number) =>
    radix === 10 ? String(n) : radixString(n, radix),
  ),
  "Number.Number::_convert": plain((n: number, precision: number, mode: number) => {
    // avmplus' DTOSTR_FIXED 1, DTOSTR_PRECISION 2, DTOSTR_EXPONENTIAL 3.
    switch (mode) {
      case 1:
        return n.toFixed(precision);
      case 2:
        return n.toPrecision(precision);
      default:
        return n.toExponential(precision);
    }
  }),
  "Number.Number::_minValue": plain(() => Number.MIN_VALUE),

  // Global functions
  isNaN: (rt) => (v: Value) => Number.isNaN(rt.toNumber(v)),
  isFinite: (rt) => (v: Value) => Number.isFinite(rt.toNumber(v)),
  parseInt: (rt) => (s: Value, radix: Value) => Number.parseInt(rt.toString(s), rt.toInt(radix)),
  parseFloat: (rt) => (s: Value) => Number.parseFloat(rt.toString(s)),
  "avmplus::getQualifiedClassName": (rt) => (v: Value) => qualifiedClassName(rt, v),
  "avmplus::getQualifiedSuperclassName": (rt) => (v: Value) => {
    const cls = v !== null && typeof v === "object" && v.$it ? v : rt.traitsOf(v).cls;
    const base = cls?.$base;
    return base ? base.$it.name : null;
  },

  // Error
  // Error.throwError fills in the template's %n: in debugger mode it has some.
  "Error.getErrorMessage": (rt) => (id: number) =>
    rt.debugger ? `Error #${id}: ${messages[id] ?? ""}` : `Error #${id}`,
  "Error#getStackTrace": plain(() => null),

  // avmshell's System
  "avmplus::System.trace": (rt) => (args: Value) => {
    rt.print(
      elements(args)
        .map((v) => rt.toString(v))
        .join(" "),
    );
  },
  "avmplus::System.write": (rt) => (s: Value) => {
    rt.print(rt.toString(s));
  },
  "avmplus::System.avmplus:System::getArgv": (rt) => () => rt.array([]),
  "avmplus::System.getAvmplusVersion": plain(() => "swf2es"),
  "avmplus::System.get:swfVersion": plain(() => 31),
  "avmplus::System.get:apiVersion": plain(() => 50),
  "avmplus::System.getTimer": plain(() => Date.now() - started),
  "avmplus::System.getRunmode": plain(() => "jit"),
  "avmplus::System.isDebugger": (rt) => () => rt.debugger,
  "avmplus::System.exit": plain(() => undefined),
};

// Math, and Number's copies of it.
for (const name of [
  "abs",
  "acos",
  "asin",
  "atan",
  "ceil",
  "cos",
  "exp",
  "floor",
  "log",
  "round",
  "sin",
  "sqrt",
  "tan",
]) {
  const f = (Math as unknown as Record<string, (x: number) => number>)[name];
  const native = (rt: Runtime) => (x: Value) => f(rt.toNumber(x));
  natives[`Math.${name}`] = native;
  natives[`Number.${name}`] = native;
}

for (const prefix of ["Math", "Number"]) {
  natives[`${prefix}.atan2`] = (rt) => (y: Value, x: Value) =>
    Math.atan2(rt.toNumber(y), rt.toNumber(x));
  natives[`${prefix}.pow`] = (rt) => (x: Value, y: Value) => rt.toNumber(x) ** rt.toNumber(y);
  natives[`${prefix}.random`] = plain(() => Math.random());
  natives[`${prefix}.max`] =
    (rt) =>
    (...args: Value[]) =>
      args.length === 0 ? Number.NEGATIVE_INFINITY : Math.max(...args.map((a) => rt.toNumber(a)));
  natives[`${prefix}.min`] =
    (rt) =>
    (...args: Value[]) =>
      args.length === 0 ? Number.POSITIVE_INFINITY : Math.min(...args.map((a) => rt.toNumber(a)));
}

natives["Math.Math::_max"] = plain((x: number, y: number) => Math.max(x, y));
natives["Math.Math::_min"] = plain((x: number, y: number) => Math.min(x, y));

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
  natives[`${c}#get:length`] = plain(function (this: AsObject) {
    return this.$a.length;
  });
  natives[`${c}#set:length`] = (rt) =>
    function (this: AsObject, n: Value) {
      if (this.$fixed) {
        throw rt.error("RangeError", 1126);
      }

      const length = rt.toUint(n);
      const fill = this.$traits.cls.$fill;
      const a: Value[] = this.$a;
      const old = a.length;
      a.length = length;
      if (length > old) {
        a.fill(fill, old);
      }
    };
  natives[`${c}#get:fixed`] = plain(function (this: AsObject) {
    return this.$fixed;
  });
  natives[`${c}#set:fixed`] = plain(function (this: AsObject, fixed: Value) {
    this.$fixed = !!fixed;
  });
  natives[`${c}#${AS3}::push`] = (rt) =>
    function (this: AsObject, ...args: Value[]) {
      if (this.$fixed) {
        throw rt.error("RangeError", 1126);
      }

      const convert = this.$traits.cls.$convert;
      for (const v of args) {
        this.$a.push(convert(rt, this.$traits.cls, v));
      }

      return this.$a.length;
    };
  natives[`${c}#${AS3}::pop`] = (rt) =>
    function (this: AsObject) {
      if (this.$fixed) {
        throw rt.error("RangeError", 1126);
      }

      return this.$a.length ? this.$a.pop() : this.$traits.cls.$fill;
    };
  natives[`${c}#${AS3}::shift`] = (rt) =>
    function (this: AsObject) {
      if (this.$fixed) {
        throw rt.error("RangeError", 1126);
      }

      return this.$a.length ? this.$a.shift() : this.$traits.cls.$fill;
    };
  natives[`${c}#${AS3}::unshift`] = (rt) =>
    function (this: AsObject, ...args: Value[]) {
      if (this.$fixed) {
        throw rt.error("RangeError", 1126);
      }

      const convert = this.$traits.cls.$convert;
      this.$a.unshift(...args.map((v) => convert(rt, this.$traits.cls, v)));
      return this.$a.length;
    };
  natives[`${c}#${own}::newThisType`] = (rt) =>
    function (this: AsObject) {
      return rt.constructClass(this.$traits.cls, []);
    };
  natives[`${c}#${own}::_reverse`] = plain(function (this: AsObject) {
    this.$a.reverse();
    return this;
  });
  natives[`${c}#${own}::_spliceHelper`] = (rt) =>
    function (
      this: AsObject,
      insert: Value,
      insertCount: Value,
      deleteCount: Value,
      args: Value,
      offset: Value,
    ) {
      const at = rt.toUint(insert);
      const items: Value[] = (args?.$a ?? []).slice(
        rt.toUint(offset),
        rt.toUint(offset) + rt.toUint(insertCount),
      );
      this.$a.splice(at, rt.toUint(deleteCount), ...items);
    };
  natives[`${c}.${own}::_sort`] = (rt) => (o: AsObject, args: Value) => {
    const [compare] = elements(args);
    sortValues(rt, o.$a, compare);
    return o;
  };
}

/** Sort as Array's and Vector's sort with a compare function, or else as strings. */
function sortValues(rt: Runtime, a: Value[], compare: Value): void {
  if (compare !== null && typeof compare === "object" && compare.$f) {
    a.sort((x, y) => rt.toNumber(rt.callValue(compare, null, [x, y], null)));
    return;
  }

  // With no compare function, or sort options, by the elements' strings.
  a.sort((x, y) => {
    const sx = rt.toString(x);
    const sy = rt.toString(y);
    return sx < sy ? -1 : sx > sy ? 1 : 0;
  });
}

/** A match as AS3 gives it: an Array of the match and its groups, with its index and input. */
function matchArray(rt: Runtime, m: RegExpMatchArray): AsObject {
  const a = rt.array(Array.from(m));
  if (m.index !== undefined) {
    a.$d.set("index", m.index);
    a.$d.set("input", m.input);
  }

  return a;
}

/**
 * A RegExp from its pattern and options, as RegExpClass::construct: AS3's
 * flags g, i, m and s are JavaScript's, and x, extended, drops whitespace
 * and comments from the pattern.
 */
function newRegExp(rt: Runtime, cls: AsObject, args: Value[]): AsObject {
  const [pattern, options] = args;
  const o = cls.$it.instance();
  if (pattern?.$re instanceof RegExp && options === undefined) {
    o.$source = pattern.$source;
    o.$extended = pattern.$extended;
    o.$re = new RegExp(pattern.$re.source, pattern.$re.flags);
    return o;
  }

  const source = pattern === undefined ? "" : rt.toString(pattern);
  const flags = options === undefined ? "" : rt.toString(options);
  const extended = flags.includes("x");
  const js = [..."gims"].filter((f) => flags.includes(f)).join("");
  o.$source = source;
  o.$extended = extended;
  o.$re = new RegExp(
    extended ? source.replace(/\\.|\s+|#[^\n]*/g, (t) => (t[0] === "\\" ? t : "")) : source,
    js,
  );
  return o;
}

function shortName(qualified: string): string {
  const i = qualified.lastIndexOf("::");
  return i < 0 ? qualified : qualified.slice(i + 2);
}

function qualifiedClassName(rt: Runtime, v: Value): string {
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

/** A conversion of the builtin primitive classes, called or constructed. */
const conversion = (convert: (rt: Runtime, args: Value[]) => Value): ClassHook => ({
  call: (rt, _cls, args) => convert(rt, args),
  construct: (rt, _cls, args) => convert(rt, args),
});

/** Array storage for an instance of Array or a Vector, and its subclasses'. */
const withStorage = (traits: Traits): AsObject => {
  const o = Object.create(traits.proto);
  o.$a = [];
  o.$fixed = false;
  return o;
};

const hooks: Record<string, ClassHook> = {
  Object: {
    call: (rt, _cls, args) =>
      args[0] === null || args[0] === undefined ? rt.newObject([]) : args[0],
    construct: (rt, _cls, args) =>
      args[0] === null || args[0] === undefined ? rt.newObject([]) : args[0],
  },
  int: conversion((rt, args) => (args.length ? rt.toInt(args[0]) : 0)),
  uint: conversion((rt, args) => (args.length ? rt.toUint(args[0]) : 0)),
  Number: conversion((rt, args) => (args.length ? rt.toNumber(args[0]) : 0)),
  String: conversion((rt, args) => (args.length ? rt.toString(args[0]) : "")),
  Boolean: conversion((_rt, args) => !!args[0]),
  Array: {
    create: withStorage,
    call: (rt, cls, args) => rt.constructClass(cls, args),
  },
  RegExp: {
    construct: newRegExp,
    call: (rt, cls, args) =>
      args[0]?.$re instanceof RegExp && args[1] === undefined ? args[0] : newRegExp(rt, cls, args),
  },
  Function: {
    construct: (rt) => rt.newFunctionObject(() => undefined, null),
    call: (rt) => rt.newFunctionObject(() => undefined, null),
  },
  [`${VEC}::Vector`]: {
    apply: (rt, _factory, params) => vectorOf(rt, params[0] ?? null),
  },
};

for (const [kind, convert, fill] of VECTORS) {
  hooks[`${VEC}::${kind}`] = {
    create: withStorage,
    getIndex: (o, i) => {
      if (i >= o.$a.length) {
        throw o.$traits.cls.$rt.error("RangeError", 1125, i, o.$a.length);
      }

      return o.$a[i];
    },
    setIndex: (o, i, v) => {
      const cls = o.$traits.cls;
      const rt: Runtime = cls.$rt;
      if (i > o.$a.length || (i === o.$a.length && o.$fixed)) {
        throw rt.error("RangeError", 1125, i, o.$a.length);
      }

      o.$a[i] = convert(rt, cls, v);
    },
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

      const o = cls.$it.instance();
      o.$a = source.$a.map((v: Value) => convert(rt, cls, v));
      return o;
    },
  };
}

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

/** Vector.<T>: the specialized classes for int, uint and Number, else Vector$object's for T. */
function vectorOf(rt: Runtime, param: AsObject | null): AsObject {
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

export function builtinNatives(): Natives {
  return natives;
}

export function builtinHooks(): Record<string, ClassHook> {
  return hooks;
}

export type { TypeRef };
