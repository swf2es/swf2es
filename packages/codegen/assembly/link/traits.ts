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
import {
  ATTR_Override,
  CONSTANT_Double,
  CONSTANT_ExplicitNamespace,
  CONSTANT_False,
  CONSTANT_Int,
  CONSTANT_Multiname,
  CONSTANT_Namespace,
  CONSTANT_Null,
  CONSTANT_PackageInternalNs,
  CONSTANT_PackageNamespace,
  CONSTANT_PrivateNs,
  CONSTANT_ProtectedNamespace,
  CONSTANT_StaticProtectedNs,
  CONSTANT_True,
  CONSTANT_TypeName,
  CONSTANT_UInt,
  CONSTANT_Utf8,
  kCorruptABCError,
  kIllegalOverrideError,
  kIllegalSlotError,
  TRAIT_Class,
  TRAIT_Const,
  TRAIT_Getter,
  TRAIT_Method,
  TRAIT_Setter,
  TRAIT_Slot,
} from "../abc/constants";
import { API_Internal, Domain } from "./domain";
import { hashPair, IdTable } from "./table";

export const TRAITS_Instance: u8 = 1;
export const TRAITS_Class: u8 = 2;
export const TRAITS_Script: u8 = 3;
export const TRAITS_Activation: u8 = 4;
/** The types of void and null, which avmplus also represents as traits. */
export const TRAITS_Void: u8 = 5;
export const TRAITS_Null: u8 = 6;

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
  /** For a parameterized Vector type, the traits whose members it has, else -1. */
  alias: i32[] = [];
  /** The initializer method (global id), or -1. */
  init: i32[] = [];

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
  /** Made by newfunction rather than bound to traits: its receiver is Object. */
  methodFunction: u8[] = [];
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
    this.alias.push(-1);
    this.init.push(-1);
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
    this.alias.length = count;
    this.init.length = count;
    this.resolved.length = count;
    this.slotStart.length = count;
    this.dispatchStart.length = count;
  }

  /** Room for `count` more methods, unbound and unsigned. */
  addMethods(count: u32): void {
    for (let i: u32 = 0; i < count; i++) {
      this.methodTraits.push(-1);
      this.methodFinal.push(0);
      this.methodFunction.push(0);
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
    this.methodFunction.length = count;
    this.signed.length = count;
    this.returnType.length = count;
    this.receiverType.length = count;
    this.paramStart.length = count;
    this.paramCount.length = count;
    this.optionalCount.length = count;
  }

  /** The binding of `name` in `ns` among t's own members, visible at `version`. */
  own(t: u32, ns: u32, name: u32, version: u8): u32 {
    const alias = unchecked(this.alias[t]);
    if (alias >= 0) {
      t = <u32>alias;
    }

    const hash = hashPair(hashPair(t, ns), name);
    const table = this.members;
    let slot = table.start(hash);
    while (true) {
      const id = table.at(slot);
      if (id < 0) {
        return BIND_None;
      }

      if (
        unchecked(this.memberTraits[id]) === t &&
        unchecked(this.memberNs[id]) === ns &&
        unchecked(this.memberName[id]) === name &&
        unchecked(this.memberVersion[id]) <= version &&
        // Members of traits that failed to link may remain in the table.
        <u32>id >= unchecked(this.memberStart[t]) &&
        <u32>id < unchecked(this.memberEnd[t])
      ) {
        return unchecked(this.memberBinding[id]);
      }

      slot = table.next(slot);
    }
  }

  /** As TraitsBindings::findBinding: t's own members, then its base's. */
  find(t: i32, ns: u32, name: u32, version: u8): u32 {
    for (; t >= 0; t = unchecked(this.base[t])) {
      const b = this.own(<u32>t, ns, name, version);
      if (b !== BIND_None) {
        return b;
      }
    }

    return BIND_None;
  }

  /** Bind a member of t, replacing one with the same name, namespace and version. */
  add(t: u32, ns: u32, name: u32, version: u8, binding: u32): void {
    const hash = hashPair(hashPair(t, ns), name);
    const table = this.members;
    const start = unchecked(this.memberStart[t]);
    for (let slot = table.start(hash); table.at(slot) >= 0; slot = table.next(slot)) {
      const m = <u32>table.at(slot);
      if (
        m >= start &&
        unchecked(this.memberTraits[m]) === t &&
        unchecked(this.memberNs[m]) === ns &&
        unchecked(this.memberName[m]) === name &&
        unchecked(this.memberVersion[m]) === version
      ) {
        unchecked((this.memberBinding[m] = binding));
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
    unchecked((this.memberEnd[t] = id + 1));
  }

  /**
   * Read the name of trait `i` of ABC `index` into nameNs and nameId: its
   * first namespace, whose own version is nameNsVersion, and nameVersion,
   * the earliest version of its namespaces in the domain's series.
   */
  readName(domain: Domain, index: u32, i: u32): void {
    const abc = unchecked(domain.abcs[index]);
    const pool = abc.pool;
    const versions = unchecked(domain.abcNsVersion[index]);
    let mn = unchecked(abc.traitName[i]);
    if (unchecked(pool.mnKind[mn]) === CONSTANT_TypeName) {
      mn = unchecked(pool.mnA[mn]);
    }

    let ns = unchecked(pool.mnA[mn]);
    let version = domain.activeVersion(unchecked(versions[ns]));
    if (unchecked(pool.mnKind[mn]) === CONSTANT_Multiname) {
      const set = ns;
      const last = unchecked(pool.nsSetStart[set + 1]);
      ns = unchecked(pool.nsSetMembers[pool.nsSetStart[set]]);
      version = API_Internal;
      for (let m = unchecked(pool.nsSetStart[set]); m < last; m++) {
        const v = domain.activeVersion(unchecked(versions[pool.nsSetMembers[m]]));
        if (v < version) {
          version = v;
        }
      }
    }

    this.nameNs = unchecked(domain.abcNs[index][ns]);
    this.nameNsVersion = unchecked(versions[ns]);
    this.nameVersion = version;
    this.nameId = unchecked(domain.abcString[index][pool.mnB[mn]]);
  }

  /**
   * As Traits::verifyBindings: bind t's members, whose base traits are
   * already laid out; 0, or the VerifyError.
   */
  layout(domain: Domain, t: u32): i32 {
    const index = unchecked(this.abc[t]);
    const abc = unchecked(domain.abcs[index]);
    const base = unchecked(this.base[t]);
    const baseSlots = base >= 0 ? unchecked(this.slotCount[base]) : 0;
    let methodCount = base >= 0 ? unchecked(this.methodCount[base]) : 0;
    const start = <u32>this.memberTraits.length;
    unchecked((this.memberStart[t] = start));
    unchecked((this.memberEnd[t] = start));

    // A subclass sees its base's protected members in its own protected namespace.
    const protectedNs = unchecked(this.protectedNs[t]);
    if (base >= 0 && protectedNs >= 0 && unchecked(this.protectedNs[base]) >= 0) {
      const baseNs = <u32>unchecked(this.protectedNs[base]);
      const last = unchecked(this.memberEnd[base]);
      for (let m = unchecked(this.memberStart[base]); m < last; m++) {
        if (unchecked(this.memberNs[m]) === baseNs) {
          this.add(
            t,
            <u32>protectedNs,
            unchecked(this.memberName[m]),
            unchecked(this.memberVersion[m]),
            unchecked(this.memberBinding[m]),
          );
        }
      }
    }

    const first = unchecked(this.first[t]);
    const end = unchecked(this.end[t]);
    const nameCount = end - first;
    const early = this.allowEarlyBinding(t);
    let slotCount = baseSlots;
    for (let i = first; i < end; i++) {
      this.readName(domain, index, i);
      const nsId = this.nameNs;
      const nsVersion = this.nameNsVersion;
      const version = this.nameVersion;
      const name = this.nameId;
      const tag = unchecked(abc.traitTag[i]);
      const kind = tag & 0x0f;
      if (kind === TRAIT_Slot || kind === TRAIT_Const || kind === TRAIT_Class) {
        // As SlotIdCalcer: explicit ids only where slots may bind early.
        const id = unchecked(abc.traitId[i]);
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
          return kCorruptABCError;
        }

        // Slots are final, and cannot override anything else.
        if (slot - 1 < baseSlots) {
          return kIllegalOverrideError;
        }

        if (this.own(t, nsId, name, nsVersion) !== BIND_None) {
          return kCorruptABCError;
        }

        if (unchecked(this.isInterface[t])) {
          return kIllegalSlotError;
        }

        const bkind = kind === TRAIT_Slot ? BKIND_Var : BKIND_Const;
        this.add(t, nsId, name, version, ((slot - 1) << 3) | bkind);
      } else if (kind === TRAIT_Method) {
        const baseBinding = this.overridden(t, nsId, nsVersion, name, tag);
        if (baseBinding < 0) {
          return kIllegalOverrideError;
        }

        if (baseBinding === BIND_None) {
          this.add(t, nsId, name, version, (methodCount << 3) | BKIND_Method);
          methodCount += 1;
        } else if ((<u32>baseBinding & 7) === BKIND_Method) {
          this.add(t, nsId, name, version, <u32>baseBinding);
        } else {
          return kCorruptABCError;
        }
      } else if (kind === TRAIT_Getter || kind === TRAIT_Setter) {
        // The other accessor of the pair may be defined here already.
        let baseBinding = <i64>this.own(t, nsId, name, nsVersion);
        if (baseBinding === BIND_None) {
          baseBinding = this.overridden(t, nsId, nsVersion, name, tag);
          if (baseBinding < 0) {
            return kIllegalOverrideError;
          }
        }

        const us = kind === TRAIT_Getter ? BKIND_Get : BKIND_Set;
        const them = kind === TRAIT_Getter ? BKIND_Set : BKIND_Get;
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
          return kCorruptABCError;
        }
      }
    }

    unchecked((this.slotCount[t] = slotCount));
    unchecked((this.methodCount[t] = methodCount));
    if (unchecked(this.kind[t]) === TRAITS_Instance && !unchecked(this.isInterface[t])) {
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
    const base = unchecked(this.base[t]);
    const all = this.allInterfaces(t);
    const index = unchecked(this.abc[t]);
    const publicNs = domain.publicNamespace();
    const publicVersion = domain.publicVersion(index);
    for (let k = 0; k < all.length; k++) {
      const ifc = unchecked(all[k]);
      if (base >= 0 && this.subtypeOf(base, ifc)) {
        continue;
      }

      const last = unchecked(this.memberEnd[ifc]);
      for (let m = unchecked(this.memberStart[ifc]); m < last; m++) {
        const ns = unchecked(this.memberNs[m]);
        const name = unchecked(this.memberName[m]);
        const version = unchecked(this.memberVersion[m]);
        const iKind = unchecked(this.memberBinding[m]) & 7;
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
    const base = unchecked(this.base[t]);
    let binding = BIND_None;
    if (base >= 0) {
      const protectedNs = unchecked(this.protectedNs[t]);
      const baseProtected = unchecked(this.protectedNs[base]);
      const lookup = protectedNs === <i32>ns && baseProtected >= 0 ? <u32>baseProtected : ns;
      binding = this.find(base, lookup, name, version);
    }

    const baseKind = binding & 7;
    const kind = tag & 0x0f;
    const desired =
      kind === TRAIT_Method ? BKIND_Method : kind === TRAIT_Getter ? BKIND_Get : BKIND_Set;
    const legal = kind === TRAIT_Method ? LEGAL_Method : LEGAL_Accessor;
    if (!((legal >> baseKind) & 1)) {
      return -1;
    }

    // Overriding is required exactly where the base has a binding of this kind.
    const required =
      baseKind === desired ||
      (baseKind === BKIND_GetSet && (desired === BKIND_Get || desired === BKIND_Set));
    if (required !== ((tag & ATTR_Override) !== 0)) {
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
    const abc = unchecked(this.abc[t]);
    for (let b = unchecked(this.base[t]); b >= 0; b = unchecked(this.base[b])) {
      if (unchecked(this.slotCount[b]) === 0) {
        break;
      }

      if (unchecked(this.abc[b]) !== abc) {
        return false;
      }
    }

    return true;
  }

  /** Every interface t implements, its bases' and the interfaces' own included, once each. */
  allInterfaces(t: u32): u32[] {
    const all: u32[] = [];
    for (let c = <i32>t; c >= 0; c = unchecked(this.base[c])) {
      this.addInterfaces(<u32>c, all);
    }

    return all;
  }

  addInterfaces(t: u32, all: u32[]): void {
    const last = unchecked(this.interfaceEnd[t]);
    for (let j = unchecked(this.interfaceStart[t]); j < last; j++) {
      const ifc = unchecked(this.interfaceList[j]);
      if (!all.includes(ifc)) {
        all.push(ifc);
        this.addInterfaces(ifc, all);
      }
    }
  }

  /** As Traits::subtypeof: t is s, extends it, or implements it. */
  subtypeOf(t: u32, s: u32): bool {
    for (let c = <i32>t; c >= 0; c = unchecked(this.base[c])) {
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
    if (unchecked(this.resolved[t])) {
      return 0;
    }

    const alias = unchecked(this.alias[t]);
    if (alias >= 0) {
      const error = this.resolve(domain, <u32>alias);
      if (error) {
        return error;
      }

      unchecked((this.slotStart[t] = this.slotStart[alias]));
      unchecked((this.dispatchStart[t] = this.dispatchStart[alias]));
      unchecked((this.resolved[t] = 1));
      return 0;
    }

    const base = unchecked(this.base[t]);
    if (base >= 0) {
      const error = this.resolve(domain, <u32>base);
      if (error) {
        return error;
      }
    }

    const interfaces = this.allInterfaces(t);
    for (let k = 0; k < interfaces.length; k++) {
      const error = this.resolve(domain, unchecked(interfaces[k]));
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
    const dispatch = unchecked(this.dispatchStart[t]);
    for (let d: u32 = 0; d < unchecked(this.methodCount[t]); d++) {
      const m = unchecked(this.dispatch[dispatch + d]);
      if (m >= 0) {
        const signError = this.sign(domain, <u32>m);
        if (signError) {
          return signError;
        }
      }
    }

    const init = unchecked(this.init[t]);
    if (init >= 0) {
      const signError = this.sign(domain, <u32>init);
      if (signError) {
        return signError;
      }
    }

    let legal: bool = true;
    if (base >= 0) {
      const baseDispatch = unchecked(this.dispatchStart[base]);
      for (let d: u32 = 0; d < unchecked(this.methodCount[base]); d++) {
        const virt = unchecked(this.dispatch[baseDispatch + d]);
        const over = unchecked(this.dispatch[dispatch + d]);
        if (virt >= 0 && virt !== over) {
          legal = legal && this.checkOverride(domain, t, <u32>virt, over);
        }
      }
    }

    if (legal && !unchecked(this.isInterface[t])) {
      legal = this.checkInterfaces(domain, t, interfaces);
    }

    if (!legal) {
      return kIllegalOverrideError;
    }

    unchecked((this.resolved[t] = 1));
    return 0;
  }

  /**
   * As Traits::finishSlotsAndMethods: each slot's type, and each method's
   * dispatch id; an overridden method must not be final.
   */
  resolveSlotsAndMethods(domain: Domain, t: u32): i32 {
    const index = unchecked(this.abc[t]);
    const abc = unchecked(domain.abcs[index]);
    const base = unchecked(this.base[t]);
    const slotCount = unchecked(this.slotCount[t]);
    const slots = <u32>this.slotType.length;
    unchecked((this.slotStart[t] = slots));
    for (let s: u32 = 0; s < slotCount; s++) {
      this.slotType.push(TYPE_Any);
      this.slotSet.push(0);
    }

    const methodCount = unchecked(this.methodCount[t]);
    const dispatch = <u32>this.dispatch.length;
    unchecked((this.dispatchStart[t] = dispatch));
    for (let d: u32 = 0; d < methodCount; d++) {
      this.dispatch.push(-1);
    }

    let baseSlots: u32 = 0;
    if (base >= 0) {
      baseSlots = unchecked(this.slotCount[base]);
      const from = unchecked(this.slotStart[base]);
      for (let s: u32 = 0; s < baseSlots; s++) {
        unchecked((this.slotType[slots + s] = this.slotType[from + s]));
        unchecked((this.slotSet[slots + s] = 1));
      }

      const baseMethods = unchecked(this.methodCount[base]);
      const fromDispatch = unchecked(this.dispatchStart[base]);
      for (let d: u32 = 0; d < baseMethods; d++) {
        unchecked((this.dispatch[dispatch + d] = this.dispatch[fromDispatch + d]));
      }
    }

    const methods = unchecked(domain.methodStart[index]);
    const early = this.allowEarlyBinding(t);
    let next = baseSlots;
    for (let i = unchecked(this.first[t]); i < unchecked(this.end[t]); i++) {
      const tag = unchecked(abc.traitTag[i]);
      const kind = tag & 0x0f;
      if (kind === TRAIT_Slot || kind === TRAIT_Const || kind === TRAIT_Class) {
        const id = unchecked(abc.traitId[i]);
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
        if (slot >= slotCount || unchecked(this.slotSet[slots + slot])) {
          return kCorruptABCError;
        }

        let type: i32;
        if (kind === TRAIT_Class) {
          type = unchecked(domain.classStatic[domain.classStart[index] + abc.traitIndex[i]]);
        } else {
          type = domain.resolveTypeId(index, unchecked(abc.traitIndex[i]), false);
          if (type < TYPE_Any) {
            return domain.typeError;
          }
        }

        unchecked((this.slotType[slots + slot] = type));
        unchecked((this.slotSet[slots + slot] = 1));
      } else if (kind === TRAIT_Method || kind === TRAIT_Getter || kind === TRAIT_Setter) {
        this.readName(domain, index, i);
        const b = this.own(t, this.nameNs, this.nameId, this.nameNsVersion);
        if (b === BIND_None) {
          continue;
        }

        const d = (b >> 3) + (kind === TRAIT_Setter ? 1 : 0);
        const baseBinding = this.overridden(t, this.nameNs, this.nameNsVersion, this.nameId, tag);
        if (baseBinding > 0) {
          const bb = <u32>baseBinding;
          if (
            (bb & 7) === BKIND_Method ||
            (hasGetter(bb) && kind === TRAIT_Getter) ||
            (hasSetter(bb) && kind === TRAIT_Setter)
          ) {
            const virt = unchecked(this.dispatch[this.dispatchStart[base] + d]);
            if (virt >= 0 && unchecked(this.methodFinal[virt])) {
              return kIllegalOverrideError;
            }
          }
        }

        unchecked((this.dispatch[dispatch + d] = methods + abc.traitIndex[i]));
      }
    }

    return 0;
  }

  /** As Traits::genInitBody: every slot's initial value must suit its type. */
  checkInitialValues(domain: Domain, t: u32): i32 {
    const index = unchecked(this.abc[t]);
    const abc = unchecked(domain.abcs[index]);
    const early = this.allowEarlyBinding(t);
    const base = unchecked(this.base[t]);
    const slots = unchecked(this.slotStart[t]);
    let next = base >= 0 ? unchecked(this.slotCount[base]) : 0;
    for (let i = unchecked(this.first[t]); i < unchecked(this.end[t]); i++) {
      const kind = unchecked(abc.traitTag[i]) & 0x0f;
      if (kind !== TRAIT_Slot && kind !== TRAIT_Const && kind !== TRAIT_Class) {
        continue;
      }

      const id = unchecked(abc.traitId[i]);
      let slot: u32;
      if (id === 0 || !early) {
        slot = ++next;
      } else {
        slot = id;
        if (next < id) {
          next = id;
        }
      }

      const type = unchecked(this.slotType[slots + slot - 1]);
      const value = kind === TRAIT_Class ? 0 : unchecked(abc.traitValue[i]);
      const error = domain.checkDefault(index, value, unchecked(abc.traitValueKind[i]), type);
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
    if (unchecked(this.signed[m])) {
      return 0;
    }

    const index = domain.methodAbc(m);
    const abc = unchecked(domain.abcs[index]);
    const local = m - unchecked(domain.methodStart[index]);
    const returnType = domain.resolveTypeId(index, unchecked(abc.methodReturnType[local]), true);
    if (returnType < TYPE_Any) {
      return domain.typeError;
    }

    const first = unchecked(abc.methodParamStart[local]);
    const count = unchecked(abc.methodParamStart[local + 1]) - first;
    const start = <u32>this.paramType.length;
    for (let p: u32 = 0; p < count; p++) {
      const type = domain.resolveTypeId(index, unchecked(abc.paramTypes[first + p]), false);
      if (type < TYPE_Any) {
        this.paramType.length = start;
        return domain.typeError;
      }

      this.paramType.push(type);
    }

    const optionalFirst = unchecked(abc.methodOptionalStart[local]);
    const optional = unchecked(abc.methodOptionalStart[local + 1]) - optionalFirst;
    for (let j: u32 = 0; j < optional; j++) {
      const type = unchecked(this.paramType[start + count - optional + j]);
      const error = domain.checkDefault(
        index,
        unchecked(abc.optionalValue[optionalFirst + j]),
        unchecked(abc.optionalKind[optionalFirst + j]),
        type,
      );
      if (error) {
        this.paramType.length = start;
        return error;
      }
    }

    const owner = unchecked(this.methodTraits[m]);
    unchecked((this.returnType[m] = returnType));
    unchecked((this.receiverType[m] = owner >= 0 ? owner : domain.objectType()));
    unchecked((this.paramStart[m] = start));
    unchecked((this.paramCount[m] = count));
    unchecked((this.optionalCount[m] = optional));
    unchecked((this.signed[m] = 1));
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
      unchecked(this.returnType[o]) !== unchecked(this.returnType[virt]) ||
      unchecked(this.paramCount[o]) !== unchecked(this.paramCount[virt]) ||
      unchecked(this.optionalCount[o]) !== unchecked(this.optionalCount[virt])
    ) {
      return false;
    }

    const receiver = unchecked(this.receiverType[virt]);
    if (
      receiver === TYPE_Any ||
      !this.subtypeOf(t, <u32>receiver) ||
      !domain.machineCompatible(<i32>t, receiver)
    ) {
      if (domain.isMachineType(<i32>t) || receiver !== domain.objectType()) {
        return false;
      }
    }

    const oStart = unchecked(this.paramStart[o]);
    const vStart = unchecked(this.paramStart[virt]);
    for (let p: u32 = 0; p < unchecked(this.paramCount[o]); p++) {
      if (unchecked(this.paramType[oStart + p]) !== unchecked(this.paramType[vStart + p])) {
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
    const dispatch = unchecked(this.dispatchStart[t]);
    for (let k = 0; k < interfaces.length; k++) {
      const ifc = unchecked(interfaces[k]);
      const ifcDispatch = unchecked(this.dispatchStart[ifc]);
      const last = unchecked(this.memberEnd[ifc]);
      for (let m = unchecked(this.memberStart[ifc]); m < last; m++) {
        const iBinding = unchecked(this.memberBinding[m]);
        const cBinding = this.find(
          t,
          unchecked(this.memberNs[m]),
          unchecked(this.memberName[m]),
          unchecked(this.memberVersion[m]),
        );
        const iKind = iBinding & 7;
        if (!compatibleKind(iKind, cBinding & 7)) {
          return false;
        }

        const iId = iBinding >> 3;
        const cId = cBinding >> 3;
        if (iKind === BKIND_Method) {
          const virt = unchecked(this.dispatch[ifcDispatch + iId]);
          const over = unchecked(this.dispatch[dispatch + cId]);
          if (virt >= 0 && !this.checkOverride(domain, t, <u32>virt, over)) {
            return false;
          }

          continue;
        }

        if (hasGetter(iBinding)) {
          const virt = unchecked(this.dispatch[ifcDispatch + iId]);
          const over = unchecked(this.dispatch[dispatch + cId]);
          if (
            !hasGetter(cBinding) ||
            (virt >= 0 && !this.checkOverride(domain, t, <u32>virt, over))
          ) {
            return false;
          }
        }

        if (hasSetter(iBinding)) {
          const virt = unchecked(this.dispatch[ifcDispatch + iId + 1]);
          const over = unchecked(this.dispatch[dispatch + cId + 1]);
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

  const isNumber = kind === CONSTANT_Int || kind === CONSTANT_UInt || kind === CONSTANT_Double;
  const isNamespace =
    kind === CONSTANT_Namespace ||
    kind === CONSTANT_PackageNamespace ||
    kind === CONSTANT_PackageInternalNs ||
    kind === CONSTANT_ProtectedNamespace ||
    kind === CONSTANT_ExplicitNamespace ||
    kind === CONSTANT_StaticProtectedNs ||
    kind === CONSTANT_PrivateNs;
  switch (bt) {
    case BUILTIN_Object:
      return true;
    case BUILTIN_Number:
      return isNumber;
    case BUILTIN_Boolean:
      return kind === CONSTANT_True || kind === CONSTANT_False;
    case BUILTIN_Int:
      return (
        isNumber && number === <f64>(<i32>number) && number >= -2147483648 && number <= 2147483647
      );
    case BUILTIN_Uint:
      return isNumber && number === <f64>(<u32>number) && number >= 0 && number <= 4294967295;
    case BUILTIN_String:
      return kind === CONSTANT_Null || kind === CONSTANT_Utf8;
    case BUILTIN_Namespace:
      return kind === CONSTANT_Null || isNamespace;
    default:
      return kind === CONSTANT_Null;
  }
}

/** Whether `kind` names a constant a default value may be. */
export function isDefaultKind(kind: u8): bool {
  return (
    kind === CONSTANT_Int ||
    kind === CONSTANT_UInt ||
    kind === CONSTANT_Double ||
    kind === CONSTANT_Utf8 ||
    kind === CONSTANT_True ||
    kind === CONSTANT_False ||
    kind === CONSTANT_Null ||
    kind === CONSTANT_Namespace ||
    kind === CONSTANT_PackageNamespace ||
    kind === CONSTANT_PackageInternalNs ||
    kind === CONSTANT_ProtectedNamespace ||
    kind === CONSTANT_ExplicitNamespace ||
    kind === CONSTANT_StaticProtectedNs ||
    kind === CONSTANT_PrivateNs
  );
}
