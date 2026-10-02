// The TextField's editable plain text and its display object.
import { avm2 } from "@swf2es/runtime";
import { CONTENT, type TextObject } from "../../../display.js";
import type { Scripting } from "../../../scripting.js";

export function textFieldNatives(s: Scripting): avm2.Natives {
  const natives: avm2.Natives = {};

  class TextFieldNatives {
    declare $display: TextObject;

    get text(): string {
      return this.$display.text;
    }

    set text(value: avm2.Value) {
      const text = s.rt.toString(value);
      if (this.$display.text !== text) {
        this.$display.text = text;
        this.$display.invalidate(CONTENT);
      }
    }
  }

  avm2.registerNativeClass(natives, "flash.text::TextField", TextFieldNatives);
  return natives;
}
