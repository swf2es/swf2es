// AVM1's names for display objects, as Ruffle's
// (https://github.com/ruffle-rs/ruffle) core/src/display_object.rs (path,
// slash_path, avm1_parent) and container.rs (child_by_name) have them: MIT
// OR Apache-2.0, Copyright (c) 2018-2022 Ruffle LLC and Ruffle
// contributors. Where adl parts from Ruffle, adl decides (docs/avm1.md,
// "Clips and paths").
import { avm1 } from "@swf2es/runtime";
import { Container, type DisplayObject } from "../display/display.js";

/** ASCII's lower case, as Flash compares instance names and frame labels without case. */
export function asciiLower(s: string): string {
  // A loop and not a regular expression's test, which allocates: clips' display properties are looked up so.
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0x41 && c <= 0x5a) {
      return s.replace(/[A-Z]/g, (u) => String.fromCharCode(u.charCodeAt(0) + 32));
    }
  }

  return s;
}

/** A display object's parent as AVM1 sees it: none above a level, the root of its movie. */
export function parentOf(d: DisplayObject, root: DisplayObject): Container | null {
  return d === root ? null : d.parent;
}

/** The dot path of `d`, `_level0.a.b`, as a clip converts to a string and TargetPath gives it. */
export function pathOf(d: DisplayObject, root: DisplayObject): string {
  const names: string[] = [];
  let o: DisplayObject | null = d;
  while (o !== null && o !== root) {
    names.push(o.name);
    o = o.parent;
  }

  names.push("_level0");
  return names.reverse().join(".");
}

/** The slash path of `d`, `/a/b`, `_target`'s: "/" for the root. */
export function slashPathOf(d: DisplayObject, root: DisplayObject): string {
  if (d === root) {
    return "/";
  }

  const names: string[] = [];
  for (let o: DisplayObject | null = d; o !== null && o !== root; o = o.parent) {
    names.push(o.name);
  }

  return `/${names.reverse().join("/")}`;
}

/**
 * The child of `d` named `name`, the lowest in depth of those that are, in
 * its case or, up to SWF 6, folded as Flash folds names (the corpus's
 * `swf6_case_insensitive`).
 */
export function childByName(
  d: DisplayObject,
  name: string,
  caseSensitive: boolean,
): DisplayObject | null {
  if (!(d instanceof Container)) {
    return null;
  }

  // An object without a name, a shape's, has none to find it by. Folding
  // keeps a name's length, so a name of another length is passed by
  // unfolded: `_x` read on a clip asks each of its children.
  const key = caseSensitive ? name : avm1.fold(name);
  for (const child of d.children) {
    const n = child.name;
    if (n.length === key.length && n !== "" && (caseSensitive ? n : avm1.fold(n)) === key) {
      return child;
    }
  }

  return null;
}

/**
 * The display object at a dot path, `_level0.a.b`, as a clip's reference
 * finds it again: names from the root, each a child. Null where none is.
 */
export function atPath(
  path: string,
  root: DisplayObject,
  caseSensitive: boolean,
): DisplayObject | null {
  const parts = path.split(".");
  if (parts[0] !== "_level0") {
    return null;
  }

  let d: DisplayObject | null = root;
  for (let i = 1; i < parts.length && d !== null; i++) {
    d = childByName(d, parts[i], caseSensitive);
  }

  return d;
}

/** Whether `d` is on `root`'s display list, the root itself included. */
export function under(d: DisplayObject, root: DisplayObject): boolean {
  for (let o: DisplayObject | null = d; o !== null; o = o.parent) {
    if (o === root) {
      return true;
    }
  }

  return false;
}
