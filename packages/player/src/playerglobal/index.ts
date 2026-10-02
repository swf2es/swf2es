// playerglobal's natives and class hooks, a file per class under flash/...,
// as the runtime's natives are a file per family of builtins. Bound by the
// names the compiler gives them: "flash.display::DisplayObject#get:x", and
// a private native as "Class#pkg:Class::name".
import type { avm2 } from "@swf2es/runtime";
import type { Scripting } from "../scripting.js";
import { bitmapNatives } from "./flash/display/Bitmap.js";
import { bitmapDataHooks, bitmapDataNatives } from "./flash/display/BitmapData.js";
import { displayObjectHooks, displayObjectNatives } from "./flash/display/DisplayObject.js";
import { containerNatives } from "./flash/display/DisplayObjectContainer.js";
import { graphicsNatives } from "./flash/display/Graphics.js";
import { interactiveObjectNatives } from "./flash/display/InteractiveObject.js";
import { loaderNatives } from "./flash/display/Loader.js";
import { loaderInfoNatives } from "./flash/display/LoaderInfo.js";
import { movieClipNatives } from "./flash/display/MovieClip.js";
import { shapeNatives } from "./flash/display/Shape.js";
import { spriteNatives } from "./flash/display/Sprite.js";
import { stageNatives } from "./flash/display/Stage.js";
import { eventNatives } from "./flash/events/Event.js";
import { eventDispatcherNatives } from "./flash/events/EventDispatcher.js";
import { externalInterfaceNatives } from "./flash/external/ExternalInterface.js";
import { transformNatives } from "./flash/geom/Transform.js";
import { soundTransformNatives } from "./flash/media/SoundTransform.js";
import { fileFilterNatives } from "./flash/net/FileFilter.js";
import { urlRequestNatives } from "./flash/net/URLRequest.js";
import { urlStreamNatives } from "./flash/net/URLStream.js";
import { applicationDomainNatives } from "./flash/system/ApplicationDomain.js";
import { securityNatives } from "./flash/system/Security.js";
import { systemNatives } from "./flash/system/System.js";
import { timerNatives } from "./flash/utils/Timer.js";
import { toplevelNatives } from "./toplevel.js";

export function playerNatives(s: Scripting): avm2.Natives {
  return {
    ...toplevelNatives(s),
    ...eventNatives(),
    ...eventDispatcherNatives(s),
    ...displayObjectNatives(s),
    ...bitmapNatives(s),
    ...bitmapDataNatives(s),
    ...containerNatives(s),
    ...spriteNatives(s),
    ...movieClipNatives(s),
    ...stageNatives(s),
    ...loaderNatives(s),
    ...loaderInfoNatives(s),
    ...externalInterfaceNatives(s),
    ...urlRequestNatives(s),
    ...urlStreamNatives(s),
    ...applicationDomainNatives(s),
    ...securityNatives(s),
    ...systemNatives(s),
    ...interactiveObjectNatives(s),
    ...fileFilterNatives(s),
    ...transformNatives(s),
    ...soundTransformNatives(s),
    ...graphicsNatives(s),
    ...shapeNatives(s),
    ...timerNatives(s),
  };
}

export function playerHooks(s: Scripting): Record<string, avm2.ClassHook> {
  return { ...displayObjectHooks(s), ...bitmapDataHooks };
}
