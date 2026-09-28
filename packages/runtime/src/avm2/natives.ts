// The builtins' native methods, in TypeScript, bound by the names the
// compiler gives them: "Class.name" for a static method, "Class#name" for an
// instance method, the name alone for a script's function, with "get:" and
// "set:" for accessors and "uri::name" outside the public namespace. And how
// the builtin classes differ from others: how their instances hold native
// state, and what calling or constructing them does.
import { readObject, writeObject } from "./amf.js";
import { byteArrayHook, byteArrayNatives, bytesOf, domainNatives } from "./bytearray.js";
import { dateHook, dateNatives } from "./date.js";
import { jsonNatives } from "./json.js";
import { messages } from "./messages.js";
import { Namespace, publicNs, qname } from "./names.js";
import { convertDoubleToString, convertDoubleToStringRadix, DTOSTR_PRECISION } from "./numbers.js";
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
import { sort, sortOn } from "./sort.js";

type Natives = Record<string, (rt: Runtime) => Method>;

const AS3 = "http://adobe.com/AS3/2006/builtin";
const started = Date.now();
const VEC = "__AS3__.vec";

/** `f` as a native, whatever the runtime. */
const plain =
  (f: Method) =>
  (_rt: Runtime): Method =>
    f;

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
  // As NumberClass::_numberToString: another radix writes the integer part only.
  "Number.Number::_numberToString": (rt) => (n: number, radix: number) => {
    if (radix === 10 || !Number.isFinite(n)) {
      return convertDoubleToString(n);
    }

    if (radix < 2 || radix > 36) {
      throw rt.error("RangeError", 1003, radix);
    }

    return convertDoubleToStringRadix(n, radix);
  },
  // As NumberClass::_convert: toFixed, toPrecision and toExponential.
  "Number.Number::_convert": (rt) => (n: number, precision: number, mode: number) => {
    const [min, max] = mode === DTOSTR_PRECISION ? [1, 21] : [0, 20];
    if (precision < min || precision > max) {
      throw rt.error("RangeError", 1002, precision, min, max);
    }

    return convertDoubleToString(n, mode, precision);
  },
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

  // As Toplevel::bugzilla: the bug fixes the builtins' AS3 asks about, all
  // in effect at the latest SWF version, as avmshell runs.
  // Class aliases and AMF.
  "flash.net::registerClassAlias": (rt) => (aliasName: Value, cls: Value) => {
    if (cls === null || cls === undefined) {
      throw rt.error("TypeError", 2007, "classObject");
    }

    if (aliasName === null || aliasName === undefined) {
      throw rt.error("TypeError", 2007, "aliasName");
    }

    const name = rt.toString(aliasName);
    if (name === "") {
      throw rt.error("ArgumentError", 2085, "aliasName");
    }

    rt.registerClassAlias(name, cls);
  },
  "flash.net::getClassByAlias": (rt) => (aliasName: Value) => {
    if (aliasName === null || aliasName === undefined) {
      throw rt.error("TypeError", 2007, "aliasName");
    }

    const name = rt.toString(aliasName);
    if (name === "") {
      throw rt.error("ArgumentError", 2085, "aliasName");
    }

    return rt.classByAlias(name);
  },
  "flash.net::ObjectEncoding.get:dynamicPropertyWriter": plain(() => null),
  "flash.utils::ByteArray#writeObject": (rt) =>
    function (this: AsObject, v: Value) {
      writeObject(rt, bytesOf(rt, this), v);
    },
  "flash.utils::ByteArray#readObject": (rt) =>
    function (this: AsObject) {
      return readObject(rt, bytesOf(rt, this));
    },
  bugzilla: plain((n: number) => n === 504525 || n === 574600 || n === 661330),

  // Error
  // Error.throwError fills in the template's %n: in debugger mode it has some.
  "Error.getErrorMessage": (rt) => (id: number) =>
    rt.debugger ? `Error #${id}: ${messages[id] ?? ""}` : `Error #${id}`,
  "Error#getStackTrace": plain(() => null),

  // avmshell's System
  // avmshell's console skips NUL characters, which strings may hold.
  "avmplus::System.trace": (rt) => (args: Value) => {
    rt.print(
      elements(args)
        .map((v) => rt.toString(v))
        .join(" ")
        .replaceAll("\0", ""),
    );
  },
  "avmplus::System.write": (rt) => (s: Value) => {
    rt.print(rt.toString(s).replaceAll("\0", ""));
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
  natives[`${c}.${own}::_sort`] = (rt) => (o: AsObject, args: Value) => sort(rt, o, elements(args));
  natives[`${c}.${own}::_every`] = (rt) => (o: AsObject, f: Value, receiver: Value) =>
    eachElement(rt, o, f, receiver, (result) => (result === true ? undefined : false)) ?? true;
  natives[`${c}.${own}::_some`] = (rt) => (o: AsObject, f: Value, receiver: Value) =>
    eachElement(rt, o, f, receiver, (result) => (result === true ? true : undefined)) ?? false;
  natives[`${c}.${own}::_forEach`] = (rt) => (o: AsObject, f: Value, receiver: Value) => {
    eachElement(rt, o, f, receiver, () => undefined);
  };
  // As TypedVectorObject's _map and _filter: a new Vector of the same type.
  natives[`${c}#${own}::_map`] = (rt) =>
    function (this: AsObject, f: Value, receiver: Value) {
      const cls = this.$traits.cls;
      const r = rt.constructClass(cls, [this.$a.length]);
      let i = 0;
      eachElement(rt, this, f, receiver, (result) => {
        r.$a[i++] = cls.$convert(rt, cls, result);
      });
      return r;
    };
  natives[`${c}#${own}::_filter`] = (rt) =>
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

/**
 * As ArrayClass's every, filter, forEach, map and some: `f` called with
 * each element, its index and the array, up to the length at the start;
 * `each` sees each result and the element, and a value it returns ends the
 * walk with that value. A method closure takes no other receiver.
 */
function eachElement(
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

/** As QNameClass::construct: QName(name) or QName(namespace, name). */
function newQName(rt: Runtime, cls: AsObject, args: Value[]): AsObject {
  if (args.length === 1 && args[0]?.$local !== undefined) {
    return args[0];
  }

  const name = args.length >= 2 ? args[1] : args[0];
  const o = cls.$it.instance();
  let ns: Namespace | null = publicNs;
  if (args.length >= 2 && args[0] !== undefined) {
    ns =
      args[0] === null
        ? null
        : args[0] instanceof Namespace
          ? args[0]
          : rt.namespaceOf(rt.construct(rt.builtinClass("Namespace"), args[0]));
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
  return o;
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
  // As NamespaceClass::construct: a namespace, a QName's, or one of a URI.
  Namespace: conversion((rt, args) => {
    const v = args[args.length - 1];
    if (args.length === 0 || v === undefined) {
      return publicNs;
    }

    if (v instanceof Namespace) {
      return v;
    }

    if (v?.$local !== undefined) {
      return v.$ns ?? publicNs;
    }

    return rt.ns(0, rt.toString(v));
  }),
  // As QNameClass::construct.
  QName: {
    construct: newQName,
    call: newQName,
  },
  "flash.utils::ByteArray": byteArrayHook,
  Date: dateHook,
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
    getIndex: (o, i, rt) => {
      if (i >= o.$a.length) {
        throw rt.error("RangeError", 1125, i, o.$a.length);
      }

      return o.$a[i];
    },
    hasIndex: (o, i) => i < o.$a.length,
    setIndex: (o, i, v, rt) => {
      const cls = o.$traits.cls;
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
  return {
    ...natives,
    ...byteArrayNatives(),
    ...domainNatives(),
    ...dateNatives(),
    ...jsonNatives(),
  };
}

export function builtinHooks(): Record<string, ClassHook> {
  return hooks;
}

export type { TypeRef };
