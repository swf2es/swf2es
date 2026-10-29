// What a for-in goes through, as avmplus' nextNameIndex: an Array's or a
// Vector's elements by their live length, then the object's other names,
// each kept in a slot for as long as it is there, as in avmplus'
// hashtable, so that names come and go during a for-in without moving the
// others.

import type { AsObject, Value } from "./descriptors.js";
import { Namespace } from "./names.js";
import { FloatVector } from "./natives/float-vector.js";
import { WeakKeys, WeakName } from "./weak-keys.js";

/**
 * The names for-ins go through over one object, but its elements, which
 * they walk by index, each in a slot, as in avmplus' hashtable. A name
 * keeps its slot while it is there, so a for-in started inside another
 * never moves the outer one's names. One deleted stays in its slot, which
 * the outer one skips, until a for-in next starts: then its slot is free,
 * and it takes one again only if it is back, as a new name, which takes a
 * free slot; only with none free does the list grow. So it is at most as
 * long as the most such names the object had at once, as avmplus' table,
 * and nothing a for-in goes through is ever moved or dropped.
 */
export interface Enumeration {
  /** The name in each slot, null in one free: a string, or a Dictionary's object key. */
  names: (EnumeratedName | null)[];
  /** Each name's slot. */
  slot: Map<EnumeratedName, number>;
  /** A sparse Array's indices in order, taken at `indicesAt`, its length then, to step over its gaps. */
  indices?: number[];
  indicesAt?: number;
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
  if (o.$a instanceof FloatVector) {
    for (let i = 0; i < o.$a.length; i++) {
      names.push(String(i));
    }
  } else if (o.$a !== undefined) {
    for (const i of Object.keys(o.$a)) {
      names.push(i);
    }
  }

  names.push(...otherNames(o));
  return names;
}

/** An object's own names but its elements: its dynamic properties' and a Dictionary's keys. */
function otherNames(o: AsObject): EnumeratedName[] {
  const names: EnumeratedName[] = [];
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
function startEnumeration(
  enumerating: WeakMap<object, Enumeration>,
  o: AsObject,
): (EnumeratedName | null)[] {
  const names = otherNames(o);
  let e = enumerating.get(o);
  if (!e) {
    e = { names, slot: new Map(names.map((name, i) => [name, i])) };
    enumerating.set(o, e);
    return names;
  }

  // By index, not forEach: every for-in over the same object again comes here.
  const free: number[] = [];
  const known = e.names;
  for (let i = 0; i < known.length; i++) {
    const name = known[i];
    if (name === null) {
      free.push(i);
    } else if (!stillThere(o, name)) {
      e.slot.delete(name);
      known[i] = null;
      free.push(i);
    }
  }

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

/** The element at a for-in's index, as a number, or -1 where the index is past the elements. */
export function enumeratedElement(o: AsObject, index: number): number {
  return o.$a !== undefined && index <= o.$a.length ? index - 1 : -1;
}

/** The name of `o` at a for-in's index past its elements: a weak key itself, "" once it is gone. */
export function enumerated(
  enumerating: WeakMap<object, Enumeration>,
  o: AsObject,
  index: number,
): EnumeratedName {
  const name = enumerating.get(o)?.names[index - (o.$a?.length ?? 0) - 1] ?? "";
  return name instanceof WeakName ? (name.ref.deref() ?? "") : name;
}

/**
 * The index after `index` of an enumerable name of `o`, or 0. As avmplus'
 * ArrayObject and TypedVectorObject, the elements come first, by their
 * length now, not when the for-in started, so it goes on through those
 * pushed or filled in during it; then the other names, whose indices come
 * after the elements' length, which moves them if it changes then.
 */
export function nextIndex(
  enumerating: WeakMap<object, Enumeration>,
  o: AsObject,
  index: number,
): number {
  const a = o.$a;
  if (a === undefined) {
    return nextNameIndex(enumerating, o, index);
  }

  if (index === 0) {
    forgetIndices(enumerating, o);
  }

  const length = a.length;
  if (index < length) {
    const i = nextElement(enumerating, o, a, index);
    if (i >= 0) {
      return i + 1;
    }
  }

  const next = nextNameIndex(enumerating, o, Math.max(index - length, 0));
  return next === 0 ? 0 : length + next;
}

/** Past this many holes, the next element is found among an Array's indices, so that a sparse one stays cheap. */
const HOLE_SCAN_LIMIT = 16;

/** The first element of `o` at or after `from`, or -1. */
function nextElement(
  enumerating: WeakMap<object, Enumeration>,
  o: AsObject,
  a: Value[] | FloatVector,
  from: number,
): number {
  const length = a.length;
  if (a instanceof FloatVector) {
    return from < length ? from : -1;
  }

  if (enumerable(o, a, from)) {
    return from;
  }

  // Over a gap, an Array's indices, taken once per for-in and again only
  // when its length changes: an element written into a gap below its length
  // after that is missed, as avmplus keeps a sparse Array's elements in its
  // hashtable, where one added may land behind the walk as well as ahead.
  const e = enumerating.get(o);
  if (e?.indices !== undefined && e.indicesAt === length) {
    return nextIndexed(o, a, e.indices, from);
  }

  const scanned = Math.min(length, from + HOLE_SCAN_LIMIT);
  for (let i = from + 1; i < scanned; i++) {
    if (enumerable(o, a, i)) {
      return i;
    }
  }

  if (scanned === length) {
    return -1;
  }

  const keeper: Enumeration = e ?? { names: [], slot: new Map() };
  enumerating.set(o, keeper);
  // Object.keys gives an Array's indices in order.
  keeper.indices = Object.keys(a).map(Number);
  keeper.indicesAt = length;
  return nextIndexed(o, a, keeper.indices, scanned);
}

/** Drop the indices a for-in before took of `o`, which may have been filled in since. */
function forgetIndices(enumerating: WeakMap<object, Enumeration>, o: AsObject): void {
  const e = enumerating.get(o);
  if (e !== undefined) {
    e.indices = undefined;
  }
}

function enumerable(o: AsObject, a: Value[], i: number): boolean {
  return i in a && !o.$dontEnum?.has(String(i));
}

/** The first of `indices`, an Array's in order, at or after `from` that is still there, or -1. */
function nextIndexed(o: AsObject, a: Value[], indices: number[], from: number): number {
  let low = 0;
  let high = indices.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (indices[mid] < from) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }

  for (let j = low; j < indices.length; j++) {
    if (enumerable(o, a, indices[j])) {
      return indices[j];
    }
  }

  return -1;
}

/** The index after `index` among the names of `o` but its elements, or 0. */
function nextNameIndex(
  enumerating: WeakMap<object, Enumeration>,
  o: AsObject,
  index: number,
): number {
  // An Array that has never had other names needs no list of them.
  if (index === 0 && o.$a !== undefined && !o.$d?.size && !enumerating.has(o)) {
    return 0;
  }

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
