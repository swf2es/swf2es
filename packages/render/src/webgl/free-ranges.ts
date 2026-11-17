/**
 * The room of a buffer of `capacity` units: taken from its top while it
 * fits, so that what a frame adds lies in a row and goes up in one upload,
 * else from the first hole it fits, the holes kept sorted by start and
 * merged with their neighbours as ranges come back. A range given back at
 * the top lowers the top, with the hole below it, instead.
 */
export class FreeRanges {
  capacity = 0;
  top = 0;
  /** The units in holes below the top. */
  free = 0;
  /** The holes' starts, ascending, and their lengths: [start, start + length) each. */
  readonly starts: number[] = [];
  readonly lengths: number[] = [];

  /** Every unit free, of `capacity`. */
  reset(capacity: number): void {
    this.capacity = capacity;
    this.top = 0;
    this.free = 0;
    this.starts.length = 0;
    this.lengths.length = 0;
  }

  /** The units free, at the top and in holes, which no take larger than can find. */
  room(): number {
    return this.capacity - this.top + this.free;
  }

  /** Where `length` units were taken: at the top, else from the first hole that holds them; -1 for none. */
  take(length: number): number {
    if (this.top + length <= this.capacity) {
      const at = this.top;
      this.top += length;
      return at;
    }

    if (length > this.free) {
      return -1;
    }

    const starts = this.starts;
    const lengths = this.lengths;
    for (let k = 0; k < starts.length; k++) {
      if (lengths[k] >= length) {
        const at = starts[k];
        if (lengths[k] === length) {
          starts.splice(k, 1);
          lengths.splice(k, 1);
        } else {
          starts[k] += length;
          lengths[k] -= length;
        }

        this.free -= length;
        return at;
      }
    }

    return -1;
  }

  /** [start, start + length), taken before, free again. */
  give(start: number, length: number): void {
    if (length === 0) {
      return;
    }

    const starts = this.starts;
    const lengths = this.lengths;
    const n = starts.length;
    if (start + length === this.top) {
      this.top = start;
      if (n > 0 && starts[n - 1] + lengths[n - 1] === start) {
        this.top = starts[n - 1];
        this.free -= lengths[n - 1];
        starts.pop();
        lengths.pop();
      }

      return;
    }

    // The first hole past it.
    let lo = 0;
    let hi = n;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (starts[mid] < start) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }

    this.free += length;
    const before = lo > 0 && starts[lo - 1] + lengths[lo - 1] === start;
    const after = lo < n && start + length === starts[lo];
    if (before && after) {
      lengths[lo - 1] += length + lengths[lo];
      starts.splice(lo, 1);
      lengths.splice(lo, 1);
    } else if (before) {
      lengths[lo - 1] += length;
    } else if (after) {
      starts[lo] = start;
      lengths[lo] += length;
    } else {
      starts.splice(lo, 0, start);
      lengths.splice(lo, 0, length);
    }
  }
}
