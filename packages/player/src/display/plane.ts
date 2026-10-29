// A 3D display object's bitmap and the quad it is drawn through, as both
// views draw it (render/three.ts for the Pixi view, scene/view.ts for the
// renderer of swf2es's own): what it and its children draw, in its own
// space, a pixel of it a texel, drawn into a bitmap at SAMPLES a side and
// averaged down, with a texel of nothing around; and the bitmap's quad
// placed through the object's plane in perspective (display/perspective.ts)
// as Flash places it (docs/architecture.md, "3D display objects").
import type { Matrix } from "@swf2es/format";
import { isProjective } from "./geometry.js";

/** The samples a side the bitmap is drawn at before it is averaged to a texel a pixel, as Flash's high quality covers edges. */
export const SAMPLES = 4;

/** The most texels a side of a bitmap: larger, the object is drawn into it at less than a texel a pixel. */
const LARGEST = 2048;

/** The most texels the samples a bitmap is drawn at may take (16 MiB): past it, fewer samples. */
const SAMPLED_TEXELS = 4 * 1024 * 1024;

/** The samples a side, and texels a pixel of the object's space, a bitmap of a w by h rectangle is drawn at. */
export function bitmapScale(
  width: number,
  height: number,
  largest: number,
): { samples: number; texels: number } {
  const texels = Math.min(1, Math.min(LARGEST, largest) / Math.max(width, height));
  const w = Math.max(1, Math.ceil(width * texels));
  const h = Math.max(1, Math.ceil(height * texels));
  let samples = SAMPLES;
  while (
    samples > 1 &&
    (w * samples > largest || h * samples > largest || w * h * samples * samples > SAMPLED_TEXELS)
  ) {
    samples /= 2;
  }

  return { samples, texels };
}

/**
 * A bitmap's rectangle in the object's space, and its quad's corners in its
 * parent's space with the w each divides by: top left, top right, bottom
 * right, bottom left.
 */
export interface PlaneQuad {
  x: number;
  y: number;
  width: number;
  height: number;
  positions: Float64Array;
  ws: Float64Array;
}

/**
 * The quad of the bitmap of what the object draws over xMin to xMax and
 * yMin to yMax of its own space, by its plane in its parent's space, `m`,
 * into `out`: false, and nothing to draw, where a corner is behind the eye,
 * as Flash draws none of it. The bitmap reaches from the rectangle's left
 * and top out to whole pixels, a texel a pixel, and a texel of nothing
 * around. Flash draws it a texel wider and taller than it is, about its
 * centre, and half a pixel of the stage right and down: so unturned at a
 * texel a pixel its left and top edges stay where they are, and magnified
 * it grows as much each way.
 */
export function placeQuad(
  m: Matrix,
  xMin: number,
  yMin: number,
  xMax: number,
  yMax: number,
  out: PlaneQuad,
): boolean {
  const xFrom = Math.floor(xMin);
  const yFrom = Math.floor(yMin);
  const across = Math.ceil(xMax) - xFrom;
  const down = Math.ceil(yMax) - yFrom;
  if (!(across >= 1 && down >= 1 && across < 1e6 && down < 1e6)) {
    return false;
  }

  const [u, v, w] = isProjective(m) ? [m.u, m.v, m.w] : [0, 0, 1];
  const cx = xFrom + across / 2;
  const cy = yFrom + down / 2;
  const at = (x: number, y: number): [number, number] => {
    const q = u * x + v * y + w;
    return [(m.a * x + m.c * y + m.tx) / q, (m.b * x + m.d * y + m.ty) / q];
  };
  // Half a pixel of the stage right and down, in the object's space: through the inverse of
  // how its plane moves a point at the centre.
  const [ax, ay] = at(cx - 0.5, cy);
  const [bx, by] = at(cx + 0.5, cy);
  const [dx, dy] = at(cx, cy - 0.5);
  const [ex, ey] = at(cx, cy + 0.5);
  const jxx = bx - ax;
  const jyx = by - ay;
  const jxy = ex - dx;
  const jyy = ey - dy;
  const det = jxx * jyy - jxy * jyx;
  const shiftX = det ? (0.5 * jyy - 0.5 * jxy) / det : 0;
  const shiftY = det ? (0.5 * jxx - 0.5 * jyx) / det : 0;
  const sx = (across + 1) / across;
  const sy = (down + 1) / down;
  const left = cx + shiftX - (across / 2 + 1) * sx;
  const right = cx + shiftX + (across / 2 + 1) * sx;
  const top = cy + shiftY - (down / 2 + 1) * sy;
  const bottom = cy + shiftY + (down / 2 + 1) * sy;
  for (let i = 0; i < 4; i++) {
    const x = i === 1 || i === 2 ? right : left;
    const y = i >= 2 ? bottom : top;
    const q = u * x + v * y + w;
    if (!(q > 0)) {
      return false;
    }

    out.positions[i * 2] = (m.a * x + m.c * y + m.tx) / q;
    out.positions[i * 2 + 1] = (m.b * x + m.d * y + m.ty) / q;
    out.ws[i] = q;
  }

  out.x = xFrom - 1;
  out.y = yFrom - 1;
  out.width = across + 2;
  out.height = down + 2;
  return true;
}
