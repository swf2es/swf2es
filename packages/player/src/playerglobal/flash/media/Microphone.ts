// flash.media.Microphone as Flash Player has it on a machine without a
// microphone: supported, but no names and no microphone to get. A
// Microphone made with `new` reads as zeros and nulls, and its settings
// change nothing, as in Flash; only the null checks of its setters remain.
// The enhanced options are the exception: Flash keeps one set for every
// Microphone once getEnhancedMicrophone has been called, whatever it returned.
import { avm2 } from "@swf2es/runtime";
import type { Scripting } from "../../../scripting.js";

type Value = avm2.Value;

export function microphoneNatives(s: Scripting): avm2.Natives {
  const natives: avm2.Natives = {};

  let enhanced: Map<string, Value> | undefined;

  function required(value: Value, name: string): void {
    if (value === null || value === undefined) {
      throw s.rt.error("TypeError", 2007, name);
    }
  }

  class MicrophoneNatives {
    static get isSupported(): boolean {
      return true;
    }

    /** A new array each time, as Flash's. */
    static get names(): Value {
      return s.rt.array([]);
    }

    static getMicrophone(_index: Value): Value {
      return null;
    }

    static getEnhancedMicrophone(_index: Value): Value {
      enhanced ??= new Map<string, Value>([
        ["mode", "fullDuplex"],
        ["echoPath", 128],
        ["nonLinearProcessing", true],
      ]);

      return null;
    }

    get activityLevel(): number {
      return 0;
    }

    get codec(): Value {
      return null;
    }

    set codec(codec: Value) {
      required(codec, "codecString");
    }

    get enableVAD(): boolean {
      return false;
    }

    set enableVAD(_isEnabled: Value) {}

    get encodeQuality(): number {
      return 0;
    }

    set encodeQuality(_quality: Value) {}

    /** A copy of the shared options; isVoiceDetected and autoGain are not kept. */
    get enhancedOptions(): Value {
      if (!enhanced) {
        return null;
      }

      const o = s.rt.construct(
        s.rt.classNamed("flash.media::MicrophoneEnhancedOptions"),
      ) as avm2.AsObject;
      for (const [name, value] of enhanced) {
        s.rt.setProperty(o, s.rt.publicName(name), value);
      }

      return o;
    }

    set enhancedOptions(options: Value) {
      if (!enhanced || options === null || options === undefined) {
        return;
      }

      for (const name of enhanced.keys()) {
        enhanced.set(name, s.rt.getProperty(options as avm2.AsObject, s.rt.publicName(name)));
      }
    }

    get framesPerPacket(): number {
      return 0;
    }

    set framesPerPacket(_fpp: Value) {}

    get gain(): number {
      return 0;
    }

    set gain(_gain: Value) {}

    get index(): number {
      return 0;
    }

    get muted(): boolean {
      return false;
    }

    get name(): Value {
      return null;
    }

    get noiseSuppressionLevel(): number {
      return 0;
    }

    set noiseSuppressionLevel(_level: Value) {}

    get rate(): number {
      return 0;
    }

    set rate(_rate: Value) {}

    get silenceLevel(): number {
      return 0;
    }

    get silenceTimeout(): number {
      return 0;
    }

    /** A new, untouched transform each time: what is set is not kept. */
    get soundTransform(): Value {
      return s.rt.construct(s.rt.classNamed("flash.media::SoundTransform"));
    }

    set soundTransform(transform: Value) {
      required(transform, "sndTransform");
    }

    get useEchoSuppression(): boolean {
      return false;
    }

    setLoopBack(_isLooped: Value): void {}

    setSilenceLevel(_silenceLevel: Value, _timeout: Value): void {}

    setUseEchoSuppression(_isEchoSuppressed: Value): void {}
  }

  /** Flash keeps autoGain off whatever is set: its other options are AS3. */
  class MicrophoneEnhancedOptionsNatives {
    get autoGain(): boolean {
      return false;
    }

    set autoGain(_value: Value) {}
  }

  avm2.registerNativeClass(natives, "flash.media::Microphone", MicrophoneNatives);
  avm2.registerNativeClass(
    natives,
    "flash.media::MicrophoneEnhancedOptions",
    MicrophoneEnhancedOptionsNatives,
  );
  return natives;
}
