// The traits of a domain's classes, scripts and activations: what each
// defines by name, its slot ids and its method dispatch ids.
//
// As in avmplus, a traits' members are laid out when its ABC loads
// (Traits::verifyBindings, from AbcParser::parseTraits): names bind to
// slots and dispatch ids, inheriting the base's, and overrides must be of
// the right kind. What needs types (slot types, signatures, final methods,
// interfaces implemented) waits until the traits are first used.
import {
  ATTR_Override,
  CONSTANT_Multiname,
  CONSTANT_TypeName,
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

// Binding kinds, as avmplus' BindingKind; a binding is id << 3 | kind.
export const BIND_None: u32 = 0;
export const BKIND_Method: u32 = 1;
export const BKIND_Var: u32 = 2;
export const BKIND_Const: u32 = 3;
export const BKIND_Get: u32 = 5;
export const BKIND_Set: u32 = 6;
export const BKIND_GetSet: u32 = 7;

// Which base binding kinds each trait kind may meet, and which it must
// override (Traits::getOverride), as bit sets of binding kinds.
const LEGAL_Method: u32 = (1 << BIND_None) | (1 << BKIND_Method);
const LEGAL_Accessor: u32 =
  (1 << BIND_None) | (1 << BKIND_Get) | (1 << BKIND_Set) | (1 << BKIND_GetSet);

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

  memberTraits: u32[] = [];
  memberNs: u32[] = [];
  memberName: u32[] = [];
  memberVersion: u8[] = [];
  memberBinding: u32[] = [];
  members: IdTable = new IdTable();

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

    const pool = abc.pool;
    const ids = unchecked(domain.abcNs[index]);
    const versions = unchecked(domain.abcNsVersion[index]);
    const strings = unchecked(domain.abcString[index]);
    const first = unchecked(this.first[t]);
    const end = unchecked(this.end[t]);
    const nameCount = end - first;
    const early = this.allowEarlyBinding(t);
    let slotCount = baseSlots;
    for (let i = first; i < end; i++) {
      let mn = unchecked(abc.traitName[i]);
      if (unchecked(pool.mnKind[mn]) === CONSTANT_TypeName) {
        mn = unchecked(pool.mnA[mn]);
      }

      // The name's first namespace, and the earliest version of its set.
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

      const nsId = unchecked(ids[ns]);
      const nsVersion = unchecked(versions[ns]);
      const name = unchecked(strings[pool.mnB[mn]]);
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
    return 0;
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
}
