// Namespaces and multinames, as generated modules describe them.
//
// Namespaces are interned by kind and URI across modules, as the compiler
// interns them, so two modules' `public` are one object and names compare by
// identity. A private namespace is only ever equal to itself.

import { NO_CACHE, type PropertyCache } from "./property-cache.js";
import type { Domain } from "./runtime.js";

/** Namespace kinds, numbered as the compiler's NS_* constants. */
export const NS_Public = 0;
export const NS_PackageInternal = 1;
export const NS_Protected = 2;
export const NS_Explicit = 3;
export const NS_StaticProtected = 4;
export const NS_Private = 5;

export class Namespace {
  constructor(
    readonly kind: number,
    /** null for a namespace without a URI (the any namespace). */
    readonly uri: string | null,
    /**
     * E4X's prefix, undefined for none, as a Namespace value can have one.
     * A namespace with a prefix is not interned: names look it up as the
     * interned one of its kind and URI (see interned).
     */
    readonly prefix: string | undefined = undefined,
  ) {}

  /** The namespace names look this one up as: this one, or without its prefix, interned. */
  get interned(): Namespace {
    return this.prefix === undefined ? this : namespace(this.kind, this.uri);
  }
}

/** The interned namespaces, by kind, then URI: null, the any namespace, is not "null". */
const interned: Map<string | null, Namespace>[] = [];

/** The namespace of `kind` and `uri`, the same object each time. */
export function namespace(kind: number, uri: string | null): Namespace {
  let byUri = interned[kind];
  if (!byUri) {
    byUri = new Map();
    interned[kind] = byUri;
  }

  let ns = byUri.get(uri);
  if (!ns) {
    ns = new Namespace(kind, uri);
    byUri.set(uri, ns);
  }

  return ns;
}

export const publicNs = namespace(NS_Public, "");

/**
 * A public Namespace value of `uri` with `prefix`, as E4X makes one: with
 * no prefix, or the empty one for the empty URI, the interned namespace.
 */
export function prefixedNamespace(prefix: string | undefined, uri: string): Namespace {
  if (prefix === undefined || (prefix === "" && uri === "")) {
    return namespace(NS_Public, uri);
  }

  return new Namespace(NS_Public, uri, prefix);
}

/** A Namespace value's prefix, as avmplus has it: the empty URI's is "", else undefined unless given. */
export function prefixOf(ns: Namespace): string | undefined {
  return ns.prefix ?? (ns.uri === "" ? "" : undefined);
}

// Multiname kinds, as the ABC numbers them.
export const CONSTANT_Qname = 0x07;
export const CONSTANT_QnameA = 0x0d;
export const CONSTANT_RTQname = 0x0f;
export const CONSTANT_RTQnameA = 0x10;
export const CONSTANT_RTQnameL = 0x11;
export const CONSTANT_RTQnameLA = 0x12;
export const CONSTANT_Multiname = 0x09;
export const CONSTANT_MultinameA = 0x0e;
export const CONSTANT_MultinameL = 0x1b;
export const CONSTANT_MultinameLA = 0x1c;
export const CONSTANT_TypeName = 0x1d;

/**
 * A name as a property lookup uses it: its namespaces, each with the API
 * version it sees bindings at, and its local name, null for any name.
 */
export class Multiname {
  /**
   * The object a runtime name was, which a Dictionary keys by itself; its
   * name is the object's string for any other. Declared, so that every
   * multiname has the same shape.
   */
  key: unknown = undefined;
  /** The local name, or undefined until a key's is first needed. */
  private local: string | null | undefined;
  /** How a key's name is made, as the object's string, when a lookup first needs it. */
  private nameOf: ((key: unknown) => string) | null = null;
  /**
   * The application domain whose definitions the name is looked up in: its
   * module's, or the one of the name it was made from; null for the root.
   */
  domain: Domain | null = null;
  /** What its lookups found, for a module's name (property-cache.ts); a name made at run time keeps none. */
  cache: PropertyCache = NO_CACHE;

  constructor(
    readonly kind: number,
    /** Its namespaces; one of null, as a Qname's, is any namespace. */
    readonly namespaces: (Namespace | null)[],
    readonly versions: number[],
    name: string | null,
    readonly attribute: boolean,
  ) {
    this.local = name;
  }

  /**
   * A runtime name that was an object: a Dictionary keys by the object
   * itself, and anything else by its string, which is made only then, as
   * avmplus converts it only for an object that is not a Dictionary.
   */
  static keyed(
    kind: number,
    namespaces: (Namespace | null)[],
    versions: number[],
    key: object,
    attribute: boolean,
    nameOf: (key: unknown) => string,
  ): Multiname {
    const mn = new Multiname(kind, namespaces, versions, null, attribute);
    mn.key = key;
    mn.local = undefined;
    mn.nameOf = nameOf;
    return mn;
  }

  /** The local name, null for any name. */
  get name(): string | null {
    const local = this.local;
    if (local !== undefined) {
      return local;
    }

    const name = (this.nameOf as (key: unknown) => string)(this.key);
    this.local = name;
    return name;
  }

  /** Whether the name still needs a namespace from the stack. */
  get runtimeNs(): boolean {
    const k = this.kind;
    return (
      k === CONSTANT_RTQname ||
      k === CONSTANT_RTQnameA ||
      k === CONSTANT_RTQnameL ||
      k === CONSTANT_RTQnameLA
    );
  }

  /** Whether the local name comes from the stack. */
  get runtimeName(): boolean {
    const k = this.kind;
    return (
      k === CONSTANT_RTQnameL ||
      k === CONSTANT_RTQnameLA ||
      k === CONSTANT_MultinameL ||
      k === CONSTANT_MultinameLA
    );
  }

  /**
   * The dynamic property the name names, or null, as
   * Multiname::isValidDynamicName: not an attribute and with a public
   * namespace, one of the public kind and an empty URI, as
   * Namespace::isPublic.
   */
  dynamicName(): string | null {
    if (this.attribute || this.name === null) {
      return null;
    }

    for (const ns of this.namespaces) {
      // null is any namespace, as in *::x.
      if (ns !== null && ns.kind === NS_Public && ns.uri === "") {
        return this.name;
      }
    }

    return null;
  }

  private publicCache: boolean | undefined;

  /** Whether it has the public namespace and is not an attribute: whether an element is its to name. */
  get elementName(): boolean {
    if (this.publicCache === undefined) {
      this.publicCache =
        !this.attribute &&
        this.namespaces.some((ns) => ns !== null && ns.kind === NS_Public && ns.uri === "");
    }

    return this.publicCache;
  }

  toString(): string {
    const ns = this.namespaces.length === 1 ? this.namespaces[0] : null;
    const name = this.name ?? "*";
    return ns?.uri ? `${ns.uri}::${name}` : name;
  }
}

/** A TypeName, `Base.<Param>`, whose parts are other multinames of its module. */
export class TypeName {
  names: (Multiname | TypeName | null)[] = [];

  constructor(
    readonly base: number,
    readonly params: number[],
  ) {}

  get baseName(): Multiname {
    return this.names[this.base] as Multiname;
  }

  param(i: number): Multiname | TypeName | null {
    return this.names[this.params[i]];
  }
}

/** A Qname in one namespace, seen at every version. */
export function qname(ns: Namespace, name: string): Multiname {
  return new Multiname(CONSTANT_Qname, [ns], [255], name, false);
}

/** The builtin Vector classes, which avmplus names as the types they are vectors of. */
const VECTOR_NAMES: Record<string, string> = {
  "__AS3__.vec::Vector$int": "__AS3__.vec::Vector.<int>",
  "__AS3__.vec::Vector$uint": "__AS3__.vec::Vector.<uint>",
  "__AS3__.vec::Vector$double": "__AS3__.vec::Vector.<Number>",
  "__AS3__.vec::Vector$object": "__AS3__.vec::Vector.<*>",
};

/** A traits' name as avmplus writes it: a class's statics' without their trailing $, a builtin Vector's as Vector.<T>. */
export function formatClassName(name: string): string {
  const own = name.endsWith("$") ? name.slice(0, -1) : name;
  return VECTOR_NAMES[own] ?? own;
}
