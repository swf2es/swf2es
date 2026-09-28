// flash.utils.Dictionary.
import type { AsObject, Value } from "../runtime.js";
import { type Natives, plain } from "./define.js";

export const dictionaryNatives: Natives = {
  // As DictionaryObject: keyed by an object itself, in a Map of its own that
  // property access looks in first, and by any other key as a name. Weak keys
  // cannot be told apart where the host collects garbage, so are kept only
  // for AMF to write.
  "flash.utils::Dictionary#flash.utils:Dictionary::init": plain(function (
    this: AsObject,
    weakKeys: Value,
  ) {
    this.$keys = new Map<object, Value>();
    this.$weakKeys = !!weakKeys;
  }),
};
