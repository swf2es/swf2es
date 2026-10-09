// flash.utils.Dictionary: its natives, held to Dictionary.decl.ts. As
// DictionaryObject: keyed by an object itself, in a Map of its own that
// property access looks in first, and by any other key as a name. Weak keys
// keep no key alive, as Flash's do not (weak-keys.ts): a registry of
// objects keyed weakly kept every one it had seen.

import type { AsObject, Value } from "../../../descriptors.js";
import { WeakKeys } from "../../../weak-keys.js";
import { bindNatives } from "../../bind.js";
import { DictionaryDecl } from "./Dictionary.decl.js";

function init(o: AsObject, weakKeys: boolean): void {
  o.$keys = weakKeys ? new WeakKeys() : new Map<object, Value>();
  o.$weakKeys = weakKeys;
}

export const DictionaryBuiltin = bindNatives(
  DictionaryDecl,
  () =>
    class DictionaryNatives {
      Dictionary(this: AsObject, weakKeys: boolean) {
        init(this, weakKeys);
      }

      "private::init"(this: AsObject, weakKeys: boolean) {
        init(this, weakKeys);
      }
    },
);
