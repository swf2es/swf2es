// flash.display.Stage: the stage's size and frame rate, and invalidate,
// which asks for a RENDER event before the frame is drawn.
import { avm2 } from "@swf2es/runtime";
import type { Scripting } from "../../../scripting.js";

const { plain } = avm2;

export function stageNatives(s: Scripting): avm2.Natives {
  return {
    "flash.display::Stage#get:frameRate": plain(() => s.frameRate),
    "flash.display::Stage#set:frameRate": plain((v: avm2.Value) => {
      s.frameRate = Math.max(0.01, Math.min(1000, Number(v)));
    }),
    "flash.display::Stage#get:stageWidth": plain(() => s.stageWidth),
    "flash.display::Stage#get:stageHeight": plain(() => s.stageHeight),
    "flash.display::Stage#invalidate": plain(() => {
      s.invalidated = true;
    }),
    "flash.display::Stage#get:scaleMode": plain(() => "showAll"),
    "flash.display::Stage#set:scaleMode": plain(() => undefined),
    "flash.display::Stage#get:align": plain(() => ""),
    "flash.display::Stage#set:align": plain(() => undefined),
    "flash.display::Stage#get:quality": plain(() => s.quality),
    "flash.display::Stage#set:quality": plain((v: avm2.Value) => {
      s.quality = String(v).toUpperCase();
    }),
    "flash.display::Stage#get:displayState": plain(() => "normal"),
    "flash.display::Stage#set:displayState": plain(() => undefined),
    "flash.display::Stage#get:focus": plain(() => null),
    "flash.display::Stage#set:focus": plain(() => undefined),
    "flash.display::Stage#get:showDefaultContextMenu": plain(() => true),
    "flash.display::Stage#set:showDefaultContextMenu": plain(() => undefined),
    "flash.display::Stage#get:stageFocusRect": plain(() => true),
    "flash.display::Stage#set:stageFocusRect": plain(() => undefined),
  };
}
