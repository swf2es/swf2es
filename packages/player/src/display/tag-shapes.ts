// A DefineShape's character: its layers drawn from its tag when first asked
// for, and their paths let go of again once nothing has read them for a
// while (PATHS_IDLE_MS), to be read from the tag again when next asked
// for. The paths were most of a long session's memory: a SWF's shape drawn
// once kept its parsed paths, hundreds of small arrays, for as long as the
// SWF stayed loaded. The layers themselves, their fills and lines, stay,
// and stay the same objects: the renderer keeps its triangles and its
// stroked lines by them, and a shape drawn on and on without its paths
// read, its geometry kept, must not be tessellated again.
import { readShape } from "@swf2es/format";
import {
  type LinePaint,
  type Paint,
  type Path,
  pointsOf,
  type ShapeBounds,
  type ShapeLayer,
  shapeLayers,
  type Winding,
} from "./shapes.js";
import type { BitmapCharacter, ShapeCharacter } from "./timeline.js";

/**
 * Milliseconds a shape's paths stand unread before they are let go of: past
 * a shape's first draw, only lines stroked at a new scale, a hit test, a
 * geometry expired or lost, scale-9 slicing, or readGraphicsData read them
 * again, and each of those that goes on, as a zoom or a pointer resting on
 * a button does, reads them on every frame. Time, not frames: every player
 * on a page and every extra render pass frames, and a SWF may play at 1
 * frame a second or at 120.
 */
export const PATHS_IDLE_MS = 5000;

/** Milliseconds between looks for paths gone unread. */
const SWEEP_MS = 1000;

/** The clock as of the last frame (pathsFramePassed), which a read stamps its shape with. */
let now = Date.now();
let sweptAt = now;

/** The shapes holding their paths, which a sweep looks over: weakly, as an unloaded SWF's go. */
const holding = new Set<WeakRef<TagShape>>();

/**
 * A frame drawn, or played and not drawn, by any player: the clock read,
 * and every SWEEP_MS the paths unread for PATHS_IDLE_MS let go of. A page
 * that plays no frames, a hidden one, lets none go until it plays again.
 */
export function pathsFramePassed(): void {
  now = Date.now();
  if (now - sweptAt < SWEEP_MS) {
    return;
  }

  sweptAt = now;
  for (const ref of holding) {
    const shape = ref.deref();
    if (!shape) {
      holding.delete(ref);
    } else if (now - shape.readAt >= PATHS_IDLE_MS) {
      shape.release();
      holding.delete(ref);
    }
  }
}

/** How many shapes hold their paths now, for the tests. */
export function shapesHoldingPaths(): number {
  let count = 0;
  for (const ref of holding) {
    if (ref.deref()?.holdsPaths) {
      count++;
    }
  }

  return count;
}

/** A shape's fill, its contours its shape's, read again from the tag where they were let go of. */
class TagFill {
  // Private (#), not own enumerable fields: scale-9 slicing spreads a fill, and tests compare
  // layers as plain objects; neither must copy or see the shape.
  readonly #shape: TagShape;
  readonly #slot: number;

  constructor(
    readonly fill: Paint,
    readonly winding: Winding,
    shape: TagShape,
    slot: number,
  ) {
    this.#shape = shape;
    this.#slot = slot;
  }

  get contours(): Path[] {
    return this.#shape.pathsAt(this.#slot);
  }
}

/** A shape's line, its paths its shape's, as a fill's contours are. */
class TagStroke {
  readonly #shape: TagShape;
  readonly #slot: number;
  // Set only where the line has a paint, as a stroke shapeLayers makes has it.
  declare readonly paint?: LinePaint;

  constructor(
    readonly line: ShapeLayer["strokes"][number]["line"],
    paint: LinePaint | undefined,
    shape: TagShape,
    slot: number,
  ) {
    if (paint) {
      (this as { paint?: LinePaint }).paint = paint;
    }

    this.#shape = shape;
    this.#slot = slot;
  }

  get paths(): Path[] {
    return this.#shape.pathsAt(this.#slot);
  }
}

/**
 * A DefineShape as the library holds it: its tag (`source` from `offset`,
 * `length` bytes, of `code`), and its bitmap fills' bitmaps as its SWF had
 * them when it was read.
 */
export class TagShape implements ShapeCharacter {
  readonly type = "shape";
  /** When its paths were last read, by the clock of the last frame. */
  readAt = 0;
  /**
   * Where its paths' points and control points lie, as xMin, yMin, xMax,
   * yMax, and the most any of its lines reaches past them for a hit test:
   * kept as its paths come and go, so that a test of a point outside reads
   * none of them (outside).
   */
  private extent: Float64Array | null = null;
  private layered: ShapeLayer[] | null = null;
  /** Each fill's contours and each line's paths, in the order of the layers' fills and lines. */
  private paths: Path[][] | null = null;
  private ref: WeakRef<TagShape> | null = null;

  constructor(
    readonly id: number,
    readonly shape: ShapeBounds,
    private readonly source: Uint8Array,
    private readonly code: number,
    private readonly offset: number,
    private readonly length: number,
    private readonly version: number,
    private readonly bitmaps: Map<number, BitmapCharacter | null> | undefined,
  ) {}

  /**
   * Drawn into layers when first asked for, from the tag: most of the shapes a large
   * application's SWFs define are never shown, and their layers were most of its memory.
   */
  get layers(): ShapeLayer[] {
    if (this.layered) {
      return this.layered;
    }

    const bitmaps = this.bitmaps;
    const drawn = shapeLayers(this.read(), (id) => bitmaps?.get(id) ?? null);
    const paths: Path[][] = [];
    this.layered = drawn.map((layer) => ({
      fills: layer.fills.map(
        (f) => new TagFill(f.fill, f.winding, this, paths.push(f.contours) - 1),
      ),
      strokes: layer.strokes.map(
        (s) => new TagStroke(s.line, s.paint, this, paths.push(s.paths) - 1),
      ),
    }));
    this.extent = extentOf(drawn);
    this.hold(paths);
    return this.layered;
  }

  /**
   * Whether (x, y), in pixels, is farther from every path than a hit test
   * finds anything (display/bounds.ts, drawnAt): its paths are not read to
   * tell, as a script's or AVM1's shape test of a container asks of every
   * shape in it, under the point or not. False till its layers are made.
   */
  outside(x: number, y: number): boolean {
    const e = this.extent;
    // Asked as what rules the point out: a NaN rules out nothing, as the full test does.
    return e !== null && (x < e[0] - e[4] || y < e[1] - e[4] || x > e[2] + e[4] || y > e[3] + e[4]);
  }

  /** A weak reference to it, one for every holder that wants one. */
  get weak(): WeakRef<TagShape> {
    this.ref ??= new WeakRef(this);
    return this.ref;
  }

  /** Whether its paths are held now. */
  get holdsPaths(): boolean {
    return this.paths !== null;
  }

  /** The contours or paths of slot `slot`, read from the tag again if they were let go of. */
  pathsAt(slot: number): Path[] {
    this.readAt = now;
    let paths = this.paths;
    if (!paths) {
      // Laid out as the first reading laid them out, which nothing but the tag decides; the
      // paints, which the layers keep, are not wanted again.
      paths = [];
      for (const layer of shapeLayers(this.read())) {
        for (const f of layer.fills) {
          paths.push(f.contours);
        }

        for (const s of layer.strokes) {
          paths.push(s.paths);
        }
      }

      this.hold(paths);
    }

    return paths[slot];
  }

  /** Its paths let go of, read again when next asked for. */
  release(): void {
    this.paths = null;
  }

  private read() {
    return readShape(this.source, this.code, this.offset, this.length, this.version);
  }

  private hold(paths: Path[][]): void {
    this.paths = paths;
    this.readAt = now;
    holding.add(this.weak);
  }
}

/** The box of the layers' points and control points, and the widest half line a hit test takes. */
function extentOf(layers: ShapeLayer[]): Float64Array {
  const e = Float64Array.of(Infinity, Infinity, -Infinity, -Infinity, 0);
  const take = (path: Path): void => {
    for (let i = 0; i < path.length; ) {
      const end = i + 1 + pointsOf(path[i]) * 2;
      for (let k = i + 1; k < end; k += 2) {
        e[0] = Math.min(e[0], path[k]);
        e[1] = Math.min(e[1], path[k + 1]);
        e[2] = Math.max(e[2], path[k]);
        e[3] = Math.max(e[3], path[k + 1]);
      }

      i = end;
    }
  };
  for (const layer of layers) {
    for (const f of layer.fills) {
      for (const contour of f.contours) {
        take(contour);
      }
    }

    for (const s of layer.strokes) {
      // A hit test's half width: half the line, or of a pixel for a hairline (drawnAt).
      e[4] = Math.max(e[4], Math.max(s.line.width / 20, 1) / 2);
      for (const path of s.paths) {
        take(path);
      }
    }
  }

  return e;
}
