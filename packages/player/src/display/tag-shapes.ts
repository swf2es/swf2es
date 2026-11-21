// A DefineShape's character: its layers drawn from its tag when first asked
// for, and their paths let go of again once nothing has read them for a
// while (PATHS_IDLE_FRAMES), to be read from the tag again when next asked
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
  type ShapeBounds,
  type ShapeLayer,
  shapeLayers,
  type Winding,
} from "./shapes.js";
import type { BitmapCharacter, ShapeCharacter } from "./timeline.js";

/**
 * Frames a shape's paths stand unread before they are let go of: past a
 * shape's first draw, only lines stroked at a new scale, a hit test, a
 * geometry expired or lost, or readGraphicsData read them again, and each
 * of those that goes on, as a zoom or a pointer resting on a button does,
 * reads them on every frame.
 */
export const PATHS_IDLE_FRAMES = 120;

/** Frames between looks for paths gone unread. */
const SWEEP_FRAMES = 30;

/** Frames played or drawn, by every player on the page (pathsFramePassed). */
let frames = 0;

/** The shapes holding their paths, which a sweep looks over: weakly, as an unloaded SWF's go. */
const holding = new Set<WeakRef<TagShape>>();

/** A frame drawn, or played and not drawn: every SWEEP_FRAMES, paths unread for long let go of. */
export function pathsFramePassed(): void {
  frames++;
  if (frames % SWEEP_FRAMES !== 0) {
    return;
  }

  for (const ref of holding) {
    const shape = ref.deref();
    if (!shape) {
      holding.delete(ref);
    } else if (frames - shape.readAt >= PATHS_IDLE_FRAMES) {
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

  constructor(
    readonly line: ShapeLayer["strokes"][number]["line"],
    readonly paint: LinePaint | undefined,
    shape: TagShape,
    slot: number,
  ) {
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
  /** The frame its paths were last read on. */
  readAt = 0;
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
    this.hold(paths);
    return this.layered;
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
    this.readAt = frames;
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
    this.readAt = frames;
    holding.add(this.weak);
  }
}
