// AVM1's variables: names looked up along an activation's scope chain, and
// names that are paths, `a.b:c` or `/a/b:c`, resolved to an object and a
// name on it, as Ruffle's (https://github.com/ruffle-rs/ruffle)
// core/src/avm1/scope.rs and activation.rs (get_variable, set_variable,
// define_local, resolve_target_path) have them: MIT OR Apache-2.0,
// Copyright (c) 2018-2022 Ruffle LLC and Ruffle contributors.
//
// A path walks objects, and a clip's children by name, which only the
// player has: it gives them through the host (`child`, `parent`, `root`,
// `level`), as step 10 of docs/avm1.md fills in; until then a path walks
// objects' properties only.
import type { Host } from "./host.js";
import {
  type Avm1Object,
  allowed,
  find,
  fold,
  get,
  has,
  Avm1Object as ObjectClass,
  removeOwn,
  set,
} from "./objects.js";
import type { Value } from "./values.js";

/** `_global`, at the bottom of every chain. */
export const SCOPE_Global = 0;
/** A clip whose timeline's code runs: where a variable set without one is made. */
export const SCOPE_Target = 1;
/** A function's activation object. */
export const SCOPE_Local = 2;
/** A `with`'s object. */
export const SCOPE_With = 3;

export class Scope {
  constructor(
    readonly parent: Scope | null,
    readonly kind: number,
    readonly object: Avm1Object,
  ) {}
}

/** What variables need of an activation. */
export interface Variables {
  scope: Scope;
  /** `this`. */
  self: Value;
  /** The global object, `_global`. */
  readonly global: Avm1Object;
  readonly host: Host;
}

/** Whether `c` ends a path's object part: `:`, and `.` from SWF 5. */
const separates = (c: number, version: number) => c === 0x3a || (c === 0x2e && version >= 5);

/** Where a name's last `:` or `.` is, the variable after it, -1 for a name without a path. */
function lastSeparator(name: string, version: number): number {
  for (let i = name.length - 1; i >= 0; i--) {
    if (separates(name.charCodeAt(i), version)) {
      return i;
    }
  }

  return -1;
}

/** Whether `a` and `b` are the same name for a SWF of `version`. */
const sameName = (a: string, b: string, version: number) =>
  a === b || (version <= 6 && fold(a) === fold(b));

/** Whether `name` is `this`: case-insensitively up to SWF 6, in a function too (adl; Ruffle has a SWF 5 function's case-sensitive). */
function isThis(name: string, version: number): boolean {
  if (name.length !== 4 || version < 5) {
    return false;
  }

  if (name === "this") {
    return true;
  }

  return version < 7 && fold(name) === "this";
}

/**
 * `_root`, `_parent`, `_global` (from SWF 6) and `_levelN`: what a name
 * the scope chain lacks may still be.
 */
function pathProperty(cx: Variables, name: string, version: number): Value {
  if (version < 5 || name.length < 5 || name.charCodeAt(0) !== 0x5f) {
    return undefined;
  }

  if (sameName(name, "_root", version)) {
    return cx.host.root?.();
  }

  if (sameName(name, "_parent", version)) {
    return cx.host.parent?.(cx.scope.object);
  }

  if (version >= 6 && sameName(name, "_global", version)) {
    return cx.global;
  }

  return level(cx, name, version);
}

/** `_levelN` or `_flashN`: level N, if the host has it. */
function level(cx: Variables, name: string, version: number): Value {
  const prefix = name.slice(0, 6);
  if (!sameName(prefix, "_level", version) && !sameName(prefix, "_flash", version)) {
    return undefined;
  }

  const digits = /^\d+$/.exec(name.slice(6));
  return digits === null ? undefined : cx.host.level?.(Number(digits[0]));
}

/** A name without a path along the scope chain, as GetVariable and NewObject find it. */
export function resolve(cx: Variables, name: string, version: number): Value {
  if (isThis(name, version)) {
    return cx.self;
  }

  for (let s: Scope | null = cx.scope; s !== null; s = s.parent) {
    const p = find(s.object, name, version);
    if (p !== undefined) {
      // The first property found is what get finds too, where its version sees it.
      return p.get === null && allowed(p.flags, version) ? p.value : get(s.object, name, version);
    }
  }

  return pathProperty(cx, name, version);
}

/** What `resolveCallable` found a function on, for CallFunction's `this`. */
export let foundOn: Value;
/** Whether that was a function's activation object. */
export let foundLocal = false;

/** As `resolve`, setting `foundOn` to the object that had the name, undefined for none. */
export function resolveCallable(cx: Variables, name: string, version: number): Value {
  foundOn = undefined;
  foundLocal = false;
  const separator = lastSeparator(name, version);
  if (separator >= 0 || (version >= 5 && name.includes("/"))) {
    return getVariable(cx, name, version);
  }

  if (isThis(name, version)) {
    return cx.self;
  }

  for (let s: Scope | null = cx.scope; s !== null; s = s.parent) {
    if (has(s.object, name, version)) {
      const value = get(s.object, name, version);
      foundOn = s.object;
      foundLocal = s.kind === SCOPE_Local;
      return value;
    }
  }

  return pathProperty(cx, name, version);
}

/**
 * GetVariable: a name, or a path to an object and a name on it, the path
 * tried from each scope in turn; a path without a variable is the object
 * it names, from SWF 5.
 */
export function getVariable(cx: Variables, name: string, version: number): Value {
  const separator = lastSeparator(name, version);
  if (separator >= 0) {
    if (separator === 0) {
      return undefined;
    }

    const path = name.slice(0, separator);
    const variable = name.slice(separator + 1);
    for (let s: Scope | null = cx.scope; s !== null; s = s.parent) {
      const object = targetPath(cx, s.object, path, true, true, version);
      if (object !== null && has(object, variable, version)) {
        // After the getter, which may call functions of its own.
        const value = get(object, variable, version);
        foundOn = object;
        return value;
      }
    }

    return undefined;
  }

  if (version >= 5 && name.includes("/")) {
    for (let s: Scope | null = cx.scope; s !== null; s = s.parent) {
      const object = targetPath(cx, s.object, name, false, false, version);
      if (object !== null) {
        return object;
      }
    }
  }

  return resolve(cx, name, version);
}

/**
 * SetVariable: a path's object takes the name, the first a scope resolves
 * it to; a name without one is set where the scope chain has it, else on
 * the target's clip. `this` from SWF 5 sets the activation's `this`.
 */
export function setVariable(cx: Variables, name: string, value: Value, version: number): void {
  if (name === "") {
    return;
  }

  if (isThis(name, version)) {
    cx.self = value;
    return;
  }

  // A path's separators are `:` and `.` here in every version, and its
  // `this` is no object: adl sets nothing for `this.x`.
  const separator = lastSeparator(name, 5);
  if (separator >= 0) {
    const path = name.slice(0, separator);
    const variable = name.slice(separator + 1);
    for (let s: Scope | null = cx.scope; s !== null; s = s.parent) {
      const object = targetPath(cx, s.object, path, true, false, version);
      if (object !== null) {
        set(object, variable, value, version);
        return;
      }
    }

    return;
  }

  let s = cx.scope;
  for (;;) {
    if (s.kind === SCOPE_Target || has(s.object, name, version) || s.parent === null) {
      set(s.object, name, value, version);
      return;
    }

    s = s.parent;
  }
}

/** Whether the activation's chain reaches a function's scope before a clip's. */
function inLocalScope(cx: Variables): boolean {
  for (let s: Scope | null = cx.scope; s !== null; s = s.parent) {
    if (s.kind === SCOPE_Local) {
      return true;
    }

    if (s.kind === SCOPE_Target) {
      return false;
    }
  }

  return false;
}

/** Whether a name has a `:` or a `.`, a path, in every version. */
const isPath = (name: string) => lastSeparator(name, 5) >= 0;

/** Set `name` on the top scope, or on the first below a `with` that lacks it. */
function defineOn(scope: Scope, name: string, value: Value, version: number): void {
  let s = scope;
  while (s.kind === SCOPE_With && s.parent !== null && s.object.own(name, version) === undefined) {
    s = s.parent;
  }

  set(s.object, name, value, version);
}

/** DefineLocal: a variable of the activation's top scope; a path outside a function is set as SetVariable sets it. */
export function defineLocal(cx: Variables, name: string, value: Value, version: number): void {
  if (!inLocalScope(cx) && isPath(name)) {
    setVariable(cx, name, value, version);
  } else {
    defineOn(cx.scope, name, value, version);
  }
}

/** DefineLocal2: as DefineLocal of undefined, where the variable is not there yet. */
export function defineLocal2(cx: Variables, name: string, version: number): void {
  if (!inLocalScope(cx) && isPath(name)) {
    if (getVariable(cx, name, version) === undefined) {
      setVariable(cx, name, undefined, version);
    }
  } else if (!has(cx.scope.object, name, version)) {
    defineOn(cx.scope, name, undefined, version);
  }
}

/** Delete2: a path's variable on its object, or a name on the first scope that has it. */
export function deleteVariable(cx: Variables, name: string, version: number): boolean {
  const separator = lastSeparator(name, 5);
  if (separator >= 0) {
    const object = getVariable(cx, name.slice(0, separator), version);
    return object instanceof ObjectClass && removeOwn(object, name.slice(separator + 1), version);
  }

  for (let s: Scope | null = cx.scope; s !== null; s = s.parent) {
    if (has(s.object, name, version)) {
      return removeOwn(s.object, name, version);
    }
  }

  return false;
}

/**
 * The object a target path names from `start`: names separated by `.`,
 * `:` or `/`, `..` the parent, a leading `/` the root, `this`, `_root` and
 * `_levelN` first; each name a clip's child, else a property. Null where a
 * step is no object.
 */
export function targetPath(
  cx: Variables,
  start: Avm1Object,
  path: string,
  firstElement: boolean,
  handleThis: boolean,
  version: number,
): Avm1Object | null {
  if (path === "") {
    return start;
  }

  const swf5 = version >= 5;
  let object: Value = start;
  let slash = false;
  let i = 0;
  if (path.charCodeAt(0) === 0x2f) {
    i = 1;
    firstElement = false;
    slash = true;
    object = cx.host.root?.();
    if (!(object instanceof ObjectClass)) {
      return null;
    }
  }

  const n = path.length;
  while (i < n) {
    if (swf5) {
      while (i < n && path.charCodeAt(i) === 0x3a) {
        i++;
      }

      if (i === n) {
        break;
      }
    }

    let value: Value;
    const c2 = path.charCodeAt(i + 2);
    if (
      path.charCodeAt(i) === 0x2e &&
      path.charCodeAt(i + 1) === 0x2e &&
      (i + 2 >= n || c2 === 0x2f || (swf5 && c2 === 0x3a))
    ) {
      if (c2 === 0x2f) {
        slash = true;
      }

      i += 3;
      value = cx.host.parent?.(object as Avm1Object);
      if (value === undefined) {
        return null;
      }
    } else {
      let end = i;
      for (; end < n; end++) {
        const c = path.charCodeAt(end);
        if ((c === 0x3a && swf5) || (c === 0x2e && swf5 && !slash)) {
          break;
        }

        if (c === 0x2f) {
          slash = true;
          break;
        }
      }

      const name = path.slice(i, end);
      i = end + 1;
      if (swf5 && handleThis && sameName(name, "this", version)) {
        value = cx.self;
      } else if (swf5 && firstElement && sameName(name, "_root", version)) {
        value = cx.host.root?.();
      } else if (version >= 6 && firstElement && sameName(name, "_global", version)) {
        value = cx.global;
      } else if (firstElement && level(cx, name, version) !== undefined) {
        value = level(cx, name, version);
      } else {
        const o = object as Avm1Object;
        value = cx.host.child?.(o, name, version > 6);
        if (value === undefined) {
          value = get(o, name, version);
        }
      }
    }

    firstElement = false;
    if (!(value instanceof ObjectClass)) {
      return null;
    }

    object = value;
  }

  return object as Avm1Object;
}
