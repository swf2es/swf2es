// flash.utils.Dictionary.
import type { AsObject, Value } from "../descriptors.js";
import { WeakKeys } from "../weak-keys.js";
import { type Natives, plain } from "./define.js";

export const dictionaryNatives: Natives = {
  // As DictionaryObject: keyed by an object itself, in a Map of its own that
  // property access looks in first, and by any other key as a name. Weak keys
  // keep no key alive, as Flash's do not (weak-keys.ts): a registry of
  // objects keyed weakly kept every one it had seen.
  "flash.utils::Dictionary#flash.utils:Dictionary::init": plain(function (
    this: AsObject,
    weakKeys: Value,
  ) {
    this.$keys = weakKeys ? new WeakKeys() : new Map<object, Value>();
    this.$weakKeys = !!weakKeys;
  }),
};
