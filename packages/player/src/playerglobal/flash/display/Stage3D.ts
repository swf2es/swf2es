// flash.display.Stage3D without Stage3D rendering: its position and
// visibility kept, and each request for a Context3D answered as Flash
// answers it without a GPU, an ErrorEvent #3702 in a later frame, so that
// content that falls back to the display list can.
import { avm2 } from "@swf2es/runtime";
import type { Scripting } from "../../../scripting.js";
import { dispatchEvent } from "../events/EventDispatcher.js";

type AsObject = avm2.AsObject;
type Value = avm2.Value;

export function stage3DNatives(s: Scripting): avm2.Natives {
  const natives: avm2.Natives = {};

  const unavailable = (target: AsObject): void => {
    s.deferHostEvent(() =>
      dispatchEvent(
        s,
        target,
        s.rt.construct(
          s.rt.classNamed("flash.events::ErrorEvent"),
          "error",
          false,
          false,
          "Error #3702: Context3D not available.",
          3702,
        ) as AsObject,
      ),
    );
  };

  /** A position within -8192 to 8191; else ArgumentError 2006, as the corpus's `stage3d_x_y` has Flash's. */
  const position = (v: Value): number => {
    const n = s.rt.toNumber(v);
    if (!(n >= -8192 && n <= 8191)) {
      throw s.rt.error("ArgumentError", 2006);
    }

    return n;
  };

  class Stage3DNatives {
    declare $x: number | undefined;
    declare $y: number | undefined;
    declare $visible: boolean | undefined;

    get context3D(): Value {
      return null;
    }

    requestContext3D(_mode: Value = "auto", _profile: Value = "baseline"): void {
      unavailable(this as unknown as AsObject);
    }

    requestContext3DMatchingProfiles(profiles: Value): void {
      if (profiles === null || profiles === undefined) {
        throw s.rt.error("TypeError", 2007, "profiles");
      }

      unavailable(this as unknown as AsObject);
    }

    get x(): number {
      return this.$x ?? 0;
    }

    set x(v: Value) {
      this.$x = position(v);
    }

    get y(): number {
      return this.$y ?? 0;
    }

    set y(v: Value) {
      this.$y = position(v);
    }

    get visible(): boolean {
      return this.$visible ?? true;
    }

    set visible(v: Value) {
      this.$visible = !!v;
    }
  }

  avm2.registerNativeClass(natives, "flash.display::Stage3D", Stage3DNatives);
  return natives;
}
