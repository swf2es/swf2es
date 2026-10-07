// What a compiled module is built against: the values it handles, and the
// descriptors of its traits, classes and scripts it gives the runtime
// (docs/architecture.md, "Modules and the bootstrap").

import type { Multiname, Namespace, TypeName } from "./names.js";
import type { ClassRef, Domain, Script, VectorRef } from "./runtime.js";

// biome-ignore lint/suspicious/noExplicitAny: AS3 values are untyped
export type Value = any;
// biome-ignore lint/suspicious/noExplicitAny: AS3 objects are untyped
export type AsObject = any;
// biome-ignore lint/complexity/noBannedTypes: methods take their receiver as this
export type Method = Function;

/** A scope chain: its objects, outermost first, and a bit per with scope in w. */
export type Scope = Value[] & { w: number };

/** A method factory: the method's function, once its scope chain is known. */
export type Factory = (scope: Scope, sup: AsObject | null) => Method;

/** A reference to a type: null for *, a builtin's name, or a class by name. */
export type TypeRef = null | string | ClassRef | VectorRef;

/** A metadata entry as the ABC has it: its name, and its keys and values alternating, a key "" where it has none. */
export type Metadata = [string, string[]];

/** A method's signature: its return type, its parameter types, and how many of them are required. */
export type Signature = [TypeRef, TypeRef[], number];

export interface TraitsDesc {
  /** The VerifyError resolving the traits gave, if they did not resolve. */
  error?: number;
  slots: number;
  defaults: [number, Value, TypeRef][];
  bindings: [Namespace, number, string, number][];
  /** Each by dispatch id: its factory, its method id in its ABC, and its signature. */
  methods: [number, Factory, number, TypeRef, TypeRef[], number][];
  /**
   * Its own traits' metadata: the trait's kind as the ABC has it, its slot
   * id for a slot, its dispatch id for a method or an accessor pair (the
   * setter's one past the getter's), and the entries.
   */
  meta?: [number, number, Metadata[]][];
}

export interface ClassDesc {
  name: number;
  base: number;
  interfaces: number[];
  final: boolean;
  interface: boolean;
  sealed: boolean;
  protectedNs: number;
  instance: TraitsDesc;
  static: TraitsDesc;
  init: Factory;
  cinit: Factory;
  /** The constructor's parameter types and how many are required, when it has any. */
  ctor?: [TypeRef[], number];
  /** The class's own metadata, from the trait that defines it. */
  meta?: Metadata[];
  /** The module, set when it loads. */
  abc?: Abc;
}

export interface ScriptDesc {
  traits: TraitsDesc;
  init: Factory;
}

export interface AbcDesc {
  /** The hash of the module's ABC, and of the ABCs loaded before it, in order, that it was compiled against. */
  hash: string;
  linked: string[];
  names: (Multiname | TypeName | null)[];
  classes: ClassDesc[];
  scripts: ScriptDesc[];
  activations: (TraitsDesc | null)[];
}

/** A loaded module: what `rt.abc` returns, and methods reach as A. */
export interface Abc extends AbcDesc {
  scriptStates: Script[];
  /** The domain it was loaded into, and its position among the ABCs loaded there. */
  domain: Domain;
  index: number;
}

/**
 * What an ABC loaded into a domain compiles in: what the compiler needs to
 * bind its names as the runtime will find them (see RuntimeOptions.compileAbc).
 */
export interface CompileUnit {
  /** The hashes of the ABCs it is compiled after, its domain's chain, as its module names them. */
  linked: string[];
  /** Its domain and the domain's ancestors, by number, from the domain up to the root, 0. */
  domains: number[];
  /**
   * What the domain finds, by name or as a type, that is not the first
   * definition from the root down, as its caches hold it.
   */
  found: FoundDefinition[];
}

/** A definition a domain finds (see CompileUnit.found). */
export interface FoundDefinition {
  /** The name's namespace, by kind (NS_Public...) and URI, and the name. */
  nsKind: number;
  uri: string;
  name: string;
  /** The ABC that defines it: its domain's number, its position among the ABCs loaded there, and its hash. */
  domain: number;
  index: number;
  hash: string;
  /** Found as a type, as avmplus finds traits, else by name, as it finds scripts. */
  asType: boolean;
}
