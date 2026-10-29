/** What a pool holds: its size, and the frame it was last freed in. */
export interface Pooled {
  width: number;
  height: number;
  usedAt: number;
}

/** What a size, and samples where they count, are keyed by. */
const SIZE_KEY = 65536;
const SAMPLES_KEY = 32;

/**
 * Free targets kept by their size (and samples) for the next to take them:
 * an exact one found at once, a larger one among the sizes there are, each
 * size's list in the order they were freed. A frame's end lets go of those
 * idle too long, then of the least lately freed past a budget, oldest first
 * from the lists' heads, as the frame's own working set may pass it for a
 * while without what it gives back being made again.
 */
export class SizedPool<T extends Pooled> {
  private readonly lists = new Map<number, T[]>();
  private readonly bytesOf: (item: T) => number;
  /** The bytes all held take together. */
  bytes = 0;

  constructor(bytesOf: (item: T) => number) {
    this.bytesOf = bytesOf;
  }

  /** One of just `width` by `height` (and `samples`), the latest freed; none for none. */
  take(width: number, height: number, samples = 0): T | null {
    return this.takeAt((width * SIZE_KEY + height) * SAMPLES_KEY + samples);
  }

  /** The smallest of at least `width` by `height`, of no samples; none for none. */
  takeFitting(width: number, height: number): T | null {
    let best = -1;
    let least = Number.POSITIVE_INFINITY;
    for (const key of this.lists.keys()) {
      const size = Math.floor(key / SAMPLES_KEY);
      const w = Math.floor(size / SIZE_KEY);
      const h = size % SIZE_KEY;
      if (key % SAMPLES_KEY === 0 && w >= width && h >= height && w * h < least) {
        least = w * h;
        best = key;
      }
    }

    return best < 0 ? null : this.takeAt(best);
  }

  private takeAt(key: number): T | null {
    const list = this.lists.get(key);
    const item = list?.pop() ?? null;
    if (!item) {
      return null;
    }

    // An emptied size goes, so that finding a larger one looks at those held alone.
    if ((list as T[]).length === 0) {
      this.lists.delete(key);
    }

    this.bytes -= this.bytesOf(item);
    return item;
  }

  /** `item` free again, freed in frame `frame`, of `samples` where they count. */
  give(item: T, frame: number, samples = 0): void {
    item.usedAt = frame;
    const key = (item.width * SIZE_KEY + item.height) * SAMPLES_KEY + samples;
    let list = this.lists.get(key);
    if (!list) {
      list = [];
      this.lists.set(key, list);
    }

    list.push(item);
    this.bytes += this.bytesOf(item);
  }

  /**
   * Those freed more than `idle` frames before `frame` let go of, then the
   * least lately freed till they take `budget` bytes at most, each `drop`ped.
   */
  trim(frame: number, idle: number, budget: number, drop: (item: T) => void): void {
    for (const [key, list] of this.lists) {
      let gone = 0;
      while (gone < list.length && frame - list[gone].usedAt > idle) {
        this.bytes -= this.bytesOf(list[gone]);
        drop(list[gone]);
        gone++;
      }

      if (gone === list.length) {
        this.lists.delete(key);
      } else if (gone > 0) {
        list.splice(0, gone);
      }
    }

    while (this.bytes > budget) {
      // The list whose head was freed first; its head goes.
      let oldest: T[] | null = null;
      let oldestKey = 0;
      for (const [key, list] of this.lists) {
        if (!oldest || list[0].usedAt < oldest[0].usedAt) {
          oldest = list;
          oldestKey = key;
        }
      }

      if (!oldest) {
        break;
      }

      const item = oldest.shift() as T;
      this.bytes -= this.bytesOf(item);
      drop(item);
      if (oldest.length === 0) {
        this.lists.delete(oldestKey);
      }
    }
  }

  /** Every one held let go of, as the context goes. */
  clear(drop: (item: T) => void): void {
    for (const list of this.lists.values()) {
      for (const item of list) {
        drop(item);
      }
    }

    this.lists.clear();
    this.bytes = 0;
  }
}
