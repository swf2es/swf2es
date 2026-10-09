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
// satisfies ClassDecl`: a class (see bind.ts) with a method for each
// method the declaration calls native, static or not, a get or set
// accessor for each accessor, and the AS3 constructor, if native, as a
// method named as the class, as AS3 writes it. Nothing else may be public;
// private members are the class's own helpers. Each native receives its
// arguments as bind.ts passes them, defaults filled in and coerced to the
// declared types, so a uint parameter is a number, a String one a string
// or null, and one with a default is never missing; but a method whose
// AS3 reads `arguments` gets them as given.

/** What a value of the AS3 type `T` is, once coerced to it. */
type Coerced<T> = T extends "int" | "uint" | "Number"
  ? number
  : T extends "String"
    ? string | null
    : T extends "Boolean"
      ? boolean
      : AsValue;

/** The arguments of a method declared with parameters `P`: every one, a missing one given its default. */
type Args<P> = P extends readonly [infer First, ...infer Rest]
  ? [Coerced<First extends readonly [infer T, Value] ? T : First>, ...Args<Rest>]
  : [];

type ParamsOf<D> = D extends { params: infer P } ? Args<P> : [];

// One whose AS3 reads `arguments` gets them as given: neither defaulted nor coerced.
type NativeOf<D> = (
  this: AsObject,
  ...args: D extends { arguments: true }
    ? AsValue[]
    : D extends { rest: true }
      ? [...ParamsOf<D>, ...AsValue[]]
      : ParamsOf<D>
) => D extends { returns: "void" } ? void : D extends { returns: infer R } ? Coerced<R> : AsValue;

type Natives<L> = Extract<L, { native: true }>;

/** One side's natives: methods by name, and each accessor as a property of its type. */
type Side<L extends readonly TraitDecl[]> = {
  [D in Natives<L[number]> as D extends { method: infer N extends string }
    ? N
    : never]: NativeOf<D>;
} & {
  [D in Natives<L[number]> as D extends { get: infer N extends string } ? N : never]: D extends {
    returns: infer R;
  }
    ? Coerced<R>
    : AsValue;
} & {
  [D in Natives<L[number]> as D extends { set: infer N extends string } ? N : never]: D extends {
    params: readonly [infer P];
  }
    ? Coerced<P>
    : AsValue;
};

/** A class's name without its package: "ByteArray" for "flash.utils::ByteArray". */
type LocalName<N> = N extends `${string}::${infer L}` ? LocalName<L> : N;

/** The AS3 constructor, if native, as a method named as the class. */
type ConstructorOf<C extends ClassDecl> = C["init"] extends { native: true }
  ? { [K in LocalName<C["name"]>]: NativeOf<C["init"]> }
  : unknown;

/** The instance side of class `C`'s natives. */
export type InstanceNatives<C extends ClassDecl> = Side<C["instance"]> & ConstructorOf<C>;

/** The static side of class `C`'s natives. */
export type StaticNatives<C extends ClassDecl> = Side<C["static"]>;

/** A class of natives for `C`: never constructed, it only holds them. */
export type NativeClass<C extends ClassDecl> = (abstract new () => InstanceNatives<C>) &
  StaticNatives<C>;

type Extra<K, C extends ClassDecl> =
  | Exclude<keyof K, keyof StaticNatives<C> | "prototype">
  | (K extends abstract new () => infer I ? Exclude<keyof I, keyof InstanceNatives<C>> : never);

/** `K` if it has no public member `C` does not declare native, else a type naming them. */
export type Exactly<K, C extends ClassDecl> = [Extra<K, C>] extends [never]
  ? K
  : { "not declared native": Extra<K, C> };
