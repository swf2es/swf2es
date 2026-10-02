// The sound mix held by a SoundTransform; playerglobal implements pan in AS3
// in terms of these four channels, and its constructor writes volume and pan.
import { avm2 } from "@swf2es/runtime";
import type { Scripting } from "../../../scripting.js";

type Value = avm2.Value;

export function soundTransformNatives(s: Scripting): avm2.Natives {
  const natives: avm2.Natives = {};

  class SoundTransformNatives {
    declare $soundVolume: number | undefined;
    declare $soundLeftToLeft: number | undefined;
    declare $soundLeftToRight: number | undefined;
    declare $soundRightToRight: number | undefined;
    declare $soundRightToLeft: number | undefined;

    get volume(): number {
      return this.$soundVolume ?? 1;
    }

    set volume(value: Value) {
      this.$soundVolume = s.rt.toNumber(value);
    }

    get leftToLeft(): number {
      return this.$soundLeftToLeft ?? 1;
    }

    set leftToLeft(value: Value) {
      this.$soundLeftToLeft = s.rt.toNumber(value);
    }

    get leftToRight(): number {
      return this.$soundLeftToRight ?? 0;
    }

    set leftToRight(value: Value) {
      this.$soundLeftToRight = s.rt.toNumber(value);
    }

    get rightToRight(): number {
      return this.$soundRightToRight ?? 1;
    }

    set rightToRight(value: Value) {
      this.$soundRightToRight = s.rt.toNumber(value);
    }

    get rightToLeft(): number {
      return this.$soundRightToLeft ?? 0;
    }

    set rightToLeft(value: Value) {
      this.$soundRightToLeft = s.rt.toNumber(value);
    }
  }

  avm2.registerNativeClass(natives, "flash.media::SoundTransform", SoundTransformNatives);
  return natives;
}
