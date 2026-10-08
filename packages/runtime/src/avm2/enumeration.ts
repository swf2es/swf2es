// What a for-in goes through: an object's own names, each kept in a slot
// for as long as it is there, as in avmplus' hashtable, so that names come
// and go during a for-in without moving the others.

import type { AsObject, Value } from "./descriptors.js";
import { arrayIndex, Namespace } from "./names.js";
import { WeakKeys, WeakName } from "./weak-keys.js";

/**
 * The names for-ins go through over one object, each in a slot, as in
 * avmplus' hashtable. A name keeps its slot while it is there, so a for-in
 * started inside another never moves the outer one's names. One deleted
 * stays in its slot, which the outer one skips, until a for-in next starts:
 * then its slot is free, and it takes one again only if it is back, as a
 * new name, which takes a free slot; only with none free does the list
 * grow. So it is at most as long as the most names the object had at once,
 * as avmplus' table, and nothing a for-in goes through is ever moved or
 * dropped.
 */
export interface Enumeration {
  /** The name in each slot, null in one free: a string, or a Dictionary's object key. */
  names: (EnumeratedName | null)[];
  /** Each name's slot. */
  slot: Map<EnumeratedName, number>;
}

/**
 * A name a for-in goes through: a string, or an object a Dictionary is
 * keyed by, held weakly (a WeakName) where the Dictionary's keys are weak,
 * so that a for-in left off keeps no key alive.
 */
export type EnumeratedName = string | object;

/** The names below this come back from a for-in as numbers: avmplus' int atoms, of 29 bits. */
export const INT_ATOM_LIMIT = 0x10000000;

/** An object's own names, its elements', its dynamic properties' and a Dictionary's keys, in that order. */
export function ownNames(o: AsObject): EnumeratedName[] {
  const names: EnumeratedName[] = [];
  if (o.$a !== undefined) {
    for (const i of Object.keys(o.$a)) {
      names.push(i);
    }
  }

  if (o.$d) {
    for (const k of o.$d.keys()) {
      names.push(k);
    }
  }

  if (o.$keys instanceof WeakKeys) {
    for (const k of o.$keys.keys()) {
      names.push(o.$keys.nameOf(k) as WeakName);
    }
  } else if (o.$keys !== undefined) {
    for (const k of o.$keys.keys()) {
      names.push(k);
    }
  }

  return names;
}

/**
 * The names of `o` for a for-in starting over it: those it had before in
 * their slots, and new ones in the slots of those gone, then after them.
 */
export function startEnumeration(
  enumerating: WeakMap<object, Enumeration>,
  o: AsObject,
): (EnumeratedName | null)[] {
  const names = ownNames(o);
  let e = enumerating.get(o);
  if (!e) {
    e = { names, slot: new Map(names.map((name, i) => [name, i])) };
    enumerating.set(o, e);
    return names;
  }

  const free: number[] = [];
  e.names.forEach((name, i) => {
    if (name === null) {
      free.push(i);
    } else if (!stillThere(o, name)) {
      e.slot.delete(name);
      e.names[i] = null;
      free.push(i);
    }
  });

  let next = 0;
  for (const name of names) {
    if (!e.slot.has(name)) {
      const i = next < free.length ? free[next++] : e.names.length;
      e.names[i] = name;
      e.slot.set(name, i);
    }
  }

  return e.names;
}

/** The name of `o` at a for-in's index: a weak key itself, "" once it is gone. */
export function enumerated(
  enumerating: WeakMap<object, Enumeration>,
  o: AsObject,
  index: number,
): EnumeratedName {
  const name = enumerating.get(o)?.names[index - 1] ?? "";
  return name instanceof WeakName ? (name.ref.deref() ?? "") : name;
}

/** The index after `index` of an enumerable name of `o`, or 0. */
export function nextIndex(
  enumerating: WeakMap<object, Enumeration>,
  o: AsObject,
  index: number,
): number {
  const names = index === 0 ? startEnumeration(enumerating, o) : (enumerating.get(o)?.names ?? []);

  // A name deleted since the for-in started is skipped.
  for (let i = index; i < names.length; i++) {
    const name = names[i];
    if (
      name !== null &&
      !(typeof name === "string" && o.$dontEnum?.has(name)) &&
      stillThere(o, name)
    ) {
      return i + 1;
    }
  }

  return 0;
}

function stillThere(o: AsObject, name: EnumeratedName): boolean {
  if (name instanceof WeakName) {
    const key = name.ref.deref();
    return key !== undefined && (o.$keys?.has(key) ?? false);
  }

  if (typeof name !== "string") {
    return o.$keys?.has(name) ?? false;
  }

  if (o.$a !== undefined) {
    const i = arrayIndex(name);
    if (i >= 0) {
      return i in o.$a;
    }
  }

  return o.$d?.has(name) ?? false;
}

/**
 * A Namespace or QName, which enumerate "uri" and the name this gives
 * ("prefix" or "localName"), as avmplus' nextName does; else null.
 */
export function pairOf(o: Value): string | null {
  if (o instanceof Namespace) {
    return "prefix";
  }

  return typeof o === "object" && o !== null && o.$local !== undefined ? "localName" : null;
}

export const pairIndex = (index: number) => (index < 2 ? index + 1 : 0);
