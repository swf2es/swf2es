// What a Graphics draws, recorded as the layers of fills and strokes a SWF
// shape is read into (shapes.ts), so that the renderer draws both alike.
// Commands go to the fill and the stroke open at the time, each moveTo
// starting a contour of the fill and a path of the stroke. As Flash draws
// them, each fill begins a layer, and the lines drawn from then until the
// next fill begins go in it, over that fill and under the next: a line
// open at beginFill goes on in the new layer, and one drawn after endFill
// stays above the fill before it. A fill's contour left open is closed with
// a line in the line style of the time, as Flash closes it, kept apart from
// the paths (shapes.ts' Close): a line drawn on after endFill takes it away
// again, as in Flash, and bounds and hit tests leave it out.
import type { Line } from "@swf2es/format";
import { BitmapStore } from "../bitmap/bitmap.js";
import { type Rect, union } from "./geometry.js";
import {
  type Close,
  type Contour,
  CUBIC,
  CURVE,
  extent,
  LINE,
  MOVE,
  type Paint,
  type Path,
  type ShapeLayer,
  type TriangleParts,
  type Winding,
} from "./shapes.js";

type Stroke = ShapeLayer["strokes"][number];

const TWIPS = 20;
/** The quadratic approximation of a quarter ellipse Flash's drawRoundRect uses: two curves, meeting at 45°. */
const TAN_22_5 = Math.SQRT2 - 1;
const COS_45 = Math.SQRT1_2;

export class Drawing {
  readonly layers: ShapeLayer[] = [];
  /** Counts the changes to `layers`, which change in place: what is kept of them goes by it. */
  version = 0;
  /** The bounds without lines and with them, as of a version: a 9-slice's owner asks on every change. */
  private kept: [
    { version: number; r: Rect | null } | null,
    { version: number; r: Rect | null } | null,
  ] = [null, null];
  private fill: { fill: Paint; contours: Path[]; winding: Winding } | null = null;
  /** The layer the open fill is in, for the entries a change of winding adds beside it. */
  private fillLayer: ShapeLayer | null = null;
  private stroke: Stroke | null = null;
  /** The line closing the open contour, or the one endFill closed, while a line drawn on may take it away. */
  private closing: { stroke: Stroke; close: Close } | null = null;
  /** A point of the open contour off its start, for whether it leaves the line through them. */
  private toward: [number, number] | null = null;
  /** Whether the open contour has an area: one along a line has no closing line, which would retrace it. */
  private bent = false;
  /** Whether drawPath drew the open contour, which Flash never closes with a line. */
  private pathed = false;
  /** The layer the fill and line went on in after drawTriangles, which endFill drops while empty. */
  private resumed: ShapeLayer | null = null;
  /**
   * Whether a drawTriangles culled: what it draws then depends on whether
   * a transform turns the drawing over.
   */
  culled = false;
  private x = 0;
  private y = 0;

  beginFill(fill: Paint): void {
    this.endFill();
    this.closing = null;
    this.pathed = false;
    const line = this.stroke?.line;
    this.dropStroke();
    this.fill = { fill, contours: [], winding: "evenOdd" };
    this.fillLayer = { fills: [this.fill], strokes: [] };
    this.layers.push(this.fillLayer);
    this.beginContour();
    if (line) {
      this.stroke = { line, paths: [] };
      this.fillLayer.strokes.push(this.stroke);
      this.begin(this.stroke.paths);
    }
  }

  /** The closing line stays till what comes next: a line on from the pen takes it away. */
  endFill(): void {
    const layer = this.fillLayer;
    this.fill = null;
    this.fillLayer = null;
    if (layer && layer === this.resumed) {
      this.dropEmpty(layer);
    }

    this.resumed = null;
  }

  /** `layer` taken away if it is the last and draws nothing yet: an empty layer would be a Graphics drawing nothing. */
  private dropEmpty(layer: ShapeLayer): void {
    if (
      layer === this.layers[this.layers.length - 1] &&
      !layer.strokes.length &&
      !layer.meshes &&
      !layer.extent &&
      layer.fills.every((f) => f.contours.every((c) => c.length <= 3))
    ) {
      this.layers.pop();
      this.version++;
    }
  }

  /** A stroke from here on with `line`, or none for null; the one before it ends either way. */
  lineStyle(line: Line | null): void {
    // The open contour's closing line goes to the new style; one endFill closed stays.
    if (this.fill) {
      this.unclose();
    }

    this.closing = null;
    this.dropStroke();
    this.stroke = line ? { line, paths: [] } : null;
    if (!this.stroke) {
      return;
    }

    let layer = this.layers[this.layers.length - 1];
    if (!layer) {
      layer = { fills: [], strokes: [] };
      this.layers.push(layer);
    }

    layer.strokes.push(this.stroke);
    this.begin(this.stroke.paths);
    this.reclose();
  }

  moveTo(x: number, y: number): void {
    this.pathed = false;
    this.move(x, y);
  }

  lineTo(x: number, y: number): void {
    this.command(LINE, [x, y]);
  }

  curveTo(cx: number, cy: number, x: number, y: number): void {
    this.command(CURVE, [cx, cy, x, y]);
  }

  cubicCurveTo(c1x: number, c1y: number, c2x: number, c2y: number, x: number, y: number): void {
    this.command(CUBIC, [c1x, c1y, c2x, c2y, x, y]);
  }

  drawRect(x: number, y: number, w: number, h: number): void {
    this.moveTo(x, y);
    this.lineTo(x + w, y);
    this.lineTo(x + w, y + h);
    this.lineTo(x, y + h);
    this.lineTo(x, y);
  }

  /** Corners of radii `rx`, `ry` (the ellipse's half width and height), clamped to the rectangle, two quadratics each. */
  drawRoundRect(x: number, y: number, w: number, h: number, ew: number, eh: number): void {
    const rx = Math.min(Math.abs(ew) / 2, Math.abs(w) / 2);
    const ry = Math.min(Math.abs(eh) / 2, Math.abs(h) / 2);
    this.drawRoundRectComplex(x, y, w, h, [rx, ry], [rx, ry], [rx, ry], [rx, ry]);
  }

  /** Each corner its own radii: top left, top right, bottom left, bottom right; from the right edge's end, clockwise. */
  drawRoundRectComplex(
    x: number,
    y: number,
    w: number,
    h: number,
    tl: [number, number],
    tr: [number, number],
    bl: [number, number],
    br: [number, number],
  ): void {
    const right = x + w;
    const bottom = y + h;
    this.moveTo(right, bottom - br[1]);
    this.arc(right - br[0], bottom - br[1], br[0], br[1], 0);
    this.lineTo(x + bl[0], bottom);
    this.arc(x + bl[0], bottom - bl[1], bl[0], bl[1], 1);
    this.lineTo(x, y + tl[1]);
    this.arc(x + tl[0], y + tl[1], tl[0], tl[1], 2);
    this.lineTo(right - tr[0], y);
    this.arc(right - tr[0], y + tr[1], tr[0], tr[1], 3);
    this.lineTo(right, bottom - br[1]);
  }

  /**
   * A quarter ellipse about (`cx`, `cy`) of radii `rx`, `ry`, from the pen,
   * as two quadratics meeting at 45°: `quarter` 0 goes from the right (1, 0)
   * down to the bottom (0, 1), and each next one on clockwise.
   */
  private arc(cx: number, cy: number, rx: number, ry: number, quarter: number): void {
    // A square corner is no curve, as Flash records none.
    if (rx === 0 && ry === 0) {
      return;
    }

    const [sx, sy, ex, ey] = [
      [1, 0, 0, 1],
      [0, 1, -1, 0],
      [-1, 0, 0, -1],
      [0, -1, 1, 0],
    ][quarter];
    this.curveTo(
      cx + (sx + ex * TAN_22_5) * rx,
      cy + (sy + ey * TAN_22_5) * ry,
      cx + (sx + ex) * COS_45 * rx,
      cy + (sy + ey) * COS_45 * ry,
    );
    this.curveTo(
      cx + (ex + sx * TAN_22_5) * rx,
      cy + (ey + sy * TAN_22_5) * ry,
      cx + ex * rx,
      cy + ey * ry,
    );
  }

  /**
   * Flash's drawPath: 1 moveTo, 2 lineTo, 3 curveTo, 4 wideMoveTo, 5
   * wideLineTo, 6 cubicCurveTo, each taking its data. The winding is this
   * path's: a fill drawn with one rule and then another keeps each path's,
   * as Flash does, so the contours from here on go in an entry of their
   * own beside the fill's, with the same fill. Its first contour begins at
   * the pen, and none it draws is closed with a line, as in Flash.
   */
  drawPath(commands: number[], data: number[], winding: Winding): void {
    this.version++;
    if (this.fill && this.fillLayer && this.fill.winding !== winding) {
      if (this.fill.contours.some((c) => c.length > 3)) {
        this.fill = { fill: this.fill.fill, contours: [], winding };
        this.fillLayer.fills.push(this.fill);
      } else {
        this.fill.winding = winding;
      }
    }

    // A contour of its own from the pen, as in Flash, which closes the one before it.
    this.move(this.x, this.y);
    this.pathed = true;

    let i = 0;
    for (const command of commands) {
      switch (command) {
        case 1:
          this.move(data[i], data[i + 1]);
          i += 2;
          break;
        case 2:
          this.lineTo(data[i], data[i + 1]);
          i += 2;
          break;
        case 3:
          this.curveTo(data[i], data[i + 1], data[i + 2], data[i + 3]);
          i += 4;
          break;
        case 4:
          this.move(data[i + 2], data[i + 3]);
          i += 4;
          break;
        case 5:
          this.lineTo(data[i + 2], data[i + 3]);
          i += 4;
          break;
        case 6:
          this.cubicCurveTo(
            data[i],
            data[i + 1],
            data[i + 2],
            data[i + 3],
            data[i + 4],
            data[i + 5],
          );
          i += 6;
          break;
        default:
          break;
      }
    }
  }

  /**
   * drawTriangles' triangles, as adl draws them: `vertices` x y in pixels,
   * three a triangle by `indices` or in order, up to the first index past
   * them. They go in a layer of their own, each triangle a fill of its own,
   * so that overlapping ones never cancel, and the line around each over
   * them all. They end the open fill's contour, whose closing line stays,
   * and the line's path; both go on from the pen, which stays, in a layer
   * after them, the contour still closing to where it began. With `uvt`, u
   * v t a vertex, only a bitmap fill draws them, textured; any other fill
   * draws nothing, lines neither. `cull` 1 drops those clockwise on a
   * y-down screen, -1 the others; the bounds count all.
   */
  drawTriangles(
    vertices: number[],
    indices: number[] | null,
    uvt: number[] | null,
    cull: number,
  ): void {
    const n = vertices.length >> 1;
    const count = indices ? Math.floor(indices.length / 3) : Math.floor(n / 3);
    const kept: number[] = [];
    // Those culled, which a transform that turns the drawing over draws in their place.
    const other: number[] = [];
    const e: [number, number, number, number, number] = [
      Infinity,
      Infinity,
      -Infinity,
      -Infinity,
      this.stroke ? Math.max(this.stroke.line.width / TWIPS, 1) / 2 : 0,
    ];
    // Scalars, no arrays a triangle: a 3D engine draws thousands of them anew every frame.
    for (let k = 0; k < count * 3; k += 3) {
      const a = indices ? indices[k] : k;
      const b = indices ? indices[k + 1] : k + 1;
      const c = indices ? indices[k + 2] : k + 2;
      if (!(a >= 0 && a < n && b >= 0 && b < n && c >= 0 && c < n)) {
        break;
      }

      const x0 = vertices[2 * a];
      const y0 = vertices[2 * a + 1];
      const x1 = vertices[2 * b];
      const y1 = vertices[2 * b + 1];
      const x2 = vertices[2 * c];
      const y2 = vertices[2 * c + 1];
      e[0] = Math.min(e[0], x0, x1, x2);
      e[1] = Math.min(e[1], y0, y1, y2);
      e[2] = Math.max(e[2], x0, x1, x2);
      e[3] = Math.max(e[3], y0, y1, y2);
      const turn = cull * ((x1 - x0) * (y2 - y0) - (y1 - y0) * (x2 - x0));
      if (turn <= 0) {
        kept.push(a, b, c);
      }

      if (cull && turn >= 0) {
        other.push(a, b, c);
      }
    }

    if (e[0] > e[2]) {
      return;
    }

    this.version++;
    const fill = this.fill;
    const line = this.stroke?.line ?? null;
    const contour = fill?.contours[fill.contours.length - 1];
    const origin = contour ? [contour[1], contour[2]] : [this.x, this.y];
    // The open contour ends for good, with any closing line it has.
    this.closing = null;
    this.dropStroke();
    if (this.fillLayer) {
      this.dropEmpty(this.fillLayer);
    }

    const paint = fill?.fill;
    const image = paint?.type === "image" && paint.image instanceof BitmapStore ? paint : null;
    const outline = (list: number[], k: number): Path => {
      const a = 2 * list[k];
      const b = 2 * list[k + 1];
      const c = 2 * list[k + 2];
      const x0 = vertices[a];
      const y0 = vertices[a + 1];
      return [
        MOVE,
        x0,
        y0,
        LINE,
        vertices[b],
        vertices[b + 1],
        LINE,
        vertices[c],
        vertices[c + 1],
        LINE,
        x0,
        y0,
      ];
    };
    const parts = (list: number[]): TriangleParts => {
      const out: TriangleParts = { fills: [] };
      if (uvt && image) {
        const positions = new Float32Array(list.length * 2);
        const coordinates = new Float32Array(list.length * 3);
        for (let i = 0; i < list.length; i++) {
          const v = list[i];
          positions[2 * i] = vertices[2 * v];
          positions[2 * i + 1] = vertices[2 * v + 1];
          coordinates[3 * i] = uvt[3 * v];
          coordinates[3 * i + 1] = uvt[3 * v + 1];
          coordinates[3 * i + 2] = uvt[3 * v + 2];
        }

        out.meshes = [
          {
            image: image.image as BitmapStore,
            repeat: image.repeat,
            smooth: image.smooth,
            positions,
            uvt: coordinates,
          },
        ];
      } else if (!uvt && paint) {
        for (let k = 0; k < list.length; k += 3) {
          out.fills.push({ fill: paint, contours: [outline(list, k)], winding: "evenOdd" });
        }
      }

      if (line && (!uvt || image || !paint) && list.length) {
        const paths: Path[] = [];
        for (let k = 0; k < list.length; k += 3) {
          paths.push(outline(list, k));
        }

        out.stroke = { line, paths, triangles: true };
      }

      return out;
    };
    const own = parts(kept);
    const layer: ShapeLayer = {
      fills: own.fills,
      strokes: own.stroke ? [own.stroke] : [],
      extent: e,
    };
    if (own.meshes) {
      layer.meshes = own.meshes;
    }

    if (cull) {
      layer.mirrored = parts(other);
      this.culled = true;
    }

    this.layers.push(layer);

    if (!fill && !line) {
      return;
    }

    const next: ShapeLayer = { fills: [], strokes: [] };
    this.layers.push(next);
    this.resumed = next;
    if (fill) {
      this.fill = { fill: fill.fill, contours: [], winding: fill.winding };
      this.fillLayer = next;
      next.fills.push(this.fill);
      const [ox, oy] = origin;
      const away = ox !== this.x || oy !== this.y;
      this.fill.contours.push(away ? [MOVE, ox, oy, LINE, this.x, this.y] : [MOVE, ox, oy]);
      this.toward = null;
      this.bent = false;
      if (away) {
        this.bend([this.x, this.y]);
      }
    }

    if (line) {
      this.stroke = { line, paths: [] };
      next.strokes.push(this.stroke);
      this.begin(this.stroke.paths);
    }
  }

  clear(): void {
    this.version++;
    this.layers.length = 0;
    this.fill = null;
    this.fillLayer = null;
    this.stroke = null;
    this.closing = null;
    this.pathed = false;
    this.resumed = null;
    this.culled = false;
    this.x = 0;
    this.y = 0;
  }

  /**
   * The other drawing's layers, copied, after this one is cleared: a
   * drawing copied from itself ends empty, as Flash's does (the `draws`
   * case). The styles open there do not come.
   */
  copyFrom(other: Drawing): void {
    this.clear();
    for (const layer of other.layers) {
      this.layers.push({
        fills: layer.fills.map((f) => ({ ...f, contours: f.contours.map((c) => c.slice()) })),
        strokes: layer.strokes.map((s) => ({
          line: s.line,
          paths: s.paths.map((c) => c.slice()),
          closes: s.closes?.map((c) => ({ ...c })),
          triangles: s.triangles,
        })),
        // A mesh's arrays never change once drawn.
        meshes: layer.meshes?.slice(),
        extent: layer.extent,
        // Never changed once drawn.
        mirrored: layer.mirrored,
      });
    }

    this.culled = other.culled;

    this.version++;
  }

  /** The drawing's extent, in pixels, curves at their true extremes; the lines' paths count, and with `lines` their half widths too. */
  bounds(lines: boolean): Rect | null {
    const kept = this.kept[lines ? 1 : 0];
    if (kept?.version === this.version) {
      return kept.r;
    }

    let r: Rect | null = null;
    const take = (path: Contour, pad: number) => {
      const e = extent(path);
      if (e) {
        r = union(r, { xMin: e[0] - pad, yMin: e[1] - pad, xMax: e[2] + pad, yMax: e[3] + pad });
      }
    };
    for (const layer of this.layers) {
      const e = layer.extent;
      if (e) {
        const pad = lines ? e[4] : 0;
        r = union(r, { xMin: e[0] - pad, yMin: e[1] - pad, xMax: e[2] + pad, yMax: e[3] + pad });
      }

      for (const f of layer.fills) {
        for (const c of f.contours) {
          take(c, 0);
        }
      }

      for (const s of layer.strokes) {
        for (const p of s.paths) {
          take(p, lines ? Math.max(s.line.width / TWIPS, 1) / 2 : 0);
        }
      }
    }

    this.kept[lines ? 1 : 0] = { version: this.version, r };
    return r;
  }

  /** The open stroke ends; taken away if it drew nothing, with its layer if that is left empty. */
  private dropStroke(): void {
    const stroke = this.stroke;
    const layer = this.layers[this.layers.length - 1];
    this.stroke = null;
    if (!stroke || !layer || stroke.closes?.length || stroke.paths.some((p) => p.length > 3)) {
      return;
    }

    // Always the layer's last.
    this.version++;
    layer.strokes.pop();
    if (!layer.fills.length && !layer.strokes.length) {
      this.layers.pop();
    }
  }

  /** A move, closing the open contour for good: a fill's contour and a stroke's path begin there. */
  private move(x: number, y: number): void {
    this.closing = null;
    this.x = x;
    this.y = y;
    if (this.fill) {
      this.beginContour();
    }

    if (this.stroke) {
      this.begin(this.stroke.paths);
    }
  }

  private beginContour(): void {
    this.begin((this.fill as { contours: Path[] }).contours);
    this.toward = null;
    this.bent = false;
  }

  /** A contour or stroke path begins at the pen. */
  private begin(paths: Path[]): void {
    this.version++;
    paths.push([MOVE, this.x, this.y]);
  }

  private command(kind: number, points: number[]): void {
    this.version++;
    this.unclose();
    for (const paths of [this.fill?.contours, this.stroke?.paths]) {
      if (paths) {
        paths[paths.length - 1].push(kind, ...points);
      }
    }

    this.x = points[points.length - 2];
    this.y = points[points.length - 1];
    if (this.fill) {
      this.bend(points);
      this.reclose();
    }
  }

  /** Whether the contour's new points, control points too, leave the line it has run along. */
  private bend(points: number[]): void {
    const contour = this.fill?.contours[this.fill.contours.length - 1];
    if (this.bent || !contour) {
      return;
    }

    const [sx, sy] = [contour[1], contour[2]];
    for (let i = 0; i < points.length; i += 2) {
      const dx = points[i] - sx;
      const dy = points[i + 1] - sy;
      if (!this.toward) {
        if (dx || dy) {
          this.toward = [dx, dy];
        }

        continue;
      }

      const [tx, ty] = this.toward;
      if (
        Math.abs(tx * dy - ty * dx) >
        1e-9 * (Math.abs(tx) + Math.abs(ty)) * (Math.abs(dx) + Math.abs(dy))
      ) {
        this.bent = true;
        return;
      }
    }
  }

  /** The closing line taken off, for the contour or the line style to go on. */
  private unclose(): void {
    if (this.closing) {
      this.version++;
      this.closing.stroke.closes?.pop();
      this.closing = null;
    }
  }

  /** The open contour's closing line, from the pen back to its start, on the end of the stroke's path. */
  private reclose(): void {
    const contour = this.fill?.contours[this.fill.contours.length - 1];
    const stroke = this.stroke;
    if (!contour || !stroke || !this.bent || this.pathed) {
      return;
    }

    if (contour[1] !== this.x || contour[2] !== this.y) {
      const close = { at: stroke.paths.length - 1, x: contour[1], y: contour[2] };
      stroke.closes = stroke.closes ?? [];
      stroke.closes.push(close);
      this.closing = { stroke, close };
      this.version++;
    }
  }
}
