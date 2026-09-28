// instance_info, class_info and script_info, checked like avmplus'
// parseInstanceInfos, parseClassInfos and parseScriptInfos.
import { Abc } from "./abc";
import {
  INSTANCE_ProtectedNs,
  kAlreadyBoundError,
  kCannotImplementError,
  kCorruptABCError,
  kCpoolIndexRangeError,
  kMethodInfoExceedsCountError,
} from "./constants";
import { Reader } from "./reader";
import { bindingNameError, readTraits } from "./traits";

export function readInstances(abc: Abc, r: Reader): bool {
  const count = r.u30();
  if (<usize>count > r.end - r.pos) {
    return abc.fail(kCorruptABCError);
  }

  abc.instanceName = new StaticArray<u32>(count);
  abc.instanceSuper = new StaticArray<u32>(count);
  abc.instanceFlags = new StaticArray<u8>(count);
  abc.instanceProtectedNs = new StaticArray<u32>(count);
  abc.instanceInterfaceStart = new StaticArray<u32>(count + 1);
  abc.instanceInit = new StaticArray<u32>(count);
  abc.instanceTraitStart = new StaticArray<u32>(count + 1);

  const pool = abc.pool;
  for (let i: u32 = 0; i < count; i++) {
    const name = r.u30();
    if (r.failed) {
      return abc.fail(kCorruptABCError);
    }

    const nameError = bindingNameError(pool, name, abc.builtin);
    if (nameError) {
      return abc.fail(nameError);
    }

    const base = r.u30();
    if (base >= pool.multinameCount) {
      return abc.fail(r.failed ? kCorruptABCError : kCpoolIndexRangeError);
    }

    const flags = <u8>r.u8();
    let protectedNs: u32 = 0;
    if (flags & INSTANCE_ProtectedNs) {
      protectedNs = r.u30();
      if (protectedNs >= pool.nsCount) {
        return abc.fail(r.failed ? kCorruptABCError : kCpoolIndexRangeError);
      }
    }

    const interfaceCount = r.u30();
    if (interfaceCount >= 0x10000000) {
      return abc.fail(kCorruptABCError);
    }

    abc.instanceInterfaceStart[i] = abc.interfaces.length;
    for (let j: u32 = 0; j < interfaceCount; j++) {
      const type = r.u30();
      if (r.failed) {
        return abc.fail(kCorruptABCError);
      }

      if (type === 0) {
        return abc.fail(kCannotImplementError);
      }

      if (type >= pool.multinameCount) {
        return abc.fail(kCpoolIndexRangeError);
      }

      abc.interfaces.push(type);
    }

    const init = r.u30();
    if (r.failed) {
      return abc.fail(kCorruptABCError);
    }

    if (init >= abc.methodCount) {
      return abc.fail(kMethodInfoExceedsCountError);
    }

    abc.instanceName[i] = name;
    abc.instanceSuper[i] = base;
    abc.instanceFlags[i] = flags;
    abc.instanceProtectedNs[i] = protectedNs;
    abc.instanceInit[i] = init;
    abc.instanceTraitStart[i] = abc.traitName.length;

    // No class is defined yet while instances are parsed.
    if (!readTraits(abc, r, abc.instanceOwner(i), 0) || !bind(abc, init, abc.instanceOwner(i))) {
      return false;
    }
  }

  abc.instanceInterfaceStart[count] = abc.interfaces.length;
  abc.instanceTraitStart[count] = abc.traitName.length;
  return true;
}

export function readClasses(abc: Abc, r: Reader): bool {
  const count = abc.classCount;
  abc.classInit = new StaticArray<u32>(count);
  abc.classTraitStart = new StaticArray<u32>(count + 1);

  for (let i: u32 = 0; i < count; i++) {
    const init = readMethodIndex(abc, r);
    if (init < 0) {
      return false;
    }

    abc.classInit[i] = <u32>init;
    abc.classTraitStart[i] = abc.traitName.length;

    // Class i's traits may name the classes before it.
    if (!readTraits(abc, r, abc.classOwner(i), i) || !bind(abc, <u32>init, abc.classOwner(i))) {
      return false;
    }
  }

  abc.classTraitStart[count] = abc.traitName.length;
  return true;
}

export function readScripts(abc: Abc, r: Reader): bool {
  const count = r.u30();
  if (<usize>count > r.end - r.pos) {
    return abc.fail(kCorruptABCError);
  }

  abc.scriptInit = new StaticArray<u32>(count);
  abc.scriptTraitStart = new StaticArray<u32>(count + 1);

  for (let i: u32 = 0; i < count; i++) {
    const init = readMethodIndex(abc, r);
    if (init < 0) {
      return false;
    }

    // Unlike instances and classes, a script checks its init before its traits.
    if (abc.methodOwner[init] !== -1) {
      return abc.fail(kAlreadyBoundError);
    }

    abc.scriptInit[i] = <u32>init;
    abc.scriptTraitStart[i] = abc.traitName.length;
    if (!readTraits(abc, r, abc.scriptOwner(i), abc.classCount)) {
      return false;
    }

    // A trait may already have bound the init; avmplus ignores that.
    if (abc.methodOwner[init] === -1) {
      abc.methodOwner[init] = abc.scriptOwner(i);
    }
  }

  abc.scriptTraitStart[count] = abc.traitName.length;
  return true;
}

/** A method index, or -1 after recording the error. */
function readMethodIndex(abc: Abc, r: Reader): i32 {
  const method = r.u30();
  if (r.failed) {
    abc.fail(kCorruptABCError);
    return -1;
  }

  if (method >= abc.methodCount) {
    abc.fail(kMethodInfoExceedsCountError);
    return -1;
  }

  return <i32>method;
}

/** Bind an instance or class initializer to its owner. */
function bind(abc: Abc, method: u32, owner: i32): bool {
  if (abc.methodOwner[method] !== -1) {
    return abc.fail(kAlreadyBoundError);
  }

  abc.methodOwner[method] = owner;
  return true;
}
