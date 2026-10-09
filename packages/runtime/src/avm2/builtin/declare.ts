// How builtin's classes, functions and constants are declared: what a SWF
// links against, as avmplus' builtin.abc has it, written as data the runtime
// and the build can both read. The declarations began as tools/abc-surface's
// output for that ABC and are edited by hand since. A class's natives are
// held to its declaration by the types at the end of this file.
//
// A name is "local" in the empty package's public namespace, "pkg::local"
// in package pkg's, "AS3::local" or "flash_proxy::local" in those
// namespaces, "ns:uri::local" in any other namespace, and "private::",
// "protected::", "staticprotected::" or "internal::local" in the
// declaring class's (or script's) own; "internal:pkg::local" is another
// package's internal namespace. A type is a class's name, or "*".

import type { AsObject, Value as AsValue } from "../descriptors.js";

/** A constant: its kind as the ABC spells it, and its value. */
export type Value =
  | readonly ["undefined", null]
  | readonly ["null", null]
  | readonly ["boolean", boolean]
  | readonly ["int" | "uint", number]
  /** A double; NaN, the infinities and -0 as strings, which JSON cannot hold. */
  | readonly ["double", number | string]
  | readonly ["string", string]
  | readonly ["namespace", string];

/** A metadata entry: its name and its [key, value] items, key "" for a bare value. */
export type Meta = readonly [string, readonly (readonly [string, string])[]];

/** A parameter: its type, or its type and default value. */
export type Param = string | readonly [string, Value];

export interface MethodDecl {
  readonly params?: readonly Param[];
  /** "*" when left out. */
  readonly returns?: string;
  /** Takes any number of arguments past its parameters, as ...rest or arguments does. */
  readonly rest?: true;
  readonly arguments?: true;
  readonly ignoreRest?: true;
  /** Implemented by a native. */
  readonly native?: true;
  /** Its body is still avmplus' AS3, to be written as a native. Neither: declared only. */
  readonly avmplus?: true;
}

interface Common {
  /** The API version of a name in a public namespace; 0 when left out. */
  readonly api?: number;
  readonly meta?: readonly Meta[];
}

export type TraitDecl =
  | ({ readonly var: string; readonly type?: string; readonly value?: Value } & Common)
  | ({ readonly const: string; readonly type?: string; readonly value?: Value } & Common)
  | ({ readonly method: string } & Accessor)
  | ({ readonly get: string } & Accessor)
  | ({ readonly set: string } & Accessor)
  | ({ readonly function: string } & MethodDecl & Common)
  | ({ readonly class: ClassDecl } & Common);

type Accessor = MethodDecl & Common & { readonly final?: true; readonly override?: true };

export interface ClassDecl {
  readonly name: string;
  readonly api?: number;
  /** The base class; none only for Object. */
  readonly super?: string;
  readonly interfaces?: readonly string[];
  readonly sealed?: true;
  readonly final?: true;
  readonly interface?: true;
  /**
   * The URI of its protected namespace, when not "pkg:local" (or "local"
   * in the empty package); false for a class without one, as interfaces are.
   */
  readonly protectedNs?: string | false;
  /** The URI of its private namespace, when not the usual one, as protectedNs. */
  readonly privateNs?: string;
  /** The constructor. */
  readonly init: MethodDecl;
  /** The class initializer, which sets up the prototype. */
  readonly classInit: MethodDecl;
  readonly static: readonly TraitDecl[];
  readonly instance: readonly TraitDecl[];
}

export interface ScriptDecl {
  /** The URI of its private namespace, as "File.as$1", if it names anything in it. */
  readonly private?: string;
  readonly init: MethodDecl;
  readonly traits: readonly TraitDecl[];
}

// What a class's natives must be, from its declaration written `as const
// satisfies ClassDecl`: one function per method, getter ("get:name") and
// setter ("set:name") it declares native, and no other. Each receives its
// arguments as bind.ts passes them, defaults filled in and coerced to the
// declared types, so a uint parameter is a number, a String one a string
// or null.

/** What a value of the AS3 type `T` is, once coerced to it. */
type Coerced<T> = T extends "int" | "uint" | "Number"
  ? number
  : T extends "String"
    ? string | null
    : T extends "Boolean"
      ? boolean
      : AsValue;

/** The arguments of a method declared with parameters `P`: optional from the first with a default. */
type Args<P> = P extends readonly [infer First, ...infer Rest]
  ? First extends readonly [infer T, Value]
    ? [Coerced<T>?, ...Args<Rest>]
    : [Coerced<First>, ...Args<Rest>]
  : [];

type NativeOf<D> = (
  this: AsObject,
  ...args: D extends { rest: true } | { arguments: true }
    ? [...Args<D extends { params: infer P } ? P : []>, ...AsValue[]]
    : Args<D extends { params: infer P } ? P : []>
) => D extends { returns: "void" } ? void : D extends { returns: infer R } ? Coerced<R> : AsValue;

/** A native trait's key among its class's natives. */
type KeyOf<D> = D extends { method: infer N extends string }
  ? N
  : D extends { get: infer N extends string }
    ? `get:${N}`
    : D extends { set: infer N extends string }
      ? `set:${N}`
      : never;

type NativesOf<L> = L extends readonly TraitDecl[]
  ? { [D in Extract<L[number], { native: true }> as KeyOf<D>]: NativeOf<D> }
  : never;

/** The natives of class `C`'s instance methods and accessors. */
export type InstanceNatives<C extends ClassDecl> = NativesOf<C["instance"]>;

/** The natives of class `C`'s static methods and accessors. */
export type StaticNatives<C extends ClassDecl> = NativesOf<C["static"]>;

/** Class `C`'s constructor, as a native. */
export type ConstructorNative<C extends ClassDecl> = NativeOf<C["init"]>;
