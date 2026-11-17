import type { avm2 } from "@swf2es/runtime";
import type { CaptureKind, CapturePermission } from "../hosts.js";
import { dispatchEvent } from "../scripting/events.js";
import type { Scripting } from "../scripting.js";

/** adl on Linux reports granted without devices; host policy can still refuse capture. */
export function capturePermission(s: Scripting, kind: CaptureKind): CapturePermission {
  if (s.captureLifetime.signal.aborted) {
    return "denied";
  }

  return s.capture ? (s.capture.permissionStatus?.(kind) ?? "unknown") : "granted";
}

export function requestCapturePermission(
  s: Scripting,
  object: avm2.AsObject,
  kind: CaptureKind,
): void {
  const signal = s.captureLifetime.signal;
  if (s.destroyed) {
    return;
  }

  let answered = false;
  const deliver = (status: string) => {
    if (answered) {
      return;
    }

    answered = true;
    signal.removeEventListener("abort", revoked);
    s.loads.deferHostEvent(() => {
      if (!s.destroyed) {
        dispatchEvent(
          s,
          object,
          s.rt.construct(
            s.rt.classNamed("flash.events::PermissionEvent"),
            "permissionStatus",
            false,
            false,
            signal.aborted ? "denied" : status,
          ),
        );
      }
    });
  };
  const revoked = () => deliver("denied");
  if (signal.aborted) {
    revoked();
    return;
  }

  signal.addEventListener("abort", revoked, { once: true });
  try {
    const result =
      s.capture?.requestPermission?.(kind, signal) ?? Promise.resolve(capturePermission(s, kind));
    void result.then(deliver, () => deliver("denied"));
  } catch {
    deliver("denied");
  }
}
