// A class's natives, written as a class that holds them (see declare.ts),
// bound by its declaration under the names the compiler gives them
// ("Array#http://adobe.com/AS3/2006/builtin::push", "Array.Array::_pop",
// "Array#get:length", and "Array()" for the constructor), each called as
// avmplus calls a native: with a parameter's declared default where its
// argument is missing, and each argument coerced to its parameter's type.
// A native bound so may also replace a method whose body is still
// avmplus' AS3: see Runtime.override.

import type { AsObject, Method, TypeRef, Value } from "../descriptors.js";
import { NS_PackageInternal, NS_Public, namespace } from "../names.js";
import type { Natives } from "../natives/define.js";
import type { Runtime } from "../runtime.js";
import type {
  ClassDecl,
  Value as Constant,
  Exactly,
  MethodDecl,
  NativeClass,
  TraitDecl,
} from "./declare.js";

const AS3 = "http://adobe.com/AS3/2006/builtin";
const FLASH_PROXY = "http://www.adobe.com/2006/actionscript/flash/proxy";

/** A native's argument counts, as the ABC would give them: required, and at most (-1: any). */
export type Arity = [number, number];

/** A native made by bindNatives: its arity rides on it, for a method whose ABC has a body. */
export type BoundNative = ((rt: Runtime) => Method) & { arity: Arity };

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

/** How an argument is coerced to AS3 type `type`; null for *, which takes it as it is. */
function coercer(rt: Runtime, type: string): ((v: Value) => Value) | null {
  switch (type) {
    case "*":
      return null;
    case "int":
      return (v) => rt.toInt(v);
    case "uint":
      return (v) => rt.toUint(v);
    case "Number":
      return (v) => rt.toNumber(v);
    case "Boolean":
      return (v) => !!v;
    case "String":
      return (v) => rt.coerceString(v);
    case "Object":
      return (v) => rt.coerceObject(v);
    default: {
      const ref = typeRef(rt, type);
      return (v) => rt.coerce(v, ref);
    }
  }
}

const same = (v: Value) => v;

/** A parameter with no default. */
const NONE = Symbol("no default");

/**
 * `f` called as avmplus calls a native declared by `d`: each missing
 * argument with a default given it, and each argument coerced to its
 * parameter's type. `f` itself where nothing needs doing.
 */
function adapt(rt: Runtime, f: Method, d: MethodDecl): Method {
  const params = d.params ?? [];
  const coerce = params.map((p) => coercer(rt, typeof p === "string" ? p : p[0]));
  const defaults = params.map((p) => (typeof p === "string" ? NONE : constant(p[1])));
  const anyDefault = defaults.some((v) => v !== NONE);
  if (!anyDefault && coerce.every((c) => c === null)) {
    return f;
  }

  // A parameter without a default has its argument: a call with fewer, or
  // more where nothing takes the rest, is refused before it gets here. So
  // for a few parameters and no rest, fixed shapes do, with no array made:
  // each default, coerced once here, where its argument is missing.
  const [c0 = same, c1 = same, c2 = same] = coerce.map((c) => c ?? same);
  const [v0, v1, v2] = defaults.map((v, i) => (v === NONE ? undefined : (coerce[i] ?? same)(v)));
  if (!d.rest && !d.arguments) {
    switch (params.length) {
      case 1:
        return anyDefault
          ? function (this: AsObject, a: Value) {
              // biome-ignore lint/complexity/noArguments: how many were given, as a default needs
              return f.call(this, arguments.length > 0 ? c0(a) : v0);
            }
          : function (this: AsObject, a: Value) {
              return f.call(this, c0(a));
            };
      case 2:
        return anyDefault
          ? function (this: AsObject, a: Value, b: Value) {
              // biome-ignore lint/complexity/noArguments: how many were given, as a default needs
              const n = arguments.length;
              return f.call(this, n > 0 ? c0(a) : v0, n > 1 ? c1(b) : v1);
            }
          : function (this: AsObject, a: Value, b: Value) {
              return f.call(this, c0(a), c1(b));
            };
      case 3:
        return anyDefault
          ? function (this: AsObject, a: Value, b: Value, c: Value) {
              // biome-ignore lint/complexity/noArguments: how many were given, as a default needs
              const n = arguments.length;
              return f.call(this, n > 0 ? c0(a) : v0, n > 1 ? c1(b) : v1, n > 2 ? c2(c) : v2);
            }
          : function (this: AsObject, a: Value, b: Value, c: Value) {
              return f.call(this, c0(a), c1(b), c2(c));
            };
    }
  }

  const n = params.length;
  const adapted = function (this: AsObject, ...args: Value[]) {
    for (let i = 0; i < n; i++) {
      if (i >= args.length) {
        if (defaults[i] === NONE) {
          break;
        }

        args.push(defaults[i]);
      }

      const c = coerce[i];
      if (c !== null) {
        args[i] = c(args[i]);
      }
    }

    return f.apply(this, args);
  };
  // Its length is its parameters', as the ABC's count gives a native's with ...rest.
  Object.defineProperty(adapted, "length", { value: n });
  return adapted;
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

/**
 * The natives of class `decl` for the runtime: the members of the class
 * `natives` makes for it, which their types, not this, hold to the
 * declaration (see declare.ts).
 */
export function bindNatives<C extends ClassDecl, K extends NativeClass<C>>(
  decl: C,
  natives: (rt: Runtime) => K & Exactly<K, C>,
): Natives {
  const cls = className(decl);
  const out: Natives = {};
  let made: Holder | null = null;
  let runtime: Runtime | null = null;
  // Made once per runtime, each when first bound: the natives close over it.
  const of = (rt: Runtime) => {
    if (runtime !== rt) {
      made = natives(rt) as unknown as Holder;
      runtime = rt;
    }

    return made as Holder;
  };

  const add = (key: string, d: MethodDecl, get: (holder: Holder) => Method) => {
    const bound = ((rt: Runtime) => adapt(rt, get(of(rt)), d)) as BoundNative;
    bound.arity = arity(d);
    out[key] = bound;
  };

  const sides = [
    [".", decl.static, (h: Holder) => h],
    ["#", decl.instance, (h: Holder) => h.prototype],
  ] as const;
  for (const [separator, traits, side] of sides) {
    for (const [member, name, d] of nativeTraits(traits)) {
      const accessor = member.startsWith("get:") ? "get:" : member.startsWith("set:") ? "set:" : "";
      add(`${cls}${separator}${accessor}${keyName(name, decl)}`, d, (h) =>
        memberOf(side(h), member),
      );
    }
  }

  if (decl.init.native) {
    // The AS3 constructor is the method named as the class.
    const named = localOf(decl.name);
    add(`${cls}()`, decl.init, (h) => h.prototype[named] as Method);
  }

  return out;
}

/** Whether a native was made by bindNatives, and so carries its arity. */
export function isBound(make: (rt: Runtime) => Method): make is BoundNative {
  return Array.isArray((make as BoundNative).arity);
}
