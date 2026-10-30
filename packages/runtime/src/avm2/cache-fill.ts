// What a full lookup leaves in its multiname's inline cache for the next
// get, set or call on an object with the same traits (property-cache.ts).

import type { Method, TypeRef, Value } from "./descriptors.js";
import { hookedBinding } from "./hooks.js";
import { arrayIndex, type Multiname } from "./names.js";
import {
  entryFor,
  IC_Call,
  IC_Const,
  IC_Dynamic,
  IC_Get,
  IC_GetSet,
  IC_Method,
  IC_Set,
  IC_Slot,
  PropertyCache,
  UNFILLED,
} from "./property-cache.js";
import {
  BIND_Const,
  BIND_Get,
  BIND_GetSet,
  BIND_Method,
  BIND_Set,
  BIND_Var,
  methodKey,
  slotKey,
  type Traits,
  untypedSetKey,
} from "./traits.js";

/**
 * Keep what `mn` found on `traits`, `o`'s, in `head`, its cache: a
 * binding, as getProperty, setProperty and callProperty use it, or a
 * dynamic property's name. Not where the name resolves otherwise: through
 * a property hook (a Proxy's, XML's), an index (a Vector's, an Array's
 * element), or a Dictionary's key; nor on a primitive's dynamic property,
 * which its prototypes have.
 */
export function fillCache(
  head: PropertyCache,
  o: Value,
  traits: Traits,
  b: number,
  mn: Multiname,
): void {
  const hook = traits.properties;
  const id = b >> 3;
  let kind: number;
  let key = "";
  let get: Method | null = null;
  let set: Method | null = null;
  let type: TypeRef = null;
  if (b === 0) {
    const name = mn.dynamicName();
    if (
      name === null ||
      (typeof o !== "object" && typeof o !== "function") ||
      hook !== null ||
      !traits.dynamic ||
      traits.refusesNames ||
      traits.getIndex !== undefined ||
      traits.index !== undefined ||
      arrayIndex(name) >= 0
    ) {
      return;
    }

    kind = IC_Dynamic;
    key = name;
  } else {
    const hooked = hook !== null && hookedBinding(b, mn, hook);
    switch (b & 7) {
      case BIND_Method:
        kind = hooked ? IC_Call : IC_Method;
        get = traits.proto[methodKey(id)];
        break;
      case BIND_Var:
      case BIND_Const:
        kind = (b & 7) === BIND_Var ? IC_Slot : IC_Const;
        key = slotKey(id);
        type = traits.slotType(id);
        break;
      case BIND_Get:
        kind = IC_Get;
        get = traits.proto[methodKey(id)];
        break;
      case BIND_Set:
        kind = IC_Set;
        set = traits.proto[untypedSetKey(id + 1)] ?? traits.proto[methodKey(id + 1)];
        break;
      case BIND_GetSet:
        kind = IC_GetSet;
        get = traits.proto[methodKey(id)];
        set = traits.proto[untypedSetKey(id + 1)] ?? traits.proto[methodKey(id + 1)];
        break;
      default:
        return;
    }

    if (hooked && kind !== IC_Call) {
      return;
    }
  }

  if (head === UNFILLED) {
    head = new PropertyCache();
    mn.cache = head;
  }

  const e = entryFor(head, traits);
  if (e === null) {
    return;
  }

  e.traits = traits;
  e.kind = kind;
  e.key = key;
  e.get = get;
  e.set = set;
  e.type = type;
  e.id = id;
}
