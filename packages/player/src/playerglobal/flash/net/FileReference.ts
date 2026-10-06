// flash.net.FileReference and FileReferenceList: file dialogs the player
// does not show. Each acts as Flash does when the user cancels it: browse
// and the saves return, and Event.CANCEL comes in the next frame; a
// FileReference never has a file, so what reads one throws #2037.
import { avm2 } from "@swf2es/runtime";
import { dispatchEvent } from "../../../scripting/events.js";
import type { Scripting } from "../../../scripting.js";

type AsObject = avm2.AsObject;
type Value = avm2.Value;

export function fileReferenceNatives(s: Scripting): avm2.Natives {
  const natives: avm2.Natives = {};

  /** The dialog cancelled, as Flash reports it: CANCEL from the player, in a later frame. */
  const cancelled = (target: AsObject): void => {
    s.deferHostEvent(() => dispatchEvent(s, target, s.event("cancel")));
  };

  const noFile = (): never => {
    throw s.rt.error("Error", 2037);
  };

  class FileReferenceNatives {
    get creationDate(): Value {
      return noFile();
    }

    get modificationDate(): Value {
      return noFile();
    }

    get name(): Value {
      return noFile();
    }

    get size(): Value {
      return noFile();
    }

    get type(): Value {
      return noFile();
    }

    get creator(): Value {
      return null;
    }

    get data(): Value {
      return null;
    }

    browse(_typeFilter: Value = null): boolean {
      cancelled(this as unknown as AsObject);
      return true;
    }

    cancel(): void {}

    download(request: Value, _name: Value = null): void {
      if (request === null || request === undefined) {
        throw s.rt.error("TypeError", 2007, "request");
      }

      cancelled(this as unknown as AsObject);
    }

    upload(request: Value, _field: Value = "Filedata", _test: Value = false): void {
      if (request === null || request === undefined) {
        throw s.rt.error("TypeError", 2007, "request");
      }

      noFile();
    }

    uploadUnencoded(request: Value): void {
      if (request === null || request === undefined) {
        throw s.rt.error("TypeError", 2007, "request");
      }

      noFile();
    }

    "flash.net:FileReference::_load"(_into: Value): void {
      noFile();
    }

    "flash.net:FileReference::_save"(_data: Value, _name: Value): void {
      cancelled(this as unknown as AsObject);
    }

    /** Flash's check that the call comes from a player, not a plug-in host's script: here it always does. */
    static "flash.net:FileReference::_ensureIsRootPlayer"(): void {}
  }

  class FileReferenceListNatives {
    declare $fileList: Value;

    /** Null until a browse, then the files chosen: none. */
    get fileList(): Value {
      return this.$fileList ?? null;
    }

    browse(_typeFilter: Value = null): boolean {
      this.$fileList = s.rt.array([]);
      cancelled(this as unknown as AsObject);
      return true;
    }
  }

  avm2.registerNativeClass(natives, "flash.net::FileReference", FileReferenceNatives);
  avm2.registerNativeClass(natives, "flash.net::FileReferenceList", FileReferenceListNatives);
  return natives;
}
