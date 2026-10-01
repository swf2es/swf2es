// What a Graphics draws, recorded as the layers of fills and strokes a SWF
// shape is read into (shapes.ts), so that the renderer draws both alike.
// A fill or a stroke is a layer of its own, in the order begun, as Flash
// draws them: commands go to the fill and the stroke open at the time, each
// moveTo starting a contour of the fill and a path of the stroke.
import type { Fill, Line } from "@swf2es/format";
import { type Rect, union } from "./geometry.js";
import {
  CUBIC,
  CURVE,
  extent,
  LINE,
  MOVE,
  type Path,
  type ShapeLayer,
  type Winding,
} from "./shapes.js";

const TWIPS = 20;
/** The quadratic approximation of a quarter ellipse Flash's drawRoundRect uses: two curves, meeting at 45°. */
const TAN_22_5 = Math.SQRT2 - 1;
const COS_45 = Math.SQRT1_2;

export class Drawing {
  readonly layers: ShapeLayer[] = [];
  private fill: { fill: Fill; contours: Path[]; winding: Winding } | null = null;
  /** The layer the open fill is in, for the entries a change of winding adds beside it. */
  private fillLayer: ShapeLayer | null = null;
  private stroke: { line: Line; paths: Path[] } | null = null;
  private x = 0;
  private y = 0;

  beginFill(fill: Fill): void {
    this.endFill();
    this.fill = { fill, contours: [], winding: "evenOdd" };
    this.fillLayer = { fills: [this.fill], strokes: [] };
    this.layers.push(this.fillLayer);
    this.begin(this.fill.contours);
  }

  endFill(): void {
    this.fill = null;
    this.fillLayer = null;
  }

  /** A stroke from here on with `line`, or none for null; the one before it ends either way. */
  lineStyle(line: Line | null): void {
    this.stroke = line ? { line, paths: [] } : null;
    if (this.stroke) {
      this.layers.push({ fills: [], strokes: [this.stroke] });
      this.begin(this.stroke.paths);
    }
  }

  moveTo(x: number, y: number): void {
    this.x = x;
    this.y = y;
    if (this.fill) {
      this.begin(this.fill.contours);
    }

    if (this.stroke) {
      this.begin(this.stroke.paths);
    }
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
   * own beside the fill's, with the same fill.
   */
  drawPath(commands: number[], data: number[], winding: Winding): void {
    if (this.fill && this.fillLayer && this.fill.winding !== winding) {
      if (this.fill.contours.some((c) => c.length > 3)) {
        this.fill = { fill: this.fill.fill, contours: [], winding };
        this.fillLayer.fills.push(this.fill);
        this.begin(this.fill.contours);
      } else {
        this.fill.winding = winding;
      }
    }

    let i = 0;
    for (const command of commands) {
      switch (command) {
        case 1:
          this.moveTo(data[i], data[i + 1]);
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
          this.moveTo(data[i + 2], data[i + 3]);
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

  clear(): void {
    this.layers.length = 0;
    this.fill = null;
    this.fillLayer = null;
    this.stroke = null;
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
        strokes: layer.strokes.map((s) => ({ line: s.line, paths: s.paths.map((c) => c.slice()) })),
      });
    }
  }

  /** The drawing's extent, in pixels, curves at their true extremes; the lines' paths count, and with `lines` their half widths too. */
  bounds(lines: boolean): Rect | null {
    let r: Rect | null = null;
    const take = (path: Path, pad: number) => {
      const e = extent(path);
      if (e) {
        r = union(r, { xMin: e[0] - pad, yMin: e[1] - pad, xMax: e[2] + pad, yMax: e[3] + pad });
      }
    };
    for (const layer of this.layers) {
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

    return r;
  }

  /** A contour or stroke path begins at the pen. */
  private begin(paths: Path[]): void {
    paths.push([MOVE, this.x, this.y]);
  }

  private command(kind: number, points: number[]): void {
    for (const paths of [this.fill?.contours, this.stroke?.paths]) {
      if (paths) {
        paths[paths.length - 1].push(kind, ...points);
      }
    }

    this.x = points[points.length - 2];
    this.y = points[points.length - 1];
  }
}
