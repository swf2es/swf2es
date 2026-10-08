// flash.geom.Transform: a display object's matrix and color transform as
// flash.geom's Matrix and ColorTransform, copies each time, as Flash gives
// them, and set from either; and its 3D transform and perspective
// projection, kept and reported as Flash's, though not drawn in perspective.
import type { Matrix as Linear } from "@swf2es/format";
import { avm2 } from "@swf2es/runtime";
import { boundsIn, toStage } from "../../../display/bounds.js";
import { type DisplayObject, TRANSFORM } from "../../../display/display.js";
import { concat } from "../../../display/geometry.js";
import { identity3D, invert3D, multiply3D, type Raw } from "../../../display/matrix3d.js";
import type { Scripting } from "../../../scripting.js";
import { alwaysProjects, projectionFrom, projectionObject } from "./PerspectiveProjection.js";

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
// Made once: a script reads and writes a transform on every frame.
const MATRIX_NAMES = MATRIX.map((k) => avm2.qname(avm2.publicNs, k));
const COLOR_NAMES = COLOR.map(([, name]) => avm2.qname(avm2.publicNs, name));
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
function matrixObject(s: Scripting, m: Linear): AsObject {
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
  const value = (i: number) => Number(s.rt.getProperty(o, MATRIX_NAMES[i]));
  return { a: value(0), b: value(1), c: value(2), d: value(3), tx: value(4), ty: value(5) };
}

/** A new flash.geom.ColorTransform of `c`. */
function colorObject(s: Scripting, c: Color): AsObject {
  return s.rt.construct(
    s.rt.classNamed("flash.geom::ColorTransform"),
    c.rMul,
    c.gMul,
    c.bMul,
    c.aMul,
    c.rAdd,
    c.gAdd,
    c.bAdd,
    c.aAdd,
  ) as AsObject;
}

/** The color transform a flash.geom.ColorTransform holds. */
export function colorOf(s: Scripting, o: AsObject): Color {
  const value = (i: number) => Number(s.rt.getProperty(o, COLOR_NAMES[i]));
  return {
    rMul: value(0),
    gMul: value(1),
    bMul: value(2),
    aMul: value(3),
    rAdd: value(4),
    gAdd: value(5),
    bAdd: value(6),
    aAdd: value(7),
  };
}

export function transformNatives(s: Scripting): avm2.Natives {
  const natives: avm2.Natives = {};

  class TransformNatives {
    declare $display: DisplayObject;

    "flash.geom:Transform::ctor"(display: Value): void {
      this.$display = (display as AsObject).$display;
    }

    /** Null in 3D. */
    get matrix(): Value {
      return this.$display.space ? null : matrixObject(s, this.$display.matrix);
    }

    /** Null puts the object in 3D, its matrix3D made from the 2D one; a matrix takes it back to 2D. */
    set matrix(v: Value) {
      this.$display.touch();
      if (v) {
        this.$display.setMatrix(matrixOf(s, v as AsObject));
      } else {
        this.$display.enter3D();
      }
    }

    get colorTransform(): Value {
      return colorObject(s, this.$display.colorTransform ?? IDENTITY_COLOR);
    }

    set colorTransform(v: Value) {
      if (v) {
        this.$display.colorTransform = colorOf(s, v as AsObject);
        this.$display.touch();
        this.$display.invalidate(TRANSFORM);
      }
    }

    /** Its own scroll's shift left out, as Flash's does, its parents' taken in. */
    get concatenatedMatrix(): Value {
      const d = this.$display;
      const up = d.parent && d.parent !== s.stage ? toStage(d.parent, s.stage) : null;
      return matrixObject(s, up ? concat(d.matrix, up) : d.matrix);
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

    /** A copy of the 3D transform, null in 2D. */
    get matrix3D(): Value {
      const space = this.$display.space;
      if (!space) {
        return null;
      }

      const m = s.rt.construct(s.rt.classNamed("flash.geom::Matrix3D")) as AsObject;
      (m.$matrix3D as Float32Array).set(space.raw);
      return m;
    }

    /** Taken as given, and apart into the 3D properties; null back to 2D, at the identity. */
    set matrix3D(v: Value) {
      this.$display.touch();
      this.$display.setMatrix3D(v ? ((v as AsObject).$matrix3D as Float32Array) : null);
    }

    /**
     * The matrix3D from this object's space to `relativeTo`'s, through
     * their concatenated transforms, each 2D one taken as 3D; null for an
     * object in 2D, as Flash gives.
     */
    getRelativeMatrix3D(relativeTo: Value): Value {
      if (relativeTo === null || relativeTo === undefined) {
        throw s.rt.error("TypeError", 2007, "relativeTo");
      }

      const d = this.$display;
      if (!d.space) {
        return null;
      }

      const target: DisplayObject = (relativeTo as AsObject).$display;
      const toTarget = invert3D(concatenated3D(target)) ?? identity3D();
      const m = s.rt.construct(s.rt.classNamed("flash.geom::Matrix3D")) as AsObject;
      (m.$matrix3D as Float32Array).set(multiply3D(toTarget, concatenated3D(d)));
      return m;
    }

    /** A new one of this object's, which reads and writes this object's; null for an object with none. */
    get perspectiveProjection(): Value {
      const d = this.$display;
      return d.projection || alwaysProjects(s, d) ? projectionObject(s, d) : null;
    }

    set perspectiveProjection(v: Value) {
      this.$display.projection = v ? projectionFrom(s, v as AsObject) : null;
    }

    /** The bounds on the stage, out to whole pixels. */
    get pixelBounds(): Value {
      const r = boundsIn(this.$display, s.stage, s.stage, true);
      // Math.ceil gives -0 for an edge just left of 0, which Flash reports as 0.
      const x = Math.ceil(r.xMin) || 0;
      const y = Math.ceil(r.yMin) || 0;
      const right = Math.ceil(r.xMax);
      const bottom = Math.ceil(r.yMax);
      return s.rt.construct(s.rt.classNamed("flash.geom::Rectangle"), x, y, right - x, bottom - y);
    }
  }

  /** `d`'s transform to the top of its list, each 2D matrix taken as 3D. */
  const concatenated3D = (d: DisplayObject): Raw => {
    let m = identity3D();
    for (let o: DisplayObject | null = d; o && o !== s.stage; o = o.parent) {
      const local = o.space
        ? o.space.raw
        : Float32Array.of(
            o.matrix.a,
            o.matrix.b,
            0,
            0,
            o.matrix.c,
            o.matrix.d,
            0,
            0,
            0,
            0,
            1,
            0,
            o.matrix.tx,
            o.matrix.ty,
            0,
            1,
          );
      m = multiply3D(local, m);
    }

    return m;
  };

  avm2.registerNativeClass(natives, "flash.geom::Transform", TransformNatives);
  return natives;
}
