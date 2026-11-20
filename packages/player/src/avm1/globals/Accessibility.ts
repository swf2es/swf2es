// AVM1's Accessibility, as adl has it: no screen reader is ever active, so
// there is nothing to send events or properties to. Its functions are
// SWF 6's, though the object is there from SWF 5.
import { avm1 } from "@swf2es/runtime";

/** `_global.Accessibility`. */
export function accessibilityObject(realm: avm1.Realm): avm1.Avm1Object {
  const accessibility = new avm1.Avm1Object(realm.objectProto);
  accessibility.define(
    "isActive",
    realm.method(() => false),
    avm1.VERSION_6,
  );
  accessibility.define(
    "sendEvent",
    realm.method(() => undefined),
    avm1.VERSION_6,
  );
  accessibility.define(
    "updateProperties",
    realm.method(() => undefined),
    avm1.VERSION_6,
  );

  return accessibility;
}
