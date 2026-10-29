// flash.display.ShaderInput: an image a kernel samples, a BitmapData or
// floats in a ByteArray or a Vector.<Number>, which then need the width and
// height set; its channels and index are the kernel's.
import { avm2 } from "@swf2es/runtime";
import type { Scripting } from "../../../scripting.js";

type Value = avm2.Value;

/** The classes the shader natives test values against, resolved once a player. */
export interface ShaderClasses {
  array: avm2.AsObject;
  bitmapData: avm2.AsObject;
  byteArray: avm2.AsObject;
  vector: avm2.AsObject;
  shaderParameter: avm2.AsObject;
  shaderInput: avm2.AsObject;
  shaderEvent: avm2.AsObject;
}

const resolved = new WeakMap<Scripting, ShaderClasses>();

/** The classes, looked up at the first call, once playerglobal is loaded. */
export function shaderClasses(s: Scripting): ShaderClasses {
  let classes = resolved.get(s);
  if (!classes) {
    classes = {
      array: s.rt.classNamed("Array"),
      bitmapData: s.rt.classNamed("flash.display::BitmapData"),
      byteArray: s.rt.classNamed("flash.utils::ByteArray"),
      vector: s.rt.resolve(s.rt.vector("Number")),
      shaderParameter: s.rt.classNamed("flash.display::ShaderParameter"),
      shaderInput: s.rt.classNamed("flash.display::ShaderInput"),
      shaderEvent: s.rt.classNamed("flash.events::ShaderEvent"),
    };
    resolved.set(s, classes);
  }

  return classes;
}

/** Whether `v` is what a ShaderInput takes, and a ShaderJob writes: a BitmapData, a ByteArray or a Vector.<Number>. */
export function isShaderImage(s: Scripting, v: Value): boolean {
  const c = shaderClasses(s);
  return (
    s.rt.isInstance(v, c.bitmapData) ||
    s.rt.isInstance(v, c.byteArray) ||
    s.rt.isInstance(v, c.vector)
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
