// Class names and the types they name, as avmplus' PoolObject and DomainMgr
// resolve them: a type name to a class an earlier ABC's script defines, or
// one of the ABC's own while it links, Vector.<T> made for each T, and the
// names of an ABC's classes made visible once it has linked.

import * as C from "../abc/constants";
import { API_Internal, Domain, NS_Private } from "./domain";
import { hashPair } from "./table";
import {
  BUILTIN_Any,
  BUILTIN_Int,
  BUILTIN_Number,
  BUILTIN_Uint,
  TRAITS_Instance,
  TYPE_Any,
} from "./traits";

/**
 * As PoolObject::resolveTypeName for a slot or parameter type: TYPE_Any
 * for index 0, or the type; below TYPE_Any on failure, with typeError set.
 */
export function resolveTypeId(dom: Domain, index: u32, mn: u32, allowVoid: bool): i32 {
  if (mn === 0) {
    return TYPE_Any;
  }

  const pool = dom.abcs[index].pool;
  if (mn >= pool.multinameCount) {
    dom.typeError = C.kCpoolIndexRangeError;
    return -2;
  }

  if (pool.mnKind[mn] === C.CONSTANT_TypeName) {
    const base = resolveType(dom, index, pool.mnA[mn]);
    if (base === -C.kAmbiguousBindingError) {
      dom.typeError = C.kAmbiguousBindingError;
      return -2;
    }

    const param = resolveTypeId(dom, index, pool.mnB[mn], false);
    if (param < TYPE_Any) {
      return param;
    }

    const t = base >= 0 ? parameterized(dom, base, param) : -1;
    if (t < 0) {
      dom.typeError = C.kClassNotFoundError;
      return -2;
    }

    return t;
  }

  const c = resolveType(dom, index, mn);
  if (c === -C.kIllegalVoidError) {
    if (allowVoid) {
      return dom.voidType;
    }

    dom.typeError = C.kIllegalVoidError;
    return -2;
  }

  if (c < 0) {
    dom.typeError = -c;
    return -2;
  }

  return dom.classTraits[c];
}

/**
 * As PoolObject::resolveParameterizedType: Vector.<T>, which avmplus has
 * as its own classes for int, uint, Number and *, and otherwise makes as
 * a subclass of Vector.<*>; -1 if `base` is not Vector.
 */
export function parameterized(dom: Domain, base: i32, param: i32): i32 {
  if (base !== dom.vectorClass || base < 0) {
    return -1;
  }

  const bt = dom.builtin(param);
  if (bt === BUILTIN_Any) {
    return dom.vectorObjectType;
  }

  if (bt === BUILTIN_Int) {
    return dom.vectorIntType;
  }

  if (bt === BUILTIN_Uint) {
    return dom.vectorUintType;
  }

  if (bt === BUILTIN_Number) {
    return dom.vectorDoubleType;
  }

  if (dom.vectorOf.has(param)) {
    return dom.vectorOf.get(param);
  }

  // As Traits::newParameterizedITraits: a subclass of Vector.<*> with no members of its own.
  const traits = dom.traits;
  const objects = <u32>dom.vectorObjectType;
  const t = traits.create(
    TRAITS_Instance,
    traits.abc[objects],
    traits.owner[objects],
    <i32>objects,
    -1,
    0,
    0,
  );
  traits.param[t] = param;
  traits.slotCount[t] = traits.slotCount[objects];
  traits.methodCount[t] = traits.methodCount[objects];
  traits.memberStart[t] = traits.memberTraits.length;
  traits.memberEnd[t] = traits.memberTraits.length;
  dom.vectorOf.set(param, <i32>t);
  return <i32>t;
}

/**
 * As PoolObject::resolveTypeName for a base class or interface: the class
 * id, or minus the error: 1014 if nothing matches, 1008 if two classes do,
 * 1022 for void.
 */
export function resolveType(dom: Domain, index: u32, mn: u32): i32 {
  const abc = dom.abcs[index];
  const pool = abc.pool;
  const kind = pool.mnKind[mn];
  if (kind === C.CONSTANT_TypeName) {
    const base = resolveType(dom, index, pool.mnA[mn]);
    const param = pool.mnB[mn];
    if (base >= 0 && param) {
      const t = resolveType(dom, index, param);
      if (t < 0) {
        return t;
      }
    }

    return base;
  }

  const strings = dom.abcString[index];
  const ids = dom.abcNs[index];
  const versions = dom.abcNsVersion[index];
  const nameIndex = pool.mnB[mn];
  let found: i32 = -1;
  if (kind === C.CONSTANT_Qname && pool.mnA[mn] !== 0 && nameIndex !== 0) {
    const ns = pool.mnA[mn];
    found = findType(dom, index, ids[ns], strings[nameIndex], versions[ns]);
  } else if (kind === C.CONSTANT_Multiname && nameIndex !== 0) {
    const set = pool.mnA[mn];
    const last = pool.nsSetStart[set + 1];
    for (let m = pool.nsSetStart[set]; m < last; m++) {
      const ns = pool.nsSetMembers[m];
      const t = findType(dom, index, ids[ns], strings[nameIndex], versions[ns]);
      if (t >= 0 && found >= 0 && t !== found) {
        return -C.kAmbiguousBindingError;
      }

      if (t >= 0) {
        found = t;
      }
    }
  }

  if (found < 0) {
    return -C.kClassNotFoundError;
  }

  return found === dom.voidClass ? -C.kIllegalVoidError : found;
}

/**
 * As DomainMgr::findTraitsInPoolByNameAndNS for ABC `index`: a class a
 * script defines, else one of the ABC's own; -1 if none.
 */
function findType(dom: Domain, index: u32, ns: u32, name: u32, version: u8): i32 {
  const found = findTypeOf(dom, ns, name, version, -1, dom.abcDomain[index]);
  return found >= 0 ? found : findTypeOf(dom, ns, name, version, dom.abcOwner[index]);
}

/** A class name's class, of ABC `owner`'s own or else one `domain` sees; -1 if none. */
function findTypeOf(
  dom: Domain,
  ns: u32,
  name: u32,
  version: u8,
  owner: i32,
  domain: u32 = 0,
): i32 {
  if (owner < 0 && dom.domainParent.length > 1) {
    return dom.findTypeIn(ns, name, version, domain);
  }

  const hash = hashPair(ns, name);
  const table = dom.types;
  let slot = table.start(hash);
  while (true) {
    const id = table.at(slot);
    if (id < 0) {
      return -1;
    }

    if (
      dom.typeNs[id] === ns &&
      dom.typeName[id] === name &&
      dom.typeVersion[id] <= version &&
      dom.typeOwner[id] === owner
    ) {
      return <i32>dom.typeClass[id];
    }

    slot = table.next(slot);
  }
}

export function nameType(
  dom: Domain,
  ns: u32,
  name: u32,
  version: u8,
  id: i32,
  owner: i32,
  domain: u32,
): void {
  const type = <u32>dom.typeNs.length;
  dom.typeDomain.push(domain);
  dom.typeNs.push(ns);
  dom.typeName.push(name);
  dom.typeVersion.push(version);
  dom.typeClass.push(<u32>id);
  dom.typeOwner.push(owner);
  dom.types.insert(hashPair(ns, name), type);
}

/** As DomainMgr::addNamedInstanceTraits: instance i's name, unless something is already found by it. */
export function nameInstance(dom: Domain, index: u32, i: u32): void {
  const abc = dom.abcs[index];
  const pool = abc.pool;
  let mn = abc.instanceName[i];
  if (pool.mnKind[mn] === C.CONSTANT_TypeName) {
    mn = pool.mnA[mn];
  }

  let ns = pool.mnA[mn];
  if (pool.mnKind[mn] === C.CONSTANT_Multiname) {
    ns = pool.nsSetMembers[pool.nsSetStart[ns]];
  }

  const nsId = dom.abcNs[index][ns];
  const version = dom.abcNsVersion[index][ns];
  const name = dom.abcString[index][pool.mnB[mn]];
  if (findType(dom, index, nsId, name, version) < 0) {
    nameType(
      dom,
      nsId,
      name,
      version,
      <i32>(dom.classStart[index] + i),
      dom.abcOwner[index],
      dom.abcDomain[index],
    );
  }
}

/**
 * As AbcParser::addNamedTraits: every class a script of ABC `index`
 * defines, visible to all later ABCs unless the domain has the name already.
 */
export function addClassNames(dom: Domain, index: u32): void {
  const abc = dom.abcs[index];
  const pool = abc.pool;
  const ids = dom.abcNs[index];
  const versions = dom.abcNsVersion[index];
  const strings = dom.abcString[index];
  const first = abc.scriptTraitStart[0];
  const end = abc.scriptTraitStart[abc.scriptCount];
  for (let t = first; t < end; t++) {
    if ((abc.traitTag[t] & 0x0f) !== C.TRAIT_Class) {
      continue;
    }

    let mn = abc.traitName[t];
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

    const nsId = ids[ns];
    const name = strings[pool.mnB[mn]];
    const domain = dom.abcDomain[index];
    if (dom.nsType[nsId] !== NS_Private && findTypeOf(dom, nsId, name, version, -1, domain) < 0) {
      const id = dom.classStart[index] + abc.traitIndex[t];
      nameType(dom, nsId, name, version, <i32>id, -1, domain);
    }
  }
}
