// A class's natives, written as a class that holds them (see declare.ts),
// bound by its declaration under the names the compiler gives them
// ("Array#http://adobe.com/AS3/2006/builtin::push", "Array.Array::_pop",
// "Array#get:length", and "Array()" for the constructor), each called as
// avmplus calls a native: with a parameter's declared default where its
// argument is missing, and each argument coerced to its parameter's type.
// A native bound so may also replace a method whose body is still
// avmplus' AS3: see Runtime.override.

import type { Method } from "../descriptors.js";
import type { ClassHook } from "../hooks.js";
import type { Natives } from "../natives/define.js";
import type { Runtime } from "../runtime.js";
import type { ClassDecl, Exactly, MethodDecl, NativeClass, TraitDecl } from "./declare.js";
import { thunks } from "./thunks.js";

const AS3 = "http://adobe.com/AS3/2006/builtin";
const FLASH_PROXY = "http://www.adobe.com/2006/actionscript/flash/proxy";

/** A native's argument counts, as the ABC would give them: required, and at most (-1: any). */
export type Arity = [number, number];

/**
 * A native made by bindNatives: its arity rides on it, for a method whose
 * ABC has a body, and its class's name, whose methods the runtime looks at
 * for natives to replace their AS3 bodies.
 */
export type BoundNative = ((rt: Runtime) => Method) & { arity: Arity; owner: string };

/** A class of natives as bindNatives reads it: never constructed, its members are them. */
type Holder = Record<string, unknown> & { prototype: Record<string, unknown> };

function packageOf(name: string): string {
  const at = name.lastIndexOf("::");
  if (at < 0) {
    return "";
  }

  const prefix = name.slice(0, at);
  return prefix.startsWith("internal:") ? prefix.slice("internal:".length) : prefix;
}

function localOf(name: string): string {
  const at = name.lastIndexOf("::");
  return at < 0 ? name : name.slice(at + 2);
}

/** "uri::local", or "local" in a namespace whose URI is empty, as the compiler qualifies a name. */
function qualify(uri: string, local: string): string {
  return uri ? `${uri}::${local}` : local;
}

/** A declared name as the compiler qualifies it, inside class `decl`. */
function keyName(name: string, decl: ClassDecl): string {
  const at = name.lastIndexOf("::");
  if (at < 0) {
    return name;
  }

  const prefix = name.slice(0, at);
  const local = name.slice(at + 2);
  const pkg = packageOf(decl.name);
  const usual = qualify(pkg, localOf(decl.name)).replace("::", ":");
  switch (prefix) {
    case "AS3":
      return qualify(AS3, local);
    case "flash_proxy":
      return qualify(FLASH_PROXY, local);
    case "private":
      return qualify(decl.privateNs ?? usual, local);
    case "protected":
    case "staticprotected":
      return qualify(decl.protectedNs || usual, local);
    case "internal":
      return qualify(pkg, local);
  }

  if (prefix.startsWith("ns:")) {
    return qualify(prefix.slice(3), local);
  }

  if (prefix.startsWith("internal:")) {
    return qualify(prefix.slice("internal:".length), local);
  }

  return name;
}

/** A class's name as the compiler qualifies it. */
function className(decl: ClassDecl): string {
  return qualify(packageOf(decl.name), localOf(decl.name));
}

function arity(d: MethodDecl): Arity {
  const params = d.params ?? [];
  const required = params.filter((p) => typeof p === "string").length;
  return [required, d.rest || d.arguments || d.ignoreRest ? -1 : params.length];
}

/**
 * `f` called as avmplus calls a native declared by `d`: through its thunk
 * (see thunks.ts), which gives each missing argument its default and
 * coerces each to its parameter's type, where it has one; `f` itself
 * where nothing needs doing, as for a method whose AS3 reads `arguments`,
 * which gets them as given. Its length is its declared parameters' count,
 * as a compiled method's is, however the native spells them.
 */
function adapt(rt: Runtime, f: Method, d: MethodDecl, key: string): Method {
  const thunk = thunks[key];
  const g = thunk ? thunk(rt, f) : f;
  const n = d.params?.length ?? 0;
  if (g.length !== n) {
    Object.defineProperty(g, "length", { value: n });
  }

  return g;
}

/** Each trait of `traits` that is native, or has a body if `bodies`, with its member key and name. */
function* nativeTraits(
  traits: readonly TraitDecl[],
  bodies: boolean,
): Generator<[string, string, MethodDecl]> {
  for (const t of traits) {
    if (!("method" in t || "get" in t || "set" in t) || !(t.native || (bodies && t.avmplus))) {
      continue;
    }

    if ("method" in t) {
      yield [t.method, t.method, t];
    } else if ("get" in t) {
      yield [`get:${t.get}`, t.get, t];
    } else {
      yield [`set:${t.set}`, t.set, t];
    }
  }
}

/** A class's native: its key, the compiler's name for it, where its class of natives holds it, and its declaration. */
export interface NativeMember {
  key: string;
  static: boolean;
  /** Its member of the class of natives: "name", "get:name", "set:name", or the class's own name for the constructor. */
  member: string;
  decl: MethodDecl;
}

/**
 * The natives of class `decl`: its methods, accessors and constructor
 * declared native, and with `bodies`, those whose AS3 is still avmplus'
 * too, which ported will be.
 */
export function nativeMembers(decl: ClassDecl, bodies = false): NativeMember[] {
  const cls = className(decl);
  const out: NativeMember[] = [];
  for (const [isStatic, traits] of [
    [true, decl.static],
    [false, decl.instance],
  ] as const) {
    for (const [member, name, d] of nativeTraits(traits, bodies)) {
      const accessor = member.startsWith("get:") ? "get:" : member.startsWith("set:") ? "set:" : "";
      const key = `${cls}${isStatic ? "." : "#"}${accessor}${keyName(name, decl)}`;
      out.push({ key, static: isStatic, member, decl: d });
    }
  }

  if (decl.init.native || (bodies && decl.init.avmplus)) {
    // The AS3 constructor is the method named as the class.
    out.push({ key: `${cls}()`, static: false, member: localOf(decl.name), decl: decl.init });
  }

  return out;
}

/** A member of `holder`: a method's function, or an accessor's ("get:x", "set:x"). */
function memberOf(holder: Record<string, unknown>, member: string): Method {
  const accessor = member.startsWith("get:") || member.startsWith("set:");
  if (!accessor) {
    return holder[member] as Method;
  }

  // The class's own, or one it extends.
  let d: PropertyDescriptor | undefined;
  for (let o: object | null = holder; o && !d; o = Object.getPrototypeOf(o)) {
    d = Object.getOwnPropertyDescriptor(o, member.slice(4));
  }

  return (member.startsWith("get:") ? d?.get : d?.set) as Method;
}

/** A builtin class's natives, by the names the compiler gives them, and its class hook, by its name. */
export interface BuiltinClass {
  natives: Natives;
  hooks: Record<string, ClassHook>;
}

/**
 * Class `decl` for the runtime: the natives of the class `natives` makes
 * for it, which their types, not this, hold to the declaration (see
 * declare.ts), and `hook`, how the class differs from others, if it does.
 */
export function bindNatives<C extends ClassDecl, K extends NativeClass<C>>(
  decl: C,
  natives: (rt: Runtime) => K & Exactly<K, C>,
  hook?: ClassHook,
): BuiltinClass {
  const cls = className(decl);
  const out: Natives = {};
  // Made once per runtime, when first bound: the natives close over it.
  // Weakly, so that a runtime let go of is collected with its natives.
  const made = new WeakMap<Runtime, Holder>();
  const of = (rt: Runtime) => {
    let holder = made.get(rt);
    if (!holder) {
      holder = natives(rt) as unknown as Holder;
      made.set(rt, holder);
    }

    return holder;
  };

  for (const { key, static: isStatic, member, decl: d } of nativeMembers(decl)) {
    const bound = ((rt: Runtime) => {
      const h = of(rt);
      return adapt(rt, memberOf(isStatic ? h : h.prototype, member), d, key);
    }) as BoundNative;
    bound.arity = arity(d);
    bound.owner = cls;
    out[key] = bound;
  }

  return { natives: out, hooks: hook ? { [cls]: hook } : {} };
}

/** Whether a native was made by bindNatives, and so carries its arity. */
export function isBound(make: (rt: Runtime) => Method): make is BoundNative {
  return Array.isArray((make as BoundNative).arity);
}
