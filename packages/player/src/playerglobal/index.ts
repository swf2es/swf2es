// playerglobal's natives and class hooks, a file per class under flash/...,
// as the runtime's natives are a file per family of builtins. Bound by the
// names the compiler gives them: "flash.display::DisplayObject#get:x", and
// a private native as "Class#pkg:Class::name".
import type { avm2 } from "@swf2es/runtime";
import type { Scripting } from "../scripting.js";
import { displayObjectHooks, displayObjectNatives } from "./flash/display/DisplayObject.js";
import { containerNatives } from "./flash/display/DisplayObjectContainer.js";
import { movieClipNatives } from "./flash/display/MovieClip.js";
import { spriteNatives } from "./flash/display/Sprite.js";
import { stageNatives } from "./flash/display/Stage.js";
import { eventNatives } from "./flash/events/Event.js";
import { eventDispatcherNatives } from "./flash/events/EventDispatcher.js";
import { toplevelNatives } from "./toplevel.js";

export function playerNatives(s: Scripting): avm2.Natives {
  return {
    ...toplevelNatives(s),
    ...eventNatives(),
    ...eventDispatcherNatives(s),
    ...displayObjectNatives(s),
    ...containerNatives(s),
    ...spriteNatives(),
    ...movieClipNatives(s),
    ...stageNatives(s),
  };
}

export function playerHooks(s: Scripting): Record<string, avm2.ClassHook> {
  return displayObjectHooks(s);
}
