// flash.utils.ByteArray as the runtime has it, but for a subclass that
// SymbolClass binds to DefineBinaryData: its instances start with the data,
// at position 0, and share it, each seeing what the others write until one
// is resized, as Flash's do. Crossbridge keeps a C program's initialized
// data so, one subclass per data section.
import { avm2 } from "@swf2es/runtime";
import type { Scripting } from "../../../scripting.js";

export function byteArrayHooks(s: Scripting): Record<string, avm2.ClassHook> {
  return {
    "flash.utils::ByteArray": {
      ...avm2.byteArrayHook,
      create: (traits, rt) => {
        const o = avm2.byteArrayHook.create(traits, rt);
        const data = s.symbols.binarySymbol(traits);
        if (data) {
          const b = avm2.bytesOf(rt, o);
          b.buffer = data;
          b.view = new DataView(data.buffer);
          b.length = data.length;
        }

        return o;
      },
    },
  };
}
