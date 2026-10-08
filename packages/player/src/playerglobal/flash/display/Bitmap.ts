// flash.display.Bitmap: a display object showing a BitmapData, its node a
// BitmapObject (display/display.ts) that the renderer draws as a textured sprite.
import { avm2 } from "@swf2es/runtime";
import { type BitmapObject, CONTENT } from "../../../display/display.js";
import type { Scripting } from "../../../scripting.js";

type Value = avm2.Value;
type AsObject = avm2.AsObject;

export function bitmapNatives(s: Scripting): avm2.Natives {
  const natives: avm2.Natives = {};

  // A native runs with the AS3 object as `this`, so the constructor sets
  // what the setters set through the same helpers, not through them.
  const setData = (o: AsObject, v: Value) => {
    const data = v === null || v === undefined ? null : (v as AsObject);
    o.$bitmapData = data;
    const display: BitmapObject = o.$display;
    display.store = data?.$store ?? null;
    display.invalidate(CONTENT);
  };
  const setSnapping = (o: AsObject, v: Value) => {
    const mode = v === null || v === undefined ? "auto" : s.rt.toString(v);
    if (mode !== "auto" && mode !== "always" && mode !== "never") {
      throw s.rt.error("ArgumentError", 2008, "pixelSnapping");
    }

    (o.$display as BitmapObject).pixelSnapping = mode;
  };
  const setSmoothing = (o: AsObject, v: Value) => {
    const display: BitmapObject = o.$display;
    display.smoothing = !!v;
    display.invalidate(CONTENT);
  };

  class BitmapNatives {
    declare $display: BitmapObject;
    declare $bitmapData: AsObject | null;

    "flash.display:Bitmap::ctor"(bitmapData: Value, pixelSnapping: Value, smoothing: Value): void {
      // One of a bitmap's class, or placed by a timeline, shows a new BitmapData of its pixels.
      const character = this.$display.character;
      const none = bitmapData === null || bitmapData === undefined;
      setData(this, none && character ? s.symbols.bitmapDataOf(character) : bitmapData);
      setSnapping(this, pixelSnapping);
      setSmoothing(this, smoothing);
    }

    get bitmapData(): Value {
      return this.$bitmapData ?? null;
    }

    set bitmapData(v: Value) {
      setData(this, v);
    }

    get pixelSnapping(): string {
      return this.$display.pixelSnapping;
    }

    set pixelSnapping(v: Value) {
      setSnapping(this, v);
    }

    get smoothing(): boolean {
      return this.$display.smoothing;
    }

    set smoothing(v: Value) {
      setSmoothing(this, v);
    }
  }

  avm2.registerNativeClass(natives, "flash.display::Bitmap", BitmapNatives);
  return natives;
}
