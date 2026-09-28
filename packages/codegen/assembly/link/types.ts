// What the verifier asks of types: which binding a name has on a type, what
// type that binding holds, and how two types merge or assign.
import { CONSTANT_Multiname, CONSTANT_Qname, CONSTANT_TypeName } from "../abc/constants";
import { Domain } from "./domain";
import {
  BIND_None,
  BKIND_Const,
  BKIND_Get,
  BKIND_GetSet,
  BKIND_Var,
  BUILTIN_Int,
  BUILTIN_Number,
  BUILTIN_Uint,
  TRAITS_Null,
  TYPE_Any,
} from "./traits";

/** A name bound differently in two namespaces of a set it is looked up in. */
export const BIND_Ambiguous: u32 = 0xffffffff;

/**
 * As Multiname::isBinding: whether multiname `mn` of ABC `index` names
 * something that can be bound early, a name in known namespaces.
 */
export function isBindingName(domain: Domain, index: u32, mn: u32): bool {
  const pool = unchecked(domain.abcs[index]).pool;
  let kind = unchecked(pool.mnKind[mn]);
  if (kind === CONSTANT_TypeName) {
    mn = unchecked(pool.mnA[mn]);
    kind = unchecked(pool.mnKind[mn]);
  }

  if (kind === CONSTANT_Qname) {
    return unchecked(pool.mnA[mn]) !== 0 && unchecked(pool.mnB[mn]) !== 0;
  }

  return kind === CONSTANT_Multiname && unchecked(pool.mnB[mn]) !== 0;
}

/**
 * As avmplus' getBinding: the binding multiname `mn` of ABC `index` has on
 * `type`, BIND_None, or BIND_Ambiguous if it binds differently in two of
 * its namespaces. The type's own members are searched before its base's.
 */
export function getBinding(domain: Domain, index: u32, type: i32, mn: u32): u32 {
  if (type < 0 || !isBindingName(domain, index, mn)) {
    return BIND_None;
  }

  const pool = unchecked(domain.abcs[index]).pool;
  if (unchecked(pool.mnKind[mn]) === CONSTANT_TypeName) {
    mn = unchecked(pool.mnA[mn]);
  }

  const traits = domain.traits;
  const ids = unchecked(domain.abcNs[index]);
  const versions = unchecked(domain.abcNsVersion[index]);
  const name = unchecked(domain.abcString[index][pool.mnB[mn]]);
  if (unchecked(pool.mnKind[mn]) === CONSTANT_Qname) {
    const ns = unchecked(pool.mnA[mn]);
    return traits.find(type, unchecked(ids[ns]), name, unchecked(versions[ns]));
  }

  const set = unchecked(pool.mnA[mn]);
  const first = unchecked(pool.nsSetStart[set]);
  const last = unchecked(pool.nsSetStart[set + 1]);
  for (let t = type; t >= 0; t = unchecked(traits.base[t])) {
    let found = BIND_None;
    for (let m = first; m < last; m++) {
      const ns = unchecked(pool.nsSetMembers[m]);
      const b = traits.own(<u32>t, unchecked(ids[ns]), name, unchecked(versions[ns]));
      if (b === BIND_None) {
        continue;
      }

      if (found !== BIND_None && found !== b) {
        return BIND_Ambiguous;
      }

      found = b;
    }

    if (found !== BIND_None) {
      return found;
    }
  }

  return BIND_None;
}

/**
 * The binding multiname `mn` of ABC `index` has among t's own members, or
 * BIND_None; Domain.foundNs is then the namespace it was found in.
 */
export function getOwnBinding(domain: Domain, index: u32, t: u32, mn: u32): u32 {
  const pool = unchecked(domain.abcs[index]).pool;
  if (unchecked(pool.mnKind[mn]) === CONSTANT_TypeName) {
    mn = unchecked(pool.mnA[mn]);
  }

  const traits = domain.traits;
  const ids = unchecked(domain.abcNs[index]);
  const versions = unchecked(domain.abcNsVersion[index]);
  const name = unchecked(domain.abcString[index][pool.mnB[mn]]);
  if (unchecked(pool.mnKind[mn]) === CONSTANT_Qname) {
    const ns = unchecked(pool.mnA[mn]);
    domain.foundNs = <i32>unchecked(ids[ns]);
    return traits.own(t, unchecked(ids[ns]), name, unchecked(versions[ns]));
  }

  const set = unchecked(pool.mnA[mn]);
  for (let m = unchecked(pool.nsSetStart[set]); m < unchecked(pool.nsSetStart[set + 1]); m++) {
    const ns = unchecked(pool.nsSetMembers[m]);
    const b = traits.own(t, unchecked(ids[ns]), name, unchecked(versions[ns]));
    if (b !== BIND_None) {
      domain.foundNs = <i32>unchecked(ids[ns]);
      return b;
    }
  }

  return BIND_None;
}

/**
 * As Traits::readBinding: the type binding `b` holds on resolved `type`: a
 * slot's type, a getter's return type, and * for anything else.
 */
export function bindingType(domain: Domain, type: i32, b: u32): i32 {
  const kind = b & 7;
  const traits = domain.traits;
  if (kind === BKIND_Var || kind === BKIND_Const) {
    return unchecked(traits.slotType[traits.slotStart[type] + (b >> 3)]);
  }

  if (kind === BKIND_Get || kind === BKIND_GetSet) {
    const m = unchecked(traits.dispatch[traits.dispatchStart[type] + (b >> 3)]);
    return m < 0 ? TYPE_Any : unchecked(traits.returnType[m]);
  }

  return TYPE_Any;
}

/** As Verifier::findCommonBase: the nearest type both are, null merging with any non-machine type. */
export function commonBase(domain: Domain, a: i32, b: i32): i32 {
  if (a === b) {
    return a;
  }

  if (a === TYPE_Any || b === TYPE_Any) {
    return TYPE_Any;
  }

  const traits = domain.traits;
  if (unchecked(traits.kind[a]) === TRAITS_Null && !domain.isMachineType(b)) {
    return b;
  }

  if (unchecked(traits.kind[b]) === TRAITS_Null && !domain.isMachineType(a)) {
    return a;
  }

  for (let t = b; t >= 0; t = unchecked(traits.base[t])) {
    for (let s = a; s >= 0; s = unchecked(traits.base[s])) {
      if (s === t) {
        return t;
      }
    }
  }

  return TYPE_Any;
}

/** As Traits::canAssign: a value of type `rhs` is already of type `lhs`. */
export function canAssign(domain: Domain, lhs: i32, rhs: i32): bool {
  if (!domain.machineCompatible(lhs, rhs)) {
    return false;
  }

  if (lhs === TYPE_Any) {
    return true;
  }

  for (let t = rhs; t >= 0; t = unchecked(domain.traits.base[t])) {
    if (t === lhs) {
      return true;
    }
  }

  return false;
}

/** As Traits::isNumeric: int, uint or Number. */
export function isNumeric(domain: Domain, type: i32): bool {
  const bt = domain.builtin(type);
  return bt === BUILTIN_Int || bt === BUILTIN_Uint || bt === BUILTIN_Number;
}
