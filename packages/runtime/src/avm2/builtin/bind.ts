// A class's natives bound by its declaration: under the names the compiler
// gives them ("Array#http://adobe.com/AS3/2006/builtin::push",
// "Array.Array::_pop", "Array#get:length", and "Array()" for the
// constructor), each called as avmplus calls a native: with a parameter's
// declared default where its argument is missing, and each argument
// coerced to its parameter's type. A native bound so may also replace a
// method whose body is still avmplus' AS3: see Runtime.override.

import type { AsObject, Method, TypeRef, Value } from "../descriptors.js";
import { NS_PackageInternal, NS_Public, namespace } from "../names.js";
import type { Natives } from "../natives/define.js";
import type { Runtime } from "../runtime.js";
import type { ClassDecl, Value as Constant, MethodDecl, TraitDecl } from "./declare.js";

const AS3 = "http://adobe.com/AS3/2006/builtin";
const FLASH_PROXY = "http://www.adobe.com/2006/actionscript/flash/proxy";

/** A native's argument counts, as the ABC would give them: required, and at most (-1: any). */
export type Arity = [number, number];

/** A native made by bindNatives: its arity rides on it, for a method whose ABC has a body. */
export type BoundNative = ((rt: Runtime) => Method) & { arity: Arity };

/** A class's natives, keyed as its declaration names them (see declare.ts). */
export interface ClassNatives {
  init?: Method;
  static?: object;
  instance?: object;
}

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

function constant(v: Constant): Value {
  switch (v[0]) {
    case "undefined":
      return undefined;
    case "null":
      return null;
    case "double":
      return Number(v[1]);
    case "namespace":
      throw new Error(`a native's default namespace ${v[1]} is not supported`);
    default:
      return v[1];
  }
}

/** A type as the runtime coerces to it: null for *, a builtin's name, or a class by reference. */
function typeRef(rt: Runtime, type: string): TypeRef {
  if (type === "*") {
    return null;
  }

  const at = type.lastIndexOf("::");
  if (at < 0) {
    return type;
  }

  const prefix = type.slice(0, at);
  const ns = prefix.startsWith("internal:")
    ? namespace(NS_PackageInternal, prefix.slice("internal:".length))
    : namespace(NS_Public, prefix);
  return rt.cls(ns, type.slice(at + 2));
}

function arity(d: MethodDecl): Arity {
  const params = d.params ?? [];
  const required = params.filter((p) => typeof p === "string").length;
  return [required, d.rest || d.arguments ? -1 : params.length];
}

/**
 * `f` called as avmplus calls a native declared by `d`: each missing
 * argument with a default given it, and each argument coerced to its
 * parameter's type. `f` itself where nothing needs doing.
 */
function adapt(rt: Runtime, f: Method, d: MethodDecl): Method {
  const params = d.params ?? [];
  const types = params.map((p) => (typeof p === "string" ? p : p[0]));
  const defaults = params.map((p) => (typeof p === "string" ? undefined : p[1]));
  if (types.every((t) => t === "*") && defaults.every((v) => v === undefined)) {
    return f;
  }

  const refs = types.map((t) => typeRef(rt, t));
  const values = defaults.map((v) => (v === undefined ? undefined : constant(v)));
  const n = params.length;
  return function (this: AsObject, ...args: Value[]) {
    for (let i = 0; i < n; i++) {
      if (i >= args.length) {
        if (defaults[i] === undefined) {
          break;
        }

        args.push(values[i]);
      }

      if (refs[i] !== null) {
        args[i] = rt.coerce(args[i], refs[i]);
      }
    }

    return f.apply(this, args);
  };
}

/** Each native trait of `traits` with its key and declaration. */
function* nativeTraits(traits: readonly TraitDecl[]): Generator<[string, string, MethodDecl]> {
  for (const t of traits) {
    if ("method" in t && t.native) {
      yield [t.method, t.method, t];
    } else if ("get" in t && t.native) {
      yield [`get:${t.get}`, t.get, t];
    } else if ("set" in t && t.native) {
      yield [`set:${t.set}`, t.set, t];
    }
  }
}

/**
 * The natives of class `decl` for the runtime, from `natives`. Their
 * types, not this, hold them to the declaration (see declare.ts).
 */
export function bindNatives(decl: ClassDecl, natives: (rt: Runtime) => ClassNatives): Natives {
  const cls = className(decl);
  const out: Natives = {};
  let made: ClassNatives | null = null;
  let runtime: Runtime | null = null;
  // Made once per runtime, each when first bound: the natives close over it.
  const of = (rt: Runtime) => {
    if (runtime !== rt) {
      made = natives(rt);
      runtime = rt;
    }

    return made as ClassNatives;
  };

  const add = (key: string, d: MethodDecl, get: (n: ClassNatives) => Method | undefined) => {
    const bound = ((rt: Runtime) => adapt(rt, get(of(rt)) as Method, d)) as BoundNative;
    bound.arity = arity(d);
    out[key] = bound;
  };

  const sides = [
    [".", decl.static, (n: ClassNatives) => n.static],
    ["#", decl.instance, (n: ClassNatives) => n.instance],
  ] as const;
  for (const [separator, traits, side] of sides) {
    for (const [member, name, d] of nativeTraits(traits)) {
      const accessor = member.startsWith("get:") ? "get:" : member.startsWith("set:") ? "set:" : "";
      add(`${cls}${separator}${accessor}${keyName(name, decl)}`, d, (n) => {
        const holder = side(n) as Record<string, Method> | undefined;
        return holder?.[member];
      });
    }
  }

  if (decl.init.native) {
    add(`${cls}()`, decl.init, (n) => n.init);
  }

  return out;
}

/** Whether a native was made by bindNatives, and so carries its arity. */
export function isBound(make: (rt: Runtime) => Method): make is BoundNative {
  return Array.isArray((make as BoundNative).arity);
}
