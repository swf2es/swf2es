// AVM1's Accessibility, as adl has it: no screen reader is ever active, so
// there is nothing to send events or properties to. Its functions are
// SWF 6's, though the object is there from SWF 5, and read-only.
import { avm1 } from "@swf2es/runtime";

const FLAGS = avm1.READ_ONLY | avm1.VERSION_6;

/** `_global.Accessibility`. */
export function accessibilityObject(realm: avm1.Realm): avm1.Avm1Object {
  const accessibility = new avm1.Avm1Object(realm.objectProto);
  accessibility.define(
    "isActive",
    realm.method(() => false),
    FLAGS,
  );
  accessibility.define(
    "sendEvent",
    realm.method(() => undefined),
    FLAGS,
  );
  accessibility.define(
    "updateProperties",
    realm.method(() => undefined),
    FLAGS,
  );

  return accessibility;
}
