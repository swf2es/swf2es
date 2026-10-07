// avmplus.describeTypeJSON, as avmplus' TypeDescriber (core/TypeDescriber.cpp)
// builds it: the object describeType and playerglobal's
// flash.utils.describeType turn into XML. The traits' bindings are walked
// from the root of the chain down, as addBindings adds them, so a derived
// class's binding stands over its base's; their order is the hashtable's
// in avmplus, keyed by string addresses, which nothing reproduces.

import type { AsObject, Metadata, Signature, TypeRef, Value } from "../descriptors.js";
import { formatClassName, type Namespace, NS_Public } from "../names.js";
import type { Runtime } from "../runtime.js";
import {
  BIND_Const,
  BIND_Get,
  BIND_GetSet,
  BIND_Method,
  BIND_Set,
  BIND_Var,
  ClassRef,
  type Traits,
  VectorRef,
} from "../traits.js";
import type { Natives } from "./define.js";

const HIDE_NSURI_METHODS = 0x0001;
const INCLUDE_BASES = 0x0002;
const INCLUDE_INTERFACES = 0x0004;
const INCLUDE_VARIABLES = 0x0008;
const INCLUDE_ACCESSORS = 0x0010;
const INCLUDE_METHODS = 0x0020;
const INCLUDE_METADATA = 0x0040;
const INCLUDE_CONSTRUCTOR = 0x0080;
const INCLUDE_TRAITS = 0x0100;
const USE_ITRAITS = 0x0200;
const HIDE_OBJECT = 0x0400;

/**
 * The API version the caller sees, which a binding above is hidden at, as
 * avmplus hides what the calling code's pool is not versioned for: the
 * latest player's, as avmshell runs everything; a SWF's own version is
 * not yet taken into account. The builtins' internal members are above it
 * (API_Internal, 52, in the compiler's table).
 */
const CURRENT_API = 50;

/** A binding seen from the traits described: its name and namespace, its value, and the traits that bind it. */
interface Member {
  name: string;
  ns: Namespace;
  /** The API version the binding is seen at: a builtin's namespace is another than a script's with the same URI. */
  version: number;
  value: number;
  owner: Traits;
}

export const describeNatives: Natives = {
  "avmplus::describeTypeJSON": (rt) => (v: Value, flags: Value) =>
    describeTypeJSON(rt, v, rt.toUint(flags)),
};

/**
 * As TypeDescriber::describeType: the value's traits, or its class's
 * instance traits with USE_ITRAITS, which a value that is no class has
 * none of (null then), as { name, isDynamic, isFinal, isStatic, traits }.
 * undefined and null have traits of their own, void's and null's, with
 * nothing in them.
 */
export function describeTypeJSON(rt: Runtime, v: Value, flags: number): Value {
  // A class object: its own traits are the class's statics, its $it its instances'.
  const cls: AsObject | null = v !== null && typeof v === "object" && v.$it ? v : null;
  const traits = cls ? rt.traitsOf(cls) : chooseTraits(rt, v);
  if (typeof traits === "string") {
    // void or null: no traits object to walk, and no instance traits.
    if (flags & USE_ITRAITS) {
      return null;
    }

    return rt.newObject([
      "name",
      traits,
      "isDynamic",
      false,
      "isFinal",
      true,
      "isStatic",
      false,
      "traits",
      flags & INCLUDE_TRAITS ? emptyTraits(rt, flags) : null,
    ]);
  }

  let t: Traits = traits;
  let name = cls ? className(cls.$it) : className(t);
  if (flags & USE_ITRAITS) {
    if (!cls) {
      return null;
    }

    t = cls.$it;
    name = className(t);
  }

  return rt.newObject([
    "name",
    name,
    "isDynamic",
    t.dynamic,
    "isFinal",
    t.final,
    "isStatic",
    cls !== null && !(flags & USE_ITRAITS),
    "traits",
    flags & INCLUDE_TRAITS ? describeTraits(rt, t, flags) : null,
  ]);
}

/**
 * As TypeDescriber::chooseTraits: undefined is void, null is null, a
 * number that is an int in avmplus' 29 bits is an int, and anything else
 * is what it is; a class object's traits are its own, the class's.
 */
function chooseTraits(rt: Runtime, v: Value): Traits | string {
  if (v === undefined) {
    return "void";
  }

  if (v === null) {
    return "null";
  }

  if (typeof v === "number" && (v | 0) === v && v >= -(1 << 28) && v < 1 << 28) {
    return rt.traitsOfType("int");
  }

  return rt.traitsOf(v);
}

/** As Traits::formatClassName: the qualified name, a class's statics' without their trailing $. */
function className(t: Traits): string {
  return formatClassName(t.name);
}

/** A type's name as describeClassName gives it: * for none, else the class's qualified name. */
function typeName(rt: Runtime, type: TypeRef): string {
  if (type === null) {
    return "*";
  }

  if (typeof type === "string") {
    return type;
  }

  if (type instanceof VectorRef) {
    return `__AS3__.vec::Vector.<${typeName(rt, type.param)}>`;
  }

  if (type instanceof ClassRef) {
    try {
      return rt.traitsOfType(type).name;
    } catch {
      return type.ns.uri ? `${type.ns.uri}::${type.name}` : type.name;
    }
  }

  return "*";
}

/** The traits object of void and null: every array asked for empty, nothing else. */
function emptyTraits(rt: Runtime, flags: number): AsObject {
  return rt.newObject([
    "bases",
    flags & INCLUDE_BASES ? rt.array([]) : null,
    "interfaces",
    flags & INCLUDE_INTERFACES ? rt.array([]) : null,
    "metadata",
    flags & INCLUDE_METADATA ? rt.array([]) : null,
    "accessors",
    null,
    "methods",
    null,
    "variables",
    null,
    "constructor",
    null,
  ]);
}

/** As TypeDescriber::describeTraits. */
function describeTraits(rt: Runtime, t: Traits, flags: number): AsObject {
  let bases: Value = null;
  if (flags & INCLUDE_BASES) {
    const names: Value[] = [];
    for (let b = t.base; b; b = b.base) {
      names.push(className(b));
    }

    bases = rt.array(names);
  }

  let interfaces: Value = null;
  if (flags & INCLUDE_INTERFACES) {
    t.settleInterfaces();
    interfaces = rt.array([...t.interfaces].map((i) => className(i)));
  }

  let ctor: Value = null;
  if (flags & INCLUDE_CONSTRUCTOR && t.ctor && t.ctor[0].length > 0) {
    ctor = describeParams(rt, t.ctor[0], t.ctor[1]);
  }

  let metadata: Value = null;
  if (flags & INCLUDE_METADATA) {
    metadata = rt.array(t.metadata ? t.metadata.map((m) => describeMetadata(rt, m)) : []);
  }

  const variables: Value[] = [];
  const accessors: Value[] = [];
  const methods: Value[] = [];
  if (flags & (INCLUDE_ACCESSORS | INCLUDE_METHODS | INCLUDE_VARIABLES)) {
    const hidden = flags & HIDE_NSURI_METHODS ? uriNamespacesOfBases(t) : null;
    for (const member of members(t, flags)) {
      if (member.ns.kind !== NS_Public || hidden?.has(namespaceKey(member.ns, member.version))) {
        continue;
      }

      const kind = member.value & 7;
      const id = member.value >> 3;
      let v: AsObject;
      let own: Metadata[] | null | undefined;
      let other: Metadata[] | null | undefined;
      if (kind === BIND_Var || kind === BIND_Const) {
        if (!(flags & INCLUDE_VARIABLES)) {
          continue;
        }

        v = rt.newObject([
          "access",
          kind === BIND_Const ? "readonly" : "readwrite",
          "type",
          typeName(rt, member.owner.slotType(id)),
        ]);
        variables.push(v);
        own = slotMetadataOf(member.owner, id);
      } else if (kind === BIND_Method) {
        if (!(flags & INCLUDE_METHODS)) {
          continue;
        }

        const [declaredBy, signature] = signatureOf(member.owner, id);
        v = rt.newObject([
          "declaredBy",
          className(declaredBy),
          "returnType",
          typeName(rt, signature[0]),
          "parameters",
          describeParams(rt, signature[1], signature[2]),
        ]);
        methods.push(v);
        own = methodMetadataOf(member.owner, id);
      } else {
        if (!(flags & INCLUDE_ACCESSORS)) {
          continue;
        }

        const getter = kind === BIND_Get || kind === BIND_GetSet;
        const [declaredBy, signature] = signatureOf(member.owner, getter ? id : id + 1);
        const type = getter ? signature[0] : signature[1].length ? signature[1][0] : null;
        v = rt.newObject([
          "declaredBy",
          className(declaredBy),
          "access",
          kind === BIND_Get ? "readonly" : kind === BIND_Set ? "writeonly" : "readwrite",
          "type",
          typeName(rt, type),
        ]);
        accessors.push(v);
        if (getter) {
          own = methodMetadataOf(member.owner, id);
        }

        if (kind === BIND_Set || kind === BIND_GetSet) {
          other = methodMetadataOf(member.owner, id + 1);
        }
      }

      let md: Value = null;
      if (flags & INCLUDE_METADATA && (own || other)) {
        md = rt.array([...(own ?? []), ...(other ?? [])].map((m) => describeMetadata(rt, m)));
      }

      v.$d.set("name", member.name);
      v.$d.set("uri", member.ns.uri === "" ? null : member.ns.uri);
      v.$d.set("metadata", md);
    }
  }

  return rt.newObject([
    "bases",
    bases,
    "interfaces",
    interfaces,
    "metadata",
    metadata,
    "accessors",
    accessors.length ? rt.array(accessors) : null,
    "methods",
    methods.length ? rt.array(methods) : null,
    "variables",
    variables.length ? rt.array(variables) : null,
    "constructor",
    ctor,
  ]);
}

/**
 * The bindings of t and its bases, as addBindings gathers them: the
 * root's first, each derived traits' over its base's for the same name
 * and namespace, Object's own left out with HIDE_OBJECT unless t is an
 * interface. The bindings a class gets in its interfaces' namespaces are
 * no members of its own and do not show, as they do not in avmplus.
 */
function members(t: Traits, flags: number): Member[] {
  const chain: Traits[] = [];
  for (let c: Traits | null = t; c; c = c.base) {
    if (flags & HIDE_OBJECT && !c.base && !c.isInterface) {
      break;
    }

    chain.unshift(c);
  }

  const found = new Map<string, Member>();
  for (const owner of chain) {
    owner.settleInterfaces();
    // An interface's namespace has its qualified name as URI, pkg:Name where the traits say pkg::Name.
    const interfaceNames = owner.isInterface
      ? null
      : new Set([...owner.interfaces].flatMap((i) => [i.name, i.name.replace("::", ":")]));
    for (const [name, list] of owner.bindings) {
      for (const b of list) {
        if (
          b.version > CURRENT_API ||
          (interfaceNames && b.ns.uri && interfaceNames.has(b.ns.uri))
        ) {
          continue;
        }

        const key = `${b.ns.kind}\u0000${b.ns.uri}\u0000${name}`;
        found.set(key, { name, ns: b.ns, version: b.version, value: b.value, owner });
      }
    }
  }

  return [...found.values()];
}

/**
 * The namespaces with a URI that t's bases bind names in, which
 * HIDE_NSURI_METHODS hides: by identity in avmplus, where the builtins'
 * AS3 namespace, versioned, is another than a script's of the same URI,
 * so Object's AS3 methods hide under a class and a script's own AS3
 * methods do not, until a class derives from it.
 */
function uriNamespacesOfBases(t: Traits): Set<string> {
  const set = new Set<string>();
  for (let c = t.base; c; c = c.base) {
    for (const list of c.bindings.values()) {
      for (const b of list) {
        if (b.ns.uri) {
          set.add(namespaceKey(b.ns, b.version));
        }
      }
    }
  }

  return set;
}

function namespaceKey(ns: Namespace, version: number): string {
  return `${ns.kind}\u0000${ns.uri}\u0000${version}`;
}

/** The nearest traits from `owner` up that has the signature of dispatch id `d`, which declares the method, and the signature. */
function signatureOf(owner: Traits, d: number): [Traits, Signature] {
  for (let c: Traits | null = owner; c; c = c.base) {
    const signature = c.signatures.get(d);
    if (signature) {
      return [c, signature];
    }
  }

  return [owner, [null, [], 0]];
}

/** Slot `id`'s metadata, from the traits that declare it; undefined for none. */
function slotMetadataOf(owner: Traits, id: number): Metadata[] | undefined {
  for (let c: Traits | null = owner; c; c = c.base) {
    if (id in c.slotTypes) {
      return c.slotMetadata?.get(id);
    }
  }

  return undefined;
}

/** Dispatch id `d`'s metadata, the nearest traits' that has any, as getMethodMetadataPos finds it. */
function methodMetadataOf(owner: Traits, d: number): Metadata[] | undefined {
  for (let c: Traits | null = owner; c; c = c.base) {
    const entries = c.methodMetadata?.get(d);
    if (entries) {
      return entries;
    }
  }

  return undefined;
}

/** As TypeDescriber::describeParams: each parameter's type, and whether it is optional. */
function describeParams(rt: Runtime, params: TypeRef[], required: number): AsObject {
  return rt.array(
    params.map((type, i) => rt.newObject(["type", typeName(rt, type), "optional", i >= required])),
  );
}

/** As describeMetadataInfo: { name, value: [{ key, value }] }. */
function describeMetadata(rt: Runtime, [name, items]: Metadata): AsObject {
  const pairs: Value[] = [];
  for (let i = 0; i < items.length; i += 2) {
    pairs.push(rt.newObject(["key", items[i], "value", items[i + 1]]));
  }

  return rt.newObject(["name", name, "value", rt.array(pairs)]);
}
