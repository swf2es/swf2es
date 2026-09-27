import { Abc } from "./abc";
import { readClasses, readInstances, readScripts } from "./classes";
import { kCorruptABCError } from "./constants";
import { readMetadata, readMethods } from "./methods";
import { readConstantPool } from "./pool";
import { Reader } from "./reader";

/**
 * Parse the ABC block at `base`, which must be followed by PADDING readable
 * bytes. Check `error` on the result: 0, or the VerifyError avmplus would throw.
 */
export function readAbc(base: usize, length: u32): Abc {
  const abc = new Abc();
  const r = new Reader(base, base + length);
  abc.minorVersion = r.u16();
  abc.majorVersion = r.u16();
  if (r.failed) {
    abc.fail(kCorruptABCError);
    return abc;
  }

  abc.pool = readConstantPool(r, base);
  if (abc.pool.error) {
    abc.fail(abc.pool.error);
    return abc;
  }

  if (
    !readMethods(abc, r) ||
    !readMetadata(abc, r) ||
    !readInstances(abc, r) ||
    !readClasses(abc, r) ||
    !readScripts(abc, r)
  ) {
    return abc;
  }

  // A read past the end returns 0, which can look like an empty table.
  if (r.failed) {
    abc.fail(kCorruptABCError);
    return abc;
  }

  abc.traitMetadataStart.push(abc.traitMetadata.length);
  return abc;
}
