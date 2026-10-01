// flash.geom.Transform: a display object's matrix and color transform as
// flash.geom's Matrix and ColorTransform, copies each time, as Flash gives
// them, and set from either. The 3D side waits with the rest of 3D.
import type { Matrix as Linear } from "@swf2es/format";
import { avm2 } from "@swf2es/runtime";
import { toStage } from "../../../bounds.js";
import { type DisplayObject, TRANSFORM } from "../../../display.js";
import type { Scripting } from "../../../scripting.js";

type AsObject = avm2.AsObject;
type Value = avm2.Value;

const MATRIX = ["a", "b", "c", "d", "tx", "ty"] as const;
const COLOR = [
  ["rMul", "redMultiplier"],
  ["gMul", "greenMultiplier"],
  ["bMul", "blueMultiplier"],
  ["aMul", "alphaMultiplier"],
  ["rAdd", "redOffset"],
  ["gAdd", "greenOffset"],
  ["bAdd", "blueOffset"],
  ["aAdd", "alphaOffset"],
] as const;
type Color = Record<(typeof COLOR)[number][0], number>;
const IDENTITY_COLOR: Color = {
  rMul: 1,
  gMul: 1,
  bMul: 1,
  aMul: 1,
  rAdd: 0,
  gAdd: 0,
  bAdd: 0,
  aAdd: 0,
};

/** A new flash.geom.Matrix of `m`. */
export function matrixObject(s: Scripting, m: Linear): AsObject {
  return s.rt.construct(
    s.rt.classNamed("flash.geom::Matrix"),
    m.a,
    m.b,
    m.c,
    m.d,
    m.tx,
    m.ty,
  ) as AsObject;
}

/** The matrix a flash.geom.Matrix holds. */
export function matrixOf(s: Scripting, o: AsObject): Linear {
  const m = {} as Linear;
  for (const k of MATRIX) {
    m[k] = Number(s.rt.getProperty(o, avm2.qname(avm2.publicNs, k)));
  }

  return m;
}

/** A new flash.geom.ColorTransform of `c`. */
export function colorObject(s: Scripting, c: Color): AsObject {
  return s.rt.construct(
    s.rt.classNamed("flash.geom::ColorTransform"),
    ...COLOR.map(([field]) => c[field]),
  ) as AsObject;
}

/** The color transform a flash.geom.ColorTransform holds. */
export function colorOf(s: Scripting, o: AsObject): Color {
  const c = {} as Color;
  for (const [field, name] of COLOR) {
    c[field] = Number(s.rt.getProperty(o, avm2.qname(avm2.publicNs, name)));
  }

  return c;
}

export function transformNatives(s: Scripting): avm2.Natives {
  const natives: avm2.Natives = {};

  class TransformNatives {
    declare $display: DisplayObject;

    "flash.geom:Transform::ctor"(display: Value): void {
      this.$display = (display as AsObject).$display;
    }

    get matrix(): Value {
      return matrixObject(s, this.$display.matrix);
    }

    set matrix(v: Value) {
      // null puts Flash's object into 3D, which waits.
      if (v) {
        this.$display.matrix = matrixOf(s, v as AsObject);
        this.$display.invalidate(TRANSFORM);
      }
    }

    get colorTransform(): Value {
      return colorObject(s, this.$display.colorTransform ?? IDENTITY_COLOR);
    }

    set colorTransform(v: Value) {
      if (v) {
        this.$display.colorTransform = colorOf(s, v as AsObject);
        this.$display.invalidate(TRANSFORM);
      }
    }

    get concatenatedMatrix(): Value {
      return matrixObject(s, toStage(this.$display, s.stage));
    }

    /** The color transform to the stage: multipliers multiplied, offsets carried through the parents' multipliers. */
    get concatenatedColorTransform(): Value {
      const c = { ...(this.$display.colorTransform ?? IDENTITY_COLOR) };
      for (let p = this.$display.parent; p && p !== s.stage; p = p.parent) {
        const q = p.colorTransform;
        if (!q) {
          continue;
        }

        for (const [mul, , add] of [
          ["rMul", 0, "rAdd"],
          ["gMul", 0, "gAdd"],
          ["bMul", 0, "bAdd"],
          ["aMul", 0, "aAdd"],
        ] as const) {
          c[add] = c[add] * q[mul] + q[add];
          c[mul] = c[mul] * q[mul];
        }
      }

      return colorObject(s, c);
    }

    get matrix3D(): Value {
      return null;
    }

    get perspectiveProjection(): Value {
      return null;
    }
  }

  avm2.registerNativeClass(natives, "flash.geom::Transform", TransformNatives);
  return natives;
}
