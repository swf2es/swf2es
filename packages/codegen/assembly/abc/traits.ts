// traits_info, checked like avmplus' parseTraits. Name clashes, overrides and
// slot layout (Traits::verifyBindings) need the base class, which may live in
// another ABC, so they are checked when classes are linked.
import { Abc } from "./abc";
import {
  ATTR_Metadata,
  CONSTANT_Qname,
  CONSTANT_TypeName,
  kClassInfoExceedsCountError,
  kClassInfoOrderError,
  kCorruptABCError,
  kCpoolEntryWrongTypeError,
  kCpoolIndexRangeError,
  kMethodInfoExceedsCountError,
  kUnsupportedTraitsKindError,
  TRAIT_Class,
  TRAIT_Const,
  TRAIT_Getter,
  TRAIT_Method,
  TRAIT_Setter,
  TRAIT_Slot,
} from "./constants";
import { ConstantPool } from "./pool";
import { Reader } from "./reader";

/**
 * Read the traits of `owner`. Class traits may only name classes below
 * `classesDefined`: avmplus defines classes one by one while parsing.
 */
export function readTraits(abc: Abc, r: Reader, owner: i32, classesDefined: u32): bool {
  const count = r.u30();
  if (<usize>count > r.end - r.pos) {
    return abc.fail(kCorruptABCError);
  }

  const first = abc.traitName.length;
  for (let i: u32 = 0; i < count; i++) {
    const name = r.u30();
    if (r.failed) {
      return abc.fail(kCorruptABCError);
    }

    const nameError = bindingNameError(abc.pool, name);
    if (nameError) {
      return abc.fail(nameError);
    }

    const tag = <u8>r.u8();
    const kind = tag & 0x0f;
    let id: u32 = 0;
    let index: u32 = 0;
    let value: u32 = 0;
    let valueKind: u8 = 0;
    if (kind === TRAIT_Slot || kind === TRAIT_Const) {
      id = r.u30();
      index = r.u30();
      value = r.u30();
      if (value) {
        valueKind = <u8>r.u8();
      }
    } else if (
      kind === TRAIT_Class ||
      kind === TRAIT_Method ||
      kind === TRAIT_Getter ||
      kind === TRAIT_Setter
    ) {
      id = r.u30();
      index = r.u30();
    } else {
      return abc.fail(r.failed ? kCorruptABCError : kUnsupportedTraitsKindError);
    }

    abc.traitMetadataStart.push(abc.traitMetadata.length);
    if (tag & ATTR_Metadata) {
      const metadataCount = r.u30();
      for (let j: u32 = 0; j < metadataCount; j++) {
        const metadata = r.u30();
        if (r.failed || metadata >= abc.metadataCount) {
          return abc.fail(kCorruptABCError);
        }

        abc.traitMetadata.push(metadata);
      }
    }

    if (r.failed) {
      return abc.fail(kCorruptABCError);
    }

    if (kind === TRAIT_Class) {
      if (index >= abc.classCount) {
        return abc.fail(kClassInfoExceedsCountError);
      }

      if (index >= classesDefined) {
        return abc.fail(kClassInfoOrderError);
      }
    } else if (kind === TRAIT_Method || kind === TRAIT_Getter || kind === TRAIT_Setter) {
      if (index >= abc.methodCount) {
        return abc.fail(kMethodInfoExceedsCountError);
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
    const kind = unchecked(abc.traitTag[t]) & 0x0f;
    if (kind === TRAIT_Method || kind === TRAIT_Getter || kind === TRAIT_Setter) {
      const method = unchecked(abc.traitIndex[t]);
      if (unchecked(abc.methodOwner[method]) !== -1) {
        return abc.fail(kCorruptABCError);
      }

      unchecked((abc.methodOwner[method] = owner));
    }
  }

  return true;
}

/**
 * 0 if multiname `index` can name a trait or class: a QName with a namespace
 * and a name. A TypeName stands for its base, as avmplus parses it.
 */
export function bindingNameError(pool: ConstantPool, index: u32): i32 {
  if (index === 0 || index >= pool.multinameCount) {
    return kCpoolIndexRangeError;
  }

  let mn = index;
  if (unchecked(pool.mnKind[mn]) === CONSTANT_TypeName) {
    mn = unchecked(pool.mnA[mn]);
  }

  if (
    unchecked(pool.mnKind[mn]) !== CONSTANT_Qname ||
    unchecked(pool.mnA[mn]) === 0 ||
    unchecked(pool.mnB[mn]) === 0
  ) {
    return kCpoolEntryWrongTypeError;
  }

  return 0;
}
