// flash.display.Shape: a display object with a Graphics and nothing else.
import { avm2 } from "@swf2es/runtime";
import type { Scripting } from "../../../scripting.js";
import { graphicsOf } from "./Graphics.js";

type Value = avm2.Value;

export function shapeNatives(s: Scripting): avm2.Natives {
  const natives: avm2.Natives = {};

  class ShapeNatives {
    get graphics(): Value {
      return graphicsOf(s, this as unknown as avm2.AsObject);
    }
  }

  avm2.registerNativeClass(natives, "flash.display::Shape", ShapeNatives);
  return natives;
}
