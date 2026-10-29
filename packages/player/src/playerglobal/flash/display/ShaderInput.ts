// flash.display.ShaderInput: an image a kernel samples, a BitmapData or
// floats in a ByteArray or a Vector.<Number>, which then need the width and
// height set; its channels and index are the kernel's.
import { avm2 } from "@swf2es/runtime";
import type { Scripting } from "../../../scripting.js";

type Value = avm2.Value;

/** Whether `v` is what a ShaderInput takes, and a ShaderJob writes: a BitmapData, a ByteArray or a Vector.<Number>. */
export function isShaderImage(s: Scripting, v: Value): boolean {
  return (
    s.rt.isInstance(v, s.rt.classNamed("flash.display::BitmapData")) ||
    s.rt.isInstance(v, s.rt.classNamed("flash.utils::ByteArray")) ||
    s.rt.isInstance(v, s.rt.resolve(s.rt.vector("Number")))
  );
}

export function shaderInputNatives(s: Scripting): avm2.Natives {
  const natives: avm2.Natives = {};

  class ShaderInputNatives {
    declare $input: Value | undefined;
    declare $width: number | undefined;
    declare $height: number | undefined;
    declare $channels: number | undefined;
    declare $index: number | undefined;

    get input(): Value {
      return this.$input ?? null;
    }

    // null too is refused, as adl refuses it.
    set input(v: Value) {
      if (!isShaderImage(s, v)) {
        throw s.rt.error("ArgumentError", 2004);
      }

      this.$input = v;
    }

    get width(): number {
      return this.$width ?? 0;
    }

    set width(v: Value) {
      this.$width = s.rt.toInt(v);
    }

    get height(): number {
      return this.$height ?? 0;
    }

    set height(v: Value) {
      this.$height = s.rt.toInt(v);
    }

    get channels(): number {
      return this.$channels ?? 0;
    }

    get index(): number {
      return this.$index ?? 0;
    }
  }

  avm2.registerNativeClass(natives, "flash.display::ShaderInput", ShaderInputNatives);
  return natives;
}
