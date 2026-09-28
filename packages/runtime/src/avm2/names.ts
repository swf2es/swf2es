// Namespaces and multinames, as generated modules describe them.
//
// Namespaces are interned by kind and URI across modules, as the compiler
// interns them, so two modules' `public` are one object and names compare by
// identity. A private namespace is only ever equal to itself.

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
  ) {}
}

const interned = new Map<string, Namespace>();

/** The namespace of `kind` and `uri`, the same object each time. */
export function namespace(kind: number, uri: string | null): Namespace {
  const key = `${kind}:${uri}`;
  let ns = interned.get(key);
  if (!ns) {
    ns = new Namespace(kind, uri);
    interned.set(key, ns);
  }

  return ns;
}

export const publicNs = namespace(NS_Public, "");

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
  constructor(
    readonly kind: number,
    readonly namespaces: Namespace[],
    readonly versions: number[],
    readonly name: string | null,
    readonly attribute: boolean,
  ) {}

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
      if (ns.kind === NS_Public && ns.uri === "") {
        return this.name;
      }
    }

    return null;
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
