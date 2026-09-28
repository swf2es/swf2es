// method_info and metadata_info, checked like avmplus' parseMethodInfos and
// parseMetadataInfos.
import { Abc } from "./abc";
import * as C from "./constants";
import { Reader } from "./reader";

export function readMethods(abc: Abc, r: Reader): bool {
  const count = r.u30();
  if (<usize>max(count, 1) > r.end - r.pos) {
    return abc.fail(C.kCorruptABCError);
  }

  abc.methodReturnType = new StaticArray<u32>(count);
  abc.methodName = new StaticArray<u32>(count);
  abc.methodFlags = new StaticArray<u8>(count);
  abc.methodParamStart = new StaticArray<u32>(count + 1);
  abc.methodOptionalStart = new StaticArray<u32>(count + 1);
  abc.methodOwner = new StaticArray<i32>(count);

  for (let i: u32 = 0; i < count; i++) {
    abc.methodOwner[i] = -1;

    const paramCount = r.u30();
    abc.methodReturnType[i] = r.u30();
    abc.methodParamStart[i] = abc.paramTypes.length;
    for (let j: u32 = 0; j < paramCount && !r.failed; j++) {
      abc.paramTypes.push(r.u30());
    }

    abc.methodName[i] = r.u30();
    const flags = <u8>r.u8();
    if (r.failed) {
      return abc.fail(C.kCorruptABCError);
    }

    if (flags & C.METHOD_Native && !abc.builtin) {
      return abc.fail(C.kIllegalNativeMethodError);
    }

    abc.methodFlags[i] = flags;
    abc.methodOptionalStart[i] = abc.optionalValue.length;
    if (flags & C.METHOD_HasOptional) {
      const optionalCount = r.u30();
      for (let j: u32 = 0; j < optionalCount && !r.failed; j++) {
        abc.optionalValue.push(r.u30());
        abc.optionalKind.push(<u8>r.u8());
      }

      if (optionalCount === 0 || optionalCount > paramCount) {
        return abc.fail(C.kCorruptABCError);
      }
    }

    // Parameter names are debug information; skip them.
    if (flags & C.METHOD_HasParamNames) {
      for (let j: u32 = 0; j < paramCount && !r.failed; j++) {
        r.u30();
      }
    }

    if (r.failed) {
      return abc.fail(C.kCorruptABCError);
    }
  }

  abc.methodParamStart[count] = abc.paramTypes.length;
  abc.methodOptionalStart[count] = abc.optionalValue.length;
  return true;
}

export function readMetadata(abc: Abc, r: Reader): bool {
  const count = r.u30();
  if (<usize>count > r.end - r.pos) {
    return abc.fail(C.kCorruptABCError);
  }

  abc.metadataName = new StaticArray<u32>(count);
  abc.metadataItemStart = new StaticArray<u32>(count + 1);

  for (let i: u32 = 0; i < count; i++) {
    const name = r.u30();
    if (r.failed) {
      return abc.fail(C.kCorruptABCError);
    }

    if (name === 0 || name >= abc.pool.stringCount) {
      return abc.fail(C.kCpoolIndexRangeError);
    }

    abc.metadataName[i] = name;
    abc.metadataItemStart[i] = abc.metadataKey.length;

    // Keys and values are string indices that avmplus does not check.
    const itemCount = r.u30();
    for (let j: u32 = 0; j < itemCount && !r.failed; j++) {
      abc.metadataKey.push(r.u30());
      abc.metadataValue.push(r.u30());
    }

    if (r.failed) {
      return abc.fail(C.kCorruptABCError);
    }
  }

  abc.metadataItemStart[count] = abc.metadataKey.length;
  return true;
}
