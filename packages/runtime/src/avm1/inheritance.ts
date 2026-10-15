// AS2's classes as the compiler writes them: Extends, InstanceOf, CastOp
// and ImplementsOp, as Ruffle's (https://github.com/ruffle-rs/ruffle)
// core/src/avm1/activation.rs and object.rs (is_instance_of) have them:
// MIT OR Apache-2.0, Copyright (c) 2018-2022 Ruffle LLC and Ruffle
// contributors. Where adl parts from Ruffle, adl decides (docs/avm1.md,
// "Classes").

import type { Activation } from "./activation.js";
import { Avm1Object, DONT_ENUM, get, set, VERSION_6 } from "./objects.js";
import type { Realm } from "./realm.js";
import { isPrimitive, toNumber, type Value } from "./values.js";

/** What Flash's log says of a primitive where an action takes an object. */
const PRIMITIVE =
  "Parameters of primitive types are no longer coerced into the required type - Object.";
/** And of an object where it takes a number. */
const OBJECT =
  "Parameters of type Object are no longer coerced into the required primitive type - number.";

/** A primitive where an object is taken: undefined and null say nothing, any other writes to the log. */
function refuse(cx: Activation, value: Value): void {
  if (value !== undefined && value !== null) {
    cx.host.trace(PRIMITIVE);
  }
}

/** The deepest a prototype chain is walked, as objects.ts walks one. */
const DEPTH = 255;

/**
 * A class's or an interface's `prototype` as InstanceOf and ImplementsOp
 * read it: its own stored value, no getter called, nothing inherited.
 */
function prototypeOf(o: Avm1Object, version: number): Value {
  return o.own("prototype", version)?.value;
}

/**
 * Whether `value` is an instance of `constr`: its `prototype` on the
 * object's chain, or among the interfaces of one there, and theirs. A
 * primitive class, or prototype, is boxed, by `_global`'s class.
 */
export function instanceOf(realm: Realm, value: Value, constr: Value, version: number): boolean {
  if (!(value instanceof Avm1Object) || constr === undefined || constr === null) {
    return false;
  }

  let prototype = prototypeOf(realm.box(constr, version), version);
  if (isPrimitive(prototype) && prototype !== undefined && prototype !== null) {
    prototype = realm.box(prototype, version);
  }

  if (!(prototype instanceof Avm1Object)) {
    return false;
  }

  let p = value.protoFor(version);
  for (let depth = 0; p instanceof Avm1Object && depth < DEPTH; depth++) {
    if (p === prototype) {
      return true;
    }

    if (p.interfaces !== null && implementsOf(p.interfaces, prototype, 0)) {
      return true;
    }

    p = p.protoFor(version);
  }

  return false;
}

/** Whether `prototype` is among `interfaces`, or theirs. */
function implementsOf(interfaces: Avm1Object[], prototype: Avm1Object, depth: number): boolean {
  for (const i of interfaces) {
    if (i === prototype) {
      return true;
    }

    if (
      i.interfaces !== null &&
      depth < DEPTH &&
      implementsOf(i.interfaces, prototype, depth + 1)
    ) {
      return true;
    }
  }

  return false;
}

/**
 * Extends: the subclass's `prototype` a new object whose prototype is the
 * superclass's, which knows its `__constructor__` but has no `constructor`
 * of its own (adl; Ruffle gives it one). A primitive on either side
 * changes nothing (adl).
 */
export function extend(cx: Activation, superclass: Value, subclass: Value, version: number): void {
  if (!(superclass instanceof Avm1Object)) {
    refuse(cx, superclass);
    return;
  }

  if (!(subclass instanceof Avm1Object)) {
    refuse(cx, subclass);
    return;
  }

  // `__constructor__` is hidden from a SWF 5 (adl).
  const prototype = new Avm1Object(get(superclass, "prototype", version));
  prototype.define("__constructor__", superclass, DONT_ENUM | VERSION_6);
  set(subclass, "prototype", prototype, version);
}

/**
 * ImplementsOp: the constructor, the interfaces' count and the interfaces
 * popped, the interfaces' prototypes given to the constructor's: only the
 * first time, as adl has it (Ruffle replaces them), and from SWF 6 too.
 */
export function implementsOp(cx: Activation, version: number): void {
  const st = cx.st;
  const constr = st.pop();
  if (!(constr instanceof Avm1Object)) {
    refuse(cx, constr);
  }

  const countValue = st.pop();
  let count = 0;
  if (isPrimitive(countValue)) {
    count = toNumber(countValue, version) | 0;
  } else {
    cx.host.trace(OBJECT);
  }

  count = Math.min(count, st.length);
  if (count <= 0) {
    return;
  }

  const interfaces: Avm1Object[] = [];
  for (let k = 0; k < count; k++) {
    const i = st.pop();
    if (i instanceof Avm1Object) {
      const p = prototypeOf(i, version);
      if (p instanceof Avm1Object) {
        interfaces.push(p);
      }
    } else {
      refuse(cx, i);
    }
  }

  if (constr instanceof Avm1Object) {
    const prototype = prototypeOf(constr, version);
    if (prototype instanceof Avm1Object && prototype.interfaces === null) {
      prototype.interfaces = interfaces;
    }
  }
}
