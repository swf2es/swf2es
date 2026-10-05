// playerglobal's natives and class hooks, a file per class under flash/...,
// as the runtime's natives are a file per family of builtins. Bound by the
// names the compiler gives them: "flash.display::DisplayObject#get:x", and
// a private native as "Class#pkg:Class::name".
import type { avm2 } from "@swf2es/runtime";
import type { Scripting } from "../scripting.js";
import { accessibilityNatives } from "./flash/accessibility/Accessibility.js";
import { cryptoNatives } from "./flash/crypto/generateRandomBytes.js";
import { avm1MovieNatives } from "./flash/display/AVM1Movie.js";
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
import { simpleButtonNatives } from "./flash/display/SimpleButton.js";
import { spriteNatives } from "./flash/display/Sprite.js";
import { stageNatives } from "./flash/display/Stage.js";
import { eventNatives } from "./flash/events/Event.js";
import { eventDispatcherNatives } from "./flash/events/EventDispatcher.js";
import { httpStatusHooks } from "./flash/events/HTTPStatusEvent.js";
import { keyboardEventNatives } from "./flash/events/KeyboardEvent.js";
import { mouseEventNatives } from "./flash/events/MouseEvent.js";
import { timerEventNatives } from "./flash/events/TimerEvent.js";
import { externalInterfaceNatives } from "./flash/external/ExternalInterface.js";
import { filterHooks, filterNatives } from "./flash/filters/filters.js";
import { matrix3DNatives } from "./flash/geom/Matrix3D.js";
import { transformNatives } from "./flash/geom/Transform.js";
import { soundHooks, soundNatives } from "./flash/media/Sound.js";
import { soundMixerNatives } from "./flash/media/SoundMixer.js";
import { soundTransformNatives } from "./flash/media/SoundTransform.js";
import { fileFilterNatives } from "./flash/net/FileFilter.js";
import { navigateNatives } from "./flash/net/navigateToURL.js";
import { sharedObjectNatives } from "./flash/net/SharedObject.js";
import { socketNatives } from "./flash/net/Socket.js";
import { urlRequestNatives } from "./flash/net/URLRequest.js";
import { urlStreamNatives } from "./flash/net/URLStream.js";
import { telemetryNatives } from "./flash/profiler/Telemetry.js";
import { applicationDomainNatives } from "./flash/system/ApplicationDomain.js";
import { capabilitiesNatives } from "./flash/system/Capabilities.js";
import { securityNatives } from "./flash/system/Security.js";
import { securityDomainNatives } from "./flash/system/SecurityDomain.js";
import { systemNatives } from "./flash/system/System.js";
import { workerHooks, workerNatives } from "./flash/system/Worker.js";
import { fontHooks, fontNatives } from "./flash/text/Font.js";
import { staticTextNatives } from "./flash/text/StaticText.js";
import { textFieldNatives } from "./flash/text/TextField.js";
import { mouseNatives } from "./flash/ui/Mouse.js";
import { byteArrayHooks } from "./flash/utils/ByteArray.js";
import { timerNatives } from "./flash/utils/Timer.js";
import { toplevelNatives } from "./toplevel.js";

export function playerNatives(s: Scripting): avm2.Natives {
  return {
    ...accessibilityNatives(s),
    ...toplevelNatives(s),
    ...cryptoNatives(),
    ...eventNatives(),
    ...keyboardEventNatives(s),
    ...timerEventNatives(s),
    ...mouseEventNatives(s),
    ...mouseNatives(s),
    ...eventDispatcherNatives(s),
    ...displayObjectNatives(s),
    ...avm1MovieNatives(),
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
    ...navigateNatives(s),
    ...applicationDomainNatives(s),
    ...capabilitiesNatives(s),
    ...securityNatives(s),
    ...securityDomainNatives(s),
    ...systemNatives(s),
    ...workerNatives(s),
    ...telemetryNatives(),
    ...interactiveObjectNatives(s),
    ...fileFilterNatives(s),
    ...socketNatives(s),
    ...sharedObjectNatives(s),
    ...transformNatives(s),
    ...matrix3DNatives(s),
    ...filterNatives(s),
    ...soundTransformNatives(s),
    ...soundNatives(s),
    ...soundMixerNatives(s),
    ...graphicsNatives(s),
    ...shapeNatives(s),
    ...simpleButtonNatives(s),
    ...timerNatives(s),
    ...staticTextNatives(),
    ...fontNatives(s),
    ...textFieldNatives(s),
  };
}

export function playerHooks(s: Scripting): Record<string, avm2.ClassHook> {
  return {
    ...displayObjectHooks(s),
    ...bitmapDataHooks(s),
    ...byteArrayHooks(s),
    ...httpStatusHooks,
    ...filterHooks,
    ...workerHooks(),
    ...soundHooks(s),
    ...fontHooks(s),
  };
}
