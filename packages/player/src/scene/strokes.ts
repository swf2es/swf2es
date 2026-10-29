// A shape layer's lines as a geometry of the renderer's, stroked as Flash
// strokes them, by @swf2es/native's line builder (strokes.zig) in one call:
// in the stage's axes, at one width all along, never under a pixel of the
// screen (strokeWidth), each line's path outlined and its outline filled
// non-zero, so that where it overlaps itself it is drawn once. A line drawn
// at whole alpha, where an overlap shows nothing, is triangles along its
// path instead, with no tessellator. Here the layer is packed as
// strokes.zig reads it.
import type { Line } from "@swf2es/format";
import type { GeometryData } from "@swf2es/render";
import { LINE, type ShapeLayer } from "../display/shapes.js";
import type { LineBuilder } from "./fills.js";
import { vertexColor } from "./shapes.js";

/**
 * How far, in pixels of the screen, a line's flattened curves and its
 * round joins' and caps' chords may stray from the curve: a tenth of one,
 * where the fills' finer flatness made strokes several times the
 * triangles, which a software rasteriser pays for; a
 * quarter shows on the references' curved lines. A 9-slice's lines take
 * half that, as its small rounded corners, which Flash draws as exact
 * curves, show a tenth.
 */
export const STROKE_FLATNESS = 0.1;

/**
 * A line's width on the stage through the linear transform (a b c d): its
 * own width scaled as its scale mode allows, never under `least`, a pixel
 * of the screen, which is also a hairline's.
 */
export function strokeWidth(
  line: Line,
  a: number,
  b: number,
  c: number,
  d: number,
  least: number,
): number {
  const sx = Math.abs(a + c);
  const sy = Math.abs(b + d);
  const scale = line.noHScale
    ? line.noVScale
      ? 1
      : sy
    : line.noVScale
      ? sx
      : Math.sqrt((sx * sx + sy * sy) / 2);
  return Math.max(least, (line.width / 20) * scale);
}

/** A line's flags in the input: drawn as triangles that may overlap; its paths' outlines filled as one. */
const OVERLAPS = 1;
const TOGETHER = 2;

/**
 * `layer`'s lines through the linear transform (a b c d), at least `least`
 * wide, as wide as `by` makes them (a 9-slice's line space) or null, built
 * by `builder`; those of whole alpha as triangles that may overlap where
 * `opaque`. Null for none, or where the builder refused them (a position
 * not a number) or ran out of memory.
 */
export function layerStrokes(
  layer: ShapeLayer,
  a: number,
  b: number,
  c: number,
  d: number,
  least: number,
  builder: LineBuilder,
  by: readonly number[] | null = null,
  opaque = false,
): GeometryData | null {
  // Seen through a transform that collapses the plane, lines cover nothing.
  if (a * d - b * c === 0) {
    return null;
  }

  const built = build(layer, a, b, c, d, least, builder, by, opaque);
  // Once more where libtess2 trapped: the builder's next instance fills the outlines by the bands.
  return built !== undefined
    ? built
    : (build(layer, a, b, c, d, least, builder, by, opaque) ?? null);
}

/** The layer packed into the builder's input and built: undefined where it did not build it. */
function build(
  layer: ShapeLayer,
  a: number,
  b: number,
  c: number,
  d: number,
  least: number,
  builder: LineBuilder,
  by: readonly number[] | null,
  opaque: boolean,
): GeometryData | null | undefined {
  let size = 6;
  for (const { paths } of layer.strokes) {
    size += 7;
    for (const path of paths) {
      size += 5 + path.length;
    }
  }

  const input = builder.input(size);
  if (!input) {
    return undefined;
  }

  input[0] = a;
  input[1] = b;
  input[2] = c;
  input[3] = d;
  // `least` is a pixel of the screen, in the stage's pixels the lines are drawn in.
  input[4] = (by ? STROKE_FLATNESS / 2 : STROKE_FLATNESS) * least;
  input[5] = layer.strokes.length;
  let at = 6;
  for (const { line, paths, closes, triangles } of layer.strokes) {
    input[at] = by
      ? strokeWidth(line, by[0], by[1], by[2], by[3], least) / 2
      : strokeWidth(line, a, b, c, d, least) / 2;
    // Codes a SWF reserves draw round.
    input[at + 1] = line.startCap <= 2 ? line.startCap : 0;
    input[at + 2] = line.join <= 2 ? line.join : 0;
    input[at + 3] = Math.max(1, line.miterLimit);
    input[at + 4] = vertexColor(line.color);
    input[at + 5] =
      (opaque && line.color >>> 24 === 255 ? OVERLAPS : 0) | (triangles ? TOGETHER : 0);
    input[at + 6] = paths.length;
    at += 7;
    // Each path as strokePaths gives it.
    let next = 0;
    for (let i = 0; i < paths.length; i++) {
      const path = paths[i];
      const close = closes?.[next]?.at === i ? closes[next++] : null;
      const home = Boolean(triangles) || (close?.x === path[1] && close.y === path[2]);
      const extra = close && !home;
      input[at] = home ? 1 : 0;
      input[at + 1] = path.length + (extra ? 3 : 0);
      input.set(path, at + 2);
      at += 2 + path.length;
      if (extra) {
        input[at] = LINE;
        input[at + 1] = close.x;
        input[at + 2] = close.y;
        at += 3;
      }
    }
  }

  return builder.build(at);
}
