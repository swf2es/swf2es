// Device capture follows Adobe's documented API; without a capture host,
// the existing device-free defaults measured in adl remain unchanged.
// The devices are read before a SWF that names the class runs (Code.link);
// one that reached it unseen starts the reading at its first call, and
// finds the devices at a later one.
import { avm2 } from "@swf2es/runtime";
import type { As3 } from "../../../as3/types.js";
import { capturePermission, requestCapturePermission } from "../../../media/capture-permission.js";
import { microphoneRates } from "../../../media/capture-resampler.js";
import { MicrophoneState, microphoneStates } from "../../../media/microphone.js";
import { mixOf } from "../../../media/sounds.js";
import type { Scripting } from "../../../scripting.js";

type Value = avm2.Value;
/** The enhanced options Flash keeps. */
type EnhancedName = "mode" | "echoPath" | "nonLinearProcessing";

export function microphoneNatives(s: Scripting): avm2.Natives {
  const natives: avm2.Natives = {};
  const microphones = new Map<number, avm2.AsObject>();
  let enhancedDevice: MicrophoneState | null = null;
  const state = (object: object) => microphoneStates.get(object);
  const getMicrophone = (value: Value): Value => {
    void s.prepareCapture();
    const index = value === undefined || Number(value) === -1 ? 0 : s.rt.toInt(value);
    const device = s.capture?.microphones?.[index];
    if (!device || !s.capture?.openMicrophone || s.destroyed) {
      return null;
    }
    let microphone = microphones.get(index);
    if (!microphone) {
      microphone = s.rt.construct(s.rt.classNamed("flash.media::Microphone"));
      const live = new MicrophoneState(s, microphone, device, index);
      live.disabled = enhancedDevice !== null;
      microphoneStates.set(microphone, live);
      microphones.set(index, microphone);
    }
    return microphone;
  };

  let enhanced: Map<EnhancedName, Value> | undefined;

  function required(value: Value, name: string): void {
    if (value === null || value === undefined) {
      throw s.rt.error("TypeError", 2007, name);
    }
  }

  class MicrophoneNatives {
    static get permissionStatus(): string {
      return capturePermission(s, "microphone");
    }
    requestPermission(): void {
      requestCapturePermission(s, this, "microphone");
    }

    static get isSupported(): boolean {
      void s.prepareCapture();
      return true;
    }

    /** A new array each time, as Flash's. */
    static get names(): Value {
      void s.prepareCapture();
      return s.rt.array((s.capture?.microphones ?? []).map((device) => device.name));
    }

    static getMicrophone(index: Value): Value {
      return getMicrophone(index);
    }

    static getEnhancedMicrophone(index: Value): Value {
      enhanced ??= new Map<EnhancedName, Value>([
        ["mode", "fullDuplex"],
        ["echoPath", 128],
        ["nonLinearProcessing", true],
      ]);

      const microphone = getMicrophone(index);
      if (microphone && typeof microphone === "object") {
        const live = state(microphone);
        if (live) {
          for (const other of microphones.values()) {
            const previous = state(other);
            if (previous && previous !== live) {
              previous.disabled = true;
              previous.unavailable();
            }
          }
          enhancedDevice = live;
          live.disabled = false;
          live.enhanced = true;
          live.settings();
          live.sync();
        }
      }
      return microphone;
    }

    get activityLevel(): number {
      return state(this)?.activityLevel ?? 0;
    }

    get codec(): Value {
      return state(this)?.codec ?? null;
    }

    set codec(codec: Value) {
      required(codec, "codecString");
      const live = state(this);
      if (live && (codec === "NellyMoser" || codec === "Speex")) {
        live.codec = codec;
        if (codec === "Speex") {
          live.setRate(16);
        }
      }
    }

    get enableVAD(): boolean {
      return state(this)?.enableVAD ?? false;
    }

    set enableVAD(isEnabled: Value) {
      const live = state(this);
      if (live) {
        live.enableVAD = !!isEnabled;
        live.settings();
      }
    }

    get encodeQuality(): number {
      return state(this)?.encodeQuality ?? 0;
    }

    set encodeQuality(quality: Value) {
      const live = state(this);
      if (live) {
        live.encodeQuality = Math.max(0, Math.min(10, s.rt.toInt(quality)));
        live.settings();
      }
    }

    /** A copy of the shared options; isVoiceDetected and autoGain are not kept. */
    get enhancedOptions(): Value {
      if (!enhanced) {
        return null;
      }

      const o = s.rt.construct(
        s.rt.classNamed("flash.media::MicrophoneEnhancedOptions"),
      ) as As3<"flash.media::MicrophoneEnhancedOptions">;
      for (const [name, value] of enhanced) {
        s.rt.setProp(o, name, value);
      }

      return o;
    }

    set enhancedOptions(options: Value) {
      if (!enhanced || options === null || options === undefined) {
        return;
      }

      const live = state(this);
      if (live?.enhanced) {
        live.enhancedMode = s.rt.toString(
          s.rt.prop(options as As3<"flash.media::MicrophoneEnhancedOptions">, "mode"),
        );
        live.settings();
      }
      for (const name of enhanced.keys()) {
        enhanced.set(
          name,
          s.rt.prop(options as As3<"flash.media::MicrophoneEnhancedOptions">, name),
        );
      }
    }

    get framesPerPacket(): number {
      return state(this)?.framesPerPacket ?? 0;
    }

    set framesPerPacket(fpp: Value) {
      const live = state(this);
      if (live) {
        live.framesPerPacket = Math.max(1, Math.min(10, s.rt.toInt(fpp)));
        live.settings();
      }
    }

    get gain(): number {
      return state(this)?.gain ?? 0;
    }

    set gain(gain: Value) {
      const live = state(this);
      if (live) {
        live.gain = Math.max(0, Math.min(100, s.rt.toNumber(gain) || 0));
        live.settings();
      }
    }

    get index(): number {
      return state(this)?.index ?? 0;
    }

    get muted(): boolean {
      return state(this)?.muted ?? false;
    }

    get name(): Value {
      const live = state(this);
      return live ? (s.capture?.microphones?.[live.index]?.name ?? live.device.name) : null;
    }

    get noiseSuppressionLevel(): number {
      return state(this)?.noiseSuppressionLevel ?? 0;
    }

    set noiseSuppressionLevel(level: Value) {
      const live = state(this);
      if (live) {
        live.noiseSuppressionLevel = Math.min(0, s.rt.toInt(level));
        live.settings();
      }
    }

    get rate(): number {
      return state(this)?.rate ?? 0;
    }

    set rate(rate: Value) {
      const live = state(this);
      const value = s.rt.toInt(rate);
      if (live && microphoneRates.has(value)) {
        live.setRate(value);
      }
    }

    get silenceLevel(): number {
      return state(this)?.silenceLevel ?? 0;
    }

    get silenceTimeout(): number {
      return state(this)?.silenceTimeout ?? 0;
    }

    /** A new, untouched transform each time: what is set is not kept. */
    get soundTransform(): Value {
      const transform = s.rt.construct(s.rt.classNamed("flash.media::SoundTransform"));
      const live = state(this);
      if (live) {
        transform.$soundVolume = live.mix.volume;
        transform.$soundLeftToLeft = live.mix.leftToLeft;
        transform.$soundLeftToRight = live.mix.leftToRight;
        transform.$soundRightToLeft = live.mix.rightToLeft;
        transform.$soundRightToRight = live.mix.rightToRight;
      }
      return transform;
    }

    set soundTransform(transform: Value) {
      required(transform, "sndTransform");
      const live = state(this);
      if (live) {
        live.mix = mixOf(transform as avm2.AsObject);
        live.settings();
      }
    }

    get useEchoSuppression(): boolean {
      return state(this)?.useEchoSuppression ?? false;
    }

    setLoopBack(isLooped: Value): void {
      const live = state(this);
      if (live) {
        live.setLoopback(isLooped === undefined || !!isLooped);
      }
    }

    setSilenceLevel(silenceLevel: Value, timeout: Value): void {
      const live = state(this);
      if (live) {
        live.silenceLevel = Math.max(0, Math.min(100, s.rt.toNumber(silenceLevel) || 0));
        const ms = timeout === undefined ? -1 : s.rt.toInt(timeout);
        live.silenceTimeout = ms < 0 ? 2000 : ms;
      }
    }

    setUseEchoSuppression(isEchoSuppressed: Value): void {
      const live = state(this);
      if (live && !live.enhanced) {
        live.useEchoSuppression = !!isEchoSuppressed;
        live.settings();
      }
    }
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
