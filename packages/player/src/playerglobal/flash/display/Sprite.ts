// flash.display.Sprite: its constructor's private native constructChildren
// places a symbol's first frame, so that the subclass's constructor finds
// the children by name; a Sprite a script makes has none.
import { avm2 } from "@swf2es/runtime";
import { MovieClip } from "../../../display.js";
import { displayOf } from "./DisplayObject.js";

const { plain } = avm2;
type AsObject = avm2.AsObject;

export function spriteNatives(): avm2.Natives {
  return {
    "flash.display::Sprite#flash.display:Sprite::constructChildren": plain(function (
      this: AsObject,
    ) {
      const d = displayOf(this);
      if (d instanceof MovieClip && d.currentFrame === 0) {
        d.enterFirstFrame();
      }
    }),
    "flash.display::Sprite#get:buttonMode": plain(() => false),
    "flash.display::Sprite#set:buttonMode": plain(() => undefined),
    "flash.display::Sprite#get:useHandCursor": plain(() => true),
    "flash.display::Sprite#set:useHandCursor": plain(() => undefined),
  };
}
