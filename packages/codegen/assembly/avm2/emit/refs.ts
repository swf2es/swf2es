// How a method or module names what it refers to: types, as the runtime
// knows them across modules or through the module's table T; namespaces and
// qualified names; and the constants a slot or parameter starts as.

import { Output } from "../../output";
import * as C from "../abc/constants";
import { Domain, NS_Private, URI_None } from "../link/domain";
import {
  BKIND_Method,
  BUILTIN_Any,
  BUILTIN_Boolean,
  BUILTIN_Float,
  BUILTIN_Int,
  BUILTIN_Namespace,
  BUILTIN_Number,
  BUILTIN_Object,
  BUILTIN_Other,
  BUILTIN_String,
  BUILTIN_Uint,
  TRAITS_Instance,
  TraitsTable,
  TYPE_Any,
} from "../link/traits";
import { MethodEmitter } from "./method";

/**
 * The first slot an object keeps in its array `$S` rather than in a
 * property of its own, as the runtime's SPILL_SLOTS (traits.ts): V8 keeps
 * an object of more than 1020 properties as a dictionary, which hashes
 * every name looked up in it, and a Crossbridge program's script global
 * has thousands of slots, its stack pointer and registers among the first.
 */
export const SPILL_SLOTS: u32 = 900;

/** Slot `slot`'s member, `.$n`, or `.$S[n - SPILL_SLOTS]` past them. */
export function slotMember(out: Output, slot: u32): void {
  if (slot < SPILL_SLOTS) {
    out.text(".$");
    out.uint(slot);
    return;
  }

  out.text(".$S[");
  out.uint(slot - SPILL_SLOTS);
  out.text("]");
}

/** Whether typeRef writes type t as T[k], a class's instances; else a literal. */
export function isClassRef(e: MethodEmitter, t: i32): bool {
  // What typeExpr writes as a literal stays one: *, the builtins it names
  // by string, and a type that is not a class's instances.
  const bt = t < 0 ? BUILTIN_Any : e.domain.builtin(t);
  return (
    t >= 0 &&
    (bt === BUILTIN_Other || bt === BUILTIN_Namespace) &&
    t !== e.domain.voidType &&
    e.domain.traits.kind[t] === TRAITS_Instance
  );
}

/**
 * Type t in a method: an entry of the module's table T, made once when
 * the module loads, for a class or Vector; the builtin types, and * as
 * null, as they are.
 */
export function typeRef(e: MethodEmitter, t: i32): void {
  const out = e.out;
  if (!isClassRef(e, t)) {
    typeExpr(e, t);
    return;
  }

  out.text("T[");
  out.uint(e.typeSlot(t));
  out.text("]");
}

/**
 * A reference to type t for the runtime, by name, as types are known
 * across modules: null for *, a string for the builtin primitive types,
 * cls(namespace, "Name") for a class, rt.vector(type) for Vector.<T>.
 */
export function typeExpr(e: MethodEmitter, t: i32): void {
  const out = e.out;
  const domain = e.domain;
  const traits = domain.traits;
  if (t < 0) {
    out.text("null");
    return;
  }

  switch (domain.builtin(t)) {
    case BUILTIN_Int:
      out.text('"int"');
      return;
    case BUILTIN_Uint:
      out.text('"uint"');
      return;
    case BUILTIN_Float:
      out.text('"float"');
      return;
    case BUILTIN_Number:
      out.text('"Number"');
      return;
    case BUILTIN_Boolean:
      out.text('"Boolean"');
      return;
    case BUILTIN_String:
      out.text('"String"');
      return;
    case BUILTIN_Object:
      out.text('"Object"');
      return;
    default:
      break;
  }

  if (t === domain.voidType) {
    out.text('"void"');
  } else if (traits.kind[t] !== TRAITS_Instance) {
    out.text("null");
  } else if (traits.param[t] !== TYPE_Any) {
    out.text("rt.vector(");
    typeExpr(e, traits.param[t]);
    out.text(")");
  } else {
    const index = traits.abc[t];
    const abc = domain.abcs[index];
    const pool = abc.pool;
    let mn = abc.instanceName[traits.owner[t]];
    if (pool.mnKind[mn] === C.CONSTANT_TypeName) {
      mn = pool.mnA[mn];
    }

    let ns = pool.mnA[mn];
    if (pool.mnKind[mn] === C.CONSTANT_Multiname) {
      ns = pool.nsSetMembers[pool.nsSetStart[ns]];
    }

    const name = domain.abcString[index][pool.mnB[mn]];
    out.text("cls(");
    const id = domain.abcNs[index][ns];
    if (domain.nsType[id] === NS_Private && index === e.index) {
      // A private namespace is its module's own object, N[k], which its
      // definitions are bound in, not one made again from its URI.
      out.text("N[");
      out.uint(ns);
      out.text("]");
    } else {
      namespace(e, id);
    }

    out.text(", ");
    out.string(domain.stringPtr[name], domain.stringLength[name]);
    out.text(")");
  }
}

/** A non-private namespace by its interned id, as ns(type, uri). */
export function namespace(e: MethodEmitter, id: u32): void {
  const out = e.out;
  out.text("ns(");
  out.uint(e.domain.nsType[id]);
  out.text(", ");
  uri(e, e.domain.nsUri[id]);
  out.text(")");
}

export function uri(e: MethodEmitter, id: u32): void {
  if (id === URI_None) {
    e.out.text("null");
    return;
  }

  const domain = e.domain;
  e.out.string(domain.stringPtr[id], domain.stringLength[id]);
}

/**
 * The member of interface traits `ifc` that dispatch id `disp` of its
 * layout binds a method to, whose name every class implementing it has an
 * alias of (interfaceAlias); -1 where there is none to call by, a private
 * namespace's member among them, as private namespaces are not compared by
 * their URI.
 */
export function aliasedMember(domain: Domain, ifc: u32, disp: u32): i32 {
  const traits = domain.traits;
  const last = traits.memberEnd[ifc];
  for (let m = traits.memberStart[ifc]; m < last; m++) {
    const b = traits.memberBinding[m];
    if ((b & 7) === BKIND_Method && b >> 3 === disp) {
      return domain.nsType[traits.memberNs[m]] === NS_Private ? -1 : <i32>m;
    }
  }

  return -1;
}

/**
 * The name, as a string literal, under which every class that implements
 * an interface has the entry for bound calls of the method it binds the
 * interface's member `name` in `ns` to, ns being no private namespace: one
 * name for all classes, so that a call through the interface reads one
 * property whatever the receiver's class. A namespace is its kind and URI,
 * as the domain interns it; the URI's length keeps the parts apart.
 */
export function interfaceAlias(out: Output, domain: Domain, ns: u32, name: u32): void {
  out.text('"$i');
  out.uint(domain.nsType[ns]);
  const id = domain.nsUri[ns];
  if (id === URI_None) {
    out.text("n:");
  } else {
    out.text(".");
    out.uint(domain.stringLength[id]);
    out.text(":");
    out.chars(domain.stringPtr[id], domain.stringLength[id]);
    out.text(":");
  }

  out.chars(domain.stringPtr[name], domain.stringLength[name]);
  out.text('"');
}

/** "uri::name", or just the name in a public namespace with an empty URI. */
export function qualified(e: MethodEmitter, ns: u32, name: u32): string {
  const domain = e.domain;
  const nameText = String.UTF8.decodeUnsafe(domain.stringPtr[name], domain.stringLength[name]);
  const uri = domain.nsUri[ns];
  if (uri === URI_None) {
    return nameText;
  }

  const uriText = String.UTF8.decodeUnsafe(domain.stringPtr[uri], domain.stringLength[uri]);
  return uriText.length ? `${uriText}::${nameText}` : nameText;
}

/** The qualified name of the class traits t belong to. */
export function className(e: MethodEmitter, traits: TraitsTable, t: u32): string {
  const domain = e.domain;
  const index = traits.abc[t];
  const abc = domain.abcs[index];
  const pool = abc.pool;
  let mn = abc.instanceName[traits.owner[t]];
  if (pool.mnKind[mn] === C.CONSTANT_TypeName) {
    mn = pool.mnA[mn];
  }

  let ns = pool.mnA[mn];
  if (pool.mnKind[mn] === C.CONSTANT_Multiname) {
    ns = pool.nsSetMembers[pool.nsSetStart[ns]];
  }

  return qualified(e, domain.abcNs[index][ns], domain.abcString[index][pool.mnB[mn]]);
}

/** Pool string `index` as a JavaScript string literal. */
export function poolString(e: MethodEmitter, index: u32): void {
  const pool = e.abc.pool;
  e.out.string(e.base + pool.stringStart[index], pool.stringLength[index]);
}

/**
 * A constant of default-value kind `kind`, index `value`, for a slot or
 * parameter of `type`; value 0 is the type's own default.
 */
export function constant(e: MethodEmitter, value: u32, kind: u8, type: i32): void {
  const out = e.out;
  const pool = e.abc.pool;
  if (kind === C.CONSTANT_Float && e.abc.hasFloatSupport) {
    const bt = e.domain.builtin(type);
    const numeric = bt === BUILTIN_Int || bt === BUILTIN_Uint || bt === BUILTIN_Number;
    if (!numeric) {
      out.text("rt.float(");
    }

    out.double(pool.floats[value]);
    if (!numeric) {
      out.text(")");
    }

    return;
  }

  if (value === 0) {
    defaultOf(e, type);
    return;
  }

  if (type >= 0 && type === e.domain.floatType && kind !== C.CONSTANT_Float) {
    out.text("rt.float(");
    constant(e, value, kind, TYPE_Any);
    out.text(")");
    return;
  }

  switch (kind) {
    case 0x03:
      out.int(pool.ints[value]);
      return;
    case 0x04:
      out.uint(pool.uints[value]);
      return;
    case 0x06:
      out.double(pool.doubles[value]);
      return;
    case 0x01:
      poolString(e, value);
      return;
    case 0x0a:
      out.text("false");
      return;
    case 0x0b:
      out.text("true");
      return;
    case 0x0c:
      out.text("null");
      return;
    default:
      // A namespace, as the Namespace object it is to AS3.
      out.text("rt.namespace(N[");
      out.uint(value);
      out.text("])");
      return;
  }
}

/** The value a slot or parameter of `type` has before anything is stored. */
function defaultOf(e: MethodEmitter, type: i32): void {
  const out = e.out;
  switch (e.domain.builtin(type)) {
    case BUILTIN_Any:
      out.text("void 0");
      return;
    case BUILTIN_Int:
    case BUILTIN_Uint:
      out.text("0");
      return;
    case BUILTIN_Float:
      out.text("rt.float(NaN)");
      return;
    case BUILTIN_Number:
      out.text("NaN");
      return;
    case BUILTIN_Boolean:
      out.text("false");
      return;
    default:
      out.text("null");
      return;
  }
}
