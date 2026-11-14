// Stage3D's bindings, which a host opts in to. Install before loading playerglobal and close
// the host before destroying Scripting; default playback keeps ErrorEvent #3702.
import { PROFILES, type Profile, type Stage3DHost } from "@swf2es/context3d";
import { avm2 } from "@swf2es/runtime";
import type { Scripting } from "../scripting.js";
import { registerContext } from "./context3d/context.js";
import { translateErrors } from "./context3d/errors.js";
import { type AsObject, createBindings } from "./context3d/lifecycle.js";
import { registerResources } from "./context3d/resources.js";

/** Returns the host teardown; it also cancels creation queued before teardown. */
export function installContext3D(s: Scripting, host: Stage3DHost): () => void {
  const natives: avm2.Natives = {};
  const bindings = createBindings(s, host);
  const { slots, place, request, unavailable } = bindings;
  /** A profile's name as AS3 gives it; null is baseline. */
  const profileName = (value: string | null): Profile => {
    if (value === null) {
      return "baseline";
    }
    if (!PROFILES.includes(value as Profile)) {
      throw s.rt.error("ArgumentError", 2008, "profile");
    }

    return value as Profile;
  };

  class StageNatives {
    get context3D(): AsObject | null {
      return slots.get(this as unknown as AsObject) ?? null;
    }

    requestContext3D(mode: string | null = "auto", profile: string | null = "baseline"): void {
      const slot = this as unknown as AsObject;
      if (mode === null) {
        throw s.rt.error("TypeError", 2007, "context3DRenderMode");
      }
      if (mode !== "auto" && mode !== "software") {
        throw s.rt.error("ArgumentError", 2008, "context3DRenderMode");
      }

      const selected = profileName(profile);
      if (bindings.closed) {
        throw s.rt.error("Error", 3694);
      }
      if (mode !== "auto") {
        unavailable(slot);
        return;
      }

      request(slot, selected);
    }

    requestContext3DMatchingProfiles(profiles: AsObject | null): void {
      if (!profiles) {
        throw s.rt.error("ArgumentError", 1508, "profiles");
      }

      const values = profiles.$a as (string | null)[];
      if (!values.length) {
        throw s.rt.error("ArgumentError", 2008, "profiles");
      }
      const asked = new Set<Profile>();
      for (let i = 0; i < values.length; i++) {
        asked.add(profileName(values[i]));
      }
      if (bindings.closed) {
        throw s.rt.error("Error", 3694);
      }
      // The best of them, as Flash takes the best its device has.
      let best: Profile = "baselineConstrained";
      for (const profile of asked) {
        if (PROFILES.indexOf(profile) > PROFILES.indexOf(best)) {
          best = profile;
        }
      }
      request(this as unknown as AsObject, best);
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

  translateErrors(natives, s);
  Object.assign(s.rt.natives, natives);

  return bindings.close;
}

export type { Context3D, Context3DLifecycle, Stage3DHost } from "@swf2es/context3d";
