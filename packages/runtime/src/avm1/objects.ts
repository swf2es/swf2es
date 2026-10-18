// AVM1's objects and their properties, as Ruffle's
// (https://github.com/ruffle-rs/ruffle) core/src/avm1/property.rs,
// property_map.rs, object.rs and object/script_object.rs have them: MIT OR
// Apache-2.0, Copyright (c) 2018-2022 Ruffle LLC and Ruffle contributors.
// Where adl parts from Ruffle, adl decides (docs/avm1.md, "Objects").
//
// An object keeps its properties in a Map by their exact names, in the
// order they were added, which is Flash's order of enumeration reversed.
// A SWF up to 6 finds names whatever their case: it asks the exact name
// first, as code mostly spells a name one way, then the name folded to
// lower case, and else an index of the names folding changes, which an
// object builds the first time such a lookup misses and keeps from then
// on: none while all its names are lower case. A SWF from 7 never needs it.
// `__proto__` is a property like any other, which the object also keeps
// at hand for the walks up its prototypes.
//
// An array keeps its elements apart, by index in a JavaScript array, while
// they are 0 to n - 1 each there, as arrays mostly are: a read or write of
// an element by its number, and Array's methods, then need no Map and no
// name. A hole, an element deleted from the middle or set past the end,
// moves them all into the Map. Each property has its sequence number, the
// order of its adding, which for..in lists in, elements among the rest.
import { lowerCase } from "./case.js";
import { Avm1Throw } from "./errors.js";
import { ABSENT, type DisplayNative } from "./host.js";
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
// 0x400 alone hides a property from SWF 5 and 6, and leaves it to hasOwnProperty,
// which 0x100 would hide it from (adl, the corpus's global_proto_decls).
export const VERSION_7 = 0x400;
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

/** The code units folding may change. */
const FOLDED = /[A-Z\u0080-\uffff]/g;

/** Names folded by Flash's lower case, once each, as the same names come back. */
const foldCache = new Map<string, string>();

/**
 * A name as a SWF up to 6 compares it: each code unit folded to Flash's
 * lower case (`case.ts`), which is not JavaScript's: `ΑΣ` and `ασ`
 * are one name, `İ` and `i` too, `ẞ` and `ß` are not.
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
    folded = name.replace(FOLDED, (c) => String.fromCharCode(lowerCase(c.charCodeAt(0))));
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

/** The sequence number the next property added takes. */
let added = 0;

/** A property: a value, or a getter and maybe a setter (addProperty), and its attributes. */
export class Property {
  get: Avm1Object | null = null;
  set: Avm1Object | null = null;
  /** How many calls of its getter, setter or watcher are running, for the recursion limit. */
  calls = 0;
  /** When it was added: for..in lists an object's properties in this order, reversed. */
  seq = added++;

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
  /** How many of its calls are running, where the name has no property to count them. */
  calls: number;
}

/**
 * How many calls of a property's getter, setter or watcher may run at once,
 * one inside another, for a SWF of `version`: past that the getter gives
 * the stored value and the setter and watcher are skipped. A SWF up to 6
 * runs none inside another (adl, the corpus's `*_recursion_swf6`).
 */
const propertyCalls = (version: number): number => (version > 6 ? 65 : 1);

/**
 * What a function's activation object makes as it is first asked for:
 * `arguments` and `super`, which most functions never read.
 */
export interface LazyLocals {
  local(o: Avm1Object, name: string, version: number): Property | undefined;
}

/** A native function: `self` is an object (a primitive boxed), as Flash gives natives. */
export type Native = (self: Avm1Object, args: Value[], version: number) => Value;

/**
 * A native that takes `this` as it is, a primitive unboxed: String's
 * methods, which would otherwise box every string they are called on.
 */
export type RawNative = (self: Value, args: Value[], version: number) => Value;

/** Boxing primitives as natives' `this`: the realm's. */
export interface Boxer {
  box(value: Value, version: number): Avm1Object;
}

/**
 * `name` as an index of an array's elements: digits with no leading zero
 * (`0` itself, `12`, not `012` nor `1.0`), -1 for any other name.
 */
export function elementIndex(name: string): number {
  const n = name.length;
  if (n === 0 || n > 10) {
    return -1;
  }

  let index = name.charCodeAt(0) - 0x30;
  if (index < 0 || index > 9 || (index === 0 && n > 1)) {
    return -1;
  }

  for (let i = 1; i < n; i++) {
    const d = name.charCodeAt(i) - 0x30;
    if (d < 0 || d > 9) {
      return -1;
    }

    index = index * 10 + d;
  }

  return index;
}

const bySeq = (a: Property, b: Property) => a.seq - b.seq;

/** The index of an object none of whose names folding changes, shared. */
const UNCHANGED = new Map<string, Property>();

export class Avm1Object {
  /**
   * What node's inspector shows: an object reaches the whole realm, so a
   * failed assertion that printed it in full ran a test to tens of gigabytes.
   */
  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return `Avm1Object(${this.props.size} properties)`;
  }

  /** By exact name, in the order they were added. */
  readonly props = new Map<string, Property>();
  /**
   * By folded name, the first added of each name folding changes, once a
   * SWF up to 6 needs it; UNCHANGED while there is none.
   */
  private folded: Map<string, Property> | null = null;
  /** The property named `__proto__`, if any. */
  private protoProp: Property | null = null;
  /** By the name each watches, as set. */
  watchers: Watcher[] | null = null;
  /** Whether it is an array, whose `length` follows its elements: what Array's constructor makes. */
  array = false;
  /**
   * An array's elements by index while each of 0 to n - 1 is there, none
   * of them in `props`; null once one is missing, and for any other object.
   */
  elems: Property[] | null = null;
  /**
   * The primitive a String, Number or Boolean object boxes, a Date's
   * DateCell, undefined for any other.
   */
  primitive: Value = undefined;
  /** A function's activation object's `arguments` and `super`, until it has made them. */
  lazy: LazyLocals | null = null;
  /** A prototype's interfaces' prototypes, which ImplementsOp gives it, for InstanceOf. */
  interfaces: Avm1Object[] | null = null;
  /** A display object's side, where it is a clip's, a button's or a text field's AVM1 object (host.ts). */
  display: DisplayNative | null = null;

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

  /** The own property of exactly `name`, an element or in `props`. */
  exact(name: string): Property | undefined {
    const elems = this.elems;
    if (elems !== null) {
      const i = elementIndex(name);
      if (i >= 0) {
        return i < elems.length ? elems[i] : undefined;
      }
    }

    return this.props.get(name);
  }

  /** The own property `name` names for a SWF of `version`, whatever its attributes. */
  own(name: string, version: number): Property | undefined {
    const p = this.exact(name);
    if (p !== undefined) {
      return p;
    }

    if (this.lazy !== null) {
      const made = this.lazy.local(this, name, version);
      if (made !== undefined) {
        return made;
      }
    }

    return version > 6 ? undefined : this.ownFolded(name, fold(name));
  }

  /**
   * The own property a SWF up to 6 finds for `name`, folded `key`, once
   * the exact name missed: the one spelt `key`, else the first added
   * whose name folds to it.
   */
  ownFolded(name: string, key: string): Property | undefined {
    if (key !== name) {
      const p = this.props.get(key);
      if (p !== undefined) {
        return p;
      }
    }

    const folded = this.folded ?? this.index();
    return folded === UNCHANGED ? undefined : folded.get(key);
  }

  /**
   * Set `name` to a value with `flags`, as a builtin is defined: in its
   * case, replacing what it had, a getter included, where it was.
   */
  define(name: string, value: Value, flags: number): Property {
    const p = this.exact(name);
    if (p !== undefined) {
      p.value = value;
      p.flags = flags;
      p.get = null;
      p.set = null;
      return p;
    }

    return this.add(name, value, flags);
  }

  /** A new property, last in the order: the prototype where `proto`. */
  add(name: string, value: Value, flags: number, proto = name === "__proto__"): Property {
    const p = new Property(name, value, flags);
    const elems = this.elems;
    if (elems !== null) {
      const i = elementIndex(name);
      if (i === elems.length) {
        elems.push(p);
        return p;
      }

      if (i >= 0) {
        this.sparse();
      }
    }

    this.props.set(name, p);
    if (proto) {
      this.protoProp = p;
    } else if (name.length === 9 && !resolvers && fold(name) === "__resolve") {
      resolvers = true;
    }

    const folded = this.folded;
    if (folded !== null) {
      const key = fold(name);
      if (key === name) {
        return p;
      }

      if (folded === UNCHANGED) {
        this.folded = new Map([[key, p]]);
      } else if (!folded.has(key)) {
        folded.set(key, p);
      }
    }

    return p;
  }

  remove(p: Property): void {
    const elems = this.elems;
    if (elems !== null) {
      const i = elementIndex(p.name);
      if (i >= 0 && i < elems.length && elems[i] === p) {
        if (i === elems.length - 1) {
          elems.pop();
          return;
        }

        this.sparse();
      }
    }

    this.props.delete(p.name);
    if (p === this.protoProp) {
      this.protoProp = null;
    }

    const folded = this.folded;
    if (folded === null || folded === UNCHANGED) {
      return;
    }

    const key = fold(p.name);
    if (folded.get(key) === p) {
      folded.delete(key);
      for (const other of this.props.values()) {
        if (other.name !== key && fold(other.name) === key) {
          folded.set(key, other);
          break;
        }
      }
    }
  }

  /** Its own properties in the order they were added: its elements among the rest. */
  ownProperties(): Property[] {
    const own = [...this.props.values()];
    const elems = this.elems;
    if (elems === null || elems.length === 0) {
      return own;
    }

    for (const p of elems) {
      own.push(p);
    }

    return own.sort(bySeq);
  }

  /**
   * An own property set as Array's methods set an element they delete
   * first: its value, no attributes, last in the order.
   */
  renew(p: Property, value: Value): void {
    p.value = value;
    p.flags = 0;
    p.get = null;
    p.set = null;
    p.seq = added++;
  }

  /** Its elements moved into `props`, as a hole needs: in the order they were added. */
  sparse(): void {
    const elems = this.elems;
    if (elems === null) {
      return;
    }

    this.elems = null;
    if (elems.length === 0) {
      return;
    }

    const all = [...this.props.values(), ...elems].sort(bySeq);
    this.props.clear();
    for (const p of all) {
      this.props.set(p.name, p);
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
    return this.display === null ? "object" : this.display.type;
  }

  private index(): Map<string, Property> {
    let folded = UNCHANGED;
    for (const p of this.props.values()) {
      const key = fold(p.name);
      if (key === p.name) {
        continue;
      }

      if (folded === UNCHANGED) {
        folded = new Map();
      }

      if (!folded.has(key)) {
        folded.set(key, p);
      }
    }

    this.folded = folded;
    return folded;
  }
}

/**
 * A function. Natives are TypeScript; one called with `new` runs
 * `construct` where it has one, as Flash's native constructors (Object,
 * Array...) do otherwise than when called. Those DefineFunction makes are
 * functions.ts's ScriptFunction.
 */
export class Avm1Function extends Avm1Object {
  constructor(
    proto: Value,
    readonly realm: Boxer,
    readonly native: Native,
    readonly construct: Native | null = null,
    /** Whether `native` takes `this` unboxed, a RawNative. */
    readonly raw = false,
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

  /**
   * Call it with `self` as `this`; `depth`, how far up `this`'s prototypes
   * it was found, is what `super` starts from in a ScriptFunction.
   */
  call(self: Value, args: Value[], version: number, _depth = 0): Value {
    return this.raw
      ? (this.native as RawNative)(self, args, version)
      : this.native(this.realm.box(self, version), args, version);
  }

  /** Run it on `self`, the object `new` made, where it has no `construct`. */
  initialize(self: Avm1Object, args: Value[], version: number): void {
    this.native(self, args, version);
  }

  /** Run it as a constructor of `self`, made already, as `super()` runs its class's. */
  callConstructor(self: Avm1Object, args: Value[], version: number, _depth: number): Value {
    return (this.construct ?? this.native)(self, args, version);
  }
}

/** Call `fn` if it is a function; anything else gives undefined, as Flash does. */
export function invoke(fn: Value, self: Value, args: Value[], version: number, depth = 0): Value {
  return fn instanceof Avm1Function ? fn.call(self, args, version, depth) : undefined;
}

/** How far up its object's prototypes `get` found what it gave last, a getter's value too: 0 its own. */
export let foundDepth = 0;

/** The deepest a prototype chain is walked, as Ruffle stops: no further. */
const DEPTH = 255;

/**
 * What `find` gives for a display object's child or property, one object
 * reused, as each name a script resolves on a clip comes through it: its
 * callers read it at once, keep none and let go of its value
 * (`foundValue`, `has`).
 */
const displayFound = new Property("", undefined, DONT_ENUM);

/**
 * The first own property `name` names on `o` or its prototypes, whatever
 * its attributes: whether the name is there, as the scope chain asks.
 */
export function find(o: Avm1Object, name: string, version: number): Property | undefined {
  let key: string | null = null;
  let p: Value = o;
  for (let depth = 0; p instanceof Avm1Object && depth < DEPTH; depth++) {
    let own = p.exact(name);
    if (own === undefined && p.lazy !== null) {
      own = p.lazy.local(p, name, version);
    }

    if (own === undefined && version <= 6) {
      key ??= fold(name);
      own = p.ownFolded(name, key);
    }

    if (own !== undefined) {
      return own;
    }

    // A display object's children and properties, after its own (Ruffle's has_property).
    if (p.display !== null) {
      const value = p.display.get(name, version);
      if (value !== ABSENT) {
        displayFound.value = value;
        return displayFound;
      }
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
  let key: string | null = null;
  let p: Value = o;
  for (let depth = 0; p instanceof Avm1Object && depth < DEPTH; depth++) {
    let own = p.exact(name);
    if (own === undefined && p.lazy !== null) {
      own = p.lazy.local(p, name, version);
    }

    if (own === undefined && version <= 6) {
      key ??= fold(name);
      own = p.ownFolded(name, key);
    }

    if (own !== undefined && allowed(own.flags, version)) {
      if (own.get === null || own.calls >= propertyCalls(version)) {
        foundDepth = depth;
        return own.value;
      }

      // Where the getter was found, not where its own lookups were.
      const value = callGetter(own, self, version);
      foundDepth = depth;
      return value;
    }

    if (own === undefined && p.display !== null) {
      const value = p.display.get(name, version);
      if (value !== ABSENT) {
        foundDepth = depth;
        return value;
      }
    }

    p = p.protoFor(version);
  }

  foundDepth = 0;
  return resolving && resolvers ? resolve(o, name, version, self) : undefined;
}

function callGetter(p: Property, self: Value, version: number): Value {
  p.calls++;
  try {
    return invoke(p.get, self, [], version, 1);
  } finally {
    p.calls--;
  }
}

/** A setter's call, unless as many of the property's calls are running as may (propertyCalls). */
function callSetter(p: Property, setter: Avm1Object, self: Value, value: Value, version: number) {
  if (p.calls >= propertyCalls(version)) {
    return;
  }

  p.calls++;
  try {
    invoke(setter, self, [value], version, 1);
  } finally {
    p.calls--;
  }
}

/**
 * A missing name's value: the first `__resolve` on the chain that holds an
 * object, called with the name; a primitive one is skipped, and an object
 * that is no function gives undefined.
 */
function resolve(o: Avm1Object, name: string, version: number, self: Value): Value {
  let p: Value = o;
  for (let depth = 0; p instanceof Avm1Object && depth < DEPTH; depth++) {
    // adl calls a `__resolve` its version bits hide.
    // A clip is skipped as a primitive is (the corpus's `object_resolve`).
    const own = p.own("__resolve", version);
    if (
      own !== undefined &&
      own.value instanceof Avm1Object &&
      own.value.typeOf() !== "movieclip"
    ) {
      return invoke(own.value, self, [name], version);
    }

    p = p.protoFor(version);
  }

  return undefined;
}

/**
 * What the watcher of `name` on `o` gives for a set of `value` over `old`,
 * `value` where it has none, or where as many of its calls run as may.
 */
export function watched(
  o: Avm1Object,
  name: string,
  old: Value,
  value: Value,
  version: number,
): Value {
  const w = o.watcher(name, version);
  if (w === undefined) {
    return value;
  }

  // The calls count on the property, the getter's and setter's with them, else on the watcher.
  const own = o.own(name, version);
  const count = own ?? w;
  if (count.calls >= propertyCalls(version)) {
    return value;
  }

  count.calls++;
  try {
    // adl names the property as it was first set, where there is one (`FOO` sets `foo`).
    return invoke(w.callback, o, [own?.name ?? name, old, value, w.data], version);
  } finally {
    count.calls--;
  }
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

  // adl changes an array's `length`, telling its watcher, before the set's own watcher is told.
  const early = o.array && o.watchers !== null;
  if (early && virtual(o, name, version) === undefined) {
    arraySet(o, name, value, version);
  }

  if (o.watchers !== null) {
    try {
      value = watched(o, name, stored(o, name, version), value, version);
    } catch (error) {
      if (!(error instanceof Avm1Throw)) {
        throw error;
      }

      // A watcher that throws sets undefined, then the value is thrown (adl).
      store(o, name, undefined, version, early);
      throw error;
    }
  }

  store(o, name, value, version, early);
}

/**
 * A set past the watcher: the setter, or the value stored; an array's
 * `length` changed with it unless `early`, before the watcher, did.
 */
function store(o: Avm1Object, name: string, value: Value, version: number, early: boolean): void {
  o.display?.changed?.(name, value, version);
  const own = o.own(name, version);
  // A display property takes the value where the object has no property of the name (Ruffle's set_local).
  if (own === undefined && o.display !== null && o.display.set(name, value, version)) {
    return;
  }

  if (own === undefined) {
    const v = virtual(o, name, version);
    if (v !== undefined) {
      if (v.set !== null) {
        callSetter(v, v.set, o, value, version);
      }

      return;
    }
  }

  if (o.array && !early) {
    arraySet(o, name, value, version);
  }

  if (own === undefined) {
    // Up to SWF 6, `__PROTO__` is the prototype too, where there is no `__proto__`.
    o.add(name, value, 0, version > 6 ? name === "__proto__" : fold(name) === "__proto__");
    return;
  }

  if (own.set !== null) {
    callSetter(own, own.set, o, value, version);
  }

  // A value set over a builtin's shows it to every version; but adl's SWF 6 keeps bit 0x400.
  if ((own.flags & READ_ONLY) === 0) {
    own.value = value;
    own.flags &= version === 6 ? ~VERSION_BITS | 0x400 : ~VERSION_BITS;
  }
}

/** The first getter on the prototypes of `o` that a set of `name` goes to, where `o` has no `name`. */
function virtual(o: Avm1Object, name: string, version: number): Property | undefined {
  if (o.own(name, version) !== undefined) {
    return undefined;
  }

  let p: Value = o.protoFor(version);
  for (let depth = 0; p instanceof Avm1Object && depth < DEPTH; depth++) {
    const v = p.own(name, version);
    if (v !== undefined && v.get !== null && allowed(v.flags, version)) {
      return v;
    }

    p = p.protoFor(version);
  }

  return undefined;
}

/**
 * An array's `length` as a set changes it: elements past a shorter one go,
 * an index past it grows it. Under a watcher, adl sets `length` twice, as
 * the array and then as the set: the watcher is told of both, the first
 * one's value is the length cut to and kept, the second's what is stored.
 */
export function arraySet(a: Avm1Object, name: string, value: Value, version: number): void {
  if ((caseSensitive(version) ? name : fold(name)) === "length") {
    const p = a.props.get("length");
    const old = p?.value;
    if (a.watchers !== null) {
      watched(a, "length", old, value, version);
    }

    if (typeof old === "number") {
      truncate(a, toNumber(value, version) | 0, old | 0);
    }

    if (a.watchers !== null && p !== undefined && (p.flags & READ_ONLY) === 0) {
      p.value = value;
    }

    return;
  }

  const index = arrayIndex(name, version);
  if (index !== null && index >= lengthOf(a)) {
    growTo(a, (index + 1) | 0, version);
  }
}

/**
 * An array's `length` grown to `length` by an element set past it, its
 * watcher told, though what it gives is not kept (adl); past 2^31 - 1 the
 * int wraps, shorter, and deletes.
 */
export function growTo(a: Avm1Object, length: number, version: number): void {
  const p = a.props.get("length");
  if (a.watchers !== null) {
    watched(a, "length", p === undefined ? undefined : p.value, length, version);
  }

  if (length < 0 && p !== undefined && typeof p.value === "number") {
    truncate(a, length, p.value | 0);
  }

  if (p === undefined) {
    a.add("length", length, 0);
  } else {
    p.value = length;
  }
}

/**
 * The elements of `a` from `length` to `old` deleted, as a shorter
 * `length` deletes them; those that cannot be deleted stay.
 */
export function truncate(a: Avm1Object, length: number, old: number): void {
  const from = Math.max(length, 0);
  if (old <= from) {
    return;
  }

  let i = old - 1;
  const elems = a.elems;
  if (elems !== null) {
    // No index past a dense array's elements is there.
    i = Math.min(i, elems.length - 1);
    while (i >= from && a.elems !== null) {
      const p = a.elems[i];
      if ((p.flags & DONT_DELETE) === 0) {
        a.remove(p);
      }

      i--;
    }
  }

  if (i < from) {
    return;
  }

  // Past what the object holds, its names are fewer than the indices.
  if (i - from > a.props.size) {
    for (const p of [...a.props.values()]) {
      const index = elementIndex(p.name);
      if (index >= from && index <= i && (p.flags & DONT_DELETE) === 0) {
        a.remove(p);
      }
    }

    return;
  }

  for (; i >= from; i--) {
    const p = a.props.get(String(i));
    if (p !== undefined && (p.flags & DONT_DELETE) === 0) {
      a.remove(p);
    }
  }
}

/** An array's own `length`, as an int, converted as a SWF of `version` converts it. */
export function lengthOf(o: Avm1Object, version = 7): number {
  const length = o.props.get("length")?.value;
  return typeof length === "number" ? length | 0 : toNumber(length, version) | 0;
}

/**
 * A name as an array index, as adl reads one: spaces, a sign and digits,
 * wrapped to 32 bits; a SWF up to 6 takes them before anything else
 * (`3abc` and `1.9` are 3 and 1), a later one only alone. Null for none.
 */
function arrayIndex(name: string, version: number): number | null {
  const n = name.length;
  let i = 0;
  for (; i < n; i++) {
    const c = name.charCodeAt(i);
    if (c !== 0x20 && (c < 0x09 || c > 0x0d)) {
      break;
    }
  }

  const negative = name.charCodeAt(i) === 0x2d;
  if (negative || name.charCodeAt(i) === 0x2b) {
    i++;
  }

  const start = i;
  let index = 0;
  for (; i < n; i++) {
    const d = name.charCodeAt(i) - 0x30;
    if (d < 0 || d > 9) {
      break;
    }

    index = (Math.imul(index, 10) + d) | 0;
  }

  if (i === start || (i < n && version > 6)) {
    return null;
  }

  return negative ? -index | 0 : index;
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

  const own = o.ownProperties();
  for (let i = own.length - 1; i >= 0; i--) {
    if ((own[i].flags & DONT_ENUM) === 0) {
      out.push(own[i].name);
    }
  }

  // A clip's children last, by depth, the highest first.
  if (o.display !== null) {
    o.display.keys(out);
  }

  return out;
}

/** Whether `name` is on `o` or its prototypes, whatever its attributes. */
export function has(o: Avm1Object, name: string, version: number): boolean {
  const found = find(o, name, version) !== undefined;
  displayFound.value = undefined;
  return found;
}

/**
 * The value of `p`, which `find` found for `name` on `o`, as the scope
 * chain reads it: a plain one's own, else as `get` gives it. The reused
 * display property lets go of its value, a clip's AVM1 object perhaps.
 */
export function foundValue(p: Property, o: Avm1Object, name: string, version: number): Value {
  if (p === displayFound) {
    const value = p.value;
    p.value = undefined;
    return value;
  }

  return p.get === null && allowed(p.flags, version) ? p.value : get(o, name, version);
}

/** `name` as a property's name: the string a value converts to. */
export const nameOf = (value: Value, version: number): string =>
  typeof value === "string" ? value : stringOf(value, version);
