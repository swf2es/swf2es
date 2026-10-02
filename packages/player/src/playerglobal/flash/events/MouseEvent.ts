// flash.events.MouseEvent's native fields. Playerglobal constructs and
// formats the event in AS3; the coordinates follow its current target.
import { avm2 } from "@swf2es/runtime";
import { toStage } from "../../../bounds.js";
import { apply } from "../../../geometry.js";
import type { Scripting } from "../../../scripting.js";

type AsObject = avm2.AsObject;
type Value = avm2.Value;

/** The stage point of an event whose target is on the display list. */
function stagePoint(s: Scripting, event: AsObject): [number, number] {
  const x = event.$mouseX ?? Number.NaN;
  const y = event.$mouseY ?? Number.NaN;
  const target = (event.$target as AsObject | null)?.$display;
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
    declare $target: Value;
    declare $relatedObject: Value;
    declare $altKey: boolean;
    declare $buttonDown: boolean;
    declare $ctrlKey: boolean;
    declare $shiftKey: boolean;
    declare $delta: number;
    declare $relatedObjectInaccessible: boolean;

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

    "flash.events:MouseEvent::getStageX"(): number {
      return stagePoint(s, this)[0];
    }

    "flash.events:MouseEvent::getStageY"(): number {
      return stagePoint(s, this)[1];
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

    get relatedObject(): Value {
      return this.$relatedObject ?? null;
    }

    set relatedObject(value: Value) {
      this.$relatedObject = value;
    }

    get altKey(): boolean {
      return this.$altKey ?? false;
    }

    set altKey(value: Value) {
      this.$altKey = !!value;
    }

    get buttonDown(): boolean {
      return this.$buttonDown ?? false;
    }

    set buttonDown(value: Value) {
      this.$buttonDown = !!value;
    }

    get ctrlKey(): boolean {
      return this.$ctrlKey ?? false;
    }

    set ctrlKey(value: Value) {
      this.$ctrlKey = !!value;
    }

    get shiftKey(): boolean {
      return this.$shiftKey ?? false;
    }

    set shiftKey(value: Value) {
      this.$shiftKey = !!value;
    }

    get delta(): number {
      return this.$delta ?? 0;
    }

    set delta(value: Value) {
      this.$delta = s.rt.toInt(value);
    }

    get isRelatedObjectInaccessible(): boolean {
      return this.$relatedObjectInaccessible ?? false;
    }

    set isRelatedObjectInaccessible(value: Value) {
      this.$relatedObjectInaccessible = !!value;
    }
  }

  avm2.registerNativeClass(natives, "flash.events::MouseEvent", MouseEventNatives);
  return natives;
}
