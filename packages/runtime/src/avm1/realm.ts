// A player's AVM1 builtins, the global object and what boxes primitives,
// calls and constructs, as Ruffle's (https://github.com/ruffle-rs/ruffle)
// core/src/avm1/globals.rs, globals/object.rs, function.rs and
// property_decl.rs have them: MIT OR Apache-2.0, Copyright (c) 2018-2022
// Ruffle LLC and Ruffle contributors. Where adl parts from Ruffle, adl
// decides (docs/avm1.md, "Objects").
//
// So far Object and the global functions on objects; Function, Array,
// String, Number and Boolean are what boxing, InitArray and the
// conversions need of them, which step 9 completes with their classes.
import { numberToString } from "./numbers.js";
import {
  Avm1Function,
  Avm1Object,
  type Boxer,
  caseSensitive,
  DONT_DELETE,
  DONT_ENUM,
  fold,
  get,
  invoke,
  type Native,
  nameOf,
  READ_ONLY,
  VERSION_6,
} from "./objects.js";
import {
  isPrimitive,
  objects,
  type Primitive,
  stringOf,
  toBoolean,
  toNumber,
  type Value,
} from "./values.js";

/** A class's constructor and its prototype. */
interface Class {
  constr: Avm1Function;
  proto: Avm1Object;
}

/** The arguments' first, undefined where there is none. */
const first = (args: Value[]): Value => (args.length > 0 ? args[0] : undefined);

/** A number as Rust's `as u16` takes it: NaN 0, saturating. */
const u16 = (n: number): number =>
  Number.isNaN(n) ? 0 : Math.max(0, Math.min(0xffff, Math.trunc(n)));

export class Realm implements Boxer {
  /** `_global`: no prototype, as Flash's has none. */
  readonly global = new Avm1Object();
  readonly objectProto = new Avm1Object();
  readonly functionProto = new Avm1Object();
  readonly Object: Avm1Function;
  readonly Function: Avm1Function;
  readonly String: Class;
  readonly Number: Class;
  readonly Boolean: Class;
  readonly Array: Class;

  constructor() {
    const object = this.classOf(
      this.objectProto,
      (self, args, version) => {
        const v = first(args);
        return v === undefined || v === null ? self : this.box(v, version);
      },
      (_, args, version) => {
        const v = first(args);
        return v === undefined || v === null ? new Avm1Object() : this.box(v, version);
      },
    );
    const fn = this.classOf(
      this.functionProto,
      (self, args) => (args.length > 0 ? args[0] : self),
      (self, args) => (args.length > 0 ? args[0] : self),
    );
    this.Object = object;
    this.Function = fn;
    object.define("constructor", fn, DONT_ENUM | DONT_DELETE);
    fn.define("constructor", fn, DONT_ENUM | DONT_DELETE);
    this.functionProto.define("__proto__", this.objectProto, DONT_ENUM | DONT_DELETE);
    this.objectPrototype();

    this.String = this.boxClass(
      (self, args, version) => {
        const s = args.length > 0 ? stringOf(args[0], version) : "";
        self.primitive = s;
        self.define("length", s.length, DONT_ENUM | DONT_DELETE);
        return self;
      },
      (_, args, version) => (args.length > 0 ? stringOf(args[0], version) : ""),
      (self, version) => stringOf(self.primitive, version),
    );
    this.Number = this.boxClass(
      (self, args, version) => {
        self.primitive = args.length > 0 ? toNumber(args[0], version) : 0;
        return self;
      },
      (_, args, version) => (args.length > 0 ? toNumber(args[0], version) : 0),
      (self) => (typeof self.primitive === "number" ? numberToString(self.primitive) : undefined),
    );
    this.Boolean = this.boxClass(
      (self, args, version) => {
        self.primitive = args.length > 0 ? toBoolean(args[0], version) : false;
        return self;
      },
      (_, args, version) => (args.length > 0 ? toBoolean(args[0], version) : false),
      (self) => (typeof self.primitive === "boolean" ? String(self.primitive) : undefined),
    );
    this.Array = this.arrayClass();

    const g = this.global;
    g.define("Object", object, DONT_ENUM);
    g.define("Function", fn, DONT_ENUM | VERSION_6);
    // Getters, which give undefined to a SWF 4.
    this.getter(g, "NaN", (version) => (version > 4 ? Number.NaN : undefined));
    this.getter(g, "Infinity", (version) => (version > 4 ? Number.POSITIVE_INFINITY : undefined));
    g.define(
      "ASSetPropFlags",
      this.method((_, args, version) => setPropFlags(this, args, version)),
      DONT_ENUM,
    );
    // Flash's own globals leave a variable `o`, set to null.
    g.define("o", null, 0);
    g.define("Number", this.Number.constr, DONT_ENUM);
    g.define("Boolean", this.Boolean.constr, DONT_ENUM);
    g.define("String", this.String.constr, DONT_ENUM);
    g.define("Array", this.Array.constr, DONT_ENUM);
  }

  /** A property of `object` whose value a native getter gives, without a setter. */
  private getter(object: Avm1Object, name: string, value: (version: number) => Value): void {
    object.add(name, undefined, DONT_ENUM).get = this.method((_, __, version) => value(version));
  }

  /** A native function, a method's: no `prototype`. */
  method(native: Native): Avm1Function {
    return new Avm1Function(this.functionProto, this, native);
  }

  /** `value` as an object, as a native's `this`: a primitive boxed by its class on `_global`. */
  box(value: Value, version: number): Avm1Object {
    if (value instanceof Avm1Object) {
      return value;
    }

    const name = boxName(value);
    if (name === null) {
      return new Avm1Object();
    }

    const constr = this.global.own(name, version)?.value;
    const boxed =
      constr instanceof Avm1Object ? this.construct(constr, [value], version) : undefined;
    return boxed instanceof Avm1Object ? boxed : new Avm1Object();
  }

  /**
   * `new constr(...args)`: an object whose `__proto__` is the constructor's
   * `prototype`, which knows its constructor, given to the constructor;
   * a native constructor's result is the result. Anything but a function
   * constructs undefined.
   */
  construct(constr: Value, args: Value[], version: number): Value {
    if (!(constr instanceof Avm1Function)) {
      return undefined;
    }

    const prototype = constr.own("prototype", version);
    const self = new Avm1Object(prototype?.value);
    if (version < 7) {
      self.define("constructor", constr, DONT_ENUM);
    }

    self.define("__constructor__", constr, DONT_ENUM);

    if (constr.construct !== null) {
      return constr.construct(self, args, version);
    }

    constr.native(self, args, version);
    return self;
  }

  /**
   * `value[name]` of a primitive, as Flash finds it on the object boxing it,
   * without making one: its own `length`, `__constructor__` and
   * `constructor` up to SWF 6, then its class's prototype, with the
   * primitive as `this`. A class replaced on `_global` boxes it.
   */
  primitiveMember(value: Primitive, name: string, version: number): Value {
    const boxName_ = boxName(value);
    if (boxName_ === null) {
      return undefined;
    }

    const constr = this.global.own(boxName_, version)?.value;
    const builtin =
      constr === this.String.constr ||
      constr === this.Number.constr ||
      constr === this.Boolean.constr;
    if (!builtin) {
      return get(this.box(value, version), name, version);
    }

    const prototype = (constr as Avm1Object).own("prototype", version);
    const key = caseSensitive(version) ? name : fold(name);
    switch (key) {
      case "__proto__":
        if (prototype !== undefined) {
          return prototype.value;
        }
        break;
      case "__constructor__":
        return constr;
      case "constructor":
        if (version < 7) {
          return constr;
        }
        break;
      case "length":
        if (typeof value === "string") {
          return value.length;
        }
        break;
    }

    const proto = prototype?.value;
    return proto instanceof Avm1Object ? get(proto, name, version, value) : undefined;
  }

  /** A class with its own prototype object, in Flash's order: `prototype`, `constructor`, `__proto__`. */
  private classOf(proto: Avm1Object, construct: Native, call: Native): Avm1Function {
    const constr = new Avm1Function(undefined, this, call, construct);
    constr.define("prototype", proto, DONT_ENUM | DONT_DELETE);
    constr.define("constructor", this.Function ?? constr, DONT_ENUM | DONT_DELETE);
    constr.define("__proto__", this.functionProto, DONT_ENUM | DONT_DELETE | VERSION_6);
    proto.define("constructor", constr, DONT_ENUM | DONT_DELETE);
    return constr;
  }

  /** A class whose objects box a primitive, with `valueOf` and `toString` of it. */
  private boxClass(
    construct: Native,
    call: Native,
    text: (self: Avm1Object, version: number) => Value,
  ): Class {
    const proto = new Avm1Object(this.objectProto);
    const constr = this.classOf(proto, construct, call);
    proto.define(
      "valueOf",
      this.method((self) =>
        isPrimitive(self.primitive) && self.primitive !== undefined ? self.primitive : self,
      ),
      DONT_ENUM | DONT_DELETE,
    );
    proto.define(
      "toString",
      this.method((self, _, version) => text(self, version)),
      DONT_ENUM | DONT_DELETE,
    );
    return { constr, proto };
  }

  /** Array, as far as InitArray and the conversions need it: step 9 brings the rest. */
  private arrayClass(): Class {
    const proto = new Avm1Object(this.objectProto);
    const constr = this.classOf(
      proto,
      (self, args, version) => this.initArray(self, args, version),
      (_, args, version) => this.construct(this.Array.constr, args, version),
    );
    const join = (self: Avm1Object, separator: string, version: number) => {
      const n = toNumber(self.own("length", version)?.value, version) | 0;
      const parts: string[] = [];
      for (let i = 0; i < n; i++) {
        parts.push(stringOf(get(self, String(i), version), version));
      }

      return parts.join(separator);
    };
    proto.define(
      "toString",
      this.method((self, _, version) => join(self, ",", version)),
      DONT_ENUM | DONT_DELETE,
    );
    proto.define(
      "join",
      this.method((self, args, version) =>
        join(
          self,
          args.length > 0 && args[0] !== undefined ? stringOf(args[0], version) : ",",
          version,
        ),
      ),
      DONT_ENUM | DONT_DELETE,
    );
    return { constr, proto };
  }

  /** `self` made an array of `args`, or of a length where the one argument is a number. */
  private initArray(self: Avm1Object, args: Value[], version: number): Avm1Object {
    if (args.length === 1 && typeof args[0] === "number") {
      self.array = true;
      self.define("length", args[0] | 0, DONT_ENUM | DONT_DELETE);
      return self;
    }

    return this.fillArray(self, args, version);
  }

  /** A new array of `elements`, as InitArray makes it. */
  newArray(elements: Value[], version: number): Avm1Object {
    const self = new Avm1Object();
    const constr = this.global.own("Array", version)?.value;
    const prototype = constr instanceof Avm1Object ? constr.own("prototype", version) : undefined;
    if (prototype !== undefined) {
      self.define("__proto__", prototype.value, DONT_ENUM | DONT_DELETE);
    }

    if (constr instanceof Avm1Object) {
      self.define("constructor", constr, DONT_ENUM | DONT_DELETE);
    }

    return this.fillArray(self, elements, version);
  }

  private fillArray(self: Avm1Object, elements: Value[], _version: number): Avm1Object {
    for (let i = 0; i < elements.length; i++) {
      self.define(String(i), elements[i], 0);
    }

    self.define("length", elements.length, DONT_ENUM | DONT_DELETE);
    self.array = true;
    return self;
  }

  /**
   * A new object as InitObject makes one: `_global.Object` its
   * `constructor`, which adl has before `__proto__`, its `prototype`.
   */
  newObject(version: number): Avm1Object {
    const self = new Avm1Object();
    const constr = this.global.own("Object", version)?.value;
    if (constr instanceof Avm1Object) {
      self.define("constructor", constr, DONT_ENUM | DONT_DELETE);
      const prototype = constr.own("prototype", version);
      if (prototype !== undefined) {
        self.define("__proto__", prototype.value, DONT_ENUM | DONT_DELETE);
      }
    }

    return self;
  }

  private objectPrototype(): void {
    const proto = this.objectProto;
    const v6 = DONT_ENUM | DONT_DELETE | VERSION_6;
    const define = (name: string, flags: number, native: Native) =>
      proto.define(name, this.method(native), flags);

    define("watch", v6, (self, args, version) => {
      if (args.length === 0) {
        return false;
      }

      const name = nameOf(args[0], version);
      const callback = this.box(args.length > 1 ? args[1] : undefined, version);
      if (!(callback instanceof Avm1Function)) {
        return false;
      }

      const data = args.length > 2 ? args[2] : undefined;
      const w = self.watcher(name, version);
      if (w !== undefined) {
        w.callback = callback;
        w.data = data;
      } else {
        self.watchers ??= [];
        self.watchers.push({ name, callback, data });
      }

      return true;
    });
    define("unwatch", v6, (self, args, version) => {
      if (args.length === 0 || self.watchers === null) {
        return false;
      }

      const w = self.watcher(nameOf(args[0], version), version);
      if (w === undefined) {
        return false;
      }

      self.watchers.splice(self.watchers.indexOf(w), 1);
      return true;
    });
    define("addProperty", v6, (self, args, version) => {
      if (args.length === 0) {
        return false;
      }

      const name = nameOf(args[0], version);
      const getter = args.length > 1 ? args[1] : undefined;
      const setter = args.length > 2 ? args[2] : undefined;
      // adl takes functions only, and null for no setter.
      if (!(getter instanceof Avm1Function) || name === "") {
        return false;
      }

      if (!(setter instanceof Avm1Function) && setter !== null) {
        return false;
      }

      let p = self.own(name, version);
      if (p === undefined) {
        p = self.add(name, undefined, setter === null ? READ_ONLY : 0);
      }

      p.get = getter;
      p.set = setter;
      return true;
    });
    define("valueOf", DONT_ENUM | DONT_DELETE, (self) => self);
    define("toString", DONT_ENUM | DONT_DELETE, (self) =>
      self instanceof Avm1Function ? "[type Function]" : "[object Object]",
    );
    // adl's hasOwnProperty does not see a property with ASSetPropFlags' bit 0x100.
    define("hasOwnProperty", v6, (self, args, version) => {
      if (args.length === 0) {
        return false;
      }

      const p = self.own(nameOf(args[0], version), version);
      return p !== undefined && (p.flags & 0x100) === 0;
    });
    define("isPrototypeOf", v6, (self, args, version) => {
      if (args.length === 0) {
        return false;
      }

      let p = this.box(args[0], version).protoFor(version);
      for (let depth = 0; p instanceof Avm1Object && depth < 255; depth++) {
        if (p === self) {
          return true;
        }

        p = p.protoFor(version);
      }

      return false;
    });
    define("isPropertyEnumerable", v6, (self, args, version) => {
      if (args.length === 0) {
        return false;
      }

      const p = self.own(nameOf(args[0], version), version);
      return p !== undefined && (p.flags & DONT_ENUM) === 0;
    });
    define("toLocaleString", DONT_ENUM | DONT_DELETE, (self, _, version) =>
      stringOf(self, version),
    );
  }
}

/** The class on `_global` that boxes a primitive, null for undefined and null. */
function boxName(value: Value): string | null {
  switch (typeof value) {
    case "string":
      return "String";
    case "number":
      return "Number";
    case "boolean":
      return "Boolean";
    default:
      return null;
  }
}

/**
 * `ASSetPropFlags(object, names, set, clear)`: the attributes of the named
 * properties, or of all where `names` is null, cleared of `clear`'s bits
 * and given `set`'s. Names are a string, split at commas, or what an array
 * converts to; they are found whatever their case, in every version.
 */
function setPropFlags(realm: Realm, args: Value[], version: number): Value {
  if (args.length === 0) {
    return undefined;
  }

  const object = realm.box(args[0], version);
  const set = args.length > 2 ? u16(toNumber(args[2], version)) : 0;
  const clear = args.length > 3 ? u16(toNumber(args[3], version)) : 0;
  const change = (p: { flags: number }) => {
    p.flags = (p.flags & ~clear) | set;
  };
  if (args.length < 2) {
    return undefined;
  }

  if (args[1] === null) {
    for (const p of object.props.values()) {
      change(p);
    }

    return undefined;
  }

  for (const name of stringOf(args[1], version).split(",")) {
    const p = object.own(name, 6);
    if (p !== undefined) {
      change(p);
    }
  }

  return undefined;
}

/**
 * A method's call as a conversion makes it, Flash's "special" calls: no
 * `__resolve` asked, a method that is no function giving undefined.
 */
function callMethod(object: Avm1Object, name: string, version: number): Value {
  return invoke(get(object, name, version, object, false), object, [], version);
}

objects.valueOf = (object, version) => callMethod(object as Avm1Object, "valueOf", version);
objects.toPrimitive = (object, version) => {
  const value = callMethod(object as Avm1Object, "valueOf", version);
  return isPrimitive(value) ? value : object;
};
objects.toString = (object, version) => {
  const o = object as Avm1Object;
  if (typeof o.primitive === "string") {
    return o.primitive;
  }

  const value = callMethod(o, "toString", version);
  if (typeof value === "string") {
    return value;
  }

  return o instanceof Avm1Function ? "[type Function]" : "[type Object]";
};
objects.typeOf = (object) => (object as Avm1Object).typeOf();
