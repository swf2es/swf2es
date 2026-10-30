// drawBitmap as the player computed it a pixel at a time, before it drew a
// row at a time (bitmap/ops.ts): every pixel's 16 samples tested, sampled,
// colour transformed, scaled by its coverage and blended in turn, kept as
// the row passes' reference for a BitmapData drawn without a layer.
import {
  BitmapStore,
  over,
  type PixelRect,
} from "../../../../packages/player/dist/bitmap/bitmap.js";

export interface Affine {
  a: number;
  b: number;
  c: number;
  d: number;
  tx: number;
  ty: number;
}

export interface ColorTransformValues {
  rMul: number;
  gMul: number;
  bMul: number;
  aMul: number;
  rAdd: number;
  gAdd: number;
  bAdd: number;
  aAdd: number;
}

const MODES = new Set([
  "normal",
  "layer",
  "multiply",
  "screen",
  "lighten",
  "darken",
  "difference",
  "add",
  "subtract",
  "invert",
  "overlay",
  "hardlight",
]);

export function referenceDraw(
  store: BitmapStore,
  source: BitmapStore,
  matrix: Affine,
  ct: ColorTransformValues | null,
  mode: string,
  clip: PixelRect | null,
  smooth: boolean,
  rows = false,
): void {
  if (!MODES.has(mode)) {
    return;
  }

  const m = { ...matrix, tx: Math.floor(matrix.tx * 4) / 4, ty: Math.floor(matrix.ty * 4) / 4 };
  const det = m.a * m.d - m.b * m.c;
  if (det === 0) {
    return;
  }

  const xs = [0, source.width, 0, source.width].map(
    (x, i) => m.a * x + m.c * (i < 2 ? 0 : source.height) + m.tx,
  );
  const ys = [0, source.width, 0, source.width].map(
    (x, i) => m.b * x + m.d * (i < 2 ? 0 : source.height) + m.ty,
  );
  let area = store.clip({
    x: Math.floor(Math.min(...xs)),
    y: Math.floor(Math.min(...ys)),
    width: Math.ceil(Math.max(...xs)) - Math.floor(Math.min(...xs)),
    height: Math.ceil(Math.max(...ys)) - Math.floor(Math.min(...ys)),
  });
  if (area && clip) {
    area = store.clip({
      x: Math.max(area.x, clip.x),
      y: Math.max(area.y, clip.y),
      width: Math.min(area.x + area.width, clip.x + clip.width) - Math.max(area.x, clip.x),
      height: Math.min(area.y + area.height, clip.y + clip.height) - Math.max(area.y, clip.y),
    });
  }

  if (!area) {
    return;
  }

  const ia = m.d / det;
  const ib = -m.b / det;
  const ic = -m.c / det;
  const id = m.a / det;
  const itx = -(ia * m.tx + ic * m.ty);
  const ity = -(ib * m.tx + id * m.ty);
  const into = store.pixels;
  const from = source.readable;
  // Into itself through a BitmapData, every pixel of a row read before one is written.
  const buffered = rows && source === store;
  const row: number[] = [];

  for (let y = area.y; y < area.y + area.height; y++) {
    row.length = 0;
    for (let x = area.x; x < area.x + area.width; x++) {
      let hits = 0;
      for (let k = 0; k < 16; k++) {
        const px = x + ((k & 3) + 0.5) / 4;
        const py = y + ((k >> 2) + 0.5) / 4;
        const sx = ia * px + ic * py + itx;
        const sy = ib * px + id * py + ity;
        if (sx >= 0 && sy >= 0 && sx < source.width && sy < source.height) {
          hits++;
        }
      }

      if (hits === 0) {
        continue;
      }

      const sx = ia * (x + 0.5) + ic * (y + 0.5) + itx;
      const sy = ib * (x + 0.5) + id * (y + 0.5) + ity;
      let p = smooth ? bilinear(source, from, sx - 0.5, sy - 0.5) : nearest(source, from, sx, sy);
      if (ct) {
        p = transformed(p, ct);
      }

      if (hits < 16) {
        p = scaleBy(p, hits / 16);
      }

      const i = y * store.width + x;
      if (buffered) {
        row.push(i, p);
      } else {
        into[i] = put(store, mode, p, into[i]);
      }
    }

    for (let k = 0; k < row.length; k += 2) {
      into[row[k]] = put(store, mode, row[k + 1], into[row[k]]);
    }
  }
}

function put(store: BitmapStore, mode: string, p: number, d: number): number {
  const out = mode === "normal" || mode === "layer" ? over(p, d) : blend(mode, p, d);
  return store.transparent ? out : (out | 0xff000000) >>> 0;
}

function nearest(source: BitmapStore, from: Uint32Array, x: number, y: number): number {
  const px = Math.min(source.width - 1, Math.max(0, Math.floor(x)));
  const py = Math.min(source.height - 1, Math.max(0, Math.floor(y)));
  return from[py * source.width + px];
}

function bilinear(source: BitmapStore, from: Uint32Array, x: number, y: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const at = (px: number, py: number) =>
    from[
      Math.min(source.height - 1, Math.max(0, py)) * source.width +
        Math.min(source.width - 1, Math.max(0, px))
    ];
  let out = 0;
  for (const shift of [24, 16, 8, 0]) {
    const v = (p: number) => (p >>> shift) & 0xff;
    const top = v(at(x0, y0)) * (1 - fx) + v(at(x0 + 1, y0)) * fx;
    const bottom = v(at(x0, y0 + 1)) * (1 - fx) + v(at(x0 + 1, y0 + 1)) * fx;
    out |= Math.round(top * (1 - fy) + bottom * fy) << shift;
  }

  return out >>> 0;
}

/** As colorTransform: each channel back to straight colour, through the transform, premultiplied again. */
function transformed(p: number, ct: ColorTransformValues): number {
  const a0 = p >>> 24;
  if (a0 === 0 && ct.aAdd <= 0) {
    return 0;
  }

  const channel = (v: number, mul: number, add: number) =>
    Math.max(0, Math.min(255, Math.floor((v * Math.trunc(mul * 256)) / 256) + Math.trunc(add)));
  const a = channel(a0, ct.aMul, ct.aAdd);
  const color = (shift: number, mul: number, add: number) => {
    const c = (p >>> shift) & 0xff;
    const straight = a0 === 0 ? 0 : Math.min(255, Math.floor((c * 255) / a0));
    const v = channel(straight, mul, add);
    return a === 255 ? v : (v * (a + 1)) >> 8;
  };
  return (
    ((a << 24) |
      (color(16, ct.rMul, ct.rAdd) << 16) |
      (color(8, ct.gMul, ct.gAdd) << 8) |
      color(0, ct.bMul, ct.bAdd)) >>>
    0
  );
}

function scaleBy(p: number, f: number): number {
  let out = 0;
  for (const shift of [24, 16, 8, 0]) {
    out |= Math.round(((p >>> shift) & 0xff) * f) << shift;
  }

  return out >>> 0;
}

function blend(mode: string, s: number, d: number): number {
  const sa = s >>> 24;
  const da = d >>> 24;
  const mul = (x: number, y: number) => (x * y + 127) / 255;
  const channel = (shift: number) => {
    const cs = (s >>> shift) & 0xff;
    const cd = (d >>> shift) & 0xff;
    let b: number;
    switch (mode) {
      case "multiply":
        b = mul(cs, cd);
        break;
      case "screen":
        b = (cs * da) / 255 + (cd * sa) / 255 - mul(cs, cd);
        break;
      case "lighten":
        b = Math.max(mul(cs, da), mul(cd, sa));
        break;
      case "darken":
        b = Math.min(mul(cs, da), mul(cd, sa));
        break;
      case "difference":
        b = Math.abs(mul(cs, da) - mul(cd, sa));
        break;
      case "add":
        return Math.min(255, cs + cd);
      case "subtract":
        return Math.max(0, cd - cs);
      case "invert":
        return Math.max(0, Math.min(255, Math.floor(mul(255 - cd, sa) + mul(cd, 255 - sa))));
      case "overlay":
        b = 2 * cd <= da ? 2 * mul(cs, cd) : mul(sa, da) - 2 * mul(da - cd, sa - cs);
        break;
      default:
        b = 2 * cs <= sa ? 2 * mul(cs, cd) : mul(sa, da) - 2 * mul(da - cd, sa - cs);
        break;
    }

    return Math.max(0, Math.min(255, Math.floor(b + mul(cs, 255 - da) + mul(cd, 255 - sa))));
  };
  const a =
    mode === "add" || mode === "subtract"
      ? Math.min(255, sa + da)
      : Math.min(255, Math.round(sa + da - mul(sa, da)));
  return ((a << 24) | (channel(16) << 16) | (channel(8) << 8) | channel(0)) >>> 0;
}

/** A store of its own with `pixels`, premultiplied already. */
export function storeOf(
  width: number,
  height: number,
  transparent: boolean,
  pixels: ArrayLike<number>,
): BitmapStore {
  const store = new BitmapStore(width, height, transparent, 0);
  store.pixels.set(pixels);
  return store;
}
