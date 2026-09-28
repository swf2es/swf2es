import { Abc } from "./abc";
import { readMethodBodies } from "./bodies";
import { readClasses, readInstances, readScripts } from "./classes";
import { kCorruptABCError, kInvalidMagicError } from "./constants";
import { readMetadata, readMethods } from "./methods";
import { readConstantPool } from "./pool";
import { Reader } from "./reader";

/**
 * Parse the ABC block at `base`, which must be followed by PADDING readable
 * bytes; `builtin` for an ABC the player ships (see Abc.builtin). Check
 * `error` on the result: 0, or the VerifyError avmplus would throw.
 */
export function readAbc(base: usize, length: u32, builtin: bool = false): Abc {
  const abc = new Abc();
  abc.length = length;
  abc.builtin = builtin;
  const r = new Reader(base, base + length);
  abc.minorVersion = r.u16();
  abc.majorVersion = r.u16();
  if (r.failed) {
    abc.fail(kCorruptABCError);
    return abc;
  }

  if (!isSupportedVersion(abc.majorVersion, abc.minorVersion)) {
    abc.fail(kInvalidMagicError);
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
    !readScripts(abc, r) ||
    !readMethodBodies(abc, r, base)
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

/**
 * The versions avmplus' AbcParser::canParse accepts in Flash Player builds,
 * as the oracle's avmshell does: 46.16 and 47.12 to 47.18. All share the
 * 46.16 layout. HARMAN's AIR reads 47.16 with float constant pools, but Flash
 * Player never had float, so neither does swf2es.
 */
function isSupportedVersion(major: u32, minor: u32): bool {
  return (major === 46 && minor === 16) || (major === 47 && minor >= 12 && minor <= 18);
}
