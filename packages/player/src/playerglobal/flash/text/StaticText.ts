// flash.text.StaticText: DefineText's glyphs, which a script reads as its text.
import { avm2 } from "@swf2es/runtime";
import { StaticTextObject } from "../../../display/display.js";
import { displayOf } from "../display/DisplayObject.js";

type Value = avm2.Value;

export function staticTextNatives(): avm2.Natives {
  const natives: avm2.Natives = {};

  class StaticTextNatives {
    /** Its glyphs' characters; null where a glyph's font is not the SWF's, or there are none. */
    get text(): Value {
      const display = displayOf(this as unknown as avm2.AsObject);
      return display instanceof StaticTextObject ? display.glyphs.text : null;
    }
  }

  avm2.registerNativeClass(natives, "flash.text::StaticText", StaticTextNatives);
  return natives;
}
