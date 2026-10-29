// What the natives and a player plug into the runtime for the builtin
// classes that differ from others: how they allocate, index, resolve
// names, and are called and constructed.

import type { AsObject, Method, Value } from "./descriptors.js";
import { type Multiname, NS_Public } from "./names.js";
import type { Runtime } from "./runtime.js";
import { BIND_Method, type Traits } from "./traits.js";

/** How a class that holds its own elements indexes them. */
export interface IndexHook {
  getIndex: (o: AsObject, i: number, rt: Runtime) => Value;
  setIndex: (o: AsObject, i: number, v: Value, rt: Runtime) => void;
  hasIndex: (o: AsObject, i: number) => boolean;
  /** A name's element index, -1 if it names none; the class's own rule, else an array index's. */
  index?: (o: AsObject, name: string, rt: Runtime) => number;
}

/**
 * How a class's instances resolve the names their traits do not bind, in
 * place of dynamic properties, as XML and XMLList do (E4X's [[Get]] and so
 * on): each operation, their enumeration, and their equality and +.
 */
export interface PropertyHook {
  /**
   * Whether a public method's name resolves through the hook too, as a
   * child or attribute of XML hides the methods of its names, or is the
   * method the traits bind, as a Proxy's is.
   */
  hidesMethods: boolean;
  get(rt: Runtime, o: AsObject, mn: Multiname): Value;
  set(rt: Runtime, o: AsObject, mn: Multiname, v: Value): void;
  delete(rt: Runtime, o: AsObject, mn: Multiname): boolean;
  has(rt: Runtime, o: AsObject, mn: Multiname): boolean;
  /** callproperty: what a name calls, looked for as the class does. */
  callee(rt: Runtime, o: AsObject, mn: Multiname): Value;
  descendants(rt: Runtime, o: AsObject, mn: Multiname): Value;
  /** The index after `index` for a for-in, or 0; and the name and value at one. */
  nextIndex(rt: Runtime, o: AsObject, index: number): number;
  nextName(rt: Runtime, o: AsObject, index: number): Value;
  nextValue(rt: Runtime, o: AsObject, index: number): Value;
  /** ==, when either side is an instance, or undefined to leave it to the rest. */
  equals(rt: Runtime, a: Value, b: Value): boolean | undefined;
  /** +, when both sides are an instance or another hooked class's, or undefined. */
  add(rt: Runtime, a: Value, b: Value): Value;
  /** An instance's string, as its primitive value. */
  toString(rt: Runtime, o: AsObject): string;
  /** An instance as XML text, as esc_xelem writes it. */
  toXMLString(rt: Runtime, o: AsObject): string;
}

/**
 * Whether a hooked class's hook resolves `mn`, bound to `b`: a name its
 * traits do not bind, an attribute's, or a public name of a method, as a
 * child or attribute of XML hides the methods of its names (as avmplus'
 * getproperty does for XML and XMLList).
 */
export function hookedBinding(b: number, mn: Multiname, hook: PropertyHook): boolean {
  if (b === 0 || mn.attribute) {
    return true;
  }

  return (
    hook.hidesMethods &&
    (b & 7) === BIND_Method &&
    mn.namespaces.some((ns) => ns?.kind === NS_Public && ns.uri === "")
  );
}

/** Natives by name, or a function that makes them for the runtime they will serve. */
export type NativesProvider =
  | Record<string, (rt: Runtime) => Method>
  | ((rt: Runtime) => Record<string, (rt: Runtime) => Method>);

/** How a builtin class differs from others: allocation, index access, calls and construction. */
export interface ClassHook {
  /** How its instances resolve names, as XML's (Traits.properties). */
  properties?: PropertyHook;
  /** A playerglobal set-only accessor whose bodyless setter stores in an instance slot. */
  setOnlySlots?: Record<string, string>;
  create?: (traits: Traits, rt: Runtime) => AsObject;
  /** Its prototype object, when not an Object: an instance of the class, as Date's (its $it is ready). */
  prototype?: (rt: Runtime, cls: AsObject) => AsObject;
  /** Whether its instances refuse any name but their own and an index, as a Vector's (Traits.refusesNames). */
  refusesNames?: boolean;
  getIndex?: IndexHook["getIndex"];
  setIndex?: IndexHook["setIndex"];
  hasIndex?: IndexHook["hasIndex"];
  index?: IndexHook["index"];
  construct?: (rt: Runtime, cls: AsObject, args: Value[]) => Value;
  call?: (rt: Runtime, cls: AsObject, args: Value[]) => Value;
  apply?: (rt: Runtime, factory: AsObject, params: Value[]) => AsObject;
  /** What the VM sets up on the class once its static initializer has run, as avmshell's Worker.current. */
  created?: (rt: Runtime, cls: AsObject) => void;
  /** As construct="restricted": a subclass from another ABC cannot be constructed, nor what extends it. */
  restricted?: boolean;
}
