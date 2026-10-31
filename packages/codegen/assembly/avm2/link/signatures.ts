// What traits resolve when first used, as avmplus' Traits::resolveSignatures
// does after their supertypes: each slot's type and each dispatch id's
// method, the slots' initial values checked against their types, and the
// overrides and implemented interfaces checked against the signatures they
// meet.

import * as C from "../abc/constants";
import { overridden } from "./bindings";
import { Domain } from "./domain";
import {
  BIND_None,
  BKIND_Get,
  BKIND_GetSet,
  BKIND_Method,
  BKIND_Set,
  compatibleKind,
  TraitsTable,
  TYPE_Any,
} from "./traits";

function hasGetter(binding: u32): bool {
  const kind = binding & 7;
  return kind === BKIND_Get || kind === BKIND_GetSet;
}

function hasSetter(binding: u32): bool {
  const kind = binding & 7;
  return kind === BKIND_Set || kind === BKIND_GetSet;
}

/**
 * As Traits::finishSlotsAndMethods: each slot's type, and each method's
 * dispatch id; an overridden method must not be final.
 */
export function resolveSlotsAndMethods(traits: TraitsTable, domain: Domain, t: u32): i32 {
  const index = traits.abc[t];
  const abc = domain.abcs[index];
  const base = traits.base[t];
  const slotCount = traits.slotCount[t];
  const slots = <u32>traits.slotType.length;
  traits.slotStart[t] = slots;
  for (let s: u32 = 0; s < slotCount; s++) {
    traits.slotType.push(TYPE_Any);
    traits.slotSet.push(0);
  }

  const methodCount = traits.methodCount[t];
  const dispatch = <u32>traits.dispatch.length;
  traits.dispatchStart[t] = dispatch;
  for (let d: u32 = 0; d < methodCount; d++) {
    traits.dispatch.push(-1);
  }

  let baseSlots: u32 = 0;
  if (base >= 0) {
    baseSlots = traits.slotCount[base];
    const from = traits.slotStart[base];
    for (let s: u32 = 0; s < baseSlots; s++) {
      traits.slotType[slots + s] = traits.slotType[from + s];
      traits.slotSet[slots + s] = 1;
    }

    const baseMethods = traits.methodCount[base];
    const fromDispatch = traits.dispatchStart[base];
    for (let d: u32 = 0; d < baseMethods; d++) {
      traits.dispatch[dispatch + d] = traits.dispatch[fromDispatch + d];
    }
  }

  const methods = domain.methodStart[index];
  const early = traits.allowEarlyBinding(t);
  let next = baseSlots;
  for (let i = traits.first[t]; i < traits.end[t]; i++) {
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
      if (slot >= slotCount || traits.slotSet[slots + slot]) {
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

      traits.slotType[slots + slot] = type;
      traits.slotSet[slots + slot] = 1;
    } else if (kind === C.TRAIT_Method || kind === C.TRAIT_Getter || kind === C.TRAIT_Setter) {
      traits.readName(domain, index, i);
      const b = traits.own(t, traits.nameNs, traits.nameId, traits.nameVersion);
      if (b === BIND_None) {
        continue;
      }

      const d = (b >> 3) + (kind === C.TRAIT_Setter ? 1 : 0);
      const baseBinding = overridden(
        traits,
        t,
        traits.nameNs,
        traits.nameNsVersion,
        traits.nameId,
        tag,
      );
      if (baseBinding > 0) {
        const bb = <u32>baseBinding;
        if (
          (bb & 7) === BKIND_Method ||
          (hasGetter(bb) && kind === C.TRAIT_Getter) ||
          (hasSetter(bb) && kind === C.TRAIT_Setter)
        ) {
          const virt = traits.dispatch[traits.dispatchStart[base] + d];
          if (virt >= 0 && traits.methodFinal[virt]) {
            return C.kIllegalOverrideError;
          }
        }
      }

      traits.dispatch[dispatch + d] = methods + abc.traitIndex[i];
    }
  }

  return 0;
}

/** As Traits::genInitBody: every slot's initial value must suit its type. */
export function checkInitialValues(traits: TraitsTable, domain: Domain, t: u32): i32 {
  const index = traits.abc[t];
  const abc = domain.abcs[index];
  const early = traits.allowEarlyBinding(t);
  const base = traits.base[t];
  const slots = traits.slotStart[t];
  let next = base >= 0 ? traits.slotCount[base] : 0;
  for (let i = traits.first[t]; i < traits.end[t]; i++) {
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

    const type = traits.slotType[slots + slot - 1];
    const value = kind === C.TRAIT_Class ? 0 : abc.traitValue[i];
    const error = domain.checkDefault(index, value, abc.traitValueKind[i], type);
    if (error) {
      return error;
    }
  }

  return 0;
}

/**
 * As TraitsBindings::checkOverride: `over`, t's method at a dispatch id,
 * has the signature of the method `virt` it overrides or implements,
 * except that its receiver may be t.
 */
export function checkOverride(
  traits: TraitsTable,
  domain: Domain,
  t: u32,
  virt: u32,
  over: i32,
): bool {
  if (over < 0) {
    return false;
  }

  const o = <u32>over;
  if (o === virt) {
    return true;
  }

  if (
    traits.returnType[o] !== traits.returnType[virt] ||
    traits.paramCount[o] !== traits.paramCount[virt] ||
    traits.optionalCount[o] !== traits.optionalCount[virt]
  ) {
    return false;
  }

  const receiver = traits.receiverType[virt];
  if (
    receiver === TYPE_Any ||
    !traits.subtypeOf(t, <u32>receiver) ||
    !domain.machineCompatible(<i32>t, receiver)
  ) {
    if (domain.isMachineType(<i32>t) || receiver !== domain.objectType()) {
      return false;
    }
  }

  const oStart = traits.paramStart[o];
  const vStart = traits.paramStart[virt];
  for (let p: u32 = 0; p < traits.paramCount[o]; p++) {
    if (traits.paramType[oStart + p] !== traits.paramType[vStart + p]) {
      return false;
    }
  }

  return true;
}

/**
 * As TraitsBindings::checkLegalInterfaces: t implements every member of
 * every interface it has, with the interface's signatures.
 */
export function checkInterfaces(
  traits: TraitsTable,
  domain: Domain,
  t: u32,
  interfaces: u32[],
): bool {
  const dispatch = traits.dispatchStart[t];
  for (let k = 0; k < interfaces.length; k++) {
    const ifc = interfaces[k];
    const ifcDispatch = traits.dispatchStart[ifc];
    const last = traits.memberEnd[ifc];
    for (let m = traits.memberStart[ifc]; m < last; m++) {
      const iBinding = traits.memberBinding[m];
      const cBinding = traits.find(
        t,
        traits.memberNs[m],
        traits.memberName[m],
        traits.memberVersion[m],
      );
      const iKind = iBinding & 7;
      if (!compatibleKind(iKind, cBinding & 7)) {
        return false;
      }

      const iId = iBinding >> 3;
      const cId = cBinding >> 3;
      if (iKind === BKIND_Method) {
        const virt = traits.dispatch[ifcDispatch + iId];
        const over = traits.dispatch[dispatch + cId];
        if (virt >= 0 && !checkOverride(traits, domain, t, <u32>virt, over)) {
          return false;
        }

        continue;
      }

      if (hasGetter(iBinding)) {
        const virt = traits.dispatch[ifcDispatch + iId];
        const over = traits.dispatch[dispatch + cId];
        if (
          !hasGetter(cBinding) ||
          (virt >= 0 && !checkOverride(traits, domain, t, <u32>virt, over))
        ) {
          return false;
        }
      }

      if (hasSetter(iBinding)) {
        const virt = traits.dispatch[ifcDispatch + iId + 1];
        const over = traits.dispatch[dispatch + cId + 1];
        if (
          !hasSetter(cBinding) ||
          (virt >= 0 && !checkOverride(traits, domain, t, <u32>virt, over))
        ) {
          return false;
        }
      }
    }
  }

  return true;
}
