/**
 * What a pool holds: its size, and the frame it was last freed in; where
 * it may be used as smaller than it is, its own size, which it is pooled by.
 */
export interface Pooled {
  width: number;
  height: number;
  textureWidth?: number;
  textureHeight?: number;
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

  /** The smallest target that fits, at these samples and within `maxArea`; none for none. */
  takeFitting(
    width: number,
    height: number,
    samples = 0,
    maxArea = Number.POSITIVE_INFINITY,
  ): T | null {
    let best = -1;
    let least = Number.POSITIVE_INFINITY;
    for (const key of this.lists.keys()) {
      const size = Math.floor(key / SAMPLES_KEY);
      const w = Math.floor(size / SIZE_KEY);
      const h = size % SIZE_KEY;
      if (
        key % SAMPLES_KEY === samples &&
        w >= width &&
        h >= height &&
        w * h <= maxArea &&
        w * h < least
      ) {
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
    const key =
      ((item.textureWidth ?? item.width) * SIZE_KEY + (item.textureHeight ?? item.height)) *
        SAMPLES_KEY +
      samples;
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
    this.trimIdle(frame, idle, drop);
    trimTogether([{ pool: this, drop }], budget);
  }

  /** Those freed more than `idle` frames before `frame` let go of, each `drop`ped. */
  trimIdle(frame: number, idle: number, drop: (item: T) => void): void {
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
  }

  /**
   * The key of the list whose head goes first past a budget: the least
   * lately freed, and of those freed in one frame the largest, so that as
   * few go as may; -1 for none.
   */
  firstOut(): number {
    let best = -1;
    let bestAt = 0;
    let bestBytes = 0;
    for (const [key, list] of this.lists) {
      const head = list[0];
      const bytes = this.bytesOf(head);
      if (best < 0 || head.usedAt < bestAt || (head.usedAt === bestAt && bytes > bestBytes)) {
        best = key;
        bestAt = head.usedAt;
        bestBytes = bytes;
      }
    }

    return best;
  }

  /** The head of list `key` (firstOut), as `firstOut` found it. */
  headOf(key: number): T {
    return (this.lists.get(key) as T[])[0];
  }

  /** The head of list `key` (firstOut) let go of, `drop`ped. */
  dropHead(key: number, drop: (item: T) => void): void {
    const list = this.lists.get(key) as T[];
    const item = list.shift() as T;
    this.bytes -= this.bytesOf(item);
    drop(item);
    if (list.length === 0) {
      this.lists.delete(key);
    }
  }

  /** The bytes those freed in frame `frame` take, which that frame drew with. */
  bytesFreedIn(frame: number): number {
    let bytes = 0;
    for (const list of this.lists.values()) {
      for (let i = list.length - 1; i >= 0 && list[i].usedAt === frame; i--) {
        bytes += this.bytesOf(list[i]);
      }
    }

    return bytes;
  }

  /** The bytes `item` takes, as this pool counts them. */
  bytesFor(item: T): number {
    return this.bytesOf(item);
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

/** A pool and how what it lets go of is deleted. */
interface Trimmed {
  // biome-ignore lint/suspicious/noExplicitAny: pools of any kind share one budget.
  pool: SizedPool<any>;
  // biome-ignore lint/suspicious/noExplicitAny: as the pool's.
  drop: (item: any) => void;
}

/**
 * `pools` let go of till together they take `budget` bytes at most: the
 * least lately freed of all first, of those freed in one frame the
 * largest. One budget for all, as trimming one pool against what another
 * holds dropped a frame's own small layers while large multisampled
 * buffers idle for many frames stayed, each frame making them again.
 */
export function trimTogether(pools: readonly Trimmed[], budget: number): void {
  let bytes = 0;
  for (const { pool } of pools) {
    bytes += pool.bytes;
  }

  while (bytes > budget) {
    let from: Trimmed | null = null;
    let key = -1;
    let at = 0;
    let size = 0;
    for (const trimmed of pools) {
      const k = trimmed.pool.firstOut();
      if (k < 0) {
        continue;
      }

      const head = trimmed.pool.headOf(k);
      const headBytes = trimmed.pool.bytesFor(head);
      if (!from || head.usedAt < at || (head.usedAt === at && headBytes > size)) {
        from = trimmed;
        key = k;
        at = head.usedAt;
        size = headBytes;
      }
    }

    if (!from) {
      break;
    }

    bytes -= size;
    from.pool.dropHead(key, from.drop);
  }
}
