// flash.events.MouseEvent's natives. Playerglobal keeps its fields in AS3;
// its stage point follows its target. The local point's accessors are
// Flash Player's playerglobal's natives, kept for it.
import { avm2 } from "@swf2es/runtime";
import { toStage } from "../../../display/bounds.js";
import { apply } from "../../../display/geometry.js";
import { eventFields } from "../../../scripting/events.js";
import type { Scripting } from "../../../scripting.js";

type AsObject = avm2.AsObject;
type Value = avm2.Value;

/**
 * The stage point of an event's local point, (x, y) on its target where
 * that is on the display list; TouchEvent and GestureEvent read theirs so.
 */
export function stagePoint(
  s: Scripting,
  event: AsObject,
  x = Number.NaN,
  y = Number.NaN,
): [number, number] {
  const target = (event[eventFields(s).target] as AsObject | null)?.$display;
  if (target) {
    return apply(toStage(target, s.stage), x, y);
  }

  return [Number.isNaN(x) ? Number.NaN : 0, Number.isNaN(y) ? Number.NaN : 0];
}

export function mouseEventNatives(s: Scripting): avm2.Natives {
  const natives: avm2.Natives = {};

  class MouseEventNatives {
    declare $mouseX: number | undefined;
    declare $mouseY: number | undefined;
    declare $movementX: number | undefined;
    declare $movementY: number | undefined;

    updateAfterEvent(): void {
      s.updates++;
    }

    get localX(): number {
      return this.$mouseX ?? Number.NaN;
    }

    set localX(value: Value) {
      this.$mouseX = s.rt.toNumber(value);
    }

    get localY(): number {
      return this.$mouseY ?? Number.NaN;
    }

    set localY(value: Value) {
      this.$mouseY = s.rt.toNumber(value);
    }

    // Ours passes its local point; Flash Player's keeps it in the natives above.
    "flash.events:MouseEvent::getStageX"(x?: number, y?: number): number {
      return stagePoint(s, this, x ?? this.$mouseX, y ?? this.$mouseY)[0];
    }

    "flash.events:MouseEvent::getStageY"(x?: number, y?: number): number {
      return stagePoint(s, this, x ?? this.$mouseX, y ?? this.$mouseY)[1];
    }

    get movementX(): number {
      return this.$movementX ?? 0;
    }

    set movementX(value: Value) {
      this.$movementX = s.rt.toNumber(value);
    }

    get movementY(): number {
      return this.$movementY ?? 0;
    }

    set movementY(value: Value) {
      this.$movementY = s.rt.toNumber(value);
    }
  }

  avm2.registerNativeClass(natives, "flash.events::MouseEvent", MouseEventNatives);
  return natives;
}
