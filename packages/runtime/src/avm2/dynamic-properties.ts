// A dynamic object's properties, and the slots a for-in goes through them
// by. As avmplus' hashtable, where a name, its value and its place in a
// for-in are one slot, the properties keep the slots themselves, as they
// are set and deleted: a for-in reads a slot at each step, with no lookup,
// and finds at its start only what changed since the last, with no list of
// names to build and compare. An object no for-in has gone through keeps no
// slots, and its properties are a Map as any other.

import type { Value } from "./descriptors.js";

/**
 * The slots of an object's names, as avmplus' hashtable keeps them: a name
 * keeps its slot while it is there, so that a for-in started inside another
 * never moves the outer one's names. One deleted stays in its slot, which a
 * for-in passes over, until a for-in next starts: then its slot is free.
 * Names added since take the free slots, lowest first, in the order they
 * were added, and only with none free does the list grow; set again before
 * its slot is freed, a name takes it back.
 */
/** A slot's name deleted, or the slot free: passed over. */
export const GONE = 0;
/** A slot's name there. */
const THERE = 1;
/** A slot's name set again after it was deleted, its slot still in `deleted`. */
const BACK = 2;

export class Walk {
  /** Each slot's name, null where free. */
  readonly slots: (string | null)[];
  /** Whether each slot's name is there: GONE, THERE or BACK. */
  readonly live: number[];
  private readonly slotOf: Map<string, number>;
  /** The names added since a for-in last placed them, oldest first, some since deleted or added again. */
  private added: string[] = [];
  /** The count of those at which the ones deleted are dropped and each kept once, so that none pile up. */
  private addedLimit = 64;
  /** The slots of the names deleted since a for-in last started, to free when one next does. */
  private readonly deleted: number[] = [];
  /** The free slots, lowest first. */
  private readonly free: number[] = [];

  constructor(names: string[]) {
    this.slots = names;
    this.live = new Array<number>(names.length).fill(THERE);
    this.slotOf = new Map();
    for (let i = 0; i < names.length; i++) {
      this.slotOf.set(names[i], i);
    }
  }

  /** `name`, not there, set: back in its slot if it still has one, else to take one. */
  noteAdded(name: string, properties: Map<string, Value>): void {
    const i = this.slotOf.get(name);
    if (i !== undefined) {
      // In `deleted` still: set again and deleted over and over, it is there once.
      this.live[i] = BACK;
      return;
    }

    this.added.push(name);
    if (this.added.length >= this.addedLimit) {
      this.added = this.settle(properties);
      this.addedLimit = Math.max(64, this.added.length * 2);
    }
  }

  /** `name`, there, deleted: passed over in its slot, if it has one, until a for-in next starts. */
  noteDeleted(name: string): void {
    const i = this.slotOf.get(name);
    if (i === undefined) {
      return;
    }

    if (this.live[i] === THERE) {
      this.deleted.push(i);
    }

    this.live[i] = GONE;
  }

  /** At a for-in's start: the slots of the names deleted since the last are free. */
  freeDeleted(): void {
    const deleted = this.deleted;
    if (deleted.length === 0) {
      return;
    }

    const slots = this.slots;
    for (let n = 0; n < deleted.length; n++) {
      const i = deleted[n];
      if (this.live[i] === BACK) {
        this.live[i] = THERE;
      } else {
        this.slotOf.delete(slots[i] as string);
        slots[i] = null;
        this.free.push(i);
      }
    }

    deleted.length = 0;
    this.free.sort((a, b) => a - b);
  }

  /** The names added since this was last called, in the slots free, then after them. */
  place(properties: Map<string, Value>): void {
    if (this.added.length === 0) {
      return;
    }

    const names = this.settle(properties);
    const slots = this.slots;
    const free = this.free;
    let taken = 0;
    for (let n = 0; n < names.length; n++) {
      const name = names[n];
      const i = taken < free.length ? free[taken++] : slots.length;
      slots[i] = name;
      this.live[i] = THERE;
      this.slotOf.set(name, i);
    }

    free.splice(0, taken);
    this.added = [];
    this.addedLimit = 64;
  }

  /**
   * The names of `added` still there and without a slot, each once, in the
   * order the properties have them: by when each was last added.
   */
  private settle(properties: Map<string, Value>): string[] {
    const added = this.added;
    const kept: string[] = [];
    const seen = new Set<string>();
    for (let n = added.length - 1; n >= 0; n--) {
      const name = added[n];
      if (!seen.has(name) && properties.has(name) && !this.slotOf.has(name)) {
        seen.add(name);
        kept.push(name);
      }
    }

    return kept.reverse();
  }
}

/** An object's dynamic properties, by name, which keep their slots once a for-in has gone through them. */
export class DynamicProperties extends Map<string, Value> {
  /** The slots, from the first for-in over the object. */
  walk: Walk | null = null;
  /**
   * Whether every name was found hidden, as a prototype's methods are, so
   * that a for-in passing through need not look at each again: until a
   * name is set, or one shown (setPropertyIsEnumerable).
   */
  allHidden = false;

  override set(name: string, value: Value): this {
    this.allHidden = false;
    // Undefined while the Map's constructor runs, before the field is set.
    const walk = this.walk;
    if (walk && !super.has(name)) {
      walk.noteAdded(name, this);
    }

    return super.set(name, value);
  }

  override delete(name: string): boolean {
    if (!super.delete(name)) {
      return false;
    }

    this.walk?.noteDeleted(name);
    return true;
  }

  override clear(): void {
    const walk = this.walk;
    if (walk) {
      for (const name of super.keys()) {
        walk.noteDeleted(name);
      }
    }

    super.clear();
  }

  /**
   * The slots at the start of a for-in over the names (`starting`), whose
   * deleted names' slots are then free, or going on to them from an Array's
   * elements, whose start freed them: with the names added since in them.
   */
  startWalk(starting: boolean): Walk {
    let walk = this.walk;
    if (walk === null) {
      walk = new Walk([...super.keys()]);
      this.walk = walk;
      return walk;
    }

    if (starting) {
      walk.freeDeleted();
    }

    walk.place(this);
    return walk;
  }
}
