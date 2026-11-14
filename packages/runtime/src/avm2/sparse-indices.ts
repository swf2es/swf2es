// A sparse Array's indices, in order, which a for-in over it crosses each
// gap by (enumeration.ts): the list, and how it is taken and searched.

import type { Value } from "./descriptors.js";

/**
 * The indices of a sparse Array, in order, taken when a for-in first meets
 * a run of holes too long to step through, so that it crosses each gap by
 * them, and dropped when the for-in ends or another starts.
 */
export interface SparseIndices {
  indices: number[];
  /** The Array's length when they were last brought up to it. */
  length: number;
  /** Where in them the index last given is, and that index, so that the next step goes on from there. */
  at: number;
  given: number;
  /** How many were given since they were taken, and whether they were taken again since this for-in met them. */
  sinceTaken: number;
  retaken: boolean;
  /** Whether avmplus holds the Array's elements in its hashtable (see hashed). */
  hashed: boolean;
}

/** Take a sparse Array's indices again. */
export function retake(a: Value[], sparse: SparseIndices): void {
  sparse.indices = indicesOf(a, 0);
  sparse.length = a.length;
  sparse.at = -1;
  sparse.given = -1;
  sparse.sinceTaken = 0;
  // An Array in avmplus' hashtable never leaves it.
  sparse.hashed ||= hashed(sparse.indices);
}

/**
 * Whether avmplus holds an Array with these elements in its hashtable, as
 * it must when they span more than 32 slots and more than four times one
 * more than their count (ArrayObject's shouldBeSparse): its dense part
 * never holds so few over so many. Else avmplus may hold them dense,
 * walking them by index, as the for-in here does.
 */
export function hashed(indices: number[]): boolean {
  const n = indices.length;
  if (n === 0) {
    return false;
  }

  const span = indices[n - 1] - indices[0] + 1;
  return span > 32 && span > (n + 1) * 4;
}

/** An Array's indices from `from` on, in order, as Object.keys gives them, appended to `indices`. */
export function indicesOf(a: Value[], from: number, indices: number[] = []): number[] {
  const keys = Object.keys(a);
  for (let k = 0; k < keys.length; k++) {
    const i = Number(keys[k]);
    if (i >= from) {
      indices.push(i);
    }
  }

  return indices;
}

/** Where in `indices`, in order, the first at or after `from` is. */
export function firstAtOrAfter(indices: number[], from: number): number {
  let low = 0;
  let high = indices.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (indices[mid] < from) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }

  return low;
}
