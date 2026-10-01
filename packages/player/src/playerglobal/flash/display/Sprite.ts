// flash.display.Sprite: its constructor's private native constructChildren
// places a symbol's first frame, so that the subclass's constructor finds
// the children by name; a Sprite a script makes has none.
import { avm2 } from "@swf2es/runtime";
import { type DisplayObject, MovieClip } from "../../../display.js";

type Value = avm2.Value;

export function spriteNatives(): avm2.Natives {
  const natives: avm2.Natives = {};

  class SpriteNatives {
    declare $display: DisplayObject;

    "flash.display:Sprite::constructChildren"(): void {
      const d = this.$display;
      if (d instanceof MovieClip && d.currentFrame === 0) {
        d.enterFirstFrame();
      }
    }

    get buttonMode(): boolean {
      return false;
    }

    set buttonMode(_v: Value) {
      // Not yet: there is no mouse.
    }

    get useHandCursor(): boolean {
      return true;
    }

    set useHandCursor(_v: Value) {
      // Not yet: there is no mouse.
    }
  }

  avm2.registerNativeClass(natives, "flash.display::Sprite", SpriteNatives);
  return natives;
}
