// The API versions of avmplus' core/api-versions.h that hosts run ABCs at,
// in one place for the compiler and the runtime, which must agree: a
// version names a series of names, Flash Player's or AIR's, which
// alternate, and what code of that version sees in it.

/** Flash Player's latest, SWF_31: what a browser's SWFs, and avmshell's by default, run at. */
export const API_VERSION = 50;

/** AIR's latest, AIR_20_0: what an AIR host's SWFs run at. */
export const AIR_API_VERSION = 51;

/** VM_INTERNAL, which no ABC runs at: the first version past both series. */
const API_INTERNAL = 52;

/**
 * `version` if ABCs can run at it, a version of either series, as
 * avmshell's -api names them (1, AIR_1_0, up to AIR_API_VERSION); else a
 * RangeError, so that the compiler, which keeps a byte, and the runtime
 * never take two different versions for one.
 */
export function checkApiVersion(version: number): number {
  if (!Number.isInteger(version) || version < 1 || version >= API_INTERNAL) {
    throw new RangeError(`swf2es: no ABC runs at API version ${version}`);
  }

  return version;
}
