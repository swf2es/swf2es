// Experimental opt-in bindings. Install before loading playerglobal and close
// the host before destroying Scripting; default playback keeps ErrorEvent #3702.
import type { Stage3DHost } from "@swf2es/context3d";
import { avm2 } from "@swf2es/runtime";
import type { Scripting } from "../scripting.js";
import { registerContext } from "./context3d/context.js";
import { type AsObject, createBindings, unsupported } from "./context3d/lifecycle.js";
import { registerResources } from "./context3d/resources.js";

/** Returns the host teardown; it also cancels creation queued before teardown. */
export function installContext3D(s: Scripting, host: Stage3DHost): () => void {
  const natives: avm2.Natives = {};
  const bindings = createBindings(s, host);
  const { slots, pending, lost, place, request } = bindings;

  class StageNatives {
    get context3D(): AsObject | null {
      return slots.get(this as unknown as AsObject) ?? null;
    }

    requestContext3D(mode = "auto", profile = "baseline"): void {
      const slot = this as unknown as AsObject;
      if (
        bindings.closed ||
        mode !== "auto" ||
        profile !== "baseline" ||
        slots.has(slot) ||
        pending.has(slot) ||
        lost.has(slot)
      ) {
        unsupported();
      }

      request(slot);
    }
  }

  avm2.registerNativeClass(natives, "flash.display::Stage3D", StageNatives);
  registerContext(natives, s, bindings);
  registerResources(natives, s, bindings);

  // Keep the existing Flash-tested position validation and property storage.
  for (const property of ["x", "y", "visible"]) {
    const key = `flash.display::Stage3D#set:${property}`;
    const original = s.rt.natives[key];
    natives[key] = (rt) => {
      const setter = original(rt);
      return function (this: AsObject, value: avm2.Value) {
        setter.call(this, value);
        place(this);
      };
    };
  }

  Object.assign(s.rt.natives, natives);

  return bindings.close;
}

export type { Context3D, Context3DLifecycle, Stage3DHost } from "@swf2es/context3d";
