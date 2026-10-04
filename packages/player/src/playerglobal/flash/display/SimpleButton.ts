// flash.display.SimpleButton: a button's four states and its flags, on the
// player's ButtonObject. The state it shows is the up one until the pointer
// moves it (input.ts); a state set while shown takes its place at once.
import { avm2 } from "@swf2es/runtime";
import type { ButtonObject, ButtonState } from "../../../display.js";
import type { Scripting } from "../../../scripting.js";
import { mixerTransform, setMixerTransform } from "../media/Sound.js";
import { displayOf } from "./DisplayObject.js";

type AsObject = avm2.AsObject;
type Value = avm2.Value;

/** The ButtonObject a SimpleButton is the face of. */
function buttonOf(o: AsObject): ButtonObject {
  return displayOf(o) as ButtonObject;
}

export function simpleButtonNatives(s: Scripting): avm2.Natives {
  const natives: avm2.Natives = {};
  const get = (o: AsObject, state: ButtonState | "hitTest"): Value => {
    const b = buttonOf(o);
    const d = state === "hitTest" ? b.hitTestState : b.stateObject(state);
    return d?.object ?? null;
  };
  const set = (o: AsObject, state: ButtonState | "hitTest", v: Value): void => {
    const b = buttonOf(o);
    const d = v === null || v === undefined ? null : displayOf(v);
    // A state is the button's own: out of the container it was in.
    if (d?.parent && d.parent !== b) {
      d.parent.removeChild(d);
    }

    if (state === "up") {
      b.upState = d;
    } else if (state === "over") {
      b.overState = d;
    } else if (state === "down") {
      b.downState = d;
    } else {
      b.hitTestState = d;
    }

    b.show();
  };

  class SimpleButtonNatives {
    "flash.display:SimpleButton::_updateButton"(): void {
      buttonOf(this).show();
    }

    get upState(): Value {
      return get(this, "up");
    }

    set upState(v: Value) {
      set(this, "up", v);
    }

    get overState(): Value {
      return get(this, "over");
    }

    set overState(v: Value) {
      set(this, "over", v);
    }

    get downState(): Value {
      return get(this, "down");
    }

    set downState(v: Value) {
      set(this, "down", v);
    }

    get hitTestState(): Value {
      return get(this, "hitTest");
    }

    set hitTestState(v: Value) {
      set(this, "hitTest", v);
    }

    get enabled(): boolean {
      return buttonOf(this).enabled;
    }

    set enabled(v: Value) {
      buttonOf(this).enabled = !!v;
    }

    get useHandCursor(): boolean {
      return buttonOf(this).useHandCursor;
    }

    set useHandCursor(v: Value) {
      buttonOf(this).useHandCursor = !!v;
    }

    get trackAsMenu(): boolean {
      return buttonOf(this).trackAsMenu;
    }

    set trackAsMenu(v: Value) {
      buttonOf(this).trackAsMenu = !!v;
    }

    // SoundMixer's, as Flash has it, not the button's own (the sound-mixer case).
    get soundTransform(): Value {
      return mixerTransform(s);
    }

    set soundTransform(v: Value) {
      if (v === null || v === undefined) {
        throw s.rt.error("TypeError", 2007, "sndTransform");
      }

      setMixerTransform(s, v as AsObject);
    }
  }

  avm2.registerNativeClass(natives, "flash.display::SimpleButton", SimpleButtonNatives);
  return natives;
}
