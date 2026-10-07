// flash.display.Sprite: its constructor's private native constructChildren
// makes a symbol's first frame alive, placed before the constructor for a
// timeline's child and here for a script's, so that the subclass's
// constructor finds the children by name; a Sprite a script makes has none.
// Its soundTransform is kept, in whole percents as a channel's, and read
// back as a copy; it mixes the timeline sounds of the sprite and all in it.
import { avm2 } from "@swf2es/runtime";
import { type DisplayObject, MovieClip } from "../../../display/display.js";
import type { Rect } from "../../../display/geometry.js";
import { dropTargetOf, hitAreaOf, setHitArea } from "../../../input/pointer.js";
import type { SoundMix } from "../../../media/audio.js";
import { mixOf, updateTimelineMixes } from "../../../media/sounds.js";
import type { Scripting } from "../../../scripting.js";
import { channelMix, transformOf } from "../media/Sound.js";
import { graphicsOf } from "./Graphics.js";

type Value = avm2.Value;

export function spriteNatives(s: Scripting): avm2.Natives {
  const natives: avm2.Natives = {};

  class SpriteNatives {
    declare $display: DisplayObject;

    get graphics(): Value {
      return graphicsOf(s, this as unknown as avm2.AsObject);
    }

    "flash.display:Sprite::constructChildren"(): void {
      const d = this.$display;
      if (d instanceof MovieClip) {
        d.enterFirstFrame();
      }
    }

    declare $soundMix: SoundMix | undefined;

    get soundTransform(): Value {
      return transformOf(s, this.$soundMix ?? mixOf(null));
    }

    set soundTransform(v: Value) {
      // Named so in Sprite's error, where SimpleButton's and SoundMixer's say sndTransform.
      if (v === null || v === undefined) {
        throw s.rt.error("TypeError", 2007, "soundTransform");
      }

      this.$soundMix = channelMix(mixOf(v as avm2.AsObject));
      updateTimelineMixes(s);
    }

    declare $buttonMode: boolean | undefined;

    /** Kept for Tab, which visits a sprite in button mode, and the pointer, which shows a hand over it. */
    get buttonMode(): boolean {
      return this.$buttonMode ?? false;
    }

    set buttonMode(v: Value) {
      this.$buttonMode = !!v;
    }

    declare $useHandCursor: boolean | undefined;

    get useHandCursor(): boolean {
      return this.$useHandCursor ?? true;
    }

    set useHandCursor(v: Value) {
      this.$useHandCursor = !!v;
    }

    /** Another sprite whose drawing the pointer hits this one by (input/pointer.ts). */
    get hitArea(): Value {
      return hitAreaOf(this.$display)?.object ?? null;
    }

    set hitArea(v: Value) {
      setHitArea(this.$display, (v as { $display?: DisplayObject } | null)?.$display ?? null);
    }

    /** The object the sprite was last dragged over, kept once it is dropped. */
    get dropTarget(): Value {
      return dropTargetOf(this.$display)?.object ?? null;
    }

    startDrag(lockCenter: Value, bounds: Value): void {
      let rect: Rect | null = null;
      if (bounds !== null && bounds !== undefined) {
        const o = bounds as avm2.AsObject;
        const get = (key: string) =>
          s.rt.toNumber(s.rt.getProperty(o, avm2.qname(avm2.publicNs, key)));
        const x = get("x");
        const y = get("y");
        const right = x + get("width");
        const bottom = y + get("height");
        rect = {
          xMin: Math.min(x, right),
          yMin: Math.min(y, bottom),
          xMax: Math.max(x, right),
          yMax: Math.max(y, bottom),
        };
      }

      s.pointer?.startDrag(this.$display, !!lockCenter, rect);
    }

    stopDrag(): void {
      s.pointer?.stopDrag();
    }
  }

  avm2.registerNativeClass(natives, "flash.display::Sprite", SpriteNatives);
  return natives;
}
