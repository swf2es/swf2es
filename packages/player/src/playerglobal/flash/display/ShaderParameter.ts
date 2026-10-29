// flash.display.ShaderParameter: a kernel parameter's value, its type's
// name and its index among the kernel's parameters, set by ShaderData; its
// metadata are dynamic properties.
import { avm2 } from "@swf2es/runtime";
import type { Scripting } from "../../../scripting.js";

type Value = avm2.Value;

export function shaderParameterNatives(_s: Scripting): avm2.Natives {
  const natives: avm2.Natives = {};

  class ShaderParameterNatives {
    declare $value: Value | undefined;
    declare $type: string | null | undefined;
    declare $index: number | undefined;

    get value(): Value {
      return this.$value ?? null;
    }

    set value(v: Value) {
      this.$value = v ?? null;
    }

    get type(): string | null {
      return this.$type ?? null;
    }

    get index(): number {
      return this.$index ?? 0;
    }
  }

  avm2.registerNativeClass(natives, "flash.display::ShaderParameter", ShaderParameterNatives);
  return natives;
}
