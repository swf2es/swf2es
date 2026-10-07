// Inline caches of the runtime's multiname lookup: what a module's name
// found on the traits of the objects it was last looked up on, so that the
// next get, set or call of the name on an object with the same traits does
// what that lookup decided without searching the bindings again.
//
// A lookup's result depends only on the receiver's traits and the name,
// whose namespaces and versions are fixed: a binding, or none, which makes
// it a dynamic property's. Traits change only as they are described, and
// their prototypes' methods and hooks as a class or a script is set up;
// each bumps the epoch, which empties every cache. A dynamic property's
// entry still looks for the property on the object, which may have lost it,
// and leaves anything else, as its prototypes, to the full lookup.

import type { Method, TypeRef } from "./descriptors.js";
import type { Traits } from "./runtime.js";

/** What an entry does for its name on its traits; get, set and call take what each can. */
export const IC_Slot = 1;
export const IC_Const = 2;
export const IC_Get = 3;
export const IC_Set = 4;
export const IC_GetSet = 5;
export const IC_Method = 6;
/** A method a property hook resolves the name of for get and set, as XML's: callproperty only. */
export const IC_Call = 7;
/** No binding: an own dynamic property, if the object has it. */
export const IC_Dynamic = 8;

/** Entries a name keeps, for as many traits, before it replaces the oldest. */
export const ENTRIES = 8;
/**
 * Entries a name replaces before it stops: one seen on more traits than it
 * keeps would replace one on every miss, and still miss as often. It keeps
 * those it has until the epoch changes.
 */
export const REPLACEMENTS = 16;

/**
 * One traits' entry for a name. A name's first entry heads its list and
 * holds what the list shares: the epoch it was filled in and the entry to
 * replace next.
 */
export class PropertyCache {
  traits: Traits | null = null;
  kind = 0;
  /** The slot's field, or the dynamic property's name. */
  key = "";
  /** The getter, or the method. */
  get: Method | null = null;
  set: Method | null = null;
  /** The slot's type, which a value set is coerced to. */
  type: TypeRef = null;
  /** The method's dispatch id, which its closure is kept by. */
  id = 0;
  next: PropertyCache | null = null;
  epoch = -1;
  /** The entry the next traits replace once the list is full, and how many it has replaced. */
  victim: PropertyCache | null = null;
  replaced = 0;
}

let current = 0;

/** The epoch caches filled now are valid in. */
export function epoch(): number {
  return current;
}

/** The caches filled in this epoch, which invalidate empties so that they keep no traits or code. */
const filled: PropertyCache[] = [];

/** Note that `head`'s cache is being filled in this epoch. */
export function filling(head: PropertyCache): void {
  filled.push(head);
}

/** Empty every cache: a traits' bindings, methods or hooks are changing. */
export function invalidate(): void {
  for (let i = 0; i < filled.length; i++) {
    for (let e: PropertyCache | null = filled[i]; e !== null; e = e.next) {
      e.traits = null;
      e.get = null;
      e.set = null;
      e.type = null;
    }
  }

  filled.length = 0;
  current++;
}

/** The cache of a name made at run time, used once: never filled. */
export const NO_CACHE = new PropertyCache();
/** The cache of a module's name before its first lookup: filled with an entry of its own. */
export const UNFILLED = new PropertyCache();
