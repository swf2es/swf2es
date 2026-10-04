// flash.display.Sprite: its constructor's private native constructChildren
// makes a symbol's first frame alive, placed before the constructor for a
// timeline's child and here for a script's, so that the subclass's
// constructor finds the children by name; a Sprite a script makes has none.
import { avm2 } from "@swf2es/runtime";
import { type DisplayObject, MovieClip } from "../../../display.js";
import type { Scripting } from "../../../scripting.js";
import { graphicsOf } from "./Graphics.js";

type Value = avm2.Value;

export function spriteNatives(s: Scripting): avm2.Natives {
  const natives: avm2.Natives = {};

  class SpriteNatives {
    declare $display: DisplayObject;

    get graphics(): Value {
      return graphicsOf(s, this as unknown as avm2.AsObject);
    }

    "flash.display:Sprite::constructChildren"(): void {
      const d = this.$display;
      if (d instanceof MovieClip) {
        d.enterFirstFrame();
      }
    }

    declare $buttonMode: boolean | undefined;

    /** Kept for Tab, which visits a sprite in button mode, and the pointer, which shows a hand over it. */
    get buttonMode(): boolean {
      return this.$buttonMode ?? false;
    }

    set buttonMode(v: Value) {
      this.$buttonMode = !!v;
    }

    declare $useHandCursor: boolean | undefined;

    get useHandCursor(): boolean {
      return this.$useHandCursor ?? true;
    }

    set useHandCursor(v: Value) {
      this.$useHandCursor = !!v;
    }
  }

  avm2.registerNativeClass(natives, "flash.display::Sprite", SpriteNatives);
  return natives;
}
