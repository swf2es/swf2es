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

  /** Whether the script has been told of the grant, which its device's data must not precede. */
  get unmutedReported(): boolean {
    return this.reported === false;
  }

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

  /** Revocation is news only to a script whose device was opened or told of a decision. */
  revoke(opened: boolean): void {
    if (!opened && this.reported === null && !this.pending) {
      this.muted = true;
      return;
    }

    this.set(true);
  }

  /** Adobe documents the code, not its level; "status" is the level of every other capture code. */
  unavailable(): void {
    this.s.loads.deferHostEvent(() => {
      if (!this.s.destroyed) {
        this.dispatch(`${this.kind}.Unavailable`, "status");
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
