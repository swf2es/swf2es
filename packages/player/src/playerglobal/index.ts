// playerglobal's natives and class hooks, a file per class under flash/...,
// as the runtime's natives are a file per family of builtins. Bound by the
// names the compiler gives them: "flash.display::DisplayObject#get:x", and
// a private native as "Class#pkg:Class::name".
import type { avm2 } from "@swf2es/runtime";
import type { Scripting } from "../scripting.js";
import { webSocketNatives } from "./air/net/WebSocket.js";
import { accessibilityNatives } from "./flash/accessibility/Accessibility.js";
import { cryptoNatives } from "./flash/crypto/generateRandomBytes.js";
import { clipboardHooks, clipboardNatives } from "./flash/desktop/Clipboard.js";
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
import { shaderNatives } from "./flash/display/Shader.js";
import { shaderDataNatives } from "./flash/display/ShaderData.js";
import { shaderInputNatives } from "./flash/display/ShaderInput.js";
import { shaderJobNatives } from "./flash/display/ShaderJob.js";
import { shaderParameterNatives } from "./flash/display/ShaderParameter.js";
import { shapeNatives } from "./flash/display/Shape.js";
import { simpleButtonNatives } from "./flash/display/SimpleButton.js";
import { spriteNatives } from "./flash/display/Sprite.js";
import { stageNatives } from "./flash/display/Stage.js";
import { stage3DNatives } from "./flash/display/Stage3D.js";
import { eventNatives } from "./flash/events/Event.js";
import { eventDispatcherNatives } from "./flash/events/EventDispatcher.js";
import { gestureEventNatives } from "./flash/events/GestureEvent.js";
import { httpStatusHooks } from "./flash/events/HTTPStatusEvent.js";
import { keyboardEventNatives } from "./flash/events/KeyboardEvent.js";
import { mouseEventNatives } from "./flash/events/MouseEvent.js";
import { pressAndTapGestureEventNatives } from "./flash/events/PressAndTapGestureEvent.js";
import { timerEventNatives } from "./flash/events/TimerEvent.js";
import { touchEventNatives } from "./flash/events/TouchEvent.js";
import { externalInterfaceNatives } from "./flash/external/ExternalInterface.js";
import { bevelFilterNatives } from "./flash/filters/BevelFilter.js";
import { bitmapFilterHooks } from "./flash/filters/BitmapFilter.js";
import { blurFilterNatives } from "./flash/filters/BlurFilter.js";
import { colorMatrixFilterNatives } from "./flash/filters/ColorMatrixFilter.js";
import { convolutionFilterNatives } from "./flash/filters/ConvolutionFilter.js";
import { displacementMapFilterNatives } from "./flash/filters/DisplacementMapFilter.js";
import { dropShadowFilterNatives } from "./flash/filters/DropShadowFilter.js";
import { glowFilterNatives } from "./flash/filters/GlowFilter.js";
import { gradientBevelFilterNatives } from "./flash/filters/GradientBevelFilter.js";
import { gradientGlowFilterNatives } from "./flash/filters/GradientGlowFilter.js";
import { shaderFilterNatives } from "./flash/filters/ShaderFilter.js";
import { matrix3DNatives } from "./flash/geom/Matrix3D.js";
import { perspectiveProjectionNatives } from "./flash/geom/PerspectiveProjection.js";
import { transformNatives } from "./flash/geom/Transform.js";
import { utils3DNatives } from "./flash/geom/Utils3D.js";
import { collatorNatives } from "./flash/globalization/Collator.js";
import { currencyFormatterNatives } from "./flash/globalization/CurrencyFormatter.js";
import { currencyParseResultNatives } from "./flash/globalization/CurrencyParseResult.js";
import { dateTimeFormatterNatives } from "./flash/globalization/DateTimeFormatter.js";
import { localeIDNatives } from "./flash/globalization/LocaleID.js";
import { numberFormatterNatives } from "./flash/globalization/NumberFormatter.js";
import { numberParseResultNatives } from "./flash/globalization/NumberParseResult.js";
import { stringToolsNatives } from "./flash/globalization/StringTools.js";
import { cameraNatives } from "./flash/media/Camera.js";
import { microphoneNatives } from "./flash/media/Microphone.js";
import { soundHooks, soundNatives } from "./flash/media/Sound.js";
import { soundMixerNatives } from "./flash/media/SoundMixer.js";
import { soundTransformNatives } from "./flash/media/SoundTransform.js";
import { videoNatives } from "./flash/media/Video.js";
import { fileFilterNatives } from "./flash/net/FileFilter.js";
import { fileReferenceNatives } from "./flash/net/FileReference.js";
import { localConnectionNatives } from "./flash/net/LocalConnection.js";
import { netConnectionNatives } from "./flash/net/NetConnection.js";
import { navigateNatives } from "./flash/net/navigateToURL.js";
import { sharedObjectNatives } from "./flash/net/SharedObject.js";
import { socketNatives } from "./flash/net/Socket.js";
import { urlRequestNatives } from "./flash/net/URLRequest.js";
import { urlStreamNatives } from "./flash/net/URLStream.js";
import { xmlSocketNatives } from "./flash/net/XMLSocket.js";
import { telemetryNatives } from "./flash/profiler/Telemetry.js";
import { accelerometerNatives } from "./flash/sensors/Accelerometer.js";
import { applicationDomainNatives } from "./flash/system/ApplicationDomain.js";
import { capabilitiesNatives } from "./flash/system/Capabilities.js";
import { fsCommandNatives } from "./flash/system/FSCommand.js";
import { securityNatives } from "./flash/system/Security.js";
import { securityDomainNatives } from "./flash/system/SecurityDomain.js";
import { systemNatives } from "./flash/system/System.js";
import { workerHooks, workerNatives } from "./flash/system/Worker.js";
import { fontDescriptionNatives } from "./flash/text/engine/FontDescription.js";
import { tabStopNatives } from "./flash/text/engine/TabStop.js";
import { fontHooks, fontNatives } from "./flash/text/Font.js";
import { staticTextNatives } from "./flash/text/StaticText.js";
import { styleSheetNatives } from "./flash/text/StyleSheet.js";
import { textFieldNatives } from "./flash/text/TextField.js";
import { textRendererNatives } from "./flash/text/TextRenderer.js";
import { traceNatives } from "./flash/trace/Trace.js";
import { contextMenuNatives } from "./flash/ui/ContextMenu.js";
import { gameInputNatives } from "./flash/ui/GameInput.js";
import { keyboardNatives } from "./flash/ui/Keyboard.js";
import { mouseNatives } from "./flash/ui/Mouse.js";
import { multitouchNatives } from "./flash/ui/Multitouch.js";
import { byteArrayHooks, byteArrayNatives } from "./flash/utils/ByteArray.js";
import { timerNatives } from "./flash/utils/Timer.js";
import { xmlDocumentNatives } from "./flash/xml/XMLDocument.js";
import { toplevelNatives } from "./toplevel.js";

export { airLibrary } from "./air-library.js";
export { playerglobalLibrary } from "./playerglobal-library.js";

export function playerNatives(s: Scripting): avm2.Natives {
  return {
    ...accessibilityNatives(s),
    ...toplevelNatives(s),
    ...cryptoNatives(),
    ...byteArrayNatives(s),
    ...clipboardNatives(s),
    ...eventNatives(s),
    ...keyboardEventNatives(s),
    ...timerEventNatives(s),
    ...mouseEventNatives(s),
    ...touchEventNatives(s),
    ...gestureEventNatives(s),
    ...pressAndTapGestureEventNatives(s),
    ...mouseNatives(s),
    ...multitouchNatives(s),
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
    ...currencyParseResultNatives(s),
    ...numberParseResultNatives(),
    ...collatorNatives(s),
    ...currencyFormatterNatives(s),
    ...dateTimeFormatterNatives(s),
    ...localeIDNatives(s),
    ...numberFormatterNatives(s),
    ...stringToolsNatives(s),
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
    ...xmlSocketNatives(s),
    ...localConnectionNatives(s),
    ...webSocketNatives(s),
    ...sharedObjectNatives(s),
    ...transformNatives(s),
    ...matrix3DNatives(s),
    ...blurFilterNatives(s),
    ...glowFilterNatives(s),
    ...dropShadowFilterNatives(s),
    ...bevelFilterNatives(s),
    ...gradientGlowFilterNatives(s),
    ...gradientBevelFilterNatives(s),
    ...colorMatrixFilterNatives(s),
    ...convolutionFilterNatives(s),
    ...displacementMapFilterNatives(s),
    ...shaderFilterNatives(s),
    ...soundTransformNatives(s),
    ...soundNatives(s),
    ...soundMixerNatives(s),
    ...graphicsNatives(s),
    ...shapeNatives(s),
    ...shaderNatives(s),
    ...shaderDataNatives(s),
    ...shaderInputNatives(s),
    ...shaderParameterNatives(s),
    ...shaderJobNatives(s),
    ...simpleButtonNatives(s),
    ...timerNatives(s),
    ...staticTextNatives(),
    ...fontNatives(s),
    ...fontDescriptionNatives(s),
    ...tabStopNatives(s),
    ...textFieldNatives(s),
    ...textRendererNatives(s),
    ...traceNatives(),
    ...utils3DNatives(s),
    ...perspectiveProjectionNatives(s),
    ...styleSheetNatives(s),
    ...fileReferenceNatives(s),
    ...fsCommandNatives(s),
    ...netConnectionNatives(s),
    ...stage3DNatives(s),
    ...xmlDocumentNatives(s),
    ...videoNatives(s),
    ...cameraNatives(s),
    ...microphoneNatives(s),
    ...keyboardNatives(),
    ...gameInputNatives(s),
    ...contextMenuNatives(s),
    ...accelerometerNatives(),
  };
}

export function playerHooks(s: Scripting): Record<string, avm2.ClassHook> {
  return {
    ...displayObjectHooks(s),
    ...bitmapDataHooks(s),
    ...byteArrayHooks(s),
    ...httpStatusHooks,
    ...bitmapFilterHooks,
    ...workerHooks(s),
    ...clipboardHooks(),
    ...soundHooks(s),
    ...fontHooks(s),
  };
}
