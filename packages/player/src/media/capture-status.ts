import type { avm2 } from "@swf2es/runtime";
import { dispatchEvent } from "../scripting/events.js";
import type { Scripting } from "../scripting.js";

/** Adobe documents consent changes, not each transport reopen, as status events. */
export class CaptureStatus {
  muted = true;
  private reported: boolean | null = null;
  private pending = false;

  constructor(
    private readonly s: Scripting,
    private readonly object: avm2.AsObject,
    private readonly kind: "Camera" | "Microphone",
  ) {}

  set(muted: boolean): void {
    this.muted = muted;
    if (this.pending || this.s.destroyed || this.reported === muted) {
      return;
    }

    this.pending = true;
    this.s.loads.deferHostEvent(() => {
      this.pending = false;
      if (this.s.destroyed || this.reported === this.muted) {
        return;
      }

      this.reported = this.muted;
      this.dispatch(`${this.kind}.${this.muted ? "Muted" : "Unmuted"}`, "status");
    });
  }

  unavailable(): void {
    this.s.loads.deferHostEvent(() => {
      if (!this.s.destroyed) {
        this.dispatch(`${this.kind}.Unavailable`, "error");
      }
    });
  }

  private dispatch(code: string, level: string): void {
    dispatchEvent(
      this.s,
      this.object,
      this.s.rt.construct(
        this.s.rt.classNamed("flash.events::StatusEvent"),
        "status",
        false,
        false,
        code,
        level,
      ),
    );
  }
}
