// An experiment: layerStrokes for a layer whose lines all draw opaque, built
// by @swf2es/native/strokes in one call. The layer is packed as root.zig
// reads it, each fill's closing line added as strokePaths adds it.
import type { LineBuilder } from "@swf2es/native/strokes";
import type { GeometryData } from "@swf2es/render";
import type { ShapeLayer } from "../display/shapes.js";
import { LINE } from "../display/shapes.js";
import { vertexColor } from "./shapes.js";
import { strokeWidth } from "./strokes.js";

/** strokes.ts's STROKE_FLATNESS. */
const STROKE_FLATNESS = 0.1;

/**
 * layerStrokes(layer, a, b, c, d, least, _, by, true) by the native
 * builder; undefined where a line is not of whole alpha, which the JS
 * path outlines and tessellates.
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
): GeometryData | null | undefined {
  if (a * d - b * c === 0) {
    return null;
  }

  let size = 6;
  for (const stroke of layer.strokes) {
    if (stroke.line.color >>> 24 !== 255) {
      return undefined;
    }

    size += 6;
    for (const path of stroke.paths) {
      size += 5 + path.length;
    }
  }

  const input = builder.input(size);
  input[0] = a;
  input[1] = b;
  input[2] = c;
  input[3] = d;
  input[4] = (by ? STROKE_FLATNESS / 2 : STROKE_FLATNESS) * least;
  input[5] = layer.strokes.length;
  let at = 6;
  for (const { line, paths, closes, triangles } of layer.strokes) {
    input[at] = by
      ? strokeWidth(line, by[0], by[1], by[2], by[3], least) / 2
      : strokeWidth(line, a, b, c, d, least) / 2;
    input[at + 1] = line.startCap <= 2 ? line.startCap : 0;
    input[at + 2] = line.join <= 2 ? line.join : 0;
    input[at + 3] = Math.max(1, line.miterLimit);
    input[at + 4] = vertexColor(line.color);
    input[at + 5] = paths.length;
    at += 6;
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
