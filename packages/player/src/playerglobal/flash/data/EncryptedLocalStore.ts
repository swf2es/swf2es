// flash.data.EncryptedLocalStore over the host's EncryptedStoreHost
// (hosts.ts), as adl (AIR 51.3) has it: an item is the whole of a
// ByteArray, whatever its position, which stays as it was; getItem gives
// a new ByteArray of it at position 0, and null for a name of none or of
// empty bytes. A null name or data is ArgumentError 2007, an empty name
// 2085. stronglyBound, which ties an item to the application's signature,
// is taken and changes nothing: there is no signature to tie it to.
import { avm2 } from "@swf2es/runtime";
import type { Scripting } from "../../../scripting.js";

type AsObject = avm2.AsObject;
type Value = avm2.Value;

export function encryptedLocalStoreNatives(s: Scripting): avm2.Natives {
  const natives: avm2.Natives = {};
  const store = () => s.encryptedStore;
  /** An item's name; ArgumentError for none, or for "". */
  const nameOf = (name: Value): string => {
    if (name === null || name === undefined) {
      throw s.rt.error("ArgumentError", 2007, "name");
    }

    const named = s.rt.toString(name);
    if (named === "") {
      throw s.rt.error("ArgumentError", 2085, "name");
    }

    return named;
  };

  class EncryptedLocalStoreNatives {
    static get isSupported(): boolean {
      return store() !== null;
    }

    static setItem(name: Value, data: Value, _stronglyBound: Value = false): void {
      const named = nameOf(name);
      if (data === null || data === undefined) {
        throw s.rt.error("ArgumentError", 2007, "data");
      }

      const bytes = avm2.bytesOf(s.rt, data as AsObject);
      const copy = bytes.buffer.slice(0, bytes.length);
      if (copy.length === 0) {
        store()?.removeItem(named);
      } else {
        store()?.setItem(named, copy);
      }
    }

    static getItem(name: Value): Value {
      const bytes = store()?.getItem(nameOf(name));
      if (!bytes || bytes.length === 0) {
        return null;
      }

      const out = s.rt.construct(s.rt.classNamed("flash.utils::ByteArray")) as AsObject;
      const into = avm2.bytesOf(s.rt, out);
      into.write(bytes);
      into.position = 0;
      return out;
    }

    static removeItem(name: Value): void {
      store()?.removeItem(nameOf(name));
    }

    static reset(): void {
      store()?.reset();
    }
  }

  avm2.registerNativeClass(natives, "flash.data::EncryptedLocalStore", EncryptedLocalStoreNatives);
  return natives;
}
