// flash.events.TouchEvent's native fields. Playerglobal keeps the rest in
// AS3; the stage point follows the current target, as MouseEvent's does.
// No device the player knows records a stylus's samples, so there are none
// to get, and no tool button is down.
import { avm2 } from "@swf2es/runtime";
import type { Scripting } from "../../../scripting.js";
import { stagePoint } from "./MouseEvent.js";

type Value = avm2.Value;

export function touchEventNatives(s: Scripting): avm2.Natives {
  const natives: avm2.Natives = {};

  class TouchEventNatives {
    declare $touchX: number | undefined;
    declare $touchY: number | undefined;

    updateAfterEvent(): void {
      s.updates++;
    }

    get localX(): number {
      return this.$touchX ?? Number.NaN;
    }

    set localX(value: Value) {
      this.$touchX = s.rt.toNumber(value);
    }

    get localY(): number {
      return this.$touchY ?? Number.NaN;
    }

    set localY(value: Value) {
      this.$touchY = s.rt.toNumber(value);
    }

    "flash.events:TouchEvent::getStageX"(): number {
      return stagePoint(s, this, this.$touchX, this.$touchY)[0];
    }

    "flash.events:TouchEvent::getStageY"(): number {
      return stagePoint(s, this, this.$touchX, this.$touchY)[1];
    }

    isToolButtonDown(): boolean {
      return false;
    }

    getSamples(): number {
      return 0;
    }

    "flash.events:TouchEvent::privateGetSamples"(): number {
      return 0;
    }

    "flash.events:TouchEvent::setSamples"(): void {}
  }

  avm2.registerNativeClass(natives, "flash.events::TouchEvent", TouchEventNatives);
  return natives;
}
