// flash.events.TouchEvent's natives: the stage point, which follows the
// target as MouseEvent's does, and the local point Flash Player's
// playerglobal keeps in natives, which ours keeps in AS3 with the rest.
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

    "flash.events:TouchEvent::getStageX"(x?: number, y?: number): number {
      return stagePoint(s, this, x ?? this.$touchX, y ?? this.$touchY)[0];
    }

    "flash.events:TouchEvent::getStageY"(x?: number, y?: number): number {
      return stagePoint(s, this, x ?? this.$touchX, y ?? this.$touchY)[1];
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
