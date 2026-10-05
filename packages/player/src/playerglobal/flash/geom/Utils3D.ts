// flash.geom.Utils3D: points through a projection matrix, to the plane w = 1.
import { avm2 } from "@swf2es/runtime";
import { transform3D } from "../../../matrix3d.js";
import type { Scripting } from "../../../scripting.js";

type AsObject = avm2.AsObject;
type Value = avm2.Value;

const f = Math.fround;

export function utils3DNatives(s: Scripting): avm2.Natives {
  const natives: avm2.Natives = {};

  const nonNull = (v: Value, name: string): AsObject => {
    if (v === null || v === undefined) {
      throw s.rt.error("TypeError", 2007, name);
    }

    return v as AsObject;
  };

  const component = (v: AsObject, name: string): number =>
    s.rt.toNumber(s.rt.getProperty(v, s.rt.publicName(name)));

  /** A vector grown with zeros to `n`, as Flash grows it; a fixed one too short is RangeError 1126. */
  const grow = (v: AsObject, n: number): void => {
    if (v.$a.length >= n) {
      return;
    }

    if (v.$fixed) {
      throw s.rt.error("RangeError", 1126, v.$a.length, n);
    }

    while (v.$a.length < n) {
      v.$a.push(0);
    }
  };

  class Utils3DNatives {
    /**
     * transformVector's float32 result times the float32 reciprocal of its
     * w, as adl has it; the Flash Player of Ruffle's corpus rounds the
     * products to float32 too.
     */
    static projectVector(m: Value, v: Value): AsObject {
      const raw: Float32Array = nonNull(m, "m").$matrix3D;
      const at = nonNull(v, "v");
      const [x, y, z, w] = transform3D(
        raw,
        component(at, "x"),
        component(at, "y"),
        component(at, "z"),
      );
      const over = f(1 / w);
      return s.rt.construct(
        s.rt.classNamed("flash.geom::Vector3D"),
        x * over,
        y * over,
        z * over,
        w,
      ) as AsObject;
    }

    /** Each (x, y, z) of `verts` through the matrix in float32, to an (x, y) in `projected` over w in doubles, and 1/w to its t in `uvts`. */
    static projectVectors(m: Value, verts: Value, projected: Value, uvts: Value): void {
      const raw: Float32Array = nonNull(m, "m").$matrix3D;
      const input: Value[] = nonNull(verts, "verts").$a;
      const out = nonNull(projected, "projectedVerts");
      const uvt = nonNull(uvts, "uvts");
      grow(uvt, input.length);
      grow(out, Math.floor(input.length / 3) * 2);
      for (let i = 0, j = 0; i + 2 < input.length; i += 3, j += 2) {
        const [x, y, , w] = transform3D(
          raw,
          Number(input[i]),
          Number(input[i + 1]),
          Number(input[i + 2]),
        );
        out.$a[j] = x / w;
        out.$a[j + 1] = y / w;
        uvt.$a[i + 2] = 1 / w;
      }
    }
  }

  avm2.registerNativeClass(natives, "flash.geom::Utils3D", Utils3DNatives);
  return natives;
}
