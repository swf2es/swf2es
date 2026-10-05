// A weak-keyed Dictionary's object keys (new Dictionary(true)): each entry
// lives only as long as its key does elsewhere, as Flash's weak keys do, so
// a registry of objects keyed weakly does not keep them. A WeakMap holds the
// values, an entry for as long as its key lives; the keys' order, for a
// for-in, is kept as WeakRefs, those of keys gone dropped as they are met.
// The Map-like part is what the runtime and AMF use of a Dictionary's keys.

/** A for-in's name for a weak Dictionary's key: its key held weakly, one for each key. */
export class WeakName {
  readonly ref: WeakRef<object>;

  constructor(key: object) {
    this.ref = new WeakRef(key);
  }
}

export class WeakKeys {
  private readonly values = new WeakMap<object, unknown>();
  private readonly names = new WeakMap<object, WeakName>();
  /** Each key's name, in the order the keys were added. */
  private readonly order = new Set<WeakName>();
  /** The count of names at which those of keys gone are next dropped, so that none piles up unread. */
  private pruneAt = 64;

  get(key: object): unknown {
    return this.values.get(key);
  }

  has(key: object): boolean {
    return this.values.has(key);
  }

  set(key: object, value: unknown): this {
    if (!this.values.has(key)) {
      const name = new WeakName(key);
      this.names.set(key, name);
      this.order.add(name);
      if (this.order.size >= this.pruneAt) {
        this.prune();
        this.pruneAt = Math.max(64, this.order.size * 2);
      }
    }

    this.values.set(key, value);
    return this;
  }

  delete(key: object): boolean {
    const name = this.names.get(key);
    if (!name) {
      return false;
    }

    this.order.delete(name);
    this.names.delete(key);
    return this.values.delete(key);
  }

  /** The key's name for a for-in: the same for as long as it is there. */
  nameOf(key: object): WeakName | undefined {
    return this.names.get(key);
  }

  /** The keys there now, in the order they were added. */
  *keys(): IterableIterator<object> {
    for (const name of this.order) {
      const key = name.ref.deref();
      if (key === undefined) {
        this.order.delete(name);
        continue;
      }

      yield key;
    }
  }

  *[Symbol.iterator](): IterableIterator<[object, unknown]> {
    for (const key of this.keys()) {
      yield [key, this.values.get(key)];
    }
  }

  get size(): number {
    this.prune();
    return this.order.size;
  }

  private prune(): void {
    for (const name of this.order) {
      if (name.ref.deref() === undefined) {
        this.order.delete(name);
      }
    }
  }
}
