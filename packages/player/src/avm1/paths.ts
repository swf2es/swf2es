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

/** The level a display object is, null for one that is none. */
export type LevelOf = (d: DisplayObject) => number | null;

/**
 * The dot path of `d`, `_level0.a.b`, as a clip converts to a string and
 * TargetPath gives it: from its level, or from level 0 for one off the
 * display list.
 */
export function pathOf(d: DisplayObject, levelOf: LevelOf): string {
  const names: string[] = [];
  let level = 0;
  for (let o: DisplayObject | null = d; o !== null; o = o.parent) {
    const n = levelOf(o);
    if (n !== null) {
      level = n;
      break;
    }

    names.push(o.name);
  }

  names.push(`_level${level}`);
  return names.reverse().join(".");
}

/**
 * The slash path of `d`, `_target`'s: "/" for a level, `/a/b` below level
 * 0 and `_level1/a/b` below another, as Ruffle's slash_path has it.
 */
export function slashPathOf(d: DisplayObject, levelOf: LevelOf): string {
  if (levelOf(d) !== null) {
    return "/";
  }

  const names: string[] = [];
  let level = 0;
  for (let o: DisplayObject | null = d; o !== null; o = o.parent) {
    const n = levelOf(o);
    if (n !== null) {
      level = n;
      break;
    }

    names.push(o.name);
  }

  return `${level === 0 ? "" : `_level${level}`}/${names.reverse().join("/")}`;
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
 * finds it again: names from the level, each a child. Null where none is.
 */
export function atPath(
  path: string,
  level: (n: number) => DisplayObject | null,
  caseSensitive: boolean,
): DisplayObject | null {
  const parts = path.split(".");
  const match = /^_level(\d+)$/.exec(parts[0]);
  if (match === null) {
    return null;
  }

  let d: DisplayObject | null = level(Number(match[1]));
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
