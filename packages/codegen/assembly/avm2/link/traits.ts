// The traits of a domain's classes, scripts and activations: what each
// defines by name, its slots and their types, and its methods by dispatch id.
//
// As in avmplus, traits are laid out when their ABC loads
// (Traits::verifyBindings, from AbcParser::parseTraits): names bind to
// slots and dispatch ids, inheriting the base's, and overrides must be of
// the right kind. What needs types waits until the traits are first used
// (Traits::resolveSignatures): slot types and initial values, method
// signatures, final methods, override signatures and implemented interfaces.
//
// A type is a traits id, or TYPE_Any for *.
import * as C from "../abc/constants";
import { API_Internal, Domain } from "./domain";
import { hashPair, IdTable } from "./table";

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

// Which base binding kinds each trait kind may meet (Traits::getOverride).
const LEGAL_Method: u32 = (1 << BIND_None) | (1 << BKIND_Method);
const LEGAL_Accessor: u32 =
  (1 << BIND_None) | (1 << BKIND_Get) | (1 << BKIND_Set) | (1 << BKIND_GetSet);

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

function hasGetter(binding: u32): bool {
  const kind = binding & 7;
  return kind === BKIND_Get || kind === BKIND_GetSet;
}

function hasSetter(binding: u32): bool {
  const kind = binding & 7;
  return kind === BKIND_Set || kind === BKIND_GetSet;
}

/** As isCompatibleOverrideKind: whether `over` may implement a binding of kind `base`. */
function compatibleKind(base: u32, over: u32): bool {
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
    let version = domain.activeVersion(versions[ns]);
    if (pool.mnKind[mn] === C.CONSTANT_Multiname) {
      const set = ns;
      const last = pool.nsSetStart[set + 1];
      ns = pool.nsSetMembers[pool.nsSetStart[set]];
      version = API_Internal;
      for (let m = pool.nsSetStart[set]; m < last; m++) {
        const v = domain.activeVersion(versions[pool.nsSetMembers[m]]);
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
   * As Traits::verifyBindings: bind t's members, whose base traits are
   * already laid out; 0, or the VerifyError.
   */
  layout(domain: Domain, t: u32): i32 {
    const index = this.abc[t];
    const abc = domain.abcs[index];
    const base = this.base[t];
    const baseSlots = base >= 0 ? this.slotCount[base] : 0;
    let methodCount = base >= 0 ? this.methodCount[base] : 0;
    const start = <u32>this.memberTraits.length;
    this.memberStart[t] = start;
    this.memberEnd[t] = start;

    // A subclass sees its base's protected members in its own protected namespace.
    const protectedNs = this.protectedNs[t];
    if (base >= 0 && protectedNs >= 0 && this.protectedNs[base] >= 0) {
      const baseNs = <u32>this.protectedNs[base];
      const last = this.memberEnd[base];
      for (let m = this.memberStart[base]; m < last; m++) {
        if (this.memberNs[m] === baseNs) {
          this.add(
            t,
            <u32>protectedNs,
            this.memberName[m],
            this.memberVersion[m],
            this.memberBinding[m],
          );
        }
      }
    }

    const first = this.first[t];
    const end = this.end[t];
    const nameCount = end - first;
    const early = this.allowEarlyBinding(t);
    let slotCount = baseSlots;
    for (let i = first; i < end; i++) {
      this.readName(domain, index, i);
      const nsId = this.nameNs;
      const nsVersion = this.nameNsVersion;
      const version = this.nameVersion;
      const name = this.nameId;
      const tag = abc.traitTag[i];
      const kind = tag & 0x0f;
      if (kind === C.TRAIT_Slot || kind === C.TRAIT_Const || kind === C.TRAIT_Class) {
        // As SlotIdCalcer: explicit ids only where slots may bind early.
        const id = abc.traitId[i];
        let slot: u32;
        if (id === 0 || !early) {
          slot = ++slotCount;
        } else {
          slot = id;
          if (slotCount < id) {
            slotCount = id;
          }
        }

        if (id > nameCount && early) {
          return C.kCorruptABCError;
        }

        // Slots are final, and cannot override anything else.
        if (slot - 1 < baseSlots) {
          return C.kIllegalOverrideError;
        }

        if (this.own(t, nsId, name, version) !== BIND_None) {
          return C.kCorruptABCError;
        }

        if (this.isInterface[t]) {
          return C.kIllegalSlotError;
        }

        const bkind = kind === C.TRAIT_Slot ? BKIND_Var : BKIND_Const;
        this.add(t, nsId, name, version, ((slot - 1) << 3) | bkind);
      } else if (kind === C.TRAIT_Method) {
        const baseBinding = this.overridden(t, nsId, nsVersion, name, tag);
        if (baseBinding < 0) {
          return C.kIllegalOverrideError;
        }

        if (baseBinding === BIND_None) {
          this.add(t, nsId, name, version, (methodCount << 3) | BKIND_Method);
          methodCount += 1;
        } else if ((<u32>baseBinding & 7) === BKIND_Method) {
          this.add(t, nsId, name, version, <u32>baseBinding);
        } else {
          return C.kCorruptABCError;
        }
      } else if (kind === C.TRAIT_Getter || kind === C.TRAIT_Setter) {
        // The other accessor of the pair may be defined here already.
        let baseBinding = <i64>this.own(t, nsId, name, version);
        if (baseBinding === BIND_None) {
          baseBinding = this.overridden(t, nsId, nsVersion, name, tag);
          if (baseBinding < 0) {
            return C.kIllegalOverrideError;
          }
        }

        const us = kind === C.TRAIT_Getter ? BKIND_Get : BKIND_Set;
        const them = kind === C.TRAIT_Getter ? BKIND_Set : BKIND_Get;
        const baseKind = <u32>baseBinding & 7;
        if (baseBinding === BIND_None) {
          this.add(t, nsId, name, version, (methodCount << 3) | us);
          methodCount += 2;
        } else if (baseKind === BKIND_Get || baseKind === BKIND_Set || baseKind === BKIND_GetSet) {
          const id = <u32>baseBinding & ~7;
          this.add(
            t,
            nsId,
            name,
            version,
            baseKind === them ? id | BKIND_GetSet : <u32>baseBinding,
          );
        } else {
          return C.kCorruptABCError;
        }
      }
    }

    this.slotCount[t] = slotCount;
    this.methodCount[t] = methodCount;
    if (this.kind[t] === TRAITS_Instance && !this.isInterface[t]) {
      this.bindInterfaces(domain, t);
    }

    return 0;
  }

  /**
   * As TraitsBindings::fixOneInterfaceBindings: for each interface t
   * implements that its base does not, a member of the interface that t
   * defines in the public namespace instead is bound in the interface's
   * namespace too.
   */
  bindInterfaces(domain: Domain, t: u32): void {
    const base = this.base[t];
    const all = this.allInterfaces(t);
    const index = this.abc[t];
    const publicNs = domain.publicNamespace();
    const publicVersion = domain.publicVersion(index);
    for (let k = 0; k < all.length; k++) {
      const ifc = all[k];
      if (base >= 0 && this.subtypeOf(base, ifc)) {
        continue;
      }

      const last = this.memberEnd[ifc];
      for (let m = this.memberStart[ifc]; m < last; m++) {
        const ns = this.memberNs[m];
        const name = this.memberName[m];
        const version = this.memberVersion[m];
        const iKind = this.memberBinding[m] & 7;
        if (compatibleKind(iKind, this.find(t, ns, name, version) & 7)) {
          continue;
        }

        const p = publicNs >= 0 ? this.find(t, <u32>publicNs, name, publicVersion) : BIND_None;
        if (compatibleKind(iKind, p & 7)) {
          this.add(t, ns, name, version, p);
        }
      }
    }
  }

  /**
   * As Traits::getOverride: the base binding a method or accessor named
   * `name` in `ns` meets, or -1 if the trait may not meet it that way:
   * overriding something of another kind, or with the override attribute
   * set where nothing is overridden, or not set where something is.
   */
  overridden(t: u32, ns: u32, version: u8, name: u32, tag: u8): i64 {
    const base = this.base[t];
    let binding = BIND_None;
    if (base >= 0) {
      const protectedNs = this.protectedNs[t];
      const baseProtected = this.protectedNs[base];
      const lookup = protectedNs === <i32>ns && baseProtected >= 0 ? <u32>baseProtected : ns;
      binding = this.find(base, lookup, name, version);
    }

    const baseKind = binding & 7;
    const kind = tag & 0x0f;
    const desired =
      kind === C.TRAIT_Method ? BKIND_Method : kind === C.TRAIT_Getter ? BKIND_Get : BKIND_Set;
    const legal = kind === C.TRAIT_Method ? LEGAL_Method : LEGAL_Accessor;
    if (!((legal >> baseKind) & 1)) {
      return -1;
    }

    // Overriding is required exactly where the base has a binding of this kind.
    const required =
      baseKind === desired ||
      (baseKind === BKIND_GetSet && (desired === BKIND_Get || desired === BKIND_Set));
    if (required !== ((tag & C.ATTR_Override) !== 0)) {
      return -1;
    }

    return binding;
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

    const error = this.resolveSlotsAndMethods(domain, t);
    if (error) {
      return error;
    }

    const initError = this.checkInitialValues(domain, t);
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
          legal = legal && this.checkOverride(domain, t, <u32>virt, over);
        }
      }
    }

    if (legal && !this.isInterface[t]) {
      legal = this.checkInterfaces(domain, t, interfaces);
    }

    if (!legal) {
      return C.kIllegalOverrideError;
    }

    this.resolved[t] = 1;
    return 0;
  }

  /**
   * As Traits::finishSlotsAndMethods: each slot's type, and each method's
   * dispatch id; an overridden method must not be final.
   */
  resolveSlotsAndMethods(domain: Domain, t: u32): i32 {
    const index = this.abc[t];
    const abc = domain.abcs[index];
    const base = this.base[t];
    const slotCount = this.slotCount[t];
    const slots = <u32>this.slotType.length;
    this.slotStart[t] = slots;
    for (let s: u32 = 0; s < slotCount; s++) {
      this.slotType.push(TYPE_Any);
      this.slotSet.push(0);
    }

    const methodCount = this.methodCount[t];
    const dispatch = <u32>this.dispatch.length;
    this.dispatchStart[t] = dispatch;
    for (let d: u32 = 0; d < methodCount; d++) {
      this.dispatch.push(-1);
    }

    let baseSlots: u32 = 0;
    if (base >= 0) {
      baseSlots = this.slotCount[base];
      const from = this.slotStart[base];
      for (let s: u32 = 0; s < baseSlots; s++) {
        this.slotType[slots + s] = this.slotType[from + s];
        this.slotSet[slots + s] = 1;
      }

      const baseMethods = this.methodCount[base];
      const fromDispatch = this.dispatchStart[base];
      for (let d: u32 = 0; d < baseMethods; d++) {
        this.dispatch[dispatch + d] = this.dispatch[fromDispatch + d];
      }
    }

    const methods = domain.methodStart[index];
    const early = this.allowEarlyBinding(t);
    let next = baseSlots;
    for (let i = this.first[t]; i < this.end[t]; i++) {
      const tag = abc.traitTag[i];
      const kind = tag & 0x0f;
      if (kind === C.TRAIT_Slot || kind === C.TRAIT_Const || kind === C.TRAIT_Class) {
        const id = abc.traitId[i];
        let slot: u32;
        if (id === 0 || !early) {
          slot = ++next;
        } else {
          slot = id;
          if (next < id) {
            next = id;
          }
        }

        // A slot defined twice would give one memory location two types.
        slot -= 1;
        if (slot >= slotCount || this.slotSet[slots + slot]) {
          return C.kCorruptABCError;
        }

        let type: i32;
        if (kind === C.TRAIT_Class) {
          type = domain.classStatic[domain.classStart[index] + abc.traitIndex[i]];
        } else {
          type = domain.resolveTypeId(index, abc.traitIndex[i], false);
          if (type < TYPE_Any) {
            return domain.typeError;
          }
        }

        this.slotType[slots + slot] = type;
        this.slotSet[slots + slot] = 1;
      } else if (kind === C.TRAIT_Method || kind === C.TRAIT_Getter || kind === C.TRAIT_Setter) {
        this.readName(domain, index, i);
        const b = this.own(t, this.nameNs, this.nameId, this.nameVersion);
        if (b === BIND_None) {
          continue;
        }

        const d = (b >> 3) + (kind === C.TRAIT_Setter ? 1 : 0);
        const baseBinding = this.overridden(t, this.nameNs, this.nameNsVersion, this.nameId, tag);
        if (baseBinding > 0) {
          const bb = <u32>baseBinding;
          if (
            (bb & 7) === BKIND_Method ||
            (hasGetter(bb) && kind === C.TRAIT_Getter) ||
            (hasSetter(bb) && kind === C.TRAIT_Setter)
          ) {
            const virt = this.dispatch[this.dispatchStart[base] + d];
            if (virt >= 0 && this.methodFinal[virt]) {
              return C.kIllegalOverrideError;
            }
          }
        }

        this.dispatch[dispatch + d] = methods + abc.traitIndex[i];
      }
    }

    return 0;
  }

  /** As Traits::genInitBody: every slot's initial value must suit its type. */
  checkInitialValues(domain: Domain, t: u32): i32 {
    const index = this.abc[t];
    const abc = domain.abcs[index];
    const early = this.allowEarlyBinding(t);
    const base = this.base[t];
    const slots = this.slotStart[t];
    let next = base >= 0 ? this.slotCount[base] : 0;
    for (let i = this.first[t]; i < this.end[t]; i++) {
      const kind = abc.traitTag[i] & 0x0f;
      if (kind !== C.TRAIT_Slot && kind !== C.TRAIT_Const && kind !== C.TRAIT_Class) {
        continue;
      }

      const id = abc.traitId[i];
      let slot: u32;
      if (id === 0 || !early) {
        slot = ++next;
      } else {
        slot = id;
        if (next < id) {
          next = id;
        }
      }

      const type = this.slotType[slots + slot - 1];
      const value = kind === C.TRAIT_Class ? 0 : abc.traitValue[i];
      const error = domain.checkDefault(index, value, abc.traitValueKind[i], type);
      if (error) {
        return error;
      }
    }

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
    const returnType = domain.resolveTypeId(index, abc.methodReturnType[local], true);
    if (returnType < TYPE_Any) {
      return domain.typeError;
    }

    const first = abc.methodParamStart[local];
    const count = abc.methodParamStart[local + 1] - first;
    const start = <u32>this.paramType.length;
    for (let p: u32 = 0; p < count; p++) {
      const type = domain.resolveTypeId(index, abc.paramTypes[first + p], false);
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
    return 0;
  }

  /**
   * As TraitsBindings::checkOverride: `over`, t's method at a dispatch id,
   * has the signature of the method `virt` it overrides or implements,
   * except that its receiver may be t.
   */
  checkOverride(domain: Domain, t: u32, virt: u32, over: i32): bool {
    if (over < 0) {
      return false;
    }

    const o = <u32>over;
    if (o === virt) {
      return true;
    }

    if (
      this.returnType[o] !== this.returnType[virt] ||
      this.paramCount[o] !== this.paramCount[virt] ||
      this.optionalCount[o] !== this.optionalCount[virt]
    ) {
      return false;
    }

    const receiver = this.receiverType[virt];
    if (
      receiver === TYPE_Any ||
      !this.subtypeOf(t, <u32>receiver) ||
      !domain.machineCompatible(<i32>t, receiver)
    ) {
      if (domain.isMachineType(<i32>t) || receiver !== domain.objectType()) {
        return false;
      }
    }

    const oStart = this.paramStart[o];
    const vStart = this.paramStart[virt];
    for (let p: u32 = 0; p < this.paramCount[o]; p++) {
      if (this.paramType[oStart + p] !== this.paramType[vStart + p]) {
        return false;
      }
    }

    return true;
  }

  /**
   * As TraitsBindings::checkLegalInterfaces: t implements every member of
   * every interface it has, with the interface's signatures.
   */
  checkInterfaces(domain: Domain, t: u32, interfaces: u32[]): bool {
    const dispatch = this.dispatchStart[t];
    for (let k = 0; k < interfaces.length; k++) {
      const ifc = interfaces[k];
      const ifcDispatch = this.dispatchStart[ifc];
      const last = this.memberEnd[ifc];
      for (let m = this.memberStart[ifc]; m < last; m++) {
        const iBinding = this.memberBinding[m];
        const cBinding = this.find(t, this.memberNs[m], this.memberName[m], this.memberVersion[m]);
        const iKind = iBinding & 7;
        if (!compatibleKind(iKind, cBinding & 7)) {
          return false;
        }

        const iId = iBinding >> 3;
        const cId = cBinding >> 3;
        if (iKind === BKIND_Method) {
          const virt = this.dispatch[ifcDispatch + iId];
          const over = this.dispatch[dispatch + cId];
          if (virt >= 0 && !this.checkOverride(domain, t, <u32>virt, over)) {
            return false;
          }

          continue;
        }

        if (hasGetter(iBinding)) {
          const virt = this.dispatch[ifcDispatch + iId];
          const over = this.dispatch[dispatch + cId];
          if (
            !hasGetter(cBinding) ||
            (virt >= 0 && !this.checkOverride(domain, t, <u32>virt, over))
          ) {
            return false;
          }
        }

        if (hasSetter(iBinding)) {
          const virt = this.dispatch[ifcDispatch + iId + 1];
          const over = this.dispatch[dispatch + cId + 1];
          if (
            !hasSetter(cBinding) ||
            (virt >= 0 && !this.checkOverride(domain, t, <u32>virt, over))
          ) {
            return false;
          }
        }
      }
    }

    return true;
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
    kind === C.CONSTANT_Int || kind === C.CONSTANT_UInt || kind === C.CONSTANT_Double;
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
