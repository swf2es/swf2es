// The traits of a domain's classes, scripts and activations: what each
// defines by name, its slots and their types, and its methods by dispatch id.
//
// As in avmplus, traits are laid out when their ABC loads
// (Traits::verifyBindings, from AbcParser::parseTraits; bindings.ts): names
// bind to slots and dispatch ids, inheriting the base's, and overrides must
// be of the right kind. What needs types waits until the traits are first
// used (Traits::resolveSignatures; resolve, and signatures.ts): slot types
// and initial values, method signatures, final methods, override signatures
// and implemented interfaces.
//
// A type is a traits id, or TYPE_Any for *.
import * as C from "../abc/constants";
import { API_Internal, Domain, LOG_Sign } from "./domain";
import {
  checkInitialValues,
  checkInterfaces,
  checkOverride,
  resolveSlotsAndMethods,
} from "./signatures";
import { hashPair, IdTable } from "./table";
import { resolveTypeId } from "./typenames";

export const TRAITS_Instance: u8 = 1;
export const TRAITS_Class: u8 = 2;
export const TRAITS_Script: u8 = 3;
export const TRAITS_Activation: u8 = 4;
/** The types of void and null, which avmplus also represents as traits. */
export const TRAITS_Void: u8 = 5;
export const TRAITS_Null: u8 = 6;
/** A catch block's scope, with the exception in its one slot. */
export const TRAITS_Catch: u8 = 7;

export const TYPE_Any: i32 = -1;

// Binding kinds, as avmplus' BindingKind; a binding is id << 3 | kind.
export const BIND_None: u32 = 0;
export const BKIND_Method: u32 = 1;
export const BKIND_Var: u32 = 2;
export const BKIND_Const: u32 = 3;
export const BKIND_Get: u32 = 5;
export const BKIND_Set: u32 = 6;
export const BKIND_GetSet: u32 = 7;
// Types the rules below treat specially, as avmplus' BuiltinType.
export const BUILTIN_Any: u8 = 0;
export const BUILTIN_Object: u8 = 1;
export const BUILTIN_Void: u8 = 2;
export const BUILTIN_Boolean: u8 = 3;
export const BUILTIN_Int: u8 = 4;
export const BUILTIN_Uint: u8 = 5;
export const BUILTIN_Number: u8 = 6;
export const BUILTIN_String: u8 = 7;
export const BUILTIN_Namespace: u8 = 8;
export const BUILTIN_Other: u8 = 9;
export const BUILTIN_Float: u8 = 10;

/** As isCompatibleOverrideKind: whether `over` may implement a binding of kind `base`. */
export function compatibleKind(base: u32, over: u32): bool {
  if (base === BKIND_Method) {
    return over === BKIND_Method;
  }

  const accessors = (1 << BKIND_Get) | (1 << BKIND_Set) | (1 << BKIND_GetSet);
  return ((accessors >> base) & 1) === 1 && ((accessors >> over) & 1) === 1;
}

/**
 * The scope chain a method is created in (avmplus' ScopeTypeChain): the
 * types of its `size` entries, and whether each is a with scope. An `extra`
 * type other than TYPE_Any constrains the method's first own scope, as for
 * class methods, whose `this` must be of their class.
 */
@final
export class Scope {
  size: u32 = 0;
  types: i32[] = [];
  withs: u8[] = [];
  extra: i32 = TYPE_Any;

  /** As ScopeTypeChain::equals. */
  equals(other: Scope): bool {
    if (this.size !== other.size || this.extra !== other.extra) {
      return false;
    }

    for (let i: u32 = 0; i < this.size; i++) {
      if (this.types[i] !== other.types[i] || this.withs[i] !== other.withs[i]) {
        return false;
      }
    }

    return true;
  }
}

@final
export class TraitsTable {
  kind: u8[] = [];
  abc: u32[] = [];
  /** The class, script or body index in its ABC. */
  owner: u32[] = [];
  /** The traits whose members these inherit, or -1. */
  base: i32[] = [];
  /** Namespace id of the protected namespace, or -1. */
  protectedNs: i32[] = [];
  isInterface: u8[] = [];
  /** Where these traits' traits_info entries are in their ABC's trait tables. */
  first: u32[] = [];
  end: u32[] = [];
  /** Including the base's. */
  slotCount: u32[] = [];
  methodCount: u32[] = [];
  /** These traits' own members are members [memberStart, memberEnd). */
  memberStart: u32[] = [];
  memberEnd: u32[] = [];
  /** The interfaces a class names, as traits: interfaceList[interfaceStart, interfaceEnd). */
  interfaceStart: u32[] = [];
  interfaceEnd: u32[] = [];
  interfaceList: u32[] = [];
  /** For Vector.<T> with T other than int, uint, Number and *, T; else TYPE_Any. */
  param: i32[] = [];
  /** The initializer method (global id), or -1. */
  init: i32[] = [];
  /** The scope chain the traits' methods are created in, once known. */
  scope: Array<Scope | null> = [];

  memberTraits: u32[] = [];
  memberNs: u32[] = [];
  memberName: u32[] = [];
  memberVersion: u8[] = [];
  memberBinding: u32[] = [];
  members: IdTable = new IdTable();

  // Filled when resolved: each slot's type and each dispatch id's method,
  // the base's included, at slotType[slotStart ..] and dispatch[dispatchStart ..].
  resolved: u8[] = [];
  slotStart: u32[] = [];
  dispatchStart: u32[] = [];
  slotType: i32[] = [];
  slotSet: u8[] = [];
  dispatch: i32[] = [];

  // Methods by domain-wide id; ABC a's method m is Domain.methodStart[a] + m.
  methodTraits: i32[] = [];
  methodFinal: u8[] = [];
  /** Bound by a method, getter or setter trait, not as an initializer. */
  methodVirtual: u8[] = [];
  /** Made by newfunction rather than bound to traits: its receiver is Object. */
  methodFunction: u8[] = [];
  /** A function that takes extra arguments without a rest array, as avmplus' _ignoreRest. */
  ignoresRest: u8[] = [];
  /** A function's scope chain, captured by newfunction. */
  functionScope: Array<Scope | null> = [];
  signed: u8[] = [];
  returnType: i32[] = [];
  receiverType: i32[] = [];
  /** Parameter types, at paramType[paramStart ..], and how many are optional. */
  paramStart: u32[] = [];
  paramCount: u32[] = [];
  optionalCount: u32[] = [];
  paramType: i32[] = [];

  // The member name read by readName.
  nameNs: u32 = 0;
  nameNsVersion: u8 = 0;
  nameVersion: u8 = 0;
  nameId: u32 = 0;

  /** New traits over traits_info entries [first, end) of ABC `abc`. */
  create(kind: u8, abc: u32, owner: u32, base: i32, protectedNs: i32, first: u32, end: u32): u32 {
    const t = <u32>this.kind.length;
    this.kind.push(kind);
    this.abc.push(abc);
    this.owner.push(owner);
    this.base.push(base);
    this.protectedNs.push(protectedNs);
    this.isInterface.push(0);
    this.first.push(first);
    this.end.push(end);
    this.slotCount.push(0);
    this.methodCount.push(0);
    this.memberStart.push(0);
    this.memberEnd.push(0);
    this.interfaceStart.push(0);
    this.interfaceEnd.push(0);
    this.param.push(TYPE_Any);
    this.init.push(-1);
    this.scope.push(null);
    this.resolved.push(0);
    this.slotStart.push(0);
    this.dispatchStart.push(0);
    return t;
  }

  /** Forget traits from `count` on, left by an ABC that failed to link. */
  truncate(count: u32): void {
    this.kind.length = count;
    this.abc.length = count;
    this.owner.length = count;
    this.base.length = count;
    this.protectedNs.length = count;
    this.isInterface.length = count;
    this.first.length = count;
    this.end.length = count;
    this.slotCount.length = count;
    this.methodCount.length = count;
    this.memberStart.length = count;
    this.memberEnd.length = count;
    this.interfaceStart.length = count;
    this.interfaceEnd.length = count;
    this.param.length = count;
    this.init.length = count;
    this.scope.length = count;
    this.resolved.length = count;
    this.slotStart.length = count;
    this.dispatchStart.length = count;
  }

  /** As MethodInfo::declaringScope: the scope chain method m runs in, or null if not yet known. */
  scopeOf(m: u32): Scope | null {
    if (this.methodFunction[m]) {
      return this.functionScope[m];
    }

    const t = this.methodTraits[m];
    return t < 0 ? null : this.scope[t];
  }

  /** Room for `count` more methods, unbound and unsigned. */
  addMethods(count: u32): void {
    for (let i: u32 = 0; i < count; i++) {
      this.methodTraits.push(-1);
      this.methodFinal.push(0);
      this.methodVirtual.push(0);
      this.methodFunction.push(0);
      this.functionScope.push(null);
      this.ignoresRest.push(0);
      this.signed.push(0);
      this.returnType.push(TYPE_Any);
      this.receiverType.push(TYPE_Any);
      this.paramStart.push(0);
      this.paramCount.push(0);
      this.optionalCount.push(0);
    }
  }

  truncateMethods(count: u32): void {
    this.methodTraits.length = count;
    this.methodFinal.length = count;
    this.methodVirtual.length = count;
    this.methodFunction.length = count;
    this.functionScope.length = count;
    this.ignoresRest.length = count;
    this.signed.length = count;
    this.returnType.length = count;
    this.receiverType.length = count;
    this.paramStart.length = count;
    this.paramCount.length = count;
    this.optionalCount.length = count;
  }

  /** The binding of `name` in `ns` among t's own members, visible at `version`. */
  own(t: u32, ns: u32, name: u32, version: u8): u32 {
    const hash = hashPair(hashPair(t, ns), name);
    const table = this.members;
    let slot = table.start(hash);
    while (true) {
      const id = table.at(slot);
      if (id < 0) {
        return BIND_None;
      }

      // The slot's hash first: most slots a probe passes hold another key.
      if (
        table.hashAt(slot) === hash &&
        this.memberTraits[id] === t &&
        this.memberNs[id] === ns &&
        this.memberName[id] === name &&
        this.memberVersion[id] <= version &&
        // Members of traits that failed to link may remain in the table.
        <u32>id >= this.memberStart[t] &&
        <u32>id < this.memberEnd[t]
      ) {
        return this.memberBinding[id];
      }

      slot = table.next(slot);
    }
  }

  /** As TraitsBindings::findBinding: t's own members, then its base's. */
  find(t: i32, ns: u32, name: u32, version: u8): u32 {
    for (; t >= 0; t = this.base[t]) {
      const b = this.own(<u32>t, ns, name, version);
      if (b !== BIND_None) {
        return b;
      }
    }

    return BIND_None;
  }

  /**
   * As TraitsBindings::findBinding by name alone: the first member named
   * `name` in any namespace of t or its bases.
   */
  findName(t: i32, name: u32): u32 {
    for (; t >= 0; t = this.base[t]) {
      const last = this.memberEnd[t];
      for (let m = this.memberStart[t]; m < last; m++) {
        if (this.memberName[m] === name) {
          return this.memberBinding[m];
        }
      }
    }

    return BIND_None;
  }

  /** Bind a member of t, replacing one with the same name, namespace and version. */
  add(t: u32, ns: u32, name: u32, version: u8, binding: u32): void {
    const hash = hashPair(hashPair(t, ns), name);
    const table = this.members;
    const start = this.memberStart[t];
    for (let slot = table.start(hash); table.at(slot) >= 0; slot = table.next(slot)) {
      const m = <u32>table.at(slot);
      if (
        m >= start &&
        this.memberTraits[m] === t &&
        this.memberNs[m] === ns &&
        this.memberName[m] === name &&
        this.memberVersion[m] === version
      ) {
        this.memberBinding[m] = binding;
        return;
      }
    }

    const id = <u32>this.memberTraits.length;
    this.memberTraits.push(t);
    this.memberNs.push(ns);
    this.memberName.push(name);
    this.memberVersion.push(version);
    this.memberBinding.push(binding);
    table.insert(hash, id);
    this.memberEnd[t] = id + 1;
  }

  /**
   * Read the name of trait `i` of ABC `index` into nameNs and nameId: its
   * first namespace, whose own version is nameNsVersion, and nameVersion,
   * the earliest version of its namespaces in the domain's series.
   */
  readName(domain: Domain, index: u32, i: u32): void {
    const abc = domain.abcs[index];
    const pool = abc.pool;
    const versions = domain.abcNsVersion[index];
    let mn = abc.traitName[i];
    if (pool.mnKind[mn] === C.CONSTANT_TypeName) {
      mn = pool.mnA[mn];
    }

    let ns = pool.mnA[mn];
    let version = versions[ns];
    if (pool.mnKind[mn] === C.CONSTANT_Multiname) {
      const set = ns;
      const last = pool.nsSetStart[set + 1];
      ns = pool.nsSetMembers[pool.nsSetStart[set]];
      version = API_Internal;
      for (let m = pool.nsSetStart[set]; m < last; m++) {
        const v = versions[pool.nsSetMembers[m]];
        if (v < version) {
          version = v;
        }
      }
    }

    this.nameNs = domain.abcNs[index][ns];
    this.nameNsVersion = versions[ns];
    this.nameVersion = version;
    this.nameId = domain.abcString[index][pool.mnB[mn]];
  }

  /**
   * As Traits::allowEarlyBinding: slot ids from the ABC count only if no
   * base with slots comes from another ABC, so early slot access cannot
   * reach another ABC's private members.
   */
  allowEarlyBinding(t: u32): bool {
    const abc = this.abc[t];
    for (let b = this.base[t]; b >= 0; b = this.base[b]) {
      if (this.slotCount[b] === 0) {
        break;
      }

      if (this.abc[b] !== abc) {
        return false;
      }
    }

    return true;
  }

  /** Every interface t implements, its bases' and the interfaces' own included, once each. */
  allInterfaces(t: u32): u32[] {
    const all: u32[] = [];
    for (let c = <i32>t; c >= 0; c = this.base[c]) {
      this.addInterfaces(<u32>c, all);
    }

    return all;
  }

  addInterfaces(t: u32, all: u32[]): void {
    const last = this.interfaceEnd[t];
    for (let j = this.interfaceStart[t]; j < last; j++) {
      const ifc = this.interfaceList[j];
      if (!all.includes(ifc)) {
        all.push(ifc);
        this.addInterfaces(ifc, all);
      }
    }
  }

  /** As Traits::subtypeof: t is s, extends it, or implements it. */
  subtypeOf(t: u32, s: u32): bool {
    for (let c = <i32>t; c >= 0; c = this.base[c]) {
      if (<u32>c === s) {
        return true;
      }
    }

    return this.allInterfaces(t).includes(s);
  }

  /**
   * As Traits::resolveSignatures: resolve t's supertypes, then t's slot
   * types and initial values, its methods' signatures, and check its
   * overrides and interfaces; 0, or the VerifyError.
   */
  resolve(domain: Domain, t: u32): i32 {
    if (this.resolved[t]) {
      return 0;
    }

    const base = this.base[t];
    if (base >= 0) {
      const error = this.resolve(domain, <u32>base);
      if (error) {
        return error;
      }
    }

    const interfaces = this.allInterfaces(t);
    for (let k = 0; k < interfaces.length; k++) {
      const error = this.resolve(domain, interfaces[k]);
      if (error) {
        return error;
      }
    }

    const error = resolveSlotsAndMethods(this, domain, t);
    if (error) {
      return error;
    }

    const initError = checkInitialValues(this, domain, t);
    if (initError) {
      return initError;
    }

    // Every method's signature, then the initializer's.
    const dispatch = this.dispatchStart[t];
    for (let d: u32 = 0; d < this.methodCount[t]; d++) {
      const m = this.dispatch[dispatch + d];
      if (m >= 0) {
        const signError = this.sign(domain, <u32>m);
        if (signError) {
          return signError;
        }
      }
    }

    const init = this.init[t];
    if (init >= 0) {
      const signError = this.sign(domain, <u32>init);
      if (signError) {
        return signError;
      }
    }

    let legal: bool = true;
    if (base >= 0) {
      const baseDispatch = this.dispatchStart[base];
      for (let d: u32 = 0; d < this.methodCount[base]; d++) {
        const virt = this.dispatch[baseDispatch + d];
        const over = this.dispatch[dispatch + d];
        if (virt >= 0 && virt !== over) {
          legal = legal && checkOverride(this, domain, t, <u32>virt, over);
        }
      }
    }

    if (legal && !this.isInterface[t]) {
      legal = checkInterfaces(this, domain, t, interfaces);
    }

    if (!legal) {
      return C.kIllegalOverrideError;
    }

    this.resolved[t] = 1;
    domain.loggedResolve(t);
    return 0;
  }

  /**
   * As MethodInfo::resolveSignature: resolve method m's return type (void
   * allowed), parameter types (not), receiver, and check its optional
   * parameters' default values.
   */
  sign(domain: Domain, m: u32): i32 {
    if (this.signed[m]) {
      return 0;
    }

    const index = domain.methodAbc(m);
    const abc = domain.abcs[index];
    const local = m - domain.methodStart[index];
    const returnType = resolveTypeId(domain, index, abc.methodReturnType[local], true);
    if (returnType < TYPE_Any) {
      return domain.typeError;
    }

    const first = abc.methodParamStart[local];
    const count = abc.methodParamStart[local + 1] - first;
    const start = <u32>this.paramType.length;
    for (let p: u32 = 0; p < count; p++) {
      const type = resolveTypeId(domain, index, abc.paramTypes[first + p], false);
      if (type < TYPE_Any) {
        this.paramType.length = start;
        return domain.typeError;
      }

      this.paramType.push(type);
    }

    const optionalFirst = abc.methodOptionalStart[local];
    const optional = abc.methodOptionalStart[local + 1] - optionalFirst;
    for (let j: u32 = 0; j < optional; j++) {
      const type = this.paramType[start + count - optional + j];
      const error = domain.checkDefault(
        index,
        abc.optionalValue[optionalFirst + j],
        abc.optionalKind[optionalFirst + j],
        type,
      );
      if (error) {
        this.paramType.length = start;
        return error;
      }
    }

    // As avmplus' unchecked-function hack: a function with only untyped
    // parameters and result takes them all as optional.
    let optionalCount = optional;
    if (this.methodFunction[m] && optional === 0 && returnType === TYPE_Any && count > 0) {
      let untyped = true;
      for (let p: u32 = 0; p < count; p++) {
        untyped = untyped && this.paramType[start + p] === TYPE_Any;
      }

      if (untyped) {
        optionalCount = count;
        this.ignoresRest[m] = 1;
      }
    }

    if (this.methodFunction[m] && count === 0) {
      this.ignoresRest[m] = 1;
    }

    const owner = this.methodTraits[m];
    this.returnType[m] = returnType;
    this.receiverType[m] = owner >= 0 ? owner : domain.objectType();
    this.paramStart[m] = start;
    this.paramCount[m] = count;
    this.optionalCount[m] = optionalCount;
    this.signed[m] = 1;
    domain.logged(LOG_Sign, index, 0, local);
    return 0;
  }
}

/**
 * As PoolObject::isLegalDefaultValue and getLegalDefaultValue: whether a
 * default value of constant kind `kind` suits a slot or parameter of
 * builtin type `bt`; the value itself matters only for int and uint.
 */
export function legalDefault(bt: u8, kind: u8, number: f64): bool {
  if (bt === BUILTIN_Any) {
    return true;
  }

  const isNumber =
    kind === C.CONSTANT_Int ||
    kind === C.CONSTANT_UInt ||
    kind === C.CONSTANT_Double ||
    kind === C.CONSTANT_Float;
  const isNamespace =
    kind === C.CONSTANT_Namespace ||
    kind === C.CONSTANT_PackageNamespace ||
    kind === C.CONSTANT_PackageInternalNs ||
    kind === C.CONSTANT_ProtectedNamespace ||
    kind === C.CONSTANT_ExplicitNamespace ||
    kind === C.CONSTANT_StaticProtectedNs ||
    kind === C.CONSTANT_PrivateNs;
  switch (bt) {
    case BUILTIN_Object:
      return true;
    case BUILTIN_Float:
    case BUILTIN_Number:
      return isNumber;
    case BUILTIN_Boolean:
      return kind === C.CONSTANT_True || kind === C.CONSTANT_False;
    case BUILTIN_Int:
      return (
        isNumber && number === <f64>(<i32>number) && number >= -2147483648 && number <= 2147483647
      );
    case BUILTIN_Uint:
      return isNumber && number === <f64>(<u32>number) && number >= 0 && number <= 4294967295;
    case BUILTIN_String:
      return kind === C.CONSTANT_Null || kind === C.CONSTANT_Utf8;
    case BUILTIN_Namespace:
      return kind === C.CONSTANT_Null || isNamespace;
    default:
      return kind === C.CONSTANT_Null;
  }
}

/** Whether `kind` names a constant a default value may be. */
export function isDefaultKind(kind: u8): bool {
  return (
    kind === C.CONSTANT_Int ||
    kind === C.CONSTANT_UInt ||
    kind === C.CONSTANT_Double ||
    kind === C.CONSTANT_Float ||
    kind === C.CONSTANT_Utf8 ||
    kind === C.CONSTANT_True ||
    kind === C.CONSTANT_False ||
    kind === C.CONSTANT_Null ||
    kind === C.CONSTANT_Namespace ||
    kind === C.CONSTANT_PackageNamespace ||
    kind === C.CONSTANT_PackageInternalNs ||
    kind === C.CONSTANT_ProtectedNamespace ||
    kind === C.CONSTANT_ExplicitNamespace ||
    kind === C.CONSTANT_StaticProtectedNs ||
    kind === C.CONSTANT_PrivateNs
  );
}
