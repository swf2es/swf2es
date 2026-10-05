// flash.crypto contains one function: cryptographically strong bytes from
// the host, with Flash's bounded length and a fresh ByteArray at position 0.
import { avm2 } from "@swf2es/runtime";

type Value = avm2.Value;

export function cryptoNatives(): avm2.Natives {
  return {
    "flash.crypto::generateRandomBytes": (rt) => (count: Value) => {
      const length = rt.toUint(count);
      if (length === 0) {
        // AIR returns null here, though the API reference gives 1 as the minimum.
        return null;
      }

      if (length > 1024) {
        throw rt.error("Error", 2004);
      }

      const crypto = globalThis.crypto;
      if (!crypto?.getRandomValues) {
        throw rt.error("Error", 0);
      }

      const array = rt.construct(rt.classNamed("flash.utils::ByteArray")) as avm2.AsObject;
      const bytes = avm2.bytesOf(rt, array);
      bytes.setLength(length);
      try {
        crypto.getRandomValues(bytes.buffer.subarray(0, length));
      } catch {
        throw rt.error("Error", 0);
      }

      return array;
    },
  };
}
