// method_body_info, checked like avmplus' parseMethodBodies. Stack, local and
// scope sizes, exception ranges and catch types are checked when the method
// is verified.
import { Abc } from "./abc";
import * as C from "./constants";
import { Reader } from "./reader";
import { readTraits } from "./traits";

export function readMethodBodies(abc: Abc, r: Reader, base: usize): bool {
  abc.methodBody = new StaticArray<i32>(abc.methodCount);
  for (let m: u32 = 0; m < abc.methodCount; m++) {
    abc.methodBody[m] = -1;
  }

  // avmplus does not bound the count, so the tables grow body by body.
  const count = r.u30();
  for (let i: u32 = 0; i < count; i++) {
    const method = r.u30();
    if (r.failed) {
      return abc.fail(C.kCorruptABCError);
    }

    if (method >= abc.methodCount) {
      return abc.fail(C.kMethodInfoExceedsCountError);
    }

    const maxStack = r.u30();
    const localCount = r.u30();
    const initScopeDepth = r.u30();
    const maxScopeDepth = r.u30();
    const codeLength = r.u30();
    if (r.failed) {
      return abc.fail(C.kCorruptABCError);
    }

    if (codeLength === 0) {
      return abc.fail(C.kInvalidCodeLengthError);
    }

    if (<u64>r.pos + codeLength >= r.end) {
      return abc.fail(C.kCorruptABCError);
    }

    const codeStart = <u32>(r.pos - base);
    r.pos += codeLength;

    const exceptionStart = abc.exceptionFrom.length;
    const exceptionCount = r.u30();
    for (let j: u32 = 0; j < exceptionCount; j++) {
      abc.exceptionFrom.push(r.u30());
      abc.exceptionTo.push(r.u30());
      abc.exceptionTarget.push(r.u30());
      abc.exceptionType.push(r.u30());
      const name = r.u30();
      if (r.failed) {
        return abc.fail(C.kCorruptABCError);
      }

      if (name >= abc.pool.multinameCount) {
        return abc.fail(C.kCpoolIndexRangeError);
      }

      abc.exceptionName.push(name);
    }

    const owner = abc.methodOwner[method];
    if (
      owner >= 0 &&
      <u32>owner < abc.classCount &&
      abc.instanceFlags[owner] & C.INSTANCE_Interface
    ) {
      return abc.fail(C.kIllegalInterfaceMethodBodyError);
    }

    if (abc.methodBody[method] !== -1) {
      return abc.fail(C.kDuplicateMethodBodyError);
    }

    abc.methodBody[method] = <i32>abc.bodyMethod.length;
    abc.bodyMethod.push(method);
    abc.bodyMaxStack.push(maxStack);
    abc.bodyLocalCount.push(localCount);
    abc.bodyInitScopeDepth.push(initScopeDepth);
    abc.bodyMaxScopeDepth.push(maxScopeDepth);
    abc.bodyCodeStart.push(codeStart);
    abc.bodyCodeLength.push(codeLength);
    abc.bodyExceptionStart.push(exceptionStart);
    abc.bodyTraitStart.push(abc.traitName.length);

    // Every body has a traits list, empty unless the method needs an activation.
    if (!readTraits(abc, r, abc.activationOwner(method), abc.classCount)) {
      return false;
    }
  }

  abc.bodyExceptionStart.push(abc.exceptionFrom.length);
  abc.bodyTraitStart.push(abc.traitName.length);
  return true;
}
