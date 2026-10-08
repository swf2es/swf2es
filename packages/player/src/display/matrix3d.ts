// Flash's 4×4 matrices: 16 float32 values in column-major order, as
// Matrix3D.rawData has them, and Flash's float arithmetic on them, each
// product and sum rounded to float32 (Ruffle's matrix3d.rs, which the
// corpus's matrix3d tests check against Flash). What Matrix3D, a display
// object's 3D transform and Utils3D share.

export type Raw = Float32Array;

const f = Math.fround;

export function identity3D(): Raw {
  return Float32Array.of(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1);
}

export function scale3D(x: number, y: number, z: number): Raw {
  return Float32Array.of(x, 0, 0, 0, 0, y, 0, 0, 0, 0, z, 0, 0, 0, 0, 1);
}

export function translation3D(x: number, y: number, z: number): Raw {
  return Float32Array.of(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1);
}

/** `lhs` × `rhs`: `rhs` applied first. */
export function multiply3D(lhs: Raw, rhs: Raw): Raw {
  const out = new Float32Array(16);
  for (let column = 0; column < 4; column++) {
    for (let row = 0; row < 4; row++) {
      const c = column * 4;
      out[c + row] = f(
        f(f(f(lhs[row] * rhs[c]) + f(lhs[4 + row] * rhs[c + 1])) + f(lhs[8 + row] * rhs[c + 2])) +
          f(lhs[12 + row] * rhs[c + 3]),
      );
    }
  }

  return out;
}

function det3(m: readonly number[]): number {
  return f(
    f(f(m[0] * f(f(m[4] * m[8]) - f(m[7] * m[5]))) - f(m[3] * f(f(m[1] * m[8]) - f(m[7] * m[2])))) +
      f(m[6] * f(f(m[1] * m[5]) - f(m[4] * m[2]))),
  );
}

/**
 * Flash's determinant: without projection, the 3×3 part's with the last
 * element folded in; otherwise expanded over the first row, which keeps
 * its infinities as Flash's does.
 */
export function determinant3D(m: Raw): number {
  if (m[3] === 0 && m[7] === 0 && m[11] === 0) {
    return det3([
      m[0],
      m[1],
      f(m[2] * m[15]),
      m[4],
      m[5],
      f(m[6] * m[15]),
      m[8],
      m[9],
      f(m[10] * m[15]),
    ]);
  }

  const d0 = det3([m[5], m[6], m[7], m[9], m[10], m[11], m[13], m[14], m[15]]);
  const d4 = det3([m[1], m[2], m[3], m[9], m[10], m[11], m[13], m[14], m[15]]);
  const d8 = det3([m[1], m[2], m[3], m[5], m[6], m[7], m[13], m[14], m[15]]);
  const d12 = det3([m[1], m[2], m[3], m[5], m[6], m[7], m[9], m[10], m[11]]);
  return f(f(f(f(m[0] * d0) - f(m[4] * d4)) + f(m[8] * d8)) - f(m[12] * d12));
}

/**
 * The inverse, or null for a matrix Flash takes for singular, its
 * determinant within 1e-11 of 0 (Ruffle's). Gauss-Jordan elimination with
 * partial pivoting in float32, each pivot row multiplied by the float32
 * reciprocal of its pivot, which gives adl's inverses to the last bit
 * where the cofactors' do not.
 */
export function invert3D(m: Raw): Raw | null {
  if (!(Math.abs(determinant3D(m)) > 1e-11)) {
    return null;
  }

  // Rows of the matrix and of the identity it becomes.
  const a: number[][] = [0, 1, 2, 3].map((r) => [0, 1, 2, 3].map((c) => m[c * 4 + r]));
  const b: number[][] = [0, 1, 2, 3].map((r) => [0, 1, 2, 3].map((c) => (r === c ? 1 : 0)));
  for (let c = 0; c < 4; c++) {
    let p = c;
    for (let r = c + 1; r < 4; r++) {
      if (Math.abs(a[r][c]) > Math.abs(a[p][c])) {
        p = r;
      }
    }

    [a[c], a[p]] = [a[p], a[c]];
    [b[c], b[p]] = [b[p], b[c]];
    if (a[c][c] === 0) {
      return null;
    }

    const over = f(1 / a[c][c]);
    for (let j = 0; j < 4; j++) {
      a[c][j] = f(a[c][j] * over);
      b[c][j] = f(b[c][j] * over);
    }

    for (let r = 0; r < 4; r++) {
      const k = a[r][c];
      if (r === c) {
        continue;
      }

      for (let j = 0; j < 4; j++) {
        a[r][j] = f(a[r][j] - f(k * a[c][j]));
        b[r][j] = f(b[r][j] - f(k * b[c][j]));
      }
    }
  }

  return Float32Array.from({ length: 16 }, (_, i) => b[i % 4][i >> 2]);
}

/**
 * A rotation by `degrees` about `axis`, around `pivot`, as adl gives it to
 * the last bit: the axis made a unit one in float32, the rotation's
 * elements in doubles, and the pivot's translations multiplied on in
 * float32. Before SWF 13 Flash took the axis as it came, not made a unit
 * one first, which scales what a longer axis turns.
 */
export function rotation3D(
  degrees: number,
  axis: readonly number[],
  [px, py, pz]: readonly number[],
  unit = true,
): Raw {
  let [x, y, z] = axis;
  if (unit) {
    const length = f(Math.sqrt(f(f(f(x * x) + f(y * y)) + f(z * z))));
    x = f(x / length);
    y = f(y / length);
    z = f(z / length);
  }

  // Rounded as Flash's, multiplied before the division.
  const radians = (degrees * Math.PI) / 180;
  const c = Math.cos(radians);
  const s = Math.sin(radians);
  const t = 1 - c;
  const r = Float32Array.of(
    c + t * x * x,
    t * x * y + s * z,
    t * x * z - s * y,
    0,
    t * x * y - s * z,
    c + t * y * y,
    t * y * z + s * x,
    0,
    t * x * z + s * y,
    t * y * z - s * x,
    c + t * z * z,
    0,
    0,
    0,
    0,
    1,
  );
  if (px === 0 && py === 0 && pz === 0) {
    return r;
  }

  return multiply3D(translation3D(px, py, pz), multiply3D(r, translation3D(-px, -py, -pz)));
}

export type Orientation = "eulerAngles" | "axisAngle" | "quaternion";

/**
 * Translation × rotation × scale, the order observable with components
 * that are not finite. Euler angles are in radians, about x, then y, then z.
 */
export function compose3D(
  [tx, ty, tz]: readonly number[],
  [rx, ry, rz, rw]: readonly number[],
  [sx, sy, sz]: readonly number[],
  orientation: Orientation,
): Raw {
  const r = new Float64Array(16);
  if (orientation === "eulerAngles") {
    // In float32, sin y times cos z and sin z taken first, as the corpus's matrix3d_compose has Flash's.
    const cx = f(Math.cos(rx));
    const cy = f(Math.cos(ry));
    const cz = f(Math.cos(rz));
    const sinX = f(Math.sin(rx));
    const sinY = f(Math.sin(ry));
    const sinZ = f(Math.sin(rz));
    const yz = f(sinY * cz);
    const yZ = f(sinY * sinZ);
    r[0] = f(cy * cz);
    r[1] = f(cy * sinZ);
    r[2] = -sinY;
    r[4] = f(f(sinX * yz) - f(cx * sinZ));
    r[5] = f(f(sinX * yZ) + f(cx * cz));
    r[6] = f(sinX * cy);
    r[8] = f(f(cx * yz) + f(sinX * sinZ));
    r[9] = f(f(cx * yZ) - f(sinX * cz));
    r[10] = f(cx * cy);
  } else {
    let x = rx;
    let y = ry;
    let z = rz;
    let w = rw;
    if (orientation === "axisAngle") {
      const half = Math.sin(w / 2);
      x *= half;
      y *= half;
      z *= half;
      w = Math.cos(w / 2);
    }

    r[0] = 1 - 2 * y * y - 2 * z * z;
    r[1] = 2 * x * y + 2 * w * z;
    r[2] = 2 * x * z - 2 * w * y;
    r[4] = 2 * x * y - 2 * w * z;
    r[5] = 1 - 2 * x * x - 2 * z * z;
    r[6] = 2 * y * z + 2 * w * x;
    r[8] = 2 * x * z + 2 * w * y;
    r[9] = 2 * y * z - 2 * w * x;
    r[10] = 1 - 2 * x * x - 2 * y * y;
  }

  r[15] = 1;
  return multiply3D(
    translation3D(tx, ty, tz),
    multiply3D(Float32Array.from(r), scale3D(sx, sy, sz)),
  );
}

function dot3(a: readonly number[], b: readonly number[]): number {
  return f(f(f(a[0] * b[0]) + f(a[1] * b[1])) + f(a[2] * b[2]));
}

/** `a` less `k` times `b`. */
function less3(a: readonly number[], k: number, b: readonly number[]): number[] {
  return a.map((x, i) => f(x - f(k * b[i])));
}

/**
 * Translation, rotation and scale, each [x, y, z, w], as Matrix3D.decompose
 * gives them: the columns made orthonormal one after another, in float32,
 * each scale what was left of its column, so a skew goes, and a mirror is
 * the z scale's sign. The rotation is read from what is left, as OpenFL's
 * decompose reads it (Ruffle's), the axis and angle Flash's own way.
 */
export function decompose3D(raw: Raw, orientation: Orientation): number[][] {
  const translation = [raw[12], raw[13], raw[14], 0];
  const c0 = [raw[0], raw[1], raw[2]];
  const scaleX = f(Math.sqrt(dot3(c0, c0)));
  const u0 = c0.map((x) => f(x / scaleX));
  const c1 = less3([raw[4], raw[5], raw[6]], dot3(u0, [raw[4], raw[5], raw[6]]), u0);
  const scaleY = f(Math.sqrt(dot3(c1, c1)));
  const u1 = c1.map((x) => f(x / scaleY));
  let c2 = [raw[8], raw[9], raw[10]];
  c2 = less3(c2, dot3(u0, c2), u0);
  c2 = less3(c2, dot3(u1, c2), u1);
  let scaleZ = f(Math.sqrt(dot3(c2, c2)));
  let u2 = c2.map((x) => f(x / scaleZ));
  const cross = [
    u1[1] * u2[2] - u1[2] * u2[1],
    u1[2] * u2[0] - u1[0] * u2[2],
    u1[0] * u2[1] - u1[1] * u2[0],
  ];
  if (u0[0] * cross[0] + u0[1] * cross[1] + u0[2] * cross[2] < 0) {
    scaleZ = -scaleZ;
    u2 = u2.map((x) => -x);
  }

  const m = [...u0, 0, ...u1, 0, ...u2, 0];
  const rotation = [0, 0, 0, 0];
  if (orientation === "axisAngle") {
    rotation[3] = f(Math.acos(f(f(f(f(m[0] + m[5]) + m[10]) - 1) / 2)));
    const twice = f(2 * f(Math.sin(rotation[3])));
    if (twice !== 0) {
      rotation[0] = f(f(m[6] - m[9]) / twice);
      rotation[1] = f(f(m[8] - m[2]) / twice);
      rotation[2] = f(f(m[1] - m[4]) / twice);
    }
  } else if (orientation === "quaternion") {
    const trace = m[0] + m[5] + m[10];
    if (trace > 0) {
      rotation[3] = Math.sqrt(1 + trace) / 2;
      rotation[0] = (m[6] - m[9]) / (4 * rotation[3]);
      rotation[1] = (m[8] - m[2]) / (4 * rotation[3]);
      rotation[2] = (m[1] - m[4]) / (4 * rotation[3]);
    } else if (m[0] > m[5] && m[0] > m[10]) {
      rotation[0] = Math.sqrt(1 + m[0] - m[5] - m[10]) / 2;
      rotation[3] = (m[6] - m[9]) / (4 * rotation[0]);
      rotation[1] = (m[1] + m[4]) / (4 * rotation[0]);
      rotation[2] = (m[8] + m[2]) / (4 * rotation[0]);
    } else if (m[5] > m[10]) {
      rotation[1] = Math.sqrt(1 + m[5] - m[0] - m[10]) / 2;
      rotation[0] = (m[1] + m[4]) / (4 * rotation[1]);
      rotation[3] = (m[8] - m[2]) / (4 * rotation[1]);
      rotation[2] = (m[6] + m[9]) / (4 * rotation[1]);
    } else {
      rotation[2] = Math.sqrt(1 + m[10] - m[0] - m[5]) / 2;
      rotation[0] = (m[8] + m[2]) / (4 * rotation[2]);
      rotation[1] = (m[6] + m[9]) / (4 * rotation[2]);
      rotation[3] = (m[1] - m[4]) / (4 * rotation[2]);
    }
  } else {
    rotation[1] = f(Math.asin(-m[2]));
    if (m[2] !== 1 && m[2] !== -1) {
      rotation[0] = f(Math.atan2(m[6], m[10]));
      rotation[2] = f(Math.atan2(m[1], m[0]));
    } else {
      rotation[0] = f(Math.atan2(m[4], m[5]));
    }
  }

  return [translation, rotation, [scaleX, scaleY, scaleZ, 0]];
}

/** `m` applied to (x, y, z, 1), in float32 as Matrix3D.transformVector's; `w` 0 leaves out the translation. */
export function transform3D(m: Raw, x0: number, y0: number, z0: number, w = 1): number[] {
  const x = f(x0);
  const y = f(y0);
  const z = f(z0);
  const out: number[] = [];
  for (let row = 0; row < 4; row++) {
    const sum = f(f(f(m[row] * x) + f(m[4 + row] * y)) + f(m[8 + row] * z));
    out.push(w ? f(sum + m[12 + row]) : sum);
  }

  return out;
}

/**
 * Both taken apart as decompose takes them, the translations and scales
 * lerped and the rotations slerped, and put together with the scale
 * applied after the rotation, as adl does: a scale that is not uniform
 * then stretches the turned axes (the `three-d` case). Ruffle's corpus
 * has the scale dropped, which adl does not.
 */
export function interpolate3D(from: Raw, to: Raw, percent: number): Raw {
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
}

/**
 * `v` made a unit one, times the float32 reciprocal of its length, as adl
 * makes even a denormal one; null for one of no length in float32.
 */
function unit3(v: readonly number[]): number[] | null {
  const squared = dot3(v, v);
  const k = f(1 / Math.sqrt(squared));
  return squared === 0 ? null : v.map((x) => f(x * k));
}

/** In doubles: adl's side of an `at` and `up` nearly parallel comes out so, where float32's is none. */
function cross3(a: readonly number[], b: readonly number[]): number[] {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

/** A rotation whose columns are `x`, `y` and `z`. */
function columns3D(x: readonly number[], y: readonly number[], z: readonly number[]): Raw {
  return Float32Array.of(...x, 0, ...y, 0, ...z, 0, 0, 0, 0, 1);
}

/**
 * Matrix3D.pointAt as adl has it, to a float32 rounding or two; Ruffle and
 * Shumway leave it a stub. The object-relative `at` turns to face `pos`
 * from the matrix's position, and `up` to the world's (0, -1, 0), each
 * made square to the other; left out they are (0, 1, 0) and (0, 0, 1), not
 * the documented (0, 0, -1) and (0, -1, 0), which turn it otherwise. With
 * M's linear part K · R · S, R and S as decompose finds them and K the
 * skew it drops, it becomes K · L · S · Q: L the facing frame, x across,
 * y up and z toward `pos`, and Q taking `at` and `up` to its z and y. The
 * translation stays and the projection row goes. Null, the matrix left as
 * it was, where a direction has no length in float32: `pos` at the
 * position or along the world's up, `at` zero, or `up` zero or parallel
 * to it. A NaN anywhere makes every element NaN, as in adl.
 */
export function pointAt3D(
  m: Raw,
  pos: readonly number[],
  at: readonly number[],
  up: readonly number[],
): Raw | null {
  const toward = unit3(pos.map((v, i) => f(f(v) - m[12 + i])));
  const across = toward && unit3(cross3(toward, [0, -1, 0]));
  const facing = unit3(at.map(f));
  const side = facing && unit3(cross3(up.map(f), facing));
  if (!toward || !across || !facing || !side) {
    return null;
  }

  const above = cross3(across, toward);
  const top = cross3(facing, side);
  const frame = columns3D(
    across.map((v) => -v),
    above,
    toward,
  );
  // Rows, not columns: the inverse of the rotation taking z and y to `at` and `up`.
  const object = columns3D(
    [side[0], top[0], facing[0]],
    [side[1], top[1], facing[1]],
    [side[2], top[2], facing[2]],
  );
  const [, rotation, scale] = decompose3D(m, "eulerAngles");
  const linear = Float32Array.from(m);
  linear.fill(0, 12, 15);
  linear[3] = linear[7] = linear[11] = 0;
  linear[15] = 1;
  const unskewed = invert3D(compose3D([0, 0, 0], rotation, scale, "eulerAngles"));
  const skew = unskewed ? multiply3D(linear, unskewed) : identity3D();
  const out = multiply3D(
    skew,
    multiply3D(frame, multiply3D(scale3D(scale[0], scale[1], scale[2]), object)),
  );
  if (out.some(Number.isNaN)) {
    return out.fill(Number.NaN);
  }

  out[12] = m[12];
  out[13] = m[13];
  out[14] = m[14];
  return out;
}
