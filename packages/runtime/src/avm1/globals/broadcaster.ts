// AsBroadcaster, which Flash writes in ActionScript and Ruffle in Rust
// (https://github.com/ruffle-rs/ruffle, core/src/avm1/globals/
// as_broadcaster.rs: MIT OR Apache-2.0, Copyright (c) 2018-2022 Ruffle LLC
// and Ruffle contributors), here in TypeScript as adl runs it (docs/avm1.md,
// "AsBroadcaster"): addListener removes the listener, then pushes it, so
// it comes last; removeListener splices out the first one equal to it;
// initialize copies AsBroadcaster's addListener and removeListener onto
// the object and gives it a new broadcastMessage, each hidden from SWF 5.

import {
  Avm1Function,
  Avm1Object,
  DONT_DELETE,
  DONT_ENUM,
  foundDepth,
  get,
  invoke,
  lengthOf,
  type Native,
  set,
  VERSION_6,
} from "../objects.js";
import { looselyEquals } from "../operators.js";
import type { Realm } from "../realm.js";
import { stringOf, toNumber, type Value } from "../values.js";

/** `o.name(...args)`, as code calls a method. */
function callMethod(o: Value, name: string, args: Value[], realm: Realm, version: number): Value {
  if (o instanceof Avm1Object) {
    const method = get(o, name, version);
    return invoke(method, o, args, version, Math.max(foundDepth, 1));
  }

  if (o === undefined || o === null) {
    return undefined;
  }

  return invoke(realm.primitiveMember(o as string, name, version), o, args, version, 1);
}

/** broadcastMessage(name, ...args): each listener's method of that name called, the listeners as they were. */
function broadcast(): Native {
  return (self, args, version) => {
    if (args.length === 0) {
      return undefined;
    }

    const name = stringOf(args[0], version);
    const rest = args.slice(1);
    const listeners = get(self, "_listeners", version);
    if (!(listeners instanceof Avm1Object)) {
      return undefined;
    }

    const n = lengthOf(listeners, version);
    if (n <= 0) {
      return undefined;
    }

    // From SWF 7 the listeners as the call found them; up to 6 the array as it is
    // by then, so that one a listener removes is not called (adl).
    const snapshot: Value[] | null = version >= 7 ? [] : null;
    if (snapshot !== null) {
      for (let i = 0; i < n; i++) {
        snapshot.push(get(listeners, String(i), version));
      }
    }

    for (let i = 0; i < n; i++) {
      const listener = snapshot === null ? get(listeners, String(i), version) : snapshot[i];
      if (!(listener instanceof Avm1Object)) {
        continue;
      }

      if (name === "") {
        invoke(listener, listener, rest, version);
      } else {
        const method = get(listener, name, version, listener, false);
        invoke(method, listener, rest, version, Math.max(foundDepth, 1));
      }
    }

    return true;
  };
}

export function broadcasterClass(realm: Realm): { constr: Avm1Function; proto: Avm1Object } {
  const proto = new Avm1Object();
  const constr = new Avm1Function(
    undefined,
    realm,
    () => undefined,
    (self) => self,
  );
  // `prototype` last, as adl lists it.
  constr.define("constructor", realm.Function, DONT_ENUM | DONT_DELETE);
  constr.define("__proto__", realm.functionProto, DONT_ENUM | DONT_DELETE | VERSION_6);
  constr.define("prototype", proto, DONT_ENUM | DONT_DELETE | VERSION_6);
  proto.define("constructor", constr, DONT_ENUM | DONT_DELETE);
  proto.define("__proto__", realm.objectProto, DONT_ENUM | DONT_DELETE);

  const flags = DONT_ENUM | DONT_DELETE | VERSION_6;
  constr.define("broadcastMessage", realm.method(broadcast()), flags);
  constr.define(
    "addListener",
    realm.method((self, args, version) => {
      const listener = args.length > 0 ? args[0] : undefined;
      callMethod(self, "removeListener", [listener], realm, version);
      callMethod(get(self, "_listeners", version), "push", [listener], realm, version);
      return true;
    }),
    flags,
  );
  constr.define(
    "removeListener",
    realm.method((self, args, version) => {
      const listener = args.length > 0 ? args[0] : undefined;
      const listeners = get(self, "_listeners", version);
      if (!(listeners instanceof Avm1Object)) {
        return false;
      }

      const n = toNumber(get(listeners, "length", version), version) | 0;
      for (let i = 0; i < n; i++) {
        if (looselyEquals(get(listeners, String(i), version), listener, version)) {
          callMethod(listeners, "splice", [i, 1], realm, version);
          return true;
        }
      }

      return false;
    }),
    flags,
  );
  constr.define(
    "initialize",
    realm.method((_, args, version) => {
      const o = args.length > 0 ? args[0] : undefined;
      if (!(o instanceof Avm1Object)) {
        return undefined;
      }

      // As ASSetPropFlags(o, names, 131) sets them: hidden from SWF 5.
      const hidden = DONT_ENUM | DONT_DELETE | VERSION_6;
      const install = (name: string, value: Value) => {
        set(o, name, value, version);
        const p = o.own(name, version);
        if (p !== undefined) {
          p.flags |= hidden;
        }
      };
      install("broadcastMessage", realm.method(broadcast()));
      install("addListener", get(constr, "addListener", version));
      install("removeListener", get(constr, "removeListener", version));
      install("_listeners", realm.newArray([], version));
      return undefined;
    }),
    flags,
  );

  return { constr, proto };
}
