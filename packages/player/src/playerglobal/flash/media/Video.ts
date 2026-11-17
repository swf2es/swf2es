import { avm2 } from "@swf2es/runtime";
import type { VideoObject } from "../../../display/display.js";
import { attachCamera } from "../../../media/camera.js";
import type { Scripting } from "../../../scripting.js";

type Value = avm2.Value;

export function videoNatives(s: Scripting): avm2.Natives {
  const natives: avm2.Natives = {};

  class VideoNatives {
    declare $display: VideoObject;
    declare $deblocking: number | undefined;

    /** Ints, as the constructor takes them: a negative one is RangeError 2006, a 0 either way the default 320 by 240. */
    "flash.media:Video::ctor"(width: Value, height: Value): void {
      const w = s.rt.toInt(width);
      const h = s.rt.toInt(height);
      if (w < 0 || h < 0) {
        throw s.rt.error("RangeError", 2006);
      }

      if (w > 0 && h > 0) {
        this.$display.boxWidth = w;
        this.$display.boxHeight = h;
      }
    }

    get videoWidth(): number {
      return this.$display.source?.picture?.width ?? 0;
    }

    get videoHeight(): number {
      return this.$display.source?.picture?.height ?? 0;
    }

    get deblocking(): number {
      return this.$deblocking ?? 0;
    }

    set deblocking(v: Value) {
      this.$deblocking = s.rt.toInt(v);
    }

    get smoothing(): boolean {
      return this.$display.smoothing;
    }

    set smoothing(v: Value) {
      this.$display.smoothing = !!v;
      this.$display.pixelsChanged(false);
    }

    attachNetStream(_stream: Value): void {
      attachCamera(this.$display, null);
    }

    attachCamera(camera: Value): void {
      attachCamera(this.$display, camera);
    }

    clear(): void {
      this.$display.clear();
    }
  }

  avm2.registerNativeClass(natives, "flash.media::Video", VideoNatives);
  return natives;
}
