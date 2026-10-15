// flash.events.PressAndTapGestureEvent's natives: the tap's stage point,
// on the target as GestureEvent's own point is, and its local point, which
// Flash Player's playerglobal keeps in natives and ours in AS3.
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

    "flash.events:PressAndTapGestureEvent::getTapStageX"(x?: number, y?: number): number {
      return stagePoint(s, this, x ?? this.$tapX, y ?? this.$tapY)[0];
    }

    "flash.events:PressAndTapGestureEvent::getTapStageY"(x?: number, y?: number): number {
      return stagePoint(s, this, x ?? this.$tapX, y ?? this.$tapY)[1];
    }
  }

  avm2.registerNativeClass(
    natives,
    "flash.events::PressAndTapGestureEvent",
    PressAndTapGestureEventNatives,
  );
  return natives;
}
