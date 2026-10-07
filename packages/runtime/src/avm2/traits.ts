// The layout model: an object's traits, its bindings and slots as the
// module's descriptor gives them, and the references by which a module
// names a class or a Vector type before it exists.

import type {
  AsObject,
  ClassDesc,
  Metadata,
  Signature,
  TraitsDesc,
  TypeRef,
  Value,
} from "./descriptors.js";
import type { IndexHook, PropertyHook } from "./hooks.js";
import type { Multiname, Namespace } from "./names.js";
import { invalidate } from "./property-cache.js";
import type { Domain } from "./runtime.js";

// Binding kinds, as the compiler encodes them: kind | id << 3.
export const BIND_Method = 1;
export const BIND_Var = 2;
export const BIND_Const = 3;
export const BIND_Get = 5;
export const BIND_Set = 6;
export const BIND_GetSet = 7;

/**
 * Set class `cls`'s own static variable `name`, in whatever namespace, to
 * `value`: for a class hook setting what the VM keeps there, as a private
 * static the class reads.
 */
export function setStaticVar(cls: AsObject, name: string, value: Value): void {
  for (const [, , n, b] of (cls.$desc as ClassDesc).static.bindings) {
    if (n === name && (b & 7) === BIND_Var) {
      cls[`$${b >> 3}`] = value;
    }
  }
}

/** Trait kinds as the ABC has them, which the descriptors' metadata is keyed by. */
const TRAIT_Slot = 0;
const TRAIT_Getter = 2;
const TRAIT_Setter = 3;
const TRAIT_Class = 4;
const TRAIT_Const = 6;

interface Binding {
  ns: Namespace;
  version: number;
  value: number;
}

/**
 * The traits of an object: its own bindings by local name, and its own
 * slots' types and initial values; lookups continue in the base's, as
 * avmplus' do, so a base described after its subclass was made (Object,
 * Class and Function, during the bootstrap) is still seen.
 */
export class Traits {
  bindings = new Map<string, Binding[]>();
  slotTypes: TypeRef[] = [];
  own: [string, Value][] = [];
  /** Every slot field and its initial value, the base's first, once an instance is made. */
  private allDefaults: [string, Value][] | null = null;
  /** The JavaScript prototype of objects with these traits. */
  proto: AsObject;
  /** The class whose instances these are the traits of, once it exists. */
  cls: AsObject | null = null;
  interfaces = new Set<Traits>();
  dynamic = false;
  /** Whether it is a script's global object's, as System.isGlobal asks. */
  isGlobal = false;
  /**
   * Whether a dynamic class's instances refuse any name but their own and
   * an index, getting it or setting it, as a Vector's do: they delete one,
   * or have one in, as any dynamic object, which it never has.
   */
  refusesNames = false;
  /** How to allocate an instance, for classes whose instances hold native state. */
  create: ((traits: Traits) => AsObject) | null;
  /** How its instances resolve the names it does not bind, if not as dynamic properties. */
  properties: PropertyHook | null = null;
  /** Its own slots with [Transient] metadata, if any. */
  transientSlots: Set<number> | null = null;
  /** Its own accessors with metadata, if any, by dispatch id: whether any of it is [Transient]. */
  accessorMetadata: Map<number, boolean> | null = null;
  /** Its own methods' signatures, by dispatch id, for describeType. */
  signatures = new Map<number, Signature>();
  /** Its own slots' and methods' metadata, by slot id and by dispatch id, for describeType. */
  slotMetadata: Map<number, Metadata[]> | null = null;
  methodMetadata: Map<number, Metadata[]> | null = null;
  /** The class's: whether it is final or an interface, its constructor's parameters, its own metadata. */
  final = false;
  isInterface = false;
  /** The ABC that defines the class, whether it is restricted, and whether that makes it one nothing constructs. */
  abc: object | null = null;
  restricted = false;
  uninstantiable = false;
  ctor: [TypeRef[], number] | null = null;
  metadata: Metadata[] | null = null;
  getIndex?: IndexHook["getIndex"];
  setIndex?: IndexHook["setIndex"];
  hasIndex?: IndexHook["hasIndex"];
  index?: IndexHook["index"];

  constructor(
    readonly name: string,
    readonly base: Traits | null,
    proto?: AsObject,
  ) {
    this.proto = proto ?? Object.create(base ? base.proto : null);
    this.proto.$traits = this;
    this.create = base ? base.create : null;
    this.properties = base ? base.properties : null;
    this.getIndex = base?.getIndex;
    this.setIndex = base?.setIndex;
    this.hasIndex = base?.hasIndex;
    this.index = base?.index;
    if (base) {
      for (const i of base.interfaces) {
        this.interfaces.add(i);
      }
    }
  }

  /** Add a traits' own bindings and slots from its descriptor. */
  describe(desc: TraitsDesc): void {
    invalidate();
    for (const [ns, version, name, value] of desc.bindings) {
      let list = this.bindings.get(name);
      if (!list) {
        list = [];
        this.bindings.set(name, list);
      }

      list.push({ ns, version, value });
    }

    for (const [slot, value, type] of desc.defaults) {
      this.slotTypes[slot] = type;
      this.own.push([slotKey(slot), value]);
    }

    for (const [d, , , returnType, params, required] of desc.methods) {
      this.signatures.set(d, [returnType, params, required]);
    }

    if (desc.meta) {
      this.annotate(desc.meta);
    }

    this.allDefaults = null;
  }

  /**
   * Keep the traits' metadata, and what AMF and JSON ask of it: the slots
   * with [Transient], and for each accessor with metadata whether any of
   * it is [Transient], since an accessor's metadata hides its base's, as
   * avmplus' getMethodMetadataPos finds it.
   */
  private annotate(meta: [number, number, Metadata[]][]): void {
    const transient = (entries: Metadata[]) => entries.some(([name]) => name === "Transient");
    for (const [kind, id, entries] of meta) {
      if (kind === TRAIT_Slot || kind === TRAIT_Const || kind === TRAIT_Class) {
        this.slotMetadata ??= new Map();
        this.slotMetadata.set(id, entries);
        if (transient(entries)) {
          this.transientSlots ??= new Set();
          this.transientSlots.add(id);
        }
      } else {
        this.methodMetadata ??= new Map();
        this.methodMetadata.set(id, entries);
        if (kind === TRAIT_Getter || kind === TRAIT_Setter) {
          this.accessorMetadata ??= new Map();
          this.accessorMetadata.set(id, transient(entries));
        }
      }
    }
  }

  /**
   * Whether the member binding `b` names is [Transient], which AMF and
   * JSON leave out: a slot, or either accessor of a pair, whose metadata,
   * found as avmplus' TraitsMetadata finds it, has it.
   */
  isTransient(b: number): boolean {
    const kind = b & 7;
    const id = b >> 3;
    if (kind === BIND_Var || kind === BIND_Const) {
      for (let t: Traits | null = this; t; t = t.base) {
        if (t.transientSlots?.has(id)) {
          return true;
        }
      }

      return false;
    }

    return (
      ((kind === BIND_Get || kind === BIND_GetSet) && this.transientAccessor(id)) ||
      ((kind === BIND_Set || kind === BIND_GetSet) && this.transientAccessor(id + 1))
    );
  }

  /** Whether accessor `id`'s metadata, the nearest traits' that has any, is [Transient]. */
  private transientAccessor(id: number): boolean {
    for (let t: Traits | null = this; t; t = t.base) {
      const transient = t.accessorMetadata?.get(id);
      if (transient !== undefined) {
        return transient;
      }
    }

    return false;
  }

  /** The type of slot `id`, declared here or by a base. */
  slotType(id: number): TypeRef {
    for (let t: Traits | null = this; t; t = t.base) {
      if (id in t.slotTypes) {
        return t.slotTypes[id];
      }
    }

    return null;
  }

  /** The binding `mn` names, or 0: the first of its namespaces that binds it at its version. */
  find(mn: Multiname): number {
    const name = mn.name;
    if (name === null) {
      return 0;
    }

    const namespaces = mn.namespaces;
    for (let t: Traits | null = this; t; t = t.base) {
      const list = t.bindings.get(name);
      if (!list) {
        continue;
      }

      // Indexes, not for-of: compiled code looks its names up here.
      for (let i = 0; i < namespaces.length; i++) {
        const ns = namespaces[i];
        for (let k = 0; k < list.length; k++) {
          const b = list[k];
          if (b.ns === ns && b.version <= mn.versions[i]) {
            return b.value;
          }
        }
      }
    }

    return 0;
  }

  /** A new object with these traits, its slots at their initial values. */
  instance(): AsObject {
    const o = this.create ? this.create(this) : Object.create(this.proto);
    o.$d = this.dynamic ? new Map() : null;
    if (!this.allDefaults) {
      this.allDefaults = this.base ? [...this.base.defaultsOf(), ...this.own] : this.own.slice();
    }

    const defaults = this.allDefaults;
    for (let i = 0; i < defaults.length; i++) {
      o[defaults[i][0]] = defaults[i][1];
    }

    return o;
  }

  defaultsOf(): [string, Value][] {
    return this.allDefaults ?? (this.base ? [...this.base.defaultsOf(), ...this.own] : this.own);
  }

  /**
   * Interfaces named by a class made before them, as a script may define a
   * class before an interface it implements: each gives the interface's
   * traits once its class exists, or null before. avmplus takes interfaces
   * from traits, which exist from loading; these are settled when a type
   * test first needs them.
   */
  pendingInterfaces: (() => Traits | null)[] | null = null;

  /** Add the interfaces now made that were pending, here and in the bases. */
  settleInterfaces(): void {
    for (let c: Traits | null = this; c; c = c.base) {
      const pending = c.pendingInterfaces;
      if (!pending) {
        continue;
      }

      c.pendingInterfaces = pending.filter((get) => {
        const iface = get();
        if (!iface) {
          return true;
        }

        iface.settleInterfaces();
        c.interfaces.add(iface);
        for (const i of iface.interfaces) {
          c.interfaces.add(i);
        }

        return false;
      });
      if (!c.pendingInterfaces.length) {
        c.pendingInterfaces = null;
      }
    }
  }

  isSubtypeOf(t: Traits): boolean {
    for (let c: Traits | null = this; c; c = c.base) {
      if (c === t) {
        return true;
      }
    }

    if (this.interfaces.has(t)) {
      return true;
    }

    // An interface a base settled after this class copied its interfaces.
    this.settleInterfaces();
    for (let c: Traits | null = this; c; c = c.base) {
      if (c.interfaces.has(t)) {
        return true;
      }
    }

    return false;
  }
}

/** A class named in a module, resolved the first time it is needed. */
export class ClassRef {
  cls: AsObject | null = null;
  /** Its instances' traits, once coerceTo has found them. */
  traits: Traits | null = null;

  constructor(
    readonly ns: Namespace,
    readonly name: string,
    /** The domain its module was loaded into, which it is resolved in. */
    readonly domain: Domain,
  ) {}
}

/** Vector.<T>, resolved the first time it is needed. */
export class VectorRef {
  cls: AsObject | null = null;
  /** Its instances' traits, once coerceTo has found them. */
  traits: Traits | null = null;

  constructor(readonly param: TypeRef) {}
}

// The names of slot and method properties by id, made once each, for the
// runtime's dynamic paths; generated code names them itself.
const slotKeys: string[] = [];
const methodKeys: string[] = [];
export const slotKey = (id: number): string => (slotKeys[id] ??= `$${id}`);
export const methodKey = (id: number): string => (methodKeys[id] ??= `$m${id}`);
