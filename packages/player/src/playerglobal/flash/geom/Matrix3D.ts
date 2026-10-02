// flash.geom.Matrix3D's 16 float32 values, in column-major rawData order.
import { avm2 } from "@swf2es/runtime";
import type { Scripting } from "../../../scripting.js";

type AsObject = avm2.AsObject;
type Value = avm2.Value;

function identity(): Float32Array {
  return Float32Array.of(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1);
}

/** Matrix3D's values; its native constructor assigns them. */
function data(o: AsObject): Float32Array {
  return o.$matrix3D;
}

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
  }

  avm2.registerNativeClass(natives, "flash.geom::Matrix3D", Matrix3DNatives);
  return natives;
}
