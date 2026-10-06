// flash.media.SoundMixer: the global sound transform over every channel,
// stopAll, and the settings Flash keeps without the player using them.
import { avm2 } from "@swf2es/runtime";
import { stopAllSounds } from "../../../media/sounds.js";
import type { Scripting } from "../../../scripting.js";
import { mixerTransform, setMixerTransform } from "./Sound.js";

type AsObject = avm2.AsObject;
type Value = avm2.Value;

const PLAYBACK_MODES = ["media", "voice", "ambient"];

/** The 512 floats computeSpectrum writes, 256 a channel. */
const SPECTRUM_BYTES = 2048;

export function soundMixerNatives(s: Scripting): avm2.Natives {
  const natives: avm2.Natives = {};
  // Seconds a timeline stream buffers: Flash's default, kept and read back.
  let bufferTime = 5;
  let playbackMode = "media";
  let speakerphone = false;

  class SoundMixerNatives {
    static get soundTransform(): AsObject {
      return mixerTransform(s);
    }

    static set soundTransform(value: Value) {
      setMixerTransform(s, value);
    }

    static get bufferTime(): number {
      return bufferTime;
    }

    static set bufferTime(value: Value) {
      const time = s.rt.toInt(value);
      if (time < 0) {
        throw s.rt.error("RangeError", 2027, "bufferTime", time);
      }

      bufferTime = time;
    }

    static stopAll(): void {
      stopAllSounds(s);
    }

    static areSoundsInaccessible(): boolean {
      return false;
    }

    /**
     * Ruffle's computeSpectrum of a device with no sample history: the
     * player has no output to read back, so every value is 0.
     */
    static computeSpectrum(outputArray: Value, _fftMode: Value, _stretchFactor: Value): void {
      if (outputArray === null || outputArray === undefined) {
        throw s.rt.error("TypeError", 2007, "sound");
      }

      const bytes = (outputArray as AsObject).$bytes;
      bytes.setLength(SPECTRUM_BYTES);
      bytes.position = 0;
      bytes.write(new Uint8Array(SPECTRUM_BYTES));
      bytes.position = 0;
    }

    static get audioPlaybackMode(): string {
      return playbackMode;
    }

    static set audioPlaybackMode(value: Value) {
      if (value === null || value === undefined) {
        throw s.rt.error("TypeError", 2007, "audioPlaybackMode");
      }

      const mode = s.rt.toString(value);
      if (!PLAYBACK_MODES.includes(mode)) {
        throw s.rt.error("ArgumentError", 2004);
      }

      playbackMode = mode;
    }

    static get useSpeakerphoneForVoice(): boolean {
      return speakerphone;
    }

    static set useSpeakerphoneForVoice(value: Value) {
      speakerphone = !!value;
    }
  }

  avm2.registerNativeClass(natives, "flash.media::SoundMixer", SoundMixerNatives);
  return natives;
}
