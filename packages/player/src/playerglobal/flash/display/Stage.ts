// flash.display.Stage: the stage's size and frame rate, invalidate, which
// asks for a RENDER event before the frame is drawn, and the two container
// methods Stage declares native again, which do as a container's do.
import { avm2 } from "@swf2es/runtime";
import type { Scripting } from "../../../scripting.js";
import { containerNatives } from "./DisplayObjectContainer.js";

type Value = avm2.Value;

export function stageNatives(s: Scripting): avm2.Natives {
  const natives: avm2.Natives = {};

  class StageNatives {
    "flash.display:Stage::requireOwnerPermissions"(): void {
      // One owner: the SWF the player runs.
    }

    get frameRate(): number {
      return s.frameRate;
    }

    set frameRate(v: Value) {
      s.frameRate = Math.max(0.01, Math.min(1000, Number(v)));
    }

    get stageWidth(): number {
      return s.stageWidth;
    }

    get stageHeight(): number {
      return s.stageHeight;
    }

    invalidate(): void {
      s.invalidated = true;
    }

    get scaleMode(): string {
      return "showAll";
    }

    set scaleMode(_v: Value) {
      // The stage is the SWF's size; nothing to scale yet.
    }

    get align(): string {
      return "";
    }

    set align(_v: Value) {
      // As scaleMode.
    }

    get quality(): string {
      return s.quality;
    }

    set quality(v: Value) {
      s.quality = String(v).toUpperCase();
    }

    get displayState(): string {
      return "normal";
    }

    set displayState(_v: Value) {
      // No full screen.
    }

    get focus(): Value {
      return null;
    }

    set focus(_v: Value) {
      // No keyboard focus yet.
    }

    get showDefaultContextMenu(): boolean {
      return true;
    }

    set showDefaultContextMenu(_v: Value) {
      // No context menu.
    }

    get stageFocusRect(): boolean {
      return true;
    }

    set stageFocusRect(_v: Value) {
      // No focus rectangle.
    }
  }

  avm2.registerNativeClass(natives, "flash.display::Stage", StageNatives);
  const container = containerNatives(s);
  for (const name of ["removeChildAt", "swapChildrenAt"]) {
    natives[`flash.display::Stage#${name}`] =
      container[`flash.display::DisplayObjectContainer#${name}`];
  }

  return natives;
}
