// A Vector's elements, as the kind of its elements keeps them in V8.
//
// V8 merges the array maps a store site sees into the most general of
// them: a site that has stored into an array of objects moves an array of
// doubles that it stores into to objects too, each double boxed from then
// on. A site that every Vector's elements pass through, as push's would
// be, so makes every Vector.<Number>'s elements objects once a
// Vector.<String> has been through it. Each kind stores through a function
// of its own, and its elements start in the most general elements kind
// they will take, so that no store moves them: a double's for uint and
// Number, which a small integer cannot always hold, and an object's for
// the others.

import type { Value } from "../descriptors.js";

/** A store of x as element i of a, through the site of one kind. */
export type ElementStore = (a: Value[], i: number, x: Value) => void;

export function storeInt(a: Value[], i: number, x: Value): void {
  a[i] = x;
}

export function storeDouble(a: Value[], i: number, x: Value): void {
  a[i] = x;
}

export function storeObject(a: Value[], i: number, x: Value): void {
  a[i] = x;
}

// `length` elements of the kind's default, packed, each kind from an
// array literal of its own.

export function intElements(length: number): Value[] {
  const a: Value[] = [];
  while (a.length < length) {
    a.push(0);
  }

  return a;
}

export function doubleElements(length: number): Value[] {
  const a: Value[] = [0.5];
  a.pop();
  while (a.length < length) {
    a.push(0);
  }

  return a;
}

export function objectElements(length: number): Value[] {
  const a: Value[] = [null];
  a.pop();
  while (a.length < length) {
    a.push(null);
  }

  return a;
}
