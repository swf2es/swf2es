// flash.events.GestureEvent's natives, its subclasses' included: the
// stage point, and the local point Flash Player's playerglobal keeps in
// natives, which ours keeps in AS3 with the rest. Scripts make and dispatch gesture
// events of their own: the player recognizes no gestures yet.
import { avm2 } from "@swf2es/runtime";
import type { Scripting } from "../../../scripting.js";
import { stagePoint } from "./MouseEvent.js";

type Value = avm2.Value;

export function gestureEventNatives(s: Scripting): avm2.Natives {
  const natives: avm2.Natives = {};

  class GestureEventNatives {
    declare $gestureX: number | undefined;
    declare $gestureY: number | undefined;

    updateAfterEvent(): void {
      s.updates++;
    }

    get localX(): number {
      return this.$gestureX ?? Number.NaN;
    }

    set localX(value: Value) {
      this.$gestureX = s.rt.toNumber(value);
    }

    get localY(): number {
      return this.$gestureY ?? Number.NaN;
    }

    set localY(value: Value) {
      this.$gestureY = s.rt.toNumber(value);
    }

    "flash.events:GestureEvent::getStageX"(x?: number, y?: number): number {
      return stagePoint(s, this, x ?? this.$gestureX, y ?? this.$gestureY)[0];
    }

    "flash.events:GestureEvent::getStageY"(x?: number, y?: number): number {
      return stagePoint(s, this, x ?? this.$gestureX, y ?? this.$gestureY)[1];
    }
  }

  avm2.registerNativeClass(natives, "flash.events::GestureEvent", GestureEventNatives);
  return natives;
}
