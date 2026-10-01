// flash.net.FileFilter: three strings a file dialog would show.
import { avm2 } from "@swf2es/runtime";
import type { Scripting } from "../../../scripting.js";

type Value = avm2.Value;

export function fileFilterNatives(_s: Scripting): avm2.Natives {
  const natives: avm2.Natives = {};

  class FileFilterNatives {
    declare $description: Value;
    declare $extension: Value;
    declare $macType: Value;

    get description(): Value {
      return this.$description ?? null;
    }

    set description(v: Value) {
      this.$description = v;
    }

    get extension(): Value {
      return this.$extension ?? null;
    }

    set extension(v: Value) {
      this.$extension = v;
    }

    get macType(): Value {
      return this.$macType ?? null;
    }

    set macType(v: Value) {
      this.$macType = v;
    }
  }

  avm2.registerNativeClass(natives, "flash.net::FileFilter", FileFilterNatives);
  return natives;
}
