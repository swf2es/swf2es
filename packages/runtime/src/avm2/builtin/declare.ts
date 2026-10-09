// How builtin's classes, functions and constants are declared: what a SWF
// links against, as avmplus' builtin.abc has it, written as data the runtime
// and the build can both read. The declarations under declarations/ began
// as tools/abc-surface's output for that ABC and are edited by hand since.
//
// A name is "local" in the empty package's public namespace, "pkg::local"
// in package pkg's, "AS3::local" or "flash_proxy::local" in those
// namespaces, "ns:uri::local" in any other namespace, and "private::",
// "protected::", "staticprotected::" or "internal::local" in the
// declaring class's (or script's) own; "internal:pkg::local" is another
// package's internal namespace. A type is a class's name, or "*".

/** A constant: its kind as the ABC spells it, and its value. */
export type Value =
  | ["undefined", null]
  | ["null", null]
  | ["boolean", boolean]
  | ["int" | "uint", number]
  /** A double; NaN, the infinities and -0 as strings, which JSON cannot hold. */
  | ["double", number | string]
  | ["string", string]
  | ["namespace", string];

/** A metadata entry: its name and its [key, value] items, key "" for a bare value. */
export type Meta = [string, [string, string][]];

/** A parameter: its type, or its type and default value. */
export type Param = string | [string, Value];

export interface MethodDecl {
  params?: Param[];
  /** "*" when left out. */
  returns?: string;
  /** Takes any number of arguments past its parameters, as ...rest or arguments does. */
  rest?: true;
  arguments?: true;
  ignoreRest?: true;
  /** Implemented by a native; else, if it has a body, see avmplus. */
  native?: true;
  /** Its body is still avmplus' AS3: to be written as a native. */
  avmplus?: true;
}

interface Common {
  /** The API version of a name in a public namespace; 0 when left out. */
  api?: number;
  meta?: Meta[];
}

export type TraitDecl =
  | ({ var: string; type?: string; value?: Value } & Common)
  | ({ const: string; type?: string; value?: Value } & Common)
  | ({ method: string } & Accessor)
  | ({ get: string } & Accessor)
  | ({ set: string } & Accessor)
  | ({ function: string } & MethodDecl & Common)
  | ({ class: ClassDecl } & Common);

type Accessor = MethodDecl & Common & { final?: true; override?: true };

export interface ClassDecl {
  name: string;
  api?: number;
  /** The base class; none only for Object. */
  super?: string;
  interfaces?: string[];
  sealed?: true;
  final?: true;
  interface?: true;
  /**
   * The URI of its protected namespace, when not "pkg:local" (or "local"
   * in the empty package); false for a class without one, as interfaces are.
   */
  protectedNs?: string | false;
  /** The URI of its private namespace, when not the usual one, as protectedNs. */
  privateNs?: string;
  /** The constructor. */
  init: MethodDecl;
  /** The class initializer, which sets up the prototype. */
  classInit: MethodDecl;
  static: TraitDecl[];
  instance: TraitDecl[];
}

export interface ScriptDecl {
  /** The URI of its private namespace, as "File.as$1", if it names anything in it. */
  private?: string;
  init: MethodDecl;
  traits: TraitDecl[];
}
