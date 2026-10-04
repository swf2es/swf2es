// flash.ui.Mouse controls the cursor the host shows: whether it shows one,
// which of Flash's own it forces, and bitmap cursors registered by name.
// MouseCursorData holds a cursor's frames, hot spot and frame rate.
import { avm2 } from "@swf2es/runtime";
import { encodePng } from "../../../png.js";
import type { Scripting } from "../../../scripting.js";
import { storeOf } from "../display/BitmapData.js";

type Value = avm2.Value;
type AsObject = avm2.AsObject;

/** The names Mouse.cursor takes besides registered ones, as flash.ui.MouseCursor has them. */
const BUILT_IN: ReadonlySet<string> = new Set(["auto", "arrow", "button", "hand", "ibeam"]);

/** The largest cursor Flash takes, a side. */
const MAX_SIZE = 32;

export function mouseNatives(s: Scripting): avm2.Natives {
  const natives: avm2.Natives = {};

  class MouseNatives {
    static hide(): void {
      s.mouseVisible = false;
      s.pointer?.updateCursor();
    }

    static show(): void {
      s.mouseVisible = true;
      s.pointer?.updateCursor();
    }

    // Desktop Flash Player and AIR report both.
    static get supportsCursor(): boolean {
      return true;
    }

    static get supportsNativeCursor(): boolean {
      return true;
    }

    static get cursor(): string {
      return s.mouseCursor;
    }

    static set cursor(value: Value) {
      if (value === null || value === undefined) {
        throw s.rt.error("TypeError", 2007, "cursor");
      }

      const name = s.rt.toString(value);
      if (!BUILT_IN.has(name) && !s.cursors.has(name)) {
        throw s.rt.error("ArgumentError", 2008, "cursor");
      }

      s.mouseCursor = name;
      s.pointer?.updateCursor();
    }

    static registerCursor(name: Value, cursorData: Value): void {
      if (cursorData === null || cursorData === undefined) {
        throw s.rt.error("TypeError", 2007, "cursorData");
      }

      if (name === null || name === undefined) {
        throw s.rt.error("TypeError", 2007, "name");
      }

      // Flash registers nothing, and says nothing, for data never set.
      const d = cursorData as AsObject;
      const data = d.$cursorFrames as AsObject | null | undefined;
      if (!data) {
        return;
      }

      const frames: Value[] = data.$a;
      if (frames.length === 0) {
        throw s.rt.error("ArgumentError", 2008, "cursorData");
      }

      // Within the largest cursor's pixels, whatever its frames' sizes; NaN passes.
      const x: number = d.$cursorHotX ?? 0;
      const y: number = d.$cursorHotY ?? 0;
      if (x < 0 || x > MAX_SIZE - 1 || y < 0 || y > MAX_SIZE - 1) {
        throw s.rt.error("ArgumentError", 2008, "hotSpot");
      }

      for (const frame of frames) {
        if (frame === null || frame === undefined) {
          throw s.rt.error("ArgumentError", 2004);
        }

        const store = storeOf(s, frame as AsObject);
        if (store.width > MAX_SIZE || store.height > MAX_SIZE) {
          throw s.rt.error("ArgumentError", 2004);
        }
      }

      // The first frame alone: a CSS cursor does not animate.
      const first = storeOf(s, frames[0] as AsObject);
      const png = encodePng(first, { x: 0, y: 0, width: first.width, height: first.height }, true);
      // A hot spot past the image would make the browser refuse the cursor.
      const hotX = Math.min(Math.floor(x) || 0, first.width - 1);
      const hotY = Math.min(Math.floor(y) || 0, first.height - 1);
      const url = `data:image/png;base64,${btoa(String.fromCharCode(...png))}`;
      s.cursors.set(s.rt.toString(name), `url("${url}") ${hotX} ${hotY}, default`);
      s.pointer?.updateCursor();
    }

    static unregisterCursor(name: Value): void {
      if (name === null || name === undefined) {
        throw s.rt.error("TypeError", 2007, "name");
      }

      const key = s.rt.toString(name);
      if (s.cursors.delete(key) && s.mouseCursor === key) {
        s.mouseCursor = "auto";
      }

      s.pointer?.updateCursor();
    }
  }

  class MouseCursorDataNatives {
    declare $cursorFrames: Value;
    declare $cursorHotX: number | undefined;
    declare $cursorHotY: number | undefined;
    declare $cursorFrameRate: number | undefined;

    get data(): Value {
      return this.$cursorFrames ?? null;
    }

    set data(value: Value) {
      this.$cursorFrames = value;
    }

    // A copy each way, as Flash keeps the values and not the Point.
    get hotSpot(): Value {
      return s.rt.construct(
        s.rt.classNamed("flash.geom::Point"),
        this.$cursorHotX ?? 0,
        this.$cursorHotY ?? 0,
      );
    }

    set hotSpot(value: Value) {
      if (value === null || value === undefined) {
        throw s.rt.error("TypeError", 2007, "hotSpot");
      }

      const p = value as AsObject;
      this.$cursorHotX = s.rt.toNumber(s.rt.getProperty(p, s.rt.publicName("x")));
      this.$cursorHotY = s.rt.toNumber(s.rt.getProperty(p, s.rt.publicName("y")));
    }

    get frameRate(): number {
      return this.$cursorFrameRate ?? 0;
    }

    // A negative rate is 0; NaN stays.
    set frameRate(value: Value) {
      const rate = s.rt.toNumber(value);
      this.$cursorFrameRate = rate < 0 ? 0 : rate;
    }
  }

  avm2.registerNativeClass(natives, "flash.ui::Mouse", MouseNatives);
  avm2.registerNativeClass(natives, "flash.ui::MouseCursorData", MouseCursorDataNatives);
  return natives;
}
