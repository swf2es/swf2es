// flash.display.DisplayObject: allocated with a player display object as its
// other face, and its properties read and written through it.
import { IDENTITY } from "@swf2es/format";
import { avm2 } from "@swf2es/runtime";
import { type DisplayObject, TRANSFORM } from "../../../display.js";
import type { Scripting } from "../../../scripting.js";

const { plain } = avm2;
type AsObject = avm2.AsObject;
type Value = avm2.Value;

/** The display object `o` is the face of. */
export function displayOf(o: AsObject): DisplayObject {
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

export function displayObjectNatives(s: Scripting): avm2.Natives {
  const get = (f: (d: DisplayObject) => Value) =>
    plain(function (this: AsObject) {
      return f(displayOf(this));
    });
  const set = (f: (d: DisplayObject, v: Value) => void) =>
    plain(function (this: AsObject, v: Value) {
      f(displayOf(this), v);
    });
  const transform = (d: DisplayObject, change: (m: typeof d.matrix) => void) => {
    const m = { ...d.matrix };
    change(m);
    d.matrix = m;
    d.invalidate(TRANSFORM);
  };

  return {
    "flash.display::DisplayObject#get:name": get((d) => d.name),
    "flash.display::DisplayObject#set:name": set((d, v) => {
      d.name = String(v);
    }),
    "flash.display::DisplayObject#get:visible": get((d) => d.visible),
    "flash.display::DisplayObject#set:visible": set((d, v) => {
      d.visible = !!v;
      d.invalidate(TRANSFORM);
    }),
    "flash.display::DisplayObject#get:x": get((d) => d.matrix.tx),
    "flash.display::DisplayObject#set:x": set((d, v) =>
      transform(d, (m) => {
        m.tx = Number(v);
      }),
    ),
    "flash.display::DisplayObject#get:y": get((d) => d.matrix.ty),
    "flash.display::DisplayObject#set:y": set((d, v) =>
      transform(d, (m) => {
        m.ty = Number(v);
      }),
    ),
    "flash.display::DisplayObject#get:scaleX": get((d) => Math.hypot(d.matrix.a, d.matrix.b)),
    "flash.display::DisplayObject#set:scaleX": set((d, v) =>
      transform(d, (m) => {
        const r = Math.atan2(m.b, m.a);
        m.a = Number(v) * Math.cos(r);
        m.b = Number(v) * Math.sin(r);
      }),
    ),
    "flash.display::DisplayObject#get:scaleY": get((d) => Math.hypot(d.matrix.c, d.matrix.d)),
    "flash.display::DisplayObject#set:scaleY": set((d, v) =>
      transform(d, (m) => {
        const r = Math.atan2(-m.c, m.d);
        m.c = -Number(v) * Math.sin(r);
        m.d = Number(v) * Math.cos(r);
      }),
    ),
    "flash.display::DisplayObject#get:rotation": get(
      (d) => Math.atan2(d.matrix.b, d.matrix.a) * DEG,
    ),
    "flash.display::DisplayObject#set:rotation": set((d, v) =>
      transform(d, (m) => {
        const r = (Number(v) / DEG) % (2 * Math.PI);
        const sx = Math.hypot(m.a, m.b);
        const sy = Math.hypot(m.c, m.d);
        m.a = sx * Math.cos(r);
        m.b = sx * Math.sin(r);
        m.c = -sy * Math.sin(r);
        m.d = sy * Math.cos(r);
      }),
    ),
    "flash.display::DisplayObject#get:alpha": get((d) => d.colorTransform?.aMul ?? 1),
    "flash.display::DisplayObject#set:alpha": set((d, v) => {
      const ct = d.colorTransform ?? {
        rMul: 1,
        gMul: 1,
        bMul: 1,
        aMul: 1,
        rAdd: 0,
        gAdd: 0,
        bAdd: 0,
        aAdd: 0,
      };
      d.colorTransform = { ...ct, aMul: Number(v) };
      d.invalidate(TRANSFORM);
    }),
    "flash.display::DisplayObject#get:parent": get((d) => d.parent?.object ?? null),
    "flash.display::DisplayObject#get:stage": get((d) =>
      onStage(s, d) ? (s.stage?.object ?? null) : null,
    ),
    "flash.display::DisplayObject#get:root": get((d) => {
      // The topmost display object below the stage, or the object itself when off the display list.
      if (!onStage(s, d)) {
        return null;
      }

      let o: DisplayObject = d;
      while (o.parent && o.parent !== s.stage) {
        o = o.parent;
      }

      return o.object;
    }),
    "flash.display::DisplayObject#get:mouseX": get(() => 0),
    "flash.display::DisplayObject#get:mouseY": get(() => 0),
    "flash.display::DisplayObject#get:transform": get(() => null),
  };
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

export { IDENTITY };
