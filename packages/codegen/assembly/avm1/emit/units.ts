// Where a unit's home may reach (flow/regions.ts, BlockEmitter.unit): to
// the next bound of the action blocks past its offset, so that a block's
// own code, or the bytes between blocks, are compiled apart; within a
// window, as bitmaps' bytes between blocks may be long; and not past the
// end of its region. Any homes would do for what the code does: control
// that leaves one goes on in the next unit. These keep units few and small.

/** How far after its offset a unit's home reaches at most. */
export const UNIT_WINDOW: i32 = 1 << 15;

/**
 * The first bound of a block past `at` in a SWF of `size` bytes whose
 * blocks are `lengths[k]` bytes from `offsets[k]`, a block's start or its
 * end, else the SWF's end: where V.far's first choice of unit for control
 * at `at` ends its region and its bytes (module.ts).
 */
export function segmentEnd(offsets: Int32Array, lengths: Int32Array, size: i32, at: i32): i32 {
  let high = size;
  const count = min(offsets.length, lengths.length);
  for (let k = 0; k < count; k++) {
    const start = offsets[k];
    const length = lengths[k];
    if (start < 0 || length < 0 || <i64>start + <i64>length > <i64>size) {
      continue;
    }

    if (start > at) {
      high = min(high, start);
    }

    const stop = start + length;
    if (stop > at) {
      high = min(high, stop);
    }
  }

  return high;
}

/** How far the home of the unit at `at`, of a region that ends at `end`, may reach. */
export function unitHigh(
  offsets: Int32Array,
  lengths: Int32Array,
  size: i32,
  at: i32,
  end: i32,
): i32 {
  return min(min(segmentEnd(offsets, lengths, size, at), end), at + UNIT_WINDOW);
}
