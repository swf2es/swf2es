// What a for-in goes through, as avmplus' nextNameIndex: an Array's or a
// Vector's elements by index up to their length at each step, then the
// object's other names, each kept in a slot for as long as it is there, as
// in avmplus' hashtable, so that names come and go during a for-in without
// moving the others.

import type { AsObject, Value } from "./descriptors.js";
import { DictionaryKeys } from "./dictionary-keys.js";
import { Namespace } from "./names.js";
import { FloatVector } from "./natives/float-vector.js";

/**
 * What for-ins over one object keep. Elements are walked by index and get
 * no slots: `names` and `slot` hold only its dynamic properties' names,
 * each in a slot, as in avmplus' hashtable; a Dictionary keeps its own
 * slots, in its keys' store (dictionary-keys.ts), by the same rules. A name
 * keeps its slot while it is there, so a for-in started inside another
 * never moves the outer one's names. One deleted stays in its slot, which
 * the outer one skips, until a for-in next starts: then its slot is free,
 * and it takes one again only if it is back, as a new name, which takes a
 * free slot; only with none free does the list grow. So it is at most as
 * long as the most names the object had at once, as avmplus' table, and
 * nothing a for-in goes through is ever moved or dropped.
 */
export interface Enumeration {
  /** The name in each slot, null in one free. */
  names: (string | null)[];
  /** Each name's slot. */
  slot: Map<string, number>;
  /** A sparse Array's indices, while a for-in walks it. */
  sparse?: SparseIndices;
}

/**
 * The indices of a sparse Array, in order, taken when a for-in first meets
 * a run of holes too long to step through, so that it crosses each gap by
 * them, and dropped when the for-in ends or another starts.
 */
interface SparseIndices {
  indices: number[];
  /** The Array's length when they were last brought up to it. */
  length: number;
  /** Where in them the index last given is, and that index, so that the next step goes on from there. */
  at: number;
  given: number;
  /** How many were given since they were taken, and whether they were taken again since this for-in met them. */
  sinceTaken: number;
  retaken: boolean;
}

/** A name a for-in goes through: a string, or an object a Dictionary is keyed by. */
export type EnumeratedName = string | object;

/** The names below this come back from a for-in as numbers: avmplus' int atoms, of 29 bits. */
export const INT_ATOM_LIMIT = 0x10000000;

/** An object's own names, its elements' included, then its dynamic properties' and a Dictionary's keys. */
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

  names.push(...dynamicNames(o));
  if (o.$keys !== undefined) {
    for (const k of o.$keys.keys()) {
      names.push(k);
    }
  }

  return names;
}

function dynamicNames(o: AsObject): string[] {
  return o.$d ? [...o.$d.keys()] : [];
}

// Keep scratch separate so the per-step name lookups see the same record shapes.
const slotMarks = new WeakMap<Enumeration, Uint8Array>();

/**
 * The names of `o` past its elements, for a for-in starting over it: those
 * it had before in their slots, and new ones in the slots of those gone,
 * then after them. Or, for one going on from an Array's elements to its
 * other names (`starting` false), new ones in slots already free, then
 * after them: only a for-in's start frees slots, those of names gone.
 */
function startEnumeration(
  enumerating: WeakMap<object, Enumeration>,
  o: AsObject,
  starting: boolean,
): (string | null)[] {
  const names = dynamicNames(o);
  let e = enumerating.get(o);
  if (!e) {
    e = { names, slot: new Map(names.map((name, i) => [name, i])) };
    enumerating.set(o, e);
    return names;
  }

  if (names.length <= 1 && names.length === e.names.length && names[0] === e.names[0]) {
    return e.names;
  }

  const free: number[] = [];
  if (starting && e.names.length >= 32) {
    refreshSlots(e, names, free);
  } else {
    freeSlots(e, o, free, starting);
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

/** List each free slot in `free`, `freeing` first those of the names `o` no longer has. */
function freeSlots(e: Enumeration, o: AsObject, free: number[], freeing: boolean): void {
  // By index, not forEach: every for-in over the same object again comes here.
  const known = e.names;
  for (let i = 0; i < known.length; i++) {
    const name = known[i];
    if (name === null) {
      free.push(i);
    } else if (freeing && !stillThere(o, name)) {
      e.slot.delete(name);
      known[i] = null;
      free.push(i);
    }
  }
}

/**
 * The name of `o`, not a Dictionary, at a for-in's index among the names
 * past its elements, the index less their length.
 */
export function enumerated(
  enumerating: WeakMap<object, Enumeration>,
  o: AsObject,
  index: number,
): string {
  return enumerating.get(o)?.names[index - 1] ?? "";
}

/**
 * The index after `index` of an enumerable name of `o`, or 0. As avmplus'
 * ArrayObject and TypedVectorObject, the elements come first, by their
 * length at each step, not when the for-in started, so it goes on through
 * those pushed or filled in during it; then the other names, whose indices
 * come after the elements' length, which moves them if it changes then.
 */
export function nextIndex(
  enumerating: WeakMap<object, Enumeration>,
  o: AsObject,
  index: number,
): number {
  // An object without elements never gains them: past its first step, no need to look again.
  const known = o === lastStep.o && index === lastStep.index;
  const a: Value[] | FloatVector | undefined = known && lastStep.none ? undefined : o.$a;
  if (a !== undefined && !known) {
    // Not the keys of a Dictionary whose for-in was left off.
    lastStep.keys = null;
  }

  const next =
    a === undefined
      ? nextOfNames(enumerating, o, index, known)
      : nextOfElements(enumerating, o, a, index);
  if (next === 0) {
    lastStep.o = null;
    lastStep.keys = null;
  } else {
    lastStep.o = o;
    lastStep.index = next;
    lastStep.none = a === undefined;
  }

  return next;
}

/**
 * As nextIndex, over an object without elements: a Dictionary by its keys,
 * any other by the names of its dynamic properties.
 */
function nextOfNames(
  enumerating: WeakMap<object, Enumeration>,
  o: AsObject,
  index: number,
  known: boolean,
): number {
  // One is a Dictionary or not for good: past its first step, no need to look again.
  const keys = known ? lastStep.keys : dictionaryKeys(o);
  lastStep.keys = keys;
  return keys !== null ? keys.next(o, index) : nextNameIndex(enumerating, o, index, index === 0);
}

function dictionaryKeys(o: AsObject): DictionaryKeys | null {
  const keys = o?.$keys;
  return keys instanceof DictionaryKeys ? keys : null;
}

/**
 * The keys of Dictionary `o` at a for-in's index, which hold its names and
 * values there; null for any other object.
 */
export function dictionaryAt(o: AsObject, index: number): DictionaryKeys | null {
  return o === lastStep.o && index === lastStep.index ? lastStep.keys : dictionaryKeys(o);
}

/**
 * The step a for-in last took: the object, the index it gave, whether the
 * object has no elements and its keys if a Dictionary, so that the next
 * step and the nextName and nextValue right after it need not look for
 * them again, which misses, at a cost, on the many objects that have
 * neither, and never gain any. Let go when a for-in ends.
 */
const lastStep: { o: AsObject; index: number; none: boolean; keys: DictionaryKeys | null } = {
  o: null,
  index: 0,
  none: false,
  keys: null,
};

/**
 * Whether a for-in's step over `o` at `index` goes on from the last one
 * nextIndex gave, so that `o` is an ordinary object: no hook, no QName.
 */
export function continues(o: Value, index: number): boolean {
  return o === lastStep.o && index === lastStep.index;
}

/** The length of the elements of `o` at a for-in's index: where those end and its other names start. */
export function elementsAt(o: AsObject, index: number): number {
  if (o === lastStep.o && index === lastStep.index && lastStep.none) {
    return 0;
  }

  return o?.$a?.length ?? 0;
}

/** As nextIndex, over an object with elements. */
function nextOfElements(
  enumerating: WeakMap<object, Enumeration>,
  o: AsObject,
  a: Value[] | FloatVector,
  index: number,
): number {
  if (index === 0) {
    const e = enumerating.get(o);
    if (e !== undefined) {
      e.sparse = undefined;
      freeSlots(e, o, [], true);
    }
  }

  const length = a.length;
  if (index < length) {
    const i = nextElement(enumerating, o, a, index);
    if (i >= 0) {
      return i + 1;
    }
  }

  const at = Math.max(index - length, 0);

  // An Array that has never had other names needs no list of them.
  if (at === 0 && !o.$d?.size && !enumerating.has(o)) {
    return 0;
  }

  const next = nextNameIndex(enumerating, o, at, false);
  if (next === 0) {
    // The for-in is over: its indices go with it.
    const e = enumerating.get(o);
    if (e !== undefined) {
      e.sparse = undefined;
    }

    return 0;
  }

  return length + next;
}

/** After this many holes in a row, the next element is found by an Array's indices, so that a sparse one stays cheap. */
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

  const e = enumerating.get(o);
  if (e?.sparse !== undefined) {
    return nextSparse(o, a, e.sparse, from);
  }

  // From the hole at `from`, up to HOLE_SCAN_LIMIT of them one by one.
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
  keeper.sparse = {
    indices: indicesOf(a, 0),
    length,
    at: -1,
    given: -1,
    sinceTaken: 0,
    retaken: false,
  };
  return nextSparse(o, a, keeper.sparse, scanned);
}

/**
 * The first element of `o` at or after `from` by its indices, brought up to
 * a length grown or shrunk since. One of them gone was deleted, or moved by
 * a reorder such as reverse: the first time, and then once as many have
 * been given since as a sixteenth of them, they are taken again, so that
 * one moved is found; between, those gone are passed over, so that a for-in
 * deleting ahead of itself stays linear. As in avmplus' hashtable, which a
 * sparse Array keeps its elements in, one moved may then be missed.
 */
function nextSparse(o: AsObject, a: Value[], sparse: SparseIndices, from: number): number {
  const length = a.length;
  if (length > sparse.length) {
    if (length - sparse.length <= HOLE_SCAN_LIMIT * HOLE_SCAN_LIMIT) {
      for (let i = sparse.length; i < length; i++) {
        if (i in a) {
          sparse.indices.push(i);
        }
      }
    } else {
      sparse.indices.push(...indicesOf(a, sparse.length));
    }

    sparse.length = length;
  } else if (length < sparse.length) {
    retake(a, sparse);
  }

  let j = sparse.given === from - 1 ? sparse.at + 1 : firstAtOrAfter(sparse.indices, from);
  while (j < sparse.indices.length) {
    const i = sparse.indices[j];
    if (enumerable(o, a, i)) {
      sparse.at = j;
      sparse.given = i;
      sparse.sinceTaken++;
      return i;
    }

    if (!sparse.retaken || sparse.sinceTaken * 16 >= sparse.indices.length) {
      retake(a, sparse);
      sparse.retaken = true;
      j = firstAtOrAfter(sparse.indices, from);
    } else {
      j++;
    }
  }

  return -1;
}

/** Take a sparse Array's indices again. */
function retake(a: Value[], sparse: SparseIndices): void {
  sparse.indices = indicesOf(a, 0);
  sparse.length = a.length;
  sparse.at = -1;
  sparse.given = -1;
  sparse.sinceTaken = 0;
}

/** An Array's indices from `from` on, in order, as Object.keys gives them. */
function indicesOf(a: Value[], from: number): number[] {
  const indices: number[] = [];
  for (const k of Object.keys(a)) {
    const i = Number(k);
    if (i >= from) {
      indices.push(i);
    }
  }

  return indices;
}

/** Where in `indices`, in order, the first at or after `from` is. */
function firstAtOrAfter(indices: number[], from: number): number {
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

  return low;
}

function enumerable(o: AsObject, a: Value[], i: number): boolean {
  return i in a && !o.$dontEnum?.has(String(i));
}

/**
 * The index after `index` among the names of `o` but its elements, or 0,
 * `starting` a for-in over it.
 */
function nextNameIndex(
  enumerating: WeakMap<object, Enumeration>,
  o: AsObject,
  index: number,
  starting: boolean,
): number {
  // As the prototypes a for-in goes on to, whose methods are all hidden:
  // nothing to go through, and no list of names to keep for it.
  if (index === 0 && !anyEnumerable(o)) {
    return 0;
  }

  const names =
    index === 0 ? startEnumeration(enumerating, o, starting) : (enumerating.get(o)?.names ?? []);

  // A name deleted since the for-in started is skipped.
  for (let i = index; i < names.length; i++) {
    const name = names[i];
    if (name !== null && !o.$dontEnum?.has(name) && stillThere(o, name)) {
      return i + 1;
    }
  }

  return 0;
}

/** Whether any dynamic property of `o` is not hidden. */
function anyEnumerable(o: AsObject): boolean {
  const d: Map<string, unknown> | undefined = o.$d;
  if (!d?.size) {
    return false;
  }

  // Fewer hidden than there are names leaves one shown, whatever else is hidden.
  const hidden: Set<string> | undefined = o.$dontEnum;
  if (hidden === undefined || hidden.size < d.size) {
    return true;
  }

  for (const name of d.keys()) {
    if (!hidden.has(name)) {
      return true;
    }
  }

  return false;
}

function stillThere(o: AsObject, name: string): boolean {
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

// A mark per slot avoids a second map lookup for each existing name.
function refreshSlots(e: Enumeration, names: string[], free: number[]): void {
  let present = slotMarks.get(e);
  if (present === undefined || present.length < e.names.length) {
    present = new Uint8Array(e.names.length);
    slotMarks.set(e, present);
  }

  present.fill(0);
  let added = 0;

  for (let n = 0; n < names.length; n++) {
    const name = names[n];
    const slot = e.slot.get(name);
    if (slot === undefined) {
      names[added++] = name;
    } else {
      present[slot] = 1;
    }
  }

  names.length = added;

  for (let i = 0; i < e.names.length; i++) {
    const name = e.names[i];
    if (name === null) {
      free.push(i);
    } else if (present[i] === 0) {
      e.slot.delete(name);
      e.names[i] = null;
      free.push(i);
    }
  }
}
