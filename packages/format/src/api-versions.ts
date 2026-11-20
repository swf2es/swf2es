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
 * avmshell's -api names them (0, VM_ALLVERSIONS, which a Flash Player root
 * of SWF 9 runs at, up to AIR_API_VERSION); else a RangeError, so that the
 * compiler, which keeps a byte, and the runtime never take two different
 * versions for one.
 */
export function checkApiVersion(version: number): number {
  if (!Number.isInteger(version) || version < 0 || version >= API_INTERNAL) {
    throw new RangeError(`swf2es: no ABC runs at API version ${version}`);
  }

  return version;
}

/**
 * Whether an API version is of AIR's series: from FP_10_2 (10) up the odd
 * ones; below, all but FP_10_0 (2), FP_10_0_32 (5) and FP_10_1 (7), as
 * api-versions.h interleaves them. VM_ALLVERSIONS (0), in both, counts as
 * Flash Player's, which is the series a root that runs at it has.
 */
export function isAirApiVersion(version: number): boolean {
  if (version >= 10) {
    return (version & 1) === 1;
  }

  return version !== 0 && version !== 2 && version !== 5 && version !== 7;
}

/**
 * The API version of a root SWF of each version, by series: Flash
 * Player's by api-versions.h's names, AIR's as adl (AIR 51.5) runs such a
 * root, by which marked names it sees, for SWF 9 to 26; past 26 no name is
 * marked later to tell, and the rows go on as before. A row per SWF
 * version, from 9 up; a version below the first row runs at the first
 * row's, one past the last at the series' latest, so measuring a later
 * player extends the table by rows.
 */
const BY_SWF_VERSION: readonly (readonly [swf: number, flashPlayer: number, air: number])[] = [
  [9, 0, 1], // VM_ALLVERSIONS, AIR_1_0
  [10, 7, 9], // FP_10_1, AIR_2_5 (Ruffle has AIR_2_0; adl shows AIR 2.5's names)
  [11, 10, 11], // FP_10_2, AIR_2_6
  [12, 12, 13], // SWF_12, AIR_2_7
  [13, 14, 15],
  [14, 16, 17],
  [15, 18, 19],
  [16, 20, 21],
  [17, 22, 23],
  [18, 24, 25],
  [19, 26, 27],
  [20, 28, 29],
  [21, 30, 31],
  [22, 32, 33],
  [23, 34, 35],
  [24, 36, 37],
  [25, 38, 39],
  [26, 40, 41],
  [27, 42, 43],
  [28, 44, 45],
  [29, 46, 47],
  [30, 48, 49],
  [31, 50, 51], // SWF_31, AIR_20_0
];

/**
 * The API version a root SWF of `swfVersion` runs at, and everything it
 * loads with it, in Flash Player's series or, with `air`, AIR's.
 */
export function apiVersionOf(swfVersion: number, air = false): number {
  const first = BY_SWF_VERSION[0][0];
  const row =
    BY_SWF_VERSION[Math.max(Math.trunc(swfVersion), first) - first] ??
    BY_SWF_VERSION[BY_SWF_VERSION.length - 1];

  return air ? row[2] : row[1];
}
