// How a method or module names what it refers to: types, as the runtime
// knows them across modules or through the module's table T; namespaces and
// qualified names; and the constants a slot or parameter starts as.
import * as C from "../abc/constants";
import { NS_Private, URI_None } from "../link/domain";
import {
  BUILTIN_Any,
  BUILTIN_Boolean,
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
  if (value === 0) {
    defaultOf(e, type);
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
