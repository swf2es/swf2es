// flash.display.DisplayObject: allocated with a player display object as its
// other face, and its properties read and written through it.
import type { Matrix } from "@swf2es/format";
import { avm2 } from "@swf2es/runtime";
import { type DisplayObject, TRANSFORM } from "../../../display.js";
import type { Scripting } from "../../../scripting.js";

type Value = avm2.Value;

/** The display object `o` is the face of. */
export function displayOf(o: avm2.AsObject): DisplayObject {
  return o.$display;
}

export function displayObjectHooks(s: Scripting): Record<string, avm2.ClassHook> {
  return {
    "flash.display::DisplayObject": {
      // The one the player has pending, when it constructs a timeline child's
      // class; else one for the class, for a `new` from a script.
      create: (traits) => {
        const o = Object.create(traits.proto);
        const display = s.pending ?? s.displayFor(traits);
        s.pending = null;
        o.$display = display;
        display.object = o;
        return o;
      },
    },
  };
}

const DEG = 180 / Math.PI;

/** Change a display object's transform, by a copy, and have it drawn again. */
function transform(d: DisplayObject, change: (m: Matrix) => void): void {
  const m = { ...d.matrix };
  change(m);
  d.matrix = m;
  d.invalidate(TRANSFORM);
}

const IDENTITY_COLOR = { rMul: 1, gMul: 1, bMul: 1, aMul: 1, rAdd: 0, gAdd: 0, bAdd: 0, aAdd: 0 };

/** The root `d` is under, or is: the nearest display object up from it that carries a LoaderInfo; null under none, as for one a script made and did not add. */
export function rootOf(d: DisplayObject): DisplayObject | null {
  for (let o: DisplayObject | null = d; o; o = o.parent) {
    if (o.loaderInfo) {
      return o;
    }
  }

  return null;
}

/** Whether `d` is on the display list: under the stage. */
export function onStage(s: Scripting, d: DisplayObject): boolean {
  for (let o: DisplayObject | null = d; o; o = o.parent) {
    if (o === s.stage) {
      return true;
    }
  }

  return false;
}

export function displayObjectNatives(s: Scripting): avm2.Natives {
  const natives: avm2.Natives = {};

  // How the natives are written: each runs with the AS3 object as `this`,
  // whose $display is the player's display object (registerNativeClass).
  class DisplayObjectNatives {
    declare $display: DisplayObject;

    get name(): string {
      return this.$display.name;
    }

    set name(v: Value) {
      this.$display.name = String(v);
    }

    get visible(): boolean {
      return this.$display.visible;
    }

    set visible(v: Value) {
      this.$display.visible = !!v;
      this.$display.invalidate(TRANSFORM);
    }

    get x(): number {
      return this.$display.matrix.tx;
    }

    set x(v: Value) {
      transform(this.$display, (m) => {
        m.tx = Number(v);
      });
    }

    get y(): number {
      return this.$display.matrix.ty;
    }

    set y(v: Value) {
      transform(this.$display, (m) => {
        m.ty = Number(v);
      });
    }

    get scaleX(): number {
      return Math.hypot(this.$display.matrix.a, this.$display.matrix.b);
    }

    set scaleX(v: Value) {
      transform(this.$display, (m) => {
        const r = Math.atan2(m.b, m.a);
        m.a = Number(v) * Math.cos(r);
        m.b = Number(v) * Math.sin(r);
      });
    }

    get scaleY(): number {
      return Math.hypot(this.$display.matrix.c, this.$display.matrix.d);
    }

    set scaleY(v: Value) {
      transform(this.$display, (m) => {
        const r = Math.atan2(-m.c, m.d);
        m.c = -Number(v) * Math.sin(r);
        m.d = Number(v) * Math.cos(r);
      });
    }

    get rotation(): number {
      return Math.atan2(this.$display.matrix.b, this.$display.matrix.a) * DEG;
    }

    set rotation(v: Value) {
      transform(this.$display, (m) => {
        const r = (Number(v) / DEG) % (2 * Math.PI);
        const sx = Math.hypot(m.a, m.b);
        const sy = Math.hypot(m.c, m.d);
        m.a = sx * Math.cos(r);
        m.b = sx * Math.sin(r);
        m.c = -sy * Math.sin(r);
        m.d = sy * Math.cos(r);
      });
    }

    get alpha(): number {
      return this.$display.colorTransform?.aMul ?? 1;
    }

    set alpha(v: Value) {
      const d = this.$display;
      d.colorTransform = { ...(d.colorTransform ?? IDENTITY_COLOR), aMul: Number(v) };
      d.invalidate(TRANSFORM);
    }

    get parent(): Value {
      return this.$display.parent?.object ?? null;
    }

    get stage(): Value {
      return onStage(s, this.$display) ? (s.stage?.object ?? null) : null;
    }

    /** The root of the SWF this is in, main or loaded; null off the display list, as Flash has it. */
    get root(): Value {
      return rootOf(this.$display)?.object ?? null;
    }

    /** The LoaderInfo of the SWF this is in; null off the display list. */
    get loaderInfo(): Value {
      return rootOf(this.$display)?.loaderInfo ?? null;
    }

    get mouseX(): number {
      return 0;
    }

    get mouseY(): number {
      return 0;
    }

    get transform(): Value {
      return null;
    }
  }

  avm2.registerNativeClass(natives, "flash.display::DisplayObject", DisplayObjectNatives);
  return natives;
}
