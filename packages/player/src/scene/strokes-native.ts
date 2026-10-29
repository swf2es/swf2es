// layerStrokes in one native call: a layer's lines packed as @swf2es/native's
// strokes.zig reads them, built there as strokes.ts builds them, to the last
// bit in V8 (another engine's Math.hypot, atan2 or acos may round its last
// bits otherwise), their outlines filled there by the same libtess2 the
// native tessellator fills them with.
import type { GeometryData } from "@swf2es/render";
import { LINE, type ShapeLayer } from "../display/shapes.js";
import type { LineBuilder } from "./fills.js";
import { vertexColor } from "./shapes.js";
import { STROKE_FLATNESS, strokeWidth } from "./strokes.js";

/** A line's flags in the input: drawn as lineTriangles; its paths' outlines filled as one. */
const OVERLAPS = 1;
const TOGETHER = 2;

/**
 * layerStrokes(layer, a, b, c, d, least, tessellator, by, opaque) by
 * `builder`: undefined where it refused the layer or is unavailable, for
 * layerStrokes to build it.
 */
export function layerStrokesNative(
  layer: ShapeLayer,
  a: number,
  b: number,
  c: number,
  d: number,
  least: number,
  builder: LineBuilder,
  by: readonly number[] | null = null,
  opaque = false,
): GeometryData | null | undefined {
  // Seen through a transform that collapses the plane, lines cover nothing, as in the Pixi view.
  if (a * d - b * c === 0) {
    return null;
  }

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
    // Codes a SWF reserves draw round, as the Pixi view draws them.
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
