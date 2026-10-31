// Traits laid out as their ABC loads, as avmplus' Traits::verifyBindings:
// each member's name bound to a slot or a dispatch id, its base's
// inherited, an override of the kind it overrides, and the members of the
// interfaces a class implements bound in their own namespaces too.

import * as C from "../abc/constants";
import { Domain } from "./domain";
import {
  BIND_None,
  BKIND_Const,
  BKIND_Get,
  BKIND_GetSet,
  BKIND_Method,
  BKIND_Set,
  BKIND_Var,
  compatibleKind,
  TRAITS_Instance,
  TraitsTable,
} from "./traits";

// Which base binding kinds each trait kind may meet (Traits::getOverride).
const LEGAL_Method: u32 = (1 << BIND_None) | (1 << BKIND_Method);
const LEGAL_Accessor: u32 =
  (1 << BIND_None) | (1 << BKIND_Get) | (1 << BKIND_Set) | (1 << BKIND_GetSet);

/**
 * As Traits::verifyBindings: bind t's members, whose base traits are
 * already laid out; 0, or the VerifyError.
 */
export function layout(traits: TraitsTable, domain: Domain, t: u32): i32 {
  const index = traits.abc[t];
  const abc = domain.abcs[index];
  const base = traits.base[t];
  const baseSlots = base >= 0 ? traits.slotCount[base] : 0;
  let methodCount = base >= 0 ? traits.methodCount[base] : 0;
  const start = <u32>traits.memberTraits.length;
  traits.memberStart[t] = start;
  traits.memberEnd[t] = start;

  // A subclass sees its base's protected members in its own protected namespace.
  const protectedNs = traits.protectedNs[t];
  if (base >= 0 && protectedNs >= 0 && traits.protectedNs[base] >= 0) {
    const baseNs = <u32>traits.protectedNs[base];
    const last = traits.memberEnd[base];
    for (let m = traits.memberStart[base]; m < last; m++) {
      if (traits.memberNs[m] === baseNs) {
        traits.add(
          t,
          <u32>protectedNs,
          traits.memberName[m],
          traits.memberVersion[m],
          traits.memberBinding[m],
        );
      }
    }
  }

  const first = traits.first[t];
  const end = traits.end[t];
  const nameCount = end - first;
  const early = traits.allowEarlyBinding(t);
  let slotCount = baseSlots;
  for (let i = first; i < end; i++) {
    traits.readName(domain, index, i);
    const nsId = traits.nameNs;
    const nsVersion = traits.nameNsVersion;
    const version = traits.nameVersion;
    const name = traits.nameId;
    const tag = abc.traitTag[i];
    const kind = tag & 0x0f;
    switch (kind) {
      case C.TRAIT_Slot:
      case C.TRAIT_Const:
      case C.TRAIT_Class: {
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

        if (traits.own(t, nsId, name, version) !== BIND_None) {
          return C.kCorruptABCError;
        }

        if (traits.isInterface[t]) {
          return C.kIllegalSlotError;
        }

        const bkind = kind === C.TRAIT_Slot ? BKIND_Var : BKIND_Const;
        traits.add(t, nsId, name, version, ((slot - 1) << 3) | bkind);
        break;
      }
      case C.TRAIT_Method: {
        const baseBinding = overridden(traits, t, nsId, nsVersion, name, tag);
        if (baseBinding < 0) {
          return C.kIllegalOverrideError;
        }

        if (baseBinding === BIND_None) {
          traits.add(t, nsId, name, version, (methodCount << 3) | BKIND_Method);
          methodCount += 1;
        } else if ((<u32>baseBinding & 7) === BKIND_Method) {
          traits.add(t, nsId, name, version, <u32>baseBinding);
        } else {
          return C.kCorruptABCError;
        }
        break;
      }
      case C.TRAIT_Getter:
      case C.TRAIT_Setter: {
        // The other accessor of the pair may be defined here already.
        let baseBinding = <i64>traits.own(t, nsId, name, version);
        if (baseBinding === BIND_None) {
          baseBinding = overridden(traits, t, nsId, nsVersion, name, tag);
          if (baseBinding < 0) {
            return C.kIllegalOverrideError;
          }
        }

        const us = kind === C.TRAIT_Getter ? BKIND_Get : BKIND_Set;
        const them = kind === C.TRAIT_Getter ? BKIND_Set : BKIND_Get;
        const baseKind = <u32>baseBinding & 7;
        if (baseBinding === BIND_None) {
          traits.add(t, nsId, name, version, (methodCount << 3) | us);
          methodCount += 2;
        } else if (baseKind === BKIND_Get || baseKind === BKIND_Set || baseKind === BKIND_GetSet) {
          const id = <u32>baseBinding & ~7;
          traits.add(
            t,
            nsId,
            name,
            version,
            baseKind === them ? id | BKIND_GetSet : <u32>baseBinding,
          );
        } else {
          return C.kCorruptABCError;
        }
        break;
      }
      default:
        break;
    }
  }

  traits.slotCount[t] = slotCount;
  traits.methodCount[t] = methodCount;
  if (traits.kind[t] === TRAITS_Instance && !traits.isInterface[t]) {
    bindInterfaces(traits, domain, t);
  }

  return 0;
}

/**
 * As TraitsBindings::fixOneInterfaceBindings: for each interface t
 * implements that its base does not, a member of the interface that t
 * defines in the public namespace instead is bound in the interface's
 * namespace too.
 */
function bindInterfaces(traits: TraitsTable, domain: Domain, t: u32): void {
  const base = traits.base[t];
  const all = traits.allInterfaces(t);
  const index = traits.abc[t];
  const publicNs = domain.publicNamespace();
  const publicVersion = domain.publicVersion(index);
  for (let k = 0; k < all.length; k++) {
    const ifc = all[k];
    if (base >= 0 && traits.subtypeOf(base, ifc)) {
      continue;
    }

    const last = traits.memberEnd[ifc];
    for (let m = traits.memberStart[ifc]; m < last; m++) {
      const ns = traits.memberNs[m];
      const name = traits.memberName[m];
      const version = traits.memberVersion[m];
      const iKind = traits.memberBinding[m] & 7;
      if (compatibleKind(iKind, traits.find(t, ns, name, version) & 7)) {
        continue;
      }

      const p = publicNs >= 0 ? traits.find(t, <u32>publicNs, name, publicVersion) : BIND_None;
      if (compatibleKind(iKind, p & 7)) {
        traits.add(t, ns, name, version, p);
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
export function overridden(
  traits: TraitsTable,
  t: u32,
  ns: u32,
  version: u8,
  name: u32,
  tag: u8,
): i64 {
  const base = traits.base[t];
  let binding = BIND_None;
  if (base >= 0) {
    const protectedNs = traits.protectedNs[t];
    const baseProtected = traits.protectedNs[base];
    const lookup = protectedNs === <i32>ns && baseProtected >= 0 ? <u32>baseProtected : ns;
    binding = traits.find(base, lookup, name, version);
  }

  const baseKind = binding & 7;
  const kind = tag & 0x0f;
  const desired =
    kind === C.TRAIT_Method ? BKIND_Method : kind === C.TRAIT_Getter ? BKIND_Get : BKIND_Set;
  const legal = kind === C.TRAIT_Method ? LEGAL_Method : LEGAL_Accessor;
  if (!((legal >> baseKind) & 1)) {
    return -1;
  }

  // Overriding is required exactly where the base has a binding of traits kind.
  const required =
    baseKind === desired ||
    (baseKind === BKIND_GetSet && (desired === BKIND_Get || desired === BKIND_Set));
  if (required !== ((tag & C.ATTR_Override) !== 0)) {
    return -1;
  }

  return binding;
}
