// flash.display.Shader: its ShaderData, which byteCode's AS3 setter makes,
// and the precision hint, "full" or "fast": the CPU runs every kernel in full.
import { avm2 } from "@swf2es/runtime";
import type { Scripting } from "../../../scripting.js";

type Value = avm2.Value;

export function shaderNatives(s: Scripting): avm2.Natives {
  const natives: avm2.Natives = {};

  class ShaderNatives {
    declare $data: Value | undefined;
    declare $precision: string | undefined;

    get data(): Value {
      return this.$data ?? null;
    }

    set data(v: Value) {
      this.$data = v ?? null;
    }

    get precisionHint(): string {
      return this.$precision ?? "full";
    }

    set precisionHint(v: Value) {
      const hint = v === null || v === undefined ? null : s.rt.toString(v);
      if (hint !== "full" && hint !== "fast") {
        throw s.rt.error("ArgumentError", 2004);
      }

      this.$precision = hint;
    }
  }

  avm2.registerNativeClass(natives, "flash.display::Shader", ShaderNatives);
  return natives;
}
