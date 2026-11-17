import type { avm2 } from "@swf2es/runtime";
import type { CaptureKind } from "../hosts.js";
import { dispatchEvent } from "../scripting/events.js";
import type { Scripting } from "../scripting.js";

export function requestCapturePermission(
  s: Scripting,
  object: avm2.AsObject,
  kind: CaptureKind,
): void {
  const signal = s.captureLifetime.signal;
  if (s.destroyed || signal.aborted) {
    return;
  }
  const deliver = (status: string) => {
    s.loads.deferHostEvent(() => {
      if (!s.destroyed && !signal.aborted) {
        dispatchEvent(
          s,
          object,
          s.rt.construct(
            s.rt.classNamed("flash.events::PermissionEvent"),
            "permissionStatus",
            false,
            false,
            status,
          ),
        );
      }
    });
  };
  try {
    const result = s.capture?.requestPermission?.(kind, signal) ?? Promise.resolve("denied");
    void result.then(deliver, () => deliver("denied"));
  } catch {
    deliver("denied");
  }
}
