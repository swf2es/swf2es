// traits_info, checked like avmplus' parseTraits. Name clashes, overrides and
// slot layout (Traits::verifyBindings) need the base class, which may live in
// another ABC, so they are checked when classes are linked.
import { Abc } from "./abc";
import * as C from "./constants";
import { ConstantPool } from "./pool";
import { Reader } from "./reader";

/**
 * Read the traits of `owner`. Class traits may only name classes below
 * `classesDefined`: avmplus defines classes one by one while parsing.
 */
export function readTraits(abc: Abc, r: Reader, owner: i32, classesDefined: u32): bool {
  const count = r.u30();
  if (<usize>count > r.end - r.pos) {
    return abc.fail(C.kCorruptABCError);
  }

  const first = abc.traitName.length;
  for (let i: u32 = 0; i < count; i++) {
    const name = r.u30();
    if (r.failed) {
      return abc.fail(C.kCorruptABCError);
    }

    const nameError = bindingNameError(abc.pool, name, abc.builtin);
    if (nameError) {
      return abc.fail(nameError);
    }

    const tag = <u8>r.u8();
    const kind = tag & 0x0f;
    let id: u32 = 0;
    let index: u32 = 0;
    let value: u32 = 0;
    let valueKind: u8 = 0;
    if (kind === C.TRAIT_Slot || kind === C.TRAIT_Const) {
      id = r.u30();
      index = r.u30();
      value = r.u30();
      if (value) {
        valueKind = <u8>r.u8();
      }
    } else if (
      kind === C.TRAIT_Class ||
      kind === C.TRAIT_Method ||
      kind === C.TRAIT_Getter ||
      kind === C.TRAIT_Setter
    ) {
      id = r.u30();
      index = r.u30();
    } else {
      return abc.fail(r.failed ? C.kCorruptABCError : C.kUnsupportedTraitsKindError);
    }

    abc.traitMetadataStart.push(abc.traitMetadata.length);
    if (tag & C.ATTR_Metadata) {
      const metadataCount = r.u30();
      for (let j: u32 = 0; j < metadataCount; j++) {
        const metadata = r.u30();
        if (r.failed || metadata >= abc.metadataCount) {
          return abc.fail(C.kCorruptABCError);
        }

        abc.traitMetadata.push(metadata);
      }
    }

    if (r.failed) {
      return abc.fail(C.kCorruptABCError);
    }

    if (kind === C.TRAIT_Class) {
      if (index >= abc.classCount) {
        return abc.fail(C.kClassInfoExceedsCountError);
      }

      if (index >= classesDefined) {
        return abc.fail(C.kClassInfoOrderError);
      }
    } else if (kind === C.TRAIT_Method || kind === C.TRAIT_Getter || kind === C.TRAIT_Setter) {
      if (index >= abc.methodCount) {
        return abc.fail(C.kMethodInfoExceedsCountError);
      }
    }

    abc.traitName.push(name);
    abc.traitTag.push(tag);
    abc.traitId.push(id);
    abc.traitIndex.push(index);
    abc.traitValue.push(value);
    abc.traitValueKind.push(valueKind);
  }

  // As avmplus' makeMethodOf: a method belongs to at most one owner.
  for (let t = first; t < abc.traitName.length; t++) {
    const kind = abc.traitTag[t] & 0x0f;
    if (kind === C.TRAIT_Method || kind === C.TRAIT_Getter || kind === C.TRAIT_Setter) {
      const method = abc.traitIndex[t];
      if (abc.methodOwner[method] !== -1) {
        return abc.fail(C.kCorruptABCError);
      }

      abc.methodOwner[method] = owner;
    }
  }

  return true;
}

/**
 * 0 if multiname `index` can name a trait or class: a QName with a namespace
 * and a name, or in a builtin ABC also a Multiname with a name, whose
 * namespaces are the API versions that introduce it. A TypeName stands for
 * its base, as avmplus parses it.
 */
export function bindingNameError(pool: ConstantPool, index: u32, builtin: bool): i32 {
  if (index === 0 || index >= pool.multinameCount) {
    return C.kCpoolIndexRangeError;
  }

  let mn = index;
  if (pool.mnKind[mn] === C.CONSTANT_TypeName) {
    mn = pool.mnA[mn];
  }

  const kind = pool.mnKind[mn];
  if (builtin && kind === C.CONSTANT_Multiname && pool.mnB[mn] !== 0) {
    return 0;
  }

  if (kind !== C.CONSTANT_Qname || pool.mnA[mn] === 0 || pool.mnB[mn] === 0) {
    return C.kCpoolEntryWrongTypeError;
  }

  return 0;
}
