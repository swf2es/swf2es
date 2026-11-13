// A Dictionary's object keys, and the slots a for-in goes through them by.
// As DictionaryObject's hashtable, the store itself holds each key's slot,
// so that a for-in reads a slot for its name and value, with no list of
// names built at its start and no lookup at each step. Weak keys (new
// Dictionary(true)) keep no key alive, as Flash's do not: their entries are
// held strongly only by a WeakMap keyed by the key, and their slots hold
// them weakly, so neither a for-in left off nor a value that refers to its
// key keeps the key. Reading a slot's WeakRef is the cost of a weak walk,
// so the entries one reads are kept beside the slots until the job ends,
// which is as long as the engine itself keeps what a WeakRef gave: a step's
// name and value, and the walks after it in that job, read none again.

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
 * The weak Dictionaries whose slots' entries are kept open in this job, and
 * whether their closing at its end is asked for. deref() makes the engine
 * keep its target until the job ends, so an entry kept that long keeps no
 * key the walk that read it did not; kept longer, it would.
 */
const openedInJob: DictionaryKeys[] = [];
let closing = false;

function closeOpened(): void {
  for (let i = 0; i < openedInJob.length; i++) {
    openedInJob[i].close();
  }

  openedInJob.length = 0;
  closing = false;
}

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
   * over between for-ins makes nothing. A strong key deleted so stays alive
   * until a for-in starts or `added` is settled, which keeps that bounded by
   * twice the keys there, and 64.
   */
  private readonly map: Map<object, Entry> | WeakMap<object, Entry>;
  /** Each slot: a key's entry, a dynamic property's name, or null where free. */
  private readonly slots: (Held | string | null)[] = [];
  /** The entries added since a for-in last started, which take slots when one next does. */
  private added: Held[] = [];
  /** The count of those at which the ones deleted or collected are dropped, so none pile up. */
  private addedLimit = 64;
  /** The entries with slots deleted since a for-in last started, freed when one next does. */
  private readonly deleted: Entry[] = [];
  /** The slots of keys collected that a for-in has come across since one last started. */
  private readonly collected: number[] = [];
  /** Entries no longer used, to hold keys added later; trimmed when a for-in starts. */
  private readonly spare: Entry[] = [];
  /** The slot of each dynamic property's name. */
  private named: Map<string, number> | null = null;
  /**
   * A weak Dictionary's entries that this job's for-ins have read from
   * their slots, each at its slot's index, null where none was; null
   * outside a job that walks it.
   */
  private opened: (Entry | null)[] | null = null;

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
    if (!this.replace(key, value)) {
      this.add(key, value);
    }

    return this;
  }

  /**
   * Sets the value of a key that has an entry, there or deleted, and says
   * whether it had one; set's first half, so that a caller can look at a
   * key before it is added.
   */
  replace(key: object, value: Value): boolean {
    const known = this.map.get(key);
    if (known === undefined) {
      return false;
    }

    known.value = value;
    return true;
  }

  /** Adds a key that has no entry (replace said so). */
  add(key: object, value: Value): void {
    const entry = this.spare.pop() ?? (this.weak ? new WeakEntry() : new Entry());
    entry.key = key;
    entry.value = value;
    this.map.set(key, entry);
    this.added.push(this.hold(entry));
    if (this.added.length >= this.addedLimit) {
      this.added = this.settle(this.added);
      this.addedLimit = Math.max(64, this.added.length * 2);
    }
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

    if (this.weak) {
      return this.nextWeak(o, index);
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

  /** As next, for weak keys: each slot's WeakRef is read once a job, then its entry kept. */
  private nextWeak(o: AsObject, index: number): number {
    const slots = this.slots;
    const opened = this.opened ?? this.keepOpened();
    for (let i = index; i < slots.length; i++) {
      let entry = opened[i];
      if (entry === null) {
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

        const read = (held as WeakRef<Entry>).deref();
        if (read === undefined) {
          slots[i] = null;
          this.collected.push(i);
          continue;
        }

        entry = read;
        opened[i] = read;
      }

      if (entry.value !== GONE) {
        return i + 1;
      }
    }

    return 0;
  }

  /** Starts keeping the entries read from the slots, until the job ends. */
  private keepOpened(): (Entry | null)[] {
    const opened: (Entry | null)[] = new Array(this.slots.length).fill(null);
    this.opened = opened;
    openedInJob.push(this);
    if (!closing) {
      closing = true;
      // A microtask runs before the job ends, when the engine lets go of what deref() gave.
      void Promise.resolve().then(closeOpened);
    }

    return opened;
  }

  /** Lets go of the entries kept: the job that read them is over. */
  close(): void {
    this.opened = null;
  }

  /** The name at a for-in's index: a key, a dynamic property's name, or "" once a key is gone. */
  nameAt(index: number): object | string {
    const held = this.slots[index - 1];
    if (held === null || held === undefined) {
      return "";
    }

    return typeof held === "string" ? held : (this.at(held, index - 1)?.key ?? "");
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

    const value = this.at(held, index - 1)?.value;
    return value === GONE ? undefined : value;
  }

  /** The entry slot `i` holds: a weak one as this job's for-in read it, if it did. */
  private at(held: Held, i: number): Entry | undefined {
    if (!this.weak) {
      return held as Entry;
    }

    return this.opened?.[i] ?? (held as WeakRef<Entry>).deref();
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

  /**
   * Those of `added` still there; the others are let go, their keys with
   * them. Their entries go into `entries`, for a caller to read none twice.
   */
  private settle(added: Held[], entries?: Entry[]): Held[] {
    let kept = 0;
    for (let i = 0; i < added.length; i++) {
      const held = added[i];
      const entry = this.open(held);
      if (entry === undefined) {
        continue;
      }

      if (entry.value !== GONE) {
        added[kept++] = held;
        entries?.push(entry);
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
    // In step with the slots: an entry freed is no longer its slot's, one given a slot is.
    const opened = this.opened;
    const free: number[] = [];
    for (let i = 0; i < deleted.length; i++) {
      const entry = deleted[i];
      slots[entry.slot] = null;
      if (opened !== null) {
        opened[entry.slot] = null;
      }

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
    // Freed, `named` holds only names still there: as many as there are, and none is new.
    if (d?.size && d.size !== (this.named?.size ?? 0)) {
      this.named ??= new Map();
      for (const name of d.keys()) {
        if (!this.named.has(name)) {
          const i = next < free.length ? free[next++] : slots.length;
          slots[i] = name;
          this.named.set(name, i);
          if (opened !== null) {
            opened[i] = null;
          }
        }
      }
    }

    const entries: Entry[] = [];
    const added = this.settle(this.added, entries);
    for (let n = 0; n < added.length; n++) {
      const i = next < free.length ? free[next++] : slots.length;
      const entry = entries[n];
      slots[i] = added[n];
      entry.slot = i;
      if (opened !== null) {
        // settle read it, so the engine keeps it for this job already.
        opened[i] = entry;
      }
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
