// flash.events.PressAndTapGestureEvent's native fields: the tap's point,
// on the target as GestureEvent's own point is.
import { avm2 } from "@swf2es/runtime";
import type { Scripting } from "../../../scripting.js";
import { stagePoint } from "./MouseEvent.js";

type Value = avm2.Value;

export function pressAndTapGestureEventNatives(s: Scripting): avm2.Natives {
  const natives: avm2.Natives = {};

  class PressAndTapGestureEventNatives {
    declare $tapX: number | undefined;
    declare $tapY: number | undefined;

    get tapLocalX(): number {
      return this.$tapX ?? Number.NaN;
    }

    set tapLocalX(value: Value) {
      this.$tapX = s.rt.toNumber(value);
    }

    get tapLocalY(): number {
      return this.$tapY ?? Number.NaN;
    }

    set tapLocalY(value: Value) {
      this.$tapY = s.rt.toNumber(value);
    }

    "flash.events:PressAndTapGestureEvent::getTapStageX"(): number {
      return stagePoint(s, this, this.$tapX, this.$tapY)[0];
    }

    "flash.events:PressAndTapGestureEvent::getTapStageY"(): number {
      return stagePoint(s, this, this.$tapX, this.$tapY)[1];
    }
  }

  avm2.registerNativeClass(
    natives,
    "flash.events::PressAndTapGestureEvent",
    PressAndTapGestureEventNatives,
  );
  return natives;
}
