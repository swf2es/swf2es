// The constant pool (AVM2 overview 4.3), checked like avmplus'
// AbcParser::parseCpool so the same ABC is accepted or rejected.
import * as C from "./constants";
import { Reader } from "./reader";

/**
 * Flat tables indexed like the ABC's pools; entry 0 of each is the implicit
 * default. Strings stay byte ranges into the ABC, so only the names codegen
 * uses get decoded.
 */
@final
export class ConstantPool {
  /** 0, or the VerifyError number avmplus would throw. */
  error: i32 = 0;

  ints: StaticArray<i32> = new StaticArray<i32>(1);
  uints: StaticArray<u32> = new StaticArray<u32>(1);
  doubles: StaticArray<f64> = new StaticArray<f64>(1);

  /** Offset from the start of the ABC, and byte length, of each string. */
  stringStart: StaticArray<u32> = new StaticArray<u32>(1);
  stringLength: StaticArray<u32> = new StaticArray<u32>(1);

  nsKind: StaticArray<u8> = new StaticArray<u8>(1);
  /** String index of the namespace URI; 0 if it has none. */
  nsName: StaticArray<u32> = new StaticArray<u32>(1);

  /** Set i is nsSetMembers[nsSetStart[i] .. nsSetStart[i + 1]]. */
  nsSetStart: StaticArray<u32> = new StaticArray<u32>(2);
  nsSetMembers: StaticArray<u32> = new StaticArray<u32>(0);

  mnKind: StaticArray<u8> = new StaticArray<u8>(1);
  /** Namespace (QName), namespace set (Multiname) or base type (TypeName). */
  mnA: StaticArray<u32> = new StaticArray<u32>(1);
  /** Name string (QName, RTQName, Multiname) or type parameter (TypeName). */
  mnB: StaticArray<u32> = new StaticArray<u32>(1);

  @inline
  get stringCount(): u32 {
    return this.stringStart.length;
  }

  @inline
  get nsCount(): u32 {
    return this.nsKind.length;
  }

  @inline
  get nsSetCount(): u32 {
    return this.nsSetStart.length - 1;
  }

  @inline
  get multinameCount(): u32 {
    return this.mnKind.length;
  }
}

/** Read the constant pool at `r`; `base` is the start of the ABC. */
export function readConstantPool(r: Reader, base: usize): ConstantPool {
  const pool = new ConstantPool();

  const intCount = readCount(r);
  pool.ints = new StaticArray<i32>(max(intCount, 1));
  for (let i: u32 = 1; i < intCount; i++) {
    pool.ints[i] = r.s32();
  }

  const uintCount = readCount(r);
  pool.uints = new StaticArray<u32>(max(uintCount, 1));
  for (let i: u32 = 1; i < uintCount; i++) {
    pool.uints[i] = r.u32();
  }

  const doubleCount = readCount(r);
  pool.doubles = new StaticArray<f64>(max(doubleCount, 1));
  pool.doubles[0] = NaN;
  for (let i: u32 = 1; i < doubleCount; i++) {
    pool.doubles[i] = r.d64();
  }

  if (r.failed) {
    return fail(pool, C.kCorruptABCError);
  }

  const stringCount = max(readCount(r), 1);
  pool.stringStart = new StaticArray<u32>(stringCount);
  pool.stringLength = new StaticArray<u32>(stringCount);
  for (let i: u32 = 1; i < stringCount; i++) {
    // As avmplus: a string may not end at the end of the ABC, and its
    // UTF-8 is not validated.
    const length = r.u32();
    if (length & 0xc0000000 || <u64>r.pos + length >= r.end) {
      return fail(pool, C.kCorruptABCError);
    }

    pool.stringStart[i] = <u32>(r.pos - base);
    pool.stringLength[i] = length;
    r.pos += length;
  }

  const nsCount = max(readCount(r), 1);
  pool.nsKind = new StaticArray<u8>(nsCount);
  pool.nsName = new StaticArray<u32>(nsCount);
  for (let i: u32 = 1; i < nsCount; i++) {
    const kind = <u8>r.u8();
    if (!isNamespaceKind(kind)) {
      return fail(pool, r.failed ? C.kCorruptABCError : C.kCpoolEntryWrongTypeError);
    }

    const name = r.u30();
    if (name >= stringCount) {
      return fail(pool, C.kCpoolIndexRangeError);
    }

    pool.nsKind[i] = kind;
    pool.nsName[i] = name;
  }

  const nsSetCount = max(readCount(r), 1);
  pool.nsSetStart = new StaticArray<u32>(nsSetCount + 1);
  const members: u32[] = [];
  for (let i: u32 = 1; i < nsSetCount; i++) {
    pool.nsSetStart[i] = members.length;
    const count = readCount(r);
    for (let j: u32 = 0; j < count; j++) {
      const ns = r.u30();
      if (ns === 0) {
        return fail(pool, r.failed ? C.kCorruptABCError : C.kIllegalNamespaceError);
      }

      if (ns >= nsCount) {
        return fail(pool, C.kCpoolIndexRangeError);
      }

      members.push(ns);
    }
  }
  pool.nsSetStart[nsSetCount] = members.length;
  pool.nsSetMembers = StaticArray.fromArray(members);

  const mnCount = max(readCount(r), 1);
  pool.mnKind = new StaticArray<u8>(mnCount);
  pool.mnA = new StaticArray<u32>(mnCount);
  pool.mnB = new StaticArray<u32>(mnCount);
  for (let i: u32 = 1; i < mnCount; i++) {
    const kind = <u8>r.u8();
    let a: u32 = 0;
    let b: u32 = 0;
    switch (kind) {
      case C.CONSTANT_Qname:
      case C.CONSTANT_QnameA:
        a = r.u30();
        b = r.u30();
        if (a >= nsCount || b >= stringCount) {
          return fail(pool, C.kCpoolIndexRangeError);
        }
        break;
      case C.CONSTANT_RTQname:
      case C.CONSTANT_RTQnameA:
        b = r.u30();
        if (b >= stringCount) {
          return fail(pool, C.kCpoolIndexRangeError);
        }
        break;
      case C.CONSTANT_RTQnameL:
      case C.CONSTANT_RTQnameLA:
        // No operands: both come from the stack.
        break;
      case C.CONSTANT_Multiname:
      case C.CONSTANT_MultinameA:
        b = r.u30();
        if (b >= stringCount) {
          return fail(pool, C.kCpoolIndexRangeError);
        }

        a = r.u30();
        if (a === 0 || a >= nsSetCount) {
          return fail(pool, C.kCpoolIndexRangeError);
        }
        break;
      case C.CONSTANT_MultinameL:
      case C.CONSTANT_MultinameLA:
        a = r.u30();
        if (a === 0 || a >= nsSetCount) {
          return fail(pool, C.kCpoolIndexRangeError);
        }
        break;
      case C.CONSTANT_TypeName:
        // Forward references are legal; the base kind is checked below.
        a = r.u30();
        if (a === 0 || a >= mnCount) {
          return fail(pool, C.kCpoolIndexRangeError);
        }

        if (r.u30() !== 1) {
          return fail(pool, C.kCorruptABCError);
        }

        // Parameter 0 is Vector.<*>.
        b = r.u30();
        if (b >= mnCount) {
          return fail(pool, C.kCpoolIndexRangeError);
        }
        break;
      default:
        return fail(pool, r.failed ? C.kCorruptABCError : C.kCpoolEntryWrongTypeError);
    }

    pool.mnKind[i] = kind;
    pool.mnA[i] = a;
    pool.mnB[i] = b;
  }

  if (r.failed) {
    return fail(pool, C.kCorruptABCError);
  }

  if (!typeNamesAreAcyclic(pool)) {
    return fail(pool, C.kCorruptABCError);
  }

  return pool;
}

/** A pool count; more entries than bytes left is corrupt, which bounds allocations. */
function readCount(r: Reader): u32 {
  const count = r.u30();
  if (<usize>count > r.end - r.pos) {
    r.failed = true;
    r.pos = r.end;
    return 0;
  }

  return count;
}

function isNamespaceKind(kind: u8): bool {
  return (
    kind === C.CONSTANT_Namespace ||
    kind === C.CONSTANT_PackageNamespace ||
    kind === C.CONSTANT_PackageInternalNs ||
    kind === C.CONSTANT_ProtectedNamespace ||
    kind === C.CONSTANT_ExplicitNamespace ||
    kind === C.CONSTANT_StaticProtectedNs ||
    kind === C.CONSTANT_PrivateNs
  );
}

/**
 * A TypeName may not parameterize another TypeName, and chains like
 * Vector.<Vector.<T>> may not loop. Stamping visited entries with the
 * TypeName being checked avoids clearing a set per TypeName.
 */
function typeNamesAreAcyclic(pool: ConstantPool): bool {
  const count = pool.multinameCount;
  const stamp = new StaticArray<u32>(count);
  for (let i: u32 = 1; i < count; i++) {
    if (pool.mnKind[i] !== C.CONSTANT_TypeName) {
      continue;
    }

    if (pool.mnKind[pool.mnA[i]] === C.CONSTANT_TypeName) {
      return false;
    }

    let param = pool.mnB[i];
    while (param !== 0) {
      stamp[param] = i;
      if (pool.mnKind[param] !== C.CONSTANT_TypeName) {
        break;
      }

      param = pool.mnB[param];
      if (stamp[param] === i) {
        return false;
      }
    }
  }

  return true;
}

function fail(pool: ConstantPool, error: i32): ConstantPool {
  pool.error = error;
  return pool;
}
