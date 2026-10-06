// flash.geom.Matrix3D's 16 float32 values, in column-major rawData order,
// and its arithmetic, display/matrix3d.ts's float32 as Flash's.
import { avm2 } from "@swf2es/runtime";
import {
  compose3D,
  decompose3D,
  determinant3D,
  invert3D,
  multiply3D,
  type Orientation,
  type Raw,
  rotation3D,
  scale3D,
  transform3D,
  translation3D,
} from "../../../display/matrix3d.js";
import type { Scripting } from "../../../scripting.js";

type AsObject = avm2.AsObject;
type Value = avm2.Value;

/** The first index copyRawDataTo refuses: 2^28. */
const MAX_INDEX = 0x10000000;

function identity(): Float32Array {
  return Float32Array.of(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1);
}

/** Matrix3D's values; its native constructor assigns them. */
function data(o: AsObject): Float32Array {
  return o.$matrix3D;
}

const ORIENTATIONS = ["eulerAngles", "axisAngle", "quaternion"];

export function matrix3DNatives(s: Scripting): avm2.Natives {
  const natives: avm2.Natives = {};
  let numberVector: AsObject | null = null;
  const axes = ["x", "y", "z", "w"];

  const checkedAxis = (value: Value, axis: Value): number => {
    if (value === null || value === undefined) {
      throw s.rt.error("TypeError", 2007, "vector3D");
    }

    const n = s.rt.toUint(axis);
    if (n > 3) {
      throw s.rt.error("ArgumentError", 2004);
    }

    return n;
  };

  const vector = (values: Float32Array): AsObject => {
    numberVector ??= s.rt.resolve(s.rt.vector("Number"));
    const o = numberVector.$it.instance();
    o.$a = Array.from(values);
    return o;
  };

  const nonNull = (v: Value, name: string): AsObject => {
    if (v === null || v === undefined) {
      throw s.rt.error("TypeError", 2007, name);
    }

    return v as AsObject;
  };

  const vector3D = (x: number, y: number, z: number, w: number): AsObject =>
    s.rt.construct(s.rt.classNamed("flash.geom::Vector3D"), x, y, z, w) as AsObject;

  const read3D = (v: AsObject): number[] =>
    axes.map((axis) => s.rt.toNumber(s.rt.getProperty(v, s.rt.publicName(axis))));

  const xyz = (v: AsObject): [number, number, number] => {
    const [x, y, z] = read3D(v);
    return [x, y, z];
  };

  const matrix3D = (raw: Raw): AsObject => {
    const o = s.rt.construct(s.rt.classNamed("flash.geom::Matrix3D")) as AsObject;
    data(o).set(raw);
    return o;
  };

  const orientation = (style: Value): Orientation => {
    const name = s.rt.toString(nonNull(style, "orientationStyle"));
    if (!ORIENTATIONS.includes(name)) {
      throw s.rt.error("Error", 2187, name);
    }

    return name as Orientation;
  };

  const scales = (x: Value, y: Value, z: Value): Raw => {
    const sx = s.rt.toNumber(x);
    const sy = s.rt.toNumber(y);
    const sz = s.rt.toNumber(z);
    if (sx === 0 || sy === 0 || sz === 0) {
      throw s.rt.error("ArgumentError", 2183);
    }

    return scale3D(sx, sy, sz);
  };

  const rotation = (degrees: Value, axis: Value, pivot: Value): Raw =>
    rotation3D(
      s.rt.toNumber(degrees),
      read3D(nonNull(axis, "axis")),
      pivot === null || pivot === undefined ? [0, 0, 0] : read3D(pivot as AsObject),
      s.rt.swfVersion >= 13,
    );

  /**
   * Both taken apart as decompose takes them, the translations and scales
   * lerped and the rotations slerped, and put together with the scale
   * applied after the rotation, as adl does: a scale that is not uniform
   * then stretches the turned axes (the `three-d` case). Ruffle's corpus
   * has the scale dropped, which adl does not.
   */
  const interpolate = (from: Raw, to: Raw, percent: number): Raw => {
    const [t0, q0, s0] = decompose3D(from, "quaternion");
    const [t1, q1, s1] = decompose3D(to, "quaternion");
    const lerp = (a: number[], b: number[]) => [0, 1, 2].map((i) => a[i] + (b[i] - a[i]) * percent);
    let dot = q0[0] * q1[0] + q0[1] * q1[1] + q0[2] * q1[2] + q0[3] * q1[3];
    let end = q1;
    if (dot < 0) {
      dot = -dot;
      end = q1.map((c) => -c);
    }

    let k0 = 1 - percent;
    let k1 = percent;
    if (dot <= 0.9995) {
      const theta = Math.acos(dot);
      const sinTheta = Math.sin(theta);
      k0 = Math.sin((1 - percent) * theta) / sinTheta;
      k1 = Math.sin(percent * theta) / sinTheta;
    }

    let r = q0.map((c, i) => c * k0 + end[i] * k1);
    const length = Math.hypot(...r);
    r = length === 0 ? [0, 0, 0, 1] : r.map((c) => c / length);
    const [sx, sy, sz] = lerp(s0, s1);
    const turned = compose3D(lerp(t0, t1), r, [1, 1, 1], "quaternion");
    return multiply3D(
      translation3D(turned[12], turned[13], turned[14]),
      multiply3D(
        scale3D(sx, sy, sz),
        turned.map((v, i) => (i >= 12 && i < 15 ? 0 : v)),
      ),
    );
  };

  class Matrix3DNatives {
    declare $matrix3D: Float32Array;

    "flash.geom:Matrix3D::ctor"(raw: Value): void {
      const values = (raw as AsObject | null)?.$a as Value[] | undefined;
      this.$matrix3D = values?.length === 16 ? Float32Array.from(values.map(Number)) : identity();
    }

    get rawData(): AsObject {
      return vector(data(this));
    }

    set rawData(raw: Value) {
      const values = (raw as AsObject | null)?.$a as Value[] | undefined;
      if (values?.length === 16) {
        data(this).set(values.map(Number));
      }
    }

    clone(): AsObject {
      const copy = s.rt.construct(s.rt.classNamed("flash.geom::Matrix3D")) as AsObject;
      data(copy).set(data(this));
      return copy;
    }

    copyFrom(source: Value): void {
      if (source === null || source === undefined) {
        throw s.rt.error("TypeError", 2007, "source");
      }

      data(this).set(data(source as AsObject));
    }

    copyToMatrix3D(dest: Value): void {
      if (dest === null || dest === undefined) {
        throw s.rt.error("TypeError", 2007, "dest");
      }

      data(dest as AsObject).set(data(this));
    }

    copyRawDataFrom(source: Value, index: Value = 0, transpose: Value = false): void {
      if (source === null || source === undefined) {
        throw s.rt.error("TypeError", 2007, "source");
      }

      const values: Value[] = (source as AsObject).$a;
      const start = s.rt.toUint(index);
      if (start + 16 > values.length) {
        throw s.rt.error("ArgumentError", 2004);
      }

      const m = data(this);
      if (transpose) {
        for (let i = 0; i < 16; i++) {
          m[i] = Number(values[start + (i % 4) * 4 + (i >> 2)]);
        }
      } else {
        for (let i = 0; i < 16; i++) {
          m[i] = Number(values[start + i]);
        }
      }
    }

    copyRawDataTo(dest: Value, index: Value = 0, transpose: Value = false): void {
      if (dest === null || dest === undefined) {
        throw s.rt.error("TypeError", 2007, "dest");
      }

      const vector = dest as AsObject;
      const values: Value[] = vector.$a;
      const start = s.rt.toUint(index);
      // Below this adl pads the vector out to the index, however far; from it, a negative index too, it refuses.
      if (start >= MAX_INDEX) {
        throw s.rt.error("ArgumentError", 2004);
      }

      if (vector.$fixed && start + 16 > values.length) {
        throw s.rt.error("RangeError", 1126);
      }

      while (values.length < start + 16) {
        values.push(0);
      }

      const m = data(this);
      for (let i = 0; i < 16; i++) {
        values[start + i] = m[transpose ? (i % 4) * 4 + (i >> 2) : i];
      }
    }

    copyRowTo(row: Value, dest: Value): void {
      const n = checkedAxis(dest, row);
      const m = data(this);
      for (let i = 0; i < 4; i++) {
        s.rt.setProperty(dest as AsObject, s.rt.publicName(axes[i]), m[n + i * 4]);
      }
    }

    copyColumnTo(column: Value, dest: Value): void {
      const n = checkedAxis(dest, column);
      const m = data(this);
      for (let i = 0; i < 4; i++) {
        s.rt.setProperty(dest as AsObject, s.rt.publicName(axes[i]), m[n * 4 + i]);
      }
    }

    copyRowFrom(row: Value, source: Value): void {
      const n = checkedAxis(source, row);
      const m = data(this);
      for (let i = 0; i < 4; i++) {
        m[n + i * 4] = s.rt.toNumber(
          s.rt.getProperty(source as AsObject, s.rt.publicName(axes[i])),
        );
      }
    }

    copyColumnFrom(column: Value, source: Value): void {
      const n = checkedAxis(source, column);
      const m = data(this);
      for (let i = 0; i < 4; i++) {
        m[n * 4 + i] = s.rt.toNumber(
          s.rt.getProperty(source as AsObject, s.rt.publicName(axes[i])),
        );
      }
    }

    identity(): void {
      data(this).set(identity());
    }

    transpose(): void {
      const m = data(this);
      for (let row = 0; row < 4; row++) {
        for (let col = row + 1; col < 4; col++) {
          const a = row * 4 + col;
          const b = col * 4 + row;
          const value = m[a];
          m[a] = m[b];
          m[b] = value;
        }
      }
    }

    appendTranslation(x: Value, y: Value, z: Value): void {
      const m = data(this);
      m[12] += Math.fround(s.rt.toNumber(x));
      m[13] += Math.fround(s.rt.toNumber(y));
      m[14] += Math.fround(s.rt.toNumber(z));
    }

    prependTranslation(x: Value, y: Value, z: Value): void {
      const t = translation3D(s.rt.toNumber(x), s.rt.toNumber(y), s.rt.toNumber(z));
      data(this).set(multiply3D(data(this), t));
    }

    appendScale(x: Value, y: Value, z: Value): void {
      data(this).set(multiply3D(scales(x, y, z), data(this)));
    }

    prependScale(x: Value, y: Value, z: Value): void {
      data(this).set(multiply3D(data(this), scales(x, y, z)));
    }

    appendRotation(degrees: Value, axis: Value, pivot: Value = null): void {
      data(this).set(multiply3D(rotation(degrees, axis, pivot), data(this)));
    }

    prependRotation(degrees: Value, axis: Value, pivot: Value = null): void {
      data(this).set(multiply3D(data(this), rotation(degrees, axis, pivot)));
    }

    append(lhs: Value): void {
      data(this).set(multiply3D(data(nonNull(lhs, "lhs")), data(this)));
    }

    prepend(rhs: Value): void {
      data(this).set(multiply3D(data(this), data(nonNull(rhs, "rhs"))));
    }

    /** Of the opposite sign before SWF 13, as adl has it. */
    get determinant(): number {
      const d = determinant3D(data(this));
      return s.rt.swfVersion >= 13 ? d : -d;
    }

    invert(): boolean {
      const inverse = invert3D(data(this));
      if (inverse) {
        data(this).set(inverse);
      }

      return inverse !== null;
    }

    get position(): AsObject {
      const m = data(this);
      return vector3D(m[12], m[13], m[14], 0);
    }

    set position(v: Value) {
      if (v === null || v === undefined) {
        return;
      }

      const [x, y, z] = read3D(v as AsObject);
      const m = data(this);
      m[12] = x;
      m[13] = y;
      m[14] = z;
    }

    // Both round the vector to float32 first; transformVectors works in doubles.
    transformVector(v: Value): AsObject {
      const [x, y, z, w] = transform3D(data(this), ...xyz(nonNull(v, "vector")));
      return vector3D(x, y, z, w);
    }

    deltaTransformVector(v: Value): AsObject {
      const [x, y, z, w] = transform3D(data(this), ...xyz(nonNull(v, "vector")), 0);
      return vector3D(x, y, z, w);
    }

    transformVectors(vin: Value, vout: Value): void {
      const input: Value[] = nonNull(vin, "vin").$a;
      const output = nonNull(vout, "vout");
      const n = Math.floor(input.length / 3) * 3;
      if (n > output.$a.length) {
        if (output.$fixed) {
          throw s.rt.error("RangeError", 1126, output.$a.length, n);
        }

        while (output.$a.length < n) {
          output.$a.push(0);
        }
      }

      const m = Array.from(data(this));
      for (let i = 0; i < n; i += 3) {
        const x = Number(input[i]);
        const y = Number(input[i + 1]);
        const z = Number(input[i + 2]);
        output.$a[i] = m[0] * x + m[4] * y + m[8] * z + m[12];
        output.$a[i + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
        output.$a[i + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
      }
    }

    decompose(style: Value = "eulerAngles"): AsObject {
      const parts = decompose3D(data(this), orientation(style));
      const cls = s.rt.applyType(s.rt.classNamed("__AS3__.vec::Vector"), [
        s.rt.classNamed("flash.geom::Vector3D"),
      ]);
      const o = cls.$it.instance();
      o.$a = parts.map(([x, y, z, w]) => vector3D(x, y, z, w));
      return o;
    }

    /** False, the matrix left as it was, for fewer than three components or a null one. */
    recompose(components: Value, style: Value = "eulerAngles"): boolean {
      const list: Value[] = nonNull(components, "components").$a;
      const how = orientation(style);
      const parts = list.slice(0, 3);
      if (parts.length < 3 || parts.some((p) => p === null || p === undefined)) {
        return false;
      }

      const [t, r, sc] = parts.map((p) => read3D(p as AsObject));
      data(this).set(compose3D(t, r, sc, how));
      return true;
    }

    interpolateTo(to: Value, percent: Value): void {
      const target = data(nonNull(to, "toMat"));
      data(this).set(interpolate(data(this), target, s.rt.toNumber(percent)));
    }

    static interpolate(from: Value, to: Value, percent: Value): AsObject {
      const a = data(nonNull(from, "fromMat"));
      const b = data(nonNull(to, "toMat"));
      return matrix3D(interpolate(a, b, s.rt.toNumber(percent)));
    }
  }

  avm2.registerNativeClass(natives, "flash.geom::Matrix3D", Matrix3DNatives);
  return natives;
}
