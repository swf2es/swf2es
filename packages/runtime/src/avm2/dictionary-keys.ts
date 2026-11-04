// A Dictionary's object keys, and the slots a for-in goes through them by.
// As DictionaryObject's hashtable, the store itself holds each key's slot,
// so that a for-in reads a slot for its name and value, with no list of
// names built at its start and no lookup at each step. Weak keys (new
// Dictionary(true)) keep no key alive, as Flash's do not: their entries are
// held strongly only by a WeakMap keyed by the key, and their slots hold
// them weakly, so neither a for-in left off nor a value that refers to its
// key keeps the key.

import type { AsObject, Value } from "./descriptors.js";

/** The value of an entry not there: deleted, or kept spare. No ActionScript value is a symbol. */
const GONE = Symbol("gone");

/** What valueAt gives where a dynamic property's name is, whose value is the property's. */
export const NAMED = Symbol("named");

/**
 * A key and its value. Once deleted and its slot freed, it is kept to hold
 * a key added later, with the WeakRef a weak one has: V8 keeps each
 * WeakRef's target alive until the current job ends, so a new one for each
 * key added would keep every entry made in a long frame.
 */
class Entry {
  /** Null once deleted from a slot. */
  key: object | null = null;
  /** GONE while not there: its slot is passed over, and free when a for-in next starts. */
  value: Value = GONE;
  /** Its slot, -1 until a for-in starts and gives it one. */
  slot = -1;
}

class WeakEntry extends Entry {
  /** How the slots hold it. */
  readonly ref = new WeakRef<Entry>(this);
}

type Held = Entry | WeakRef<Entry>;

/**
 * As avmplus' hashtable, a name keeps its slot while it is there, so that a
 * for-in started inside another never moves the outer one's names. One
 * deleted stays in its slot, which a for-in passes over, until a for-in next
 * starts: then its slot is free, and the names added since take the free
 * slots, the Dictionary's dynamic properties first, then its keys in the
 * order they were added; only with none free does the list grow. So a for-in
 * goes through neither a name added during it nor one deleted before it gets
 * there, and goes through each other once.
 */
export class DictionaryKeys {
  readonly weak: boolean;
  /**
   * Each key's entry. One deleted before it had a slot stays, GONE, so that
   * the key set again takes it back: deleting and setting a key over and
   * over between for-ins makes nothing.
   */
  private readonly map: Map<object, Entry> | WeakMap<object, Entry>;
  /** Each slot: a key's entry, a dynamic property's name, or null where free. */
  private readonly slots: (Held | string | null)[] = [];
  /** The entries added since a for-in last started, which take slots when one next does. */
  private added: Held[] = [];
  /** The count of those at which the ones deleted or collected are dropped, so that none pile up. */
  private addedLimit = 64;
  /** The entries deleted since a for-in last started that have slots, to free when one next does. */
  private readonly deleted: Entry[] = [];
  /** The slots of keys collected that a for-in has come across since one last started. */
  private readonly collected: number[] = [];
  /** Entries no longer used, to hold keys added later; trimmed when a for-in starts. */
  private readonly spare: Entry[] = [];
  /** The slot of each dynamic property's name. */
  private named: Map<string, number> | null = null;

  constructor(weak: boolean) {
    this.weak = weak;
    this.map = weak ? new WeakMap() : new Map();
  }

  get(key: object): Value {
    const value = this.map.get(key)?.value;
    return value === GONE ? undefined : value;
  }

  has(key: object): boolean {
    const entry = this.map.get(key);
    return entry !== undefined && entry.value !== GONE;
  }

  set(key: object, value: Value): this {
    const known = this.map.get(key);
    if (known !== undefined) {
      known.value = value;
      return this;
    }

    const entry = this.spare.pop() ?? (this.weak ? new WeakEntry() : new Entry());
    entry.key = key;
    entry.value = value;
    this.map.set(key, entry);
    this.added.push(this.hold(entry));
    if (this.added.length >= this.addedLimit) {
      this.added = this.settle(this.added);
      this.addedLimit = Math.max(64, this.added.length * 2);
    }

    return this;
  }

  delete(key: object): boolean {
    const entry = this.map.get(key);
    if (entry === undefined || entry.value === GONE) {
      return false;
    }

    entry.value = GONE;
    if (entry.slot >= 0) {
      this.map.delete(key);
      entry.key = null;
      this.deleted.push(entry);
    }

    return true;
  }

  /** The keys there now: those with slots, in their slots' order, then those added since. */
  *keys(): IterableIterator<object> {
    for (const entry of this.entries()) {
      yield entry.key as object;
    }
  }

  *[Symbol.iterator](): IterableIterator<[object, Value]> {
    for (const entry of this.entries()) {
      yield [entry.key as object, entry.value];
    }
  }

  get size(): number {
    let n = 0;
    for (const _ of this.entries()) {
      n++;
    }

    return n;
  }

  /**
   * The index after `index` of a name of Dictionary `o` there now, or 0. A
   * for-in's start (index 0) first frees the slots of names gone and gives
   * those added theirs.
   */
  next(o: AsObject, index: number): number {
    if (index === 0) {
      this.start(o);
    }

    const slots = this.slots;
    for (let i = index; i < slots.length; i++) {
      const held = slots[i];
      if (held === null) {
        continue;
      }

      if (typeof held === "string") {
        if (o.$d?.has(held) && !o.$dontEnum?.has(held)) {
          return i + 1;
        }

        continue;
      }

      const entry = this.open(held);
      if (entry === undefined) {
        slots[i] = null;
        this.collected.push(i);
      } else if (entry.value !== GONE) {
        return i + 1;
      }
    }

    return 0;
  }

  /** The name at a for-in's index: a key itself, a dynamic property's name, or "" once a key is gone. */
  nameAt(index: number): object | string {
    const held = this.slots[index - 1];
    if (held === null || held === undefined) {
      return "";
    }

    return typeof held === "string" ? held : (this.open(held)?.key ?? "");
  }

  /** The value at a for-in's index: a key's, undefined once it is gone, or NAMED. */
  valueAt(index: number): Value {
    const held = this.slots[index - 1];
    if (held === null || held === undefined) {
      return undefined;
    }

    if (typeof held === "string") {
      return NAMED;
    }

    const value = this.open(held)?.value;
    return value === GONE ? undefined : value;
  }

  /** The entry a slot or `added` holds, or undefined once its key is collected. */
  private open(held: Held): Entry | undefined {
    return this.weak ? (held as WeakRef<Entry>).deref() : (held as Entry);
  }

  private hold(entry: Entry): Held {
    return this.weak ? (entry as WeakEntry).ref : entry;
  }

  private *entries(): IterableIterator<Entry> {
    for (let i = 0; i < this.slots.length; i++) {
      const held = this.slots[i];
      const entry = held === null || typeof held === "string" ? undefined : this.open(held);
      if (entry !== undefined && entry.value !== GONE) {
        yield entry;
      }
    }

    for (let i = 0; i < this.added.length; i++) {
      const entry = this.open(this.added[i]);
      if (entry !== undefined && entry.value !== GONE) {
        yield entry;
      }
    }
  }

  /** Those of `added` still there; the others are let go, their keys with them. */
  private settle(added: Held[]): Held[] {
    let kept = 0;
    for (let i = 0; i < added.length; i++) {
      const held = added[i];
      const entry = this.open(held);
      if (entry === undefined) {
        continue;
      }

      if (entry.value !== GONE) {
        added[kept++] = held;
      } else {
        this.map.delete(entry.key as object);
        entry.key = null;
        this.spare.push(entry);
      }
    }

    added.length = kept;
    return added;
  }

  private start(o: AsObject): void {
    const d: Map<string, unknown> | undefined = o.$d;
    const deleted = this.deleted;
    if (
      this.added.length === 0 &&
      deleted.length === 0 &&
      this.collected.length === 0 &&
      !d?.size &&
      !this.named?.size
    ) {
      return;
    }

    const slots = this.slots;
    const free: number[] = [];
    for (let i = 0; i < deleted.length; i++) {
      const entry = deleted[i];
      slots[entry.slot] = null;
      free.push(entry.slot);
      entry.slot = -1;
      this.spare.push(entry);
    }

    deleted.length = 0;
    for (let i = 0; i < this.collected.length; i++) {
      free.push(this.collected[i]);
    }

    this.collected.length = 0;
    if (this.named !== null) {
      for (const [name, i] of this.named) {
        if (!d?.has(name)) {
          this.named.delete(name);
          slots[i] = null;
          free.push(i);
        }
      }
    }

    // Lowest first, so that the names added fill the earliest gaps.
    free.sort((a, b) => a - b);
    let next = 0;
    if (d?.size) {
      this.named ??= new Map();
      for (const name of d.keys()) {
        if (!this.named.has(name)) {
          const i = next < free.length ? free[next++] : slots.length;
          slots[i] = name;
          this.named.set(name, i);
        }
      }
    }

    const added = this.settle(this.added);
    for (let n = 0; n < added.length; n++) {
      const i = next < free.length ? free[next++] : slots.length;
      slots[i] = added[n];
      (this.open(added[n]) as Entry).slot = i;
    }

    // Kept for as many keys as were added since the last start, as the next
    // may add as many again; an emptied Dictionary keeps almost none.
    if (this.spare.length > added.length + 64) {
      this.spare.length = added.length + 64;
    }

    this.added = [];
    this.addedLimit = 64;
  }
}
