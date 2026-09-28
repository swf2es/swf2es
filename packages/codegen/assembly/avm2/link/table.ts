// Hash tables of ids for the domain's interned names and bindings.

/** Maps a 32-bit hash to ids by linear probing; callers compare the keys. */
@final
export class IdTable {
  /** id + 1 per slot; 0 is empty. */
  ids: StaticArray<u32> = new StaticArray<u32>(64);
  hashes: StaticArray<u32> = new StaticArray<u32>(64);
  count: u32 = 0;

  @inline
  start(hash: u32): u32 {
    return hash & (<u32>this.ids.length - 1);
  }

  @inline
  next(slot: u32): u32 {
    return (slot + 1) & (<u32>this.ids.length - 1);
  }

  /** The id in `slot`, or -1 at the end of the probe. */
  @inline
  at(slot: u32): i32 {
    return <i32>this.ids[slot] - 1;
  }

  @inline
  hashAt(slot: u32): u32 {
    return this.hashes[slot];
  }

  insert(hash: u32, id: u32): void {
    // At most half full: a lookup that misses, as most of a binding's
    // lookups do, probes until an empty slot.
    if ((this.count + 1) * 2 > <u32>this.ids.length) {
      this.grow();
    }

    let slot = this.start(hash);
    while (this.ids[slot]) {
      slot = this.next(slot);
    }

    this.ids[slot] = id + 1;
    this.hashes[slot] = hash;
    this.count++;
  }

  grow(): void {
    const ids = this.ids;
    const hashes = this.hashes;
    this.ids = new StaticArray<u32>(ids.length * 2);
    this.hashes = new StaticArray<u32>(ids.length * 2);
    this.count = 0;

    // Re-inserting in slot order keeps equal hashes in insertion order.
    const size = <u32>ids.length;
    let first: u32 = 0;
    while (first < size && ids[first]) {
      first++;
    }

    for (let i: u32 = 1; i <= size; i++) {
      const slot = (first + i) & (size - 1);
      if (ids[slot]) {
        this.insert(hashes[slot], ids[slot] - 1);
      }
    }
  }
}

export function hashBytes(ptr: usize, length: u32): u32 {
  let h: u32 = 0x811c9dc5;
  for (let i: u32 = 0; i < length; i++) {
    h = (h ^ load<u8>(ptr + i)) * 0x01000193;
  }

  return h;
}

export function hashPair(a: u32, b: u32): u32 {
  let h = a * 0x9e3779b1;
  h ^= b + 0x7f4a7c15 + (h << 6) + (h >> 2);
  return h ^ (h >> 16);
}
