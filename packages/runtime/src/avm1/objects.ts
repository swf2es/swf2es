// AVM1's objects and their properties, as Ruffle's
// (https://github.com/ruffle-rs/ruffle) core/src/avm1/property.rs,
// property_map.rs, object.rs and object/script_object.rs have them: MIT OR
// Apache-2.0, Copyright (c) 2018-2022 Ruffle LLC and Ruffle contributors.
// Where adl parts from Ruffle, adl decides (docs/avm1.md, "Objects").
//
// An object keeps its properties in a Map by their exact names, in the
// order they were added, which is Flash's order of enumeration reversed.
// A SWF up to 6 finds names whatever their case: it asks the exact name
// first, as code mostly spells a name one way, and else an index by the
// names folded to lower case, which an object builds the first time such a
// lookup misses and keeps from then on. A SWF from 7 never needs it.
// `__proto__` is a property like any other, which the object also keeps
// at hand for the walks up its prototypes.
import { stringOf, toNumber, type Value } from "./values.js";

/** Not listed by for..in. */
export const DONT_ENUM = 1;
/** Not removed by delete. */
export const DONT_DELETE = 2;
/** Not changed by a set. */
export const READ_ONLY = 4;
/** The bits from 0x8 up, which hide a property from SWFs before a version (ASSetPropFlags). */
export const VERSION_BITS = 0xfff8;
export const VERSION_6 = 0x80;
export const VERSION_7 = 0x500;
export const VERSION_8 = 0x1000;
export const VERSION_9 = 0x2000;
export const VERSION_10 = 0x4000;

/** By version, the bits that hide a property from it (Ruffle's VERSION_MASKS); none from 10. */
const HIDING = [0x7ff8, 0x7ff8, 0x7ff8, 0x7ff8, 0x7ff8, 0x7480, 0x7500, 0x7000, 0x6000, 0x4000];

/** Whether a property of `flags` is there for a SWF of `version`. */
export const allowed = (flags: number, version: number): boolean =>
  version >= 10 || (flags & HIDING[version < 0 ? 0 : version]) === 0;

/** Whether a SWF of `version` finds names in their case: from 7. */
export const caseSensitive = (version: number): boolean => version > 6;

/** Names folded by Flash's lower case, once each, as the same names come back. */
const foldCache = new Map<string, string>();

/**
 * A name as a SWF up to 6 compares it: ASCII letters folded to lower case,
 * and the other letters as Flash's table folds them, which JavaScript's
 * lower case agrees with for the Latin, Greek and Cyrillic letters adl
 * folds.
 */
export function fold(name: string): string {
  let i = 0;
  for (; i < name.length; i++) {
    const c = name.charCodeAt(i);
    if ((c >= 0x41 && c <= 0x5a) || c >= 0x80) {
      break;
    }
  }

  if (i === name.length) {
    return name;
  }

  let folded = foldCache.get(name);
  if (folded === undefined) {
    folded = name.toLowerCase();
    if (foldCache.size >= 4096) {
      foldCache.clear();
    }

    foldCache.set(name, folded);
  }

  return folded;
}

/**
 * Whether any object has had a property named `__resolve`: until one has,
 * a name the chain lacks is undefined without a second walk for one.
 */
let resolvers = false;

/** A property: a value, or a getter and maybe a setter (addProperty), and its attributes. */
export class Property {
  get: Avm1Object | null = null;
  set: Avm1Object | null = null;

  constructor(
    /** As it was first set, which for..in lists. */
    readonly name: string,
    public value: Value,
    public flags: number,
  ) {}
}

/** What `watch` keeps for a name. */
export interface Watcher {
  readonly name: string;
  callback: Avm1Object;
  data: Value;
}

/** A native function: `self` is an object (a primitive boxed), as Flash gives natives. */
export type Native = (self: Avm1Object, args: Value[], version: number) => Value;

/** Boxing primitives as natives' `this`: the realm's. */
export interface Boxer {
  box(value: Value, version: number): Avm1Object;
}

export class Avm1Object {
  /** By exact name, in the order they were added. */
  readonly props = new Map<string, Property>();
  /** By folded name, the first added of each fold, once a SWF up to 6 needs it. */
  private folded: Map<string, Property> | null = null;
  /** The property named `__proto__`, if any. */
  private protoProp: Property | null = null;
  /** By the name each watches, as set. */
  watchers: Watcher[] | null = null;
  /** Whether it is an array, whose `length` follows its elements: what Array's constructor makes. */
  array = false;
  /** The primitive a String, Number or Boolean object boxes, undefined for any other. */
  primitive: Value = undefined;

  /** An object whose `__proto__` is `proto`, or without one. */
  constructor(proto?: Value) {
    if (proto !== undefined) {
      this.define("__proto__", proto, DONT_ENUM | DONT_DELETE);
    }
  }

  /** The prototype, `__proto__`'s value. */
  get proto(): Value {
    return this.protoProp === null ? undefined : this.protoProp.value;
  }

  /**
   * The prototype a SWF of `version` walks to: none where `__proto__` is
   * hidden from it, as a function's is from SWF 5.
   */
  protoFor(version: number): Value {
    const p = this.protoProp;
    return p === null || !allowed(p.flags, version) ? undefined : p.value;
  }

  /** The own property `name` names for a SWF of `version`, whatever its attributes. */
  own(name: string, version: number): Property | undefined {
    const p = this.props.get(name);
    if (p !== undefined || version > 6) {
      return p;
    }

    return this.foldedIndex().get(fold(name));
  }

  /**
   * Set `name` to a value with `flags`, as a builtin is defined: in its
   * case, replacing what it had, a getter included, where it was.
   */
  define(name: string, value: Value, flags: number): Property {
    const p = this.props.get(name);
    if (p !== undefined) {
      p.value = value;
      p.flags = flags;
      p.get = null;
      p.set = null;
      return p;
    }

    return this.add(name, value, flags);
  }

  /** A new property, last in the order. */
  add(name: string, value: Value, flags: number): Property {
    const p = new Property(name, value, flags);
    this.props.set(name, p);
    if (name === "__proto__") {
      this.protoProp = p;
    } else if (name.length === 9 && !resolvers && fold(name) === "__resolve") {
      resolvers = true;
    }

    const folded = this.folded;
    if (folded !== null) {
      const key = fold(name);
      if (!folded.has(key)) {
        folded.set(key, p);
      }
    }

    return p;
  }

  remove(p: Property): void {
    this.props.delete(p.name);
    if (p === this.protoProp) {
      this.protoProp = null;
    }

    const folded = this.folded;
    if (folded === null) {
      return;
    }

    const key = fold(p.name);
    if (folded.get(key) === p) {
      folded.delete(key);
      for (const other of this.props.values()) {
        if (fold(other.name) === key) {
          folded.set(key, other);
          break;
        }
      }
    }
  }

  /** The watcher of `name` for a SWF of `version`. */
  watcher(name: string, version: number): Watcher | undefined {
    const watchers = this.watchers;
    if (watchers === null) {
      return undefined;
    }

    for (const w of watchers) {
      if (w.name === name) {
        return w;
      }
    }

    if (version > 6) {
      return undefined;
    }

    const key = fold(name);
    return watchers.find((w) => fold(w.name) === key);
  }

  /** What `typeof` says of it. */
  typeOf(): string {
    return "object";
  }

  private foldedIndex(): Map<string, Property> {
    let folded = this.folded;
    if (folded === null) {
      folded = new Map();
      for (const p of this.props.values()) {
        const key = fold(p.name);
        if (!folded.has(key)) {
          folded.set(key, p);
        }
      }

      this.folded = folded;
    }

    return folded;
  }
}

/**
 * A function. Natives are TypeScript; one called with `new` runs
 * `construct` where it has one, as Flash's native constructors (Object,
 * Array...) do otherwise than when called. The functions DefineFunction
 * makes come with step 7 (docs/avm1.md).
 */
export class Avm1Function extends Avm1Object {
  constructor(
    proto: Value,
    readonly realm: Boxer,
    readonly native: Native,
    readonly construct: Native | null = null,
  ) {
    super();
    // A SWF 5 sees no prototype of a function, as adl has it.
    if (proto !== undefined) {
      this.define("__proto__", proto, DONT_ENUM | DONT_DELETE | VERSION_6);
    }
  }

  override typeOf(): string {
    return "function";
  }

  /** Call it with `self` as `this`. */
  call(self: Value, args: Value[], version: number): Value {
    return this.native(this.realm.box(self, version), args, version);
  }
}

/** Call `fn` if it is a function; anything else gives undefined, as Flash does. */
export function invoke(fn: Value, self: Value, args: Value[], version: number): Value {
  return fn instanceof Avm1Function ? fn.call(self, args, version) : undefined;
}

/** The deepest a prototype chain is walked, as Ruffle stops: no further. */
const DEPTH = 255;

/**
 * The first own property `name` names on `o` or its prototypes, whatever
 * its attributes: whether the name is there, as the scope chain asks.
 */
export function find(o: Avm1Object, name: string, version: number): Property | undefined {
  let p: Value = o;
  for (let depth = 0; p instanceof Avm1Object && depth < DEPTH; depth++) {
    const own = p.own(name, version);
    if (own !== undefined) {
      return own;
    }

    p = p.protoFor(version);
  }

  return undefined;
}

/**
 * `o[name]`: the first property its version sees on `o` or its
 * prototypes, its getter called with `self` as `this`, or what a
 * `__resolve` on the chain gives for the name.
 */
export function get(
  o: Avm1Object,
  name: string,
  version: number,
  self: Value = o,
  resolving = true,
): Value {
  let p: Value = o;
  for (let depth = 0; p instanceof Avm1Object && depth < DEPTH; depth++) {
    const own = p.own(name, version);
    if (own !== undefined && allowed(own.flags, version)) {
      return own.get === null ? own.value : invoke(own.get, self, [], version);
    }

    p = p.protoFor(version);
  }

  return resolving && resolvers ? resolve(o, name, version, self) : undefined;
}

/**
 * A missing name's value: the first `__resolve` on the chain that holds an
 * object, called with the name; a primitive one is skipped, and an object
 * that is no function gives undefined.
 */
function resolve(o: Avm1Object, name: string, version: number, self: Value): Value {
  let p: Value = o;
  for (let depth = 0; p instanceof Avm1Object && depth < DEPTH; depth++) {
    const own = p.own("__resolve", version);
    if (own !== undefined && allowed(own.flags, version) && own.value instanceof Avm1Object) {
      return invoke(own.value, self, [name], version);
    }

    p = p.protoFor(version);
  }

  return undefined;
}

/** `name`'s stored value on `o` or its prototypes, no getter called: what a watcher is told was there. */
function stored(o: Avm1Object, name: string, version: number): Value {
  let p: Value = o;
  for (let depth = 0; p instanceof Avm1Object && depth < DEPTH; depth++) {
    const own = p.own(name, version);
    if (own !== undefined && allowed(own.flags, version)) {
      return own.value;
    }

    p = p.protoFor(version);
  }

  return undefined;
}

/**
 * `o[name] = value`: the watcher of the name on `o` first, which gives the
 * value set; then an own property's setter, or the first getter's setter
 * on the prototypes, or the value stored on `o`, unless read-only.
 */
export function set(o: Avm1Object, name: string, value: Value, version: number): void {
  if (name === "") {
    return;
  }

  if (o.watchers !== null) {
    const w = o.watcher(name, version);
    if (w !== undefined) {
      const old = stored(o, name, version);
      value = invoke(w.callback, o, [name, old, value, w.data], version);
    }
  }

  const own = o.own(name, version);
  if (own === undefined) {
    let p: Value = o.protoFor(version);
    for (let depth = 0; p instanceof Avm1Object && depth < DEPTH; depth++) {
      const virtual = p.own(name, version);
      if (virtual !== undefined && virtual.get !== null && allowed(virtual.flags, version)) {
        if (virtual.set !== null) {
          invoke(virtual.set, o, [value], version);
        }

        return;
      }

      p = p.protoFor(version);
    }
  }

  if (o.array) {
    arraySet(o, name, value, version);
  }

  if (own === undefined) {
    o.add(name, value, 0);
    return;
  }

  if (own.set !== null) {
    invoke(own.set, o, [value], version);
  }

  // A value set over a builtin's shows it to every version; but adl's SWF 6 keeps bit 0x400.
  if ((own.flags & READ_ONLY) === 0) {
    own.value = value;
    own.flags &= version === 6 ? ~VERSION_BITS | 0x400 : ~VERSION_BITS;
  }
}

/** An array's `length` as a set changes it: elements past a shorter one go, an index past it grows it. */
function arraySet(a: Avm1Object, name: string, value: Value, version: number): void {
  if (name === "length") {
    const length = toNumber(value, version) | 0;
    const old = a.props.get("length")?.value;
    if (typeof old === "number") {
      for (let i = Math.max(length, 0); i < (old | 0); i++) {
        removeOwn(a, String(i), version);
      }
    }

    return;
  }

  const index = arrayIndex(name);
  if (index !== null && index >= lengthOf(a)) {
    const p = a.props.get("length");
    if (p === undefined) {
      a.add("length", index + 1, 0);
    } else {
      p.value = (index + 1) | 0;
    }
  }
}

/** An array's own `length`, as an int. */
export function lengthOf(o: Avm1Object): number {
  return toNumber(o.props.get("length")?.value, 7) | 0;
}

/** A name as an array index: an int, after spaces, or null. */
function arrayIndex(name: string): number | null {
  const m = /^[ \t\n\r\f\v]*([+-]?\d+)$/.exec(name);
  if (m === null) {
    return null;
  }

  const n = Number(m[1]);
  return n >= -2147483648 && n <= 2147483647 ? n : null;
}

/** `delete o[name]`: whether an own property went, which DontDelete keeps. */
export function removeOwn(o: Avm1Object, name: string, version: number): boolean {
  const own = o.own(name, version);
  if (own === undefined || own.flags & DONT_DELETE) {
    return false;
  }

  o.remove(own);
  return true;
}

/**
 * The names for..in visits on `o`, in Flash's order: its prototypes' first,
 * the deepest's first, but those `o` lists itself, then its own, the last
 * added first; DontEnum ones left out. An own DontEnum property does not
 * hide a prototype's of the same name (adl).
 */
export function keys(o: Avm1Object, version: number, out: string[] = [], depth = 0): string[] {
  const proto = o.protoFor(version);
  if (proto instanceof Avm1Object && depth < DEPTH) {
    const start = out.length;
    keys(proto, version, out, depth + 1);
    let n = start;
    for (let i = start; i < out.length; i++) {
      const own = o.own(out[i], version);
      if (own === undefined || own.flags & DONT_ENUM) {
        out[n++] = out[i];
      }
    }

    out.length = n;
  }

  const own = [...o.props.values()];
  for (let i = own.length - 1; i >= 0; i--) {
    if ((own[i].flags & DONT_ENUM) === 0) {
      out.push(own[i].name);
    }
  }

  return out;
}

/** Whether `name` is on `o` or its prototypes, whatever its attributes. */
export const has = (o: Avm1Object, name: string, version: number): boolean =>
  find(o, name, version) !== undefined;

/** `name` as a property's name: the string a value converts to. */
export const nameOf = (value: Value, version: number): string =>
  typeof value === "string" ? value : stringOf(value, version);
