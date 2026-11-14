// A shape layer's lines as the renderer of swf2es's own keeps them: stroked
// by the tessellator's line builder (strokes.ts) for each transform a layer
// is seen through, found again
// by a hash of the transform's numbers, and kept while the geometries keep
// them, within a budget of vertices for those not drawn lately. A layer
// with a line filled with a paint is kept in pieces (LinePiece).
import { type Geometries, type GeometryHandle, IDLE_FRAMES } from "@swf2es/render";
import type { ShapeLayer } from "../display/shapes.js";
import { evenWidth, scalesEvenly } from "../display/stretch.js";
import { same } from "../display/value-lists.js";
import type { FillTessellator } from "./fills.js";
import { type Part, strokePart } from "./shapes.js";
import { layerStrokes } from "./strokes.js";

/**
 * The vertices kept lines may hold before those drawn neither this frame
 * nor the last go, the least lately drawn first: a layer seen through ever
 * new transforms, as a zoom shows it, would otherwise keep each for the
 * geometries' idle frames. Past it with nothing idle, it grows to half
 * again what is drawn, and comes back down as less is.
 */
const LINE_VERTICES = 1_000_000;

/**
 * How often, in frames, the kept lines are looked over whatever they hold:
 * those the geometries let go of, and those that stroked to nothing, add
 * no vertices that would bring the budget on.
 */
const SWEEP_FRAMES = 60;

/** The bits of a number, read as two ints, for mixHash. */
const hashFloat = new Float64Array(1);
const hashInts = new Int32Array(hashFloat.buffer);

/** `h` mixed with the bits of `x`, zero's two signs alike and every NaN, as same() takes them. */
function mixHash(h: number, x: number): number {
  hashFloat[0] = x === 0 ? 0 : Number.isNaN(x) ? Number.NaN : x;
  return Math.imul(Math.imul(h ^ hashInts[0], 0x9e3779b1) ^ hashInts[1], 0x85ebca6b);
}

/**
 * A layer's lines as of its drawing's `version`: whether they all scale
 * both ways (scalesEvenly), what the layer brings to its object's settled
 * stretch (evenWidth), whether any of a colour is of whole alpha, whether
 * any is filled with a paint, and their entries by their key's hash.
 */
export interface LayerLines {
  version: number;
  even: boolean;
  width: number;
  whole: boolean;
  painted: boolean;
  byHash: Map<number, LineEntry[]>;
}

/**
 * A part of a painted layer's lines, drawn in order: each run of lines of
 * a colour, and each line of a paint, textured (strokePart).
 */
export interface LinePiece {
  part: Part;
  handle: GeometryHandle;
}

/**
 * A layer's lines as stroked through the linear transform (a b c d), at
 * least `least` wide, as wide as `by` makes them (a 9-slice's line space)
 * or null; their geometry, and the drawing's version they were made for.
 */
interface LineEntry {
  a: number;
  b: number;
  c: number;
  d: number;
  least: number;
  by: number[] | null;
  /** Drawn at whole alpha, where lines of whole alpha may overlap themselves (layerStrokes). */
  opaque: boolean;
  /** The lines' geometry, or for a painted layer null and its pieces. */
  handle: GeometryHandle | null;
  pieces: LinePiece[] | null;
  version: number;
  /**
   * Its layer's lines and its key's hash there, which hold no layer; its
   * vertices, -1 once forgotten; and the frame it was last drawn.
   */
  within: LayerLines;
  hash: number;
  vertices: number;
  usedAt: number;
}

/** Each shape layer's lines, by the transform they are stroked through (take). */
export class LineCache {
  /**
   * Lines stroked anew and lines found stroked already, which the bench and the draw counts read.
   */
  readonly counts = { strokeContexts: 0, strokeReuses: 0 };
  private readonly byLayer = new WeakMap<ShapeLayer, LayerLines>();
  /** Every entry, and the vertices they hold. */
  private readonly entries: LineEntry[] = [];
  private vertices = 0;
  private limit: number;
  /** The frame the entries were last looked over. */
  private swept = 0;

  constructor(
    private readonly geometries: Geometries,
    private readonly tessellator: FillTessellator,
    private readonly budget = LINE_VERTICES,
  ) {
    this.limit = budget;
  }

  /** How many transforms' lines are kept, of every layer. */
  get kept(): number {
    return this.entries.length;
  }

  /** `layer`'s lines as of its drawing's `version`, what is known of them worked out again for another. */
  of(layer: ShapeLayer, version: number): LayerLines {
    let lines = this.byLayer.get(layer);
    if (!lines) {
      lines = {
        version: -1,
        even: false,
        width: 0,
        whole: false,
        painted: false,
        byHash: new Map(),
      };
      this.byLayer.set(layer, lines);
    }

    if (lines.version !== version) {
      lines.version = version;
      lines.even = scalesEvenly(layer);
      lines.width = evenWidth(layer);
      lines.whole = false;
      lines.painted = false;
      for (let i = 0; i < layer.strokes.length; i++) {
        const stroke = layer.strokes[i];
        if (stroke.paint) {
          lines.painted = true;
        } else if (stroke.line.color >>> 24 === 255) {
          lines.whole = true;
        }
      }
    }

    return lines;
  }

  /**
   * `layer`'s lines through the linear transform (a b c d), at least `least`
   * wide, drawn opaque or not: stroked again for another transform, screen
   * or version of its drawing, the old ones kept while drawn as the
   * geometries keep them. A layer of no painted line (LayerLines' painted).
   */
  take(
    layer: ShapeLayer,
    version: number,
    a: number,
    b: number,
    c: number,
    d: number,
    least: number,
    by: readonly number[] | null,
    drawnOpaque: boolean,
  ): GeometryHandle | null {
    return this.entry(layer, version, a, b, c, d, least, by, drawnOpaque)?.handle ?? null;
  }

  /** As take, a painted layer's lines in their pieces, in order; null for none. */
  pieces(
    layer: ShapeLayer,
    version: number,
    a: number,
    b: number,
    c: number,
    d: number,
    least: number,
    by: readonly number[] | null,
    drawnOpaque: boolean,
  ): readonly LinePiece[] | null {
    return this.entry(layer, version, a, b, c, d, least, by, drawnOpaque)?.pieces ?? null;
  }

  /** The entry take and pieces read, stroked if it was not, or its geometries were let go of. */
  private entry(
    layer: ShapeLayer,
    version: number,
    a: number,
    b: number,
    c: number,
    d: number,
    least: number,
    by: readonly number[] | null,
    drawnOpaque: boolean,
  ): LineEntry | null {
    const frame = this.geometries.frame;
    if (frame - this.swept >= SWEEP_FRAMES) {
      this.trim(frame);
    }

    const lines = this.of(layer, version);
    // Only a line of whole alpha draws otherwise when opaque (layerStrokes): a layer of none keeps
    // one geometry through a fade.
    const opaque = drawnOpaque && lines.whole;
    // Found by a hash of the key's numbers, compared as numbers: a layer seen by many instances
    // keeps a transform for each, and a key formatted on every frame cost more than drawing it.
    let hash = mixHash(mixHash(mixHash(mixHash(mixHash(opaque ? 1 : 0, a), b), c), d), least);
    if (by) {
      hash = mixHash(mixHash(mixHash(mixHash(hash, by[0]), by[1]), by[2]), by[3]);
    }

    let bucket = lines.byHash.get(hash);
    let known: LineEntry | null = null;
    for (let i = 0; bucket && i < bucket.length; i++) {
      const e = bucket[i];
      if (
        same(e.a, a) &&
        same(e.b, b) &&
        same(e.c, c) &&
        same(e.d, d) &&
        same(e.least, least) &&
        e.opaque === opaque &&
        (e.by === null
          ? by === null
          : by !== null &&
            same(e.by[0], by[0]) &&
            same(e.by[1], by[1]) &&
            same(e.by[2], by[2]) &&
            same(e.by[3], by[3]))
      ) {
        known = e;
        break;
      }
    }

    if (known && known.version === version && this.alive(known)) {
      known.usedAt = frame;
      this.counts.strokeReuses++;
      return known;
    }

    if (known) {
      this.release(known);
    }

    this.counts.strokeContexts++;
    let handle: GeometryHandle | null = null;
    let pieces: LinePiece[] | null = null;
    let vertices = 0;
    if (lines.painted) {
      pieces = this.paintedPieces(layer, a, b, c, d, least, by, opaque) ?? null;
      // Not built, as where no instance could be made: none kept, so that a later frame asks again.
      if (!pieces) {
        return null;
      }

      for (const piece of pieces) {
        vertices += piece.part.geometry.positions.length / 2;
      }
    } else {
      const data = layerStrokes(layer, a, b, c, d, least, this.tessellator.lines, by, opaque);
      // As for the pieces.
      if (data === undefined) {
        return null;
      }

      handle = data ? this.geometries.add(data) : null;
      vertices = data ? data.positions.length / 2 : 0;
    }

    if (known) {
      this.vertices += vertices - known.vertices;
      known.handle = handle;
      known.pieces = pieces;
      known.version = version;
      known.vertices = vertices;
      known.usedAt = frame;
    } else {
      if (!bucket) {
        bucket = [];
        lines.byHash.set(hash, bucket);
      }

      const entry: LineEntry = {
        a,
        b,
        c,
        d,
        least,
        by: by ? [by[0], by[1], by[2], by[3]] : null,
        opaque,
        handle,
        pieces,
        version,
        within: lines,
        hash,
        vertices,
        usedAt: frame,
      };
      bucket.push(entry);
      this.entries.push(entry);
      this.vertices += vertices;
      known = entry;
    }

    if (this.vertices > this.limit) {
      this.trim(frame);
    }

    return known;
  }

  /**
   * A painted layer's lines as its pieces, in order: each run of lines of
   * a colour built together, each painted line alone and textured. Undefined
   * where the builder built none, which a later frame may try again.
   */
  private paintedPieces(
    layer: ShapeLayer,
    a: number,
    b: number,
    c: number,
    d: number,
    least: number,
    by: readonly number[] | null,
    opaque: boolean,
  ): LinePiece[] | undefined {
    const strokes = layer.strokes;
    const builder = this.tessellator.lines;
    const pieces: LinePiece[] = [];
    for (let from = 0; from < strokes.length; ) {
      const paint = strokes[from].paint;
      let to = from + 1;
      while (!paint && to < strokes.length && !strokes[to].paint) {
        to++;
      }

      const data = layerStrokes(layer, a, b, c, d, least, builder, by, opaque, from, to);
      if (data === undefined) {
        for (const piece of pieces) {
          this.geometries.remove(piece.handle.id);
        }

        return undefined;
      }

      const part: Part | null = !data
        ? null
        : paint
          ? strokePart(data, a, b, c, d, paint)
          : { geometry: data, paint: null, region: null, mesh: null };
      if (part) {
        pieces.push({ part, handle: this.geometries.add(part.geometry) });
      }

      from = to;
    }

    return pieces;
  }

  /** Whether `e` holds geometries. */
  private holds(e: LineEntry): boolean {
    return e.handle !== null || (e.pieces !== null && e.pieces.length > 0);
  }

  /** Whether every geometry `e` holds is kept still. */
  private alive(e: LineEntry): boolean {
    if (e.handle) {
      return this.geometries.alive(e.handle);
    }

    for (let i = 0; e.pieces && i < e.pieces.length; i++) {
      if (!this.geometries.alive(e.pieces[i].handle)) {
        return false;
      }
    }

    return true;
  }

  /** The geometries `e` holds let go of, those still kept. */
  private release(e: LineEntry): void {
    if (e.handle && this.geometries.alive(e.handle)) {
      this.geometries.remove(e.handle.id);
    }

    for (const piece of e.pieces ?? []) {
      if (this.geometries.alive(piece.handle)) {
        this.geometries.remove(piece.handle.id);
      }
    }
  }

  /**
   * The kept lines looked over: those the geometries let go of, or that
   * stroked to nothing and went undrawn for their idle frames, forgotten;
   * then, past three quarters of the budget, those drawn neither in this
   * `frame` nor the last let go of, the least lately drawn first; the limit
   * set to half again what is left, the budget at least.
   */
  private trim(frame: number): void {
    this.swept = frame;
    const entries = this.entries;
    const most = (this.budget * 3) / 4;
    let kept = 0;
    for (const e of entries) {
      if (this.holds(e) ? this.alive(e) : frame - e.usedAt <= IDLE_FRAMES) {
        entries[kept++] = e;
      } else {
        // A piece of a painted layer's may be kept still where another was let go of.
        this.release(e);
        this.forget(e);
      }
    }

    entries.length = kept;
    if (this.vertices > most) {
      // Mid-walk, those drawn last frame may yet be drawn in this one.
      const idle = entries.filter((e) => e.usedAt < frame - 1).sort((x, y) => x.usedAt - y.usedAt);
      for (let i = 0; i < idle.length && this.vertices > most; i++) {
        this.release(idle[i]);
        this.forget(idle[i]);
      }

      kept = 0;
      for (const e of entries) {
        if (e.vertices >= 0) {
          entries[kept++] = e;
        }
      }

      entries.length = kept;
    }

    this.limit = Math.max(this.budget, this.vertices * 1.5);
  }

  /** `layer`'s lines let go of, as its drawing draws it no more: the next sweep forgets them. */
  drop(layer: ShapeLayer): void {
    for (const bucket of this.byLayer.get(layer)?.byHash.values() ?? []) {
      for (const e of bucket) {
        this.release(e);
      }
    }
  }

  /** Line entry `e` taken out of its layer's lines, its vertices no longer counted. */
  private forget(e: LineEntry): void {
    const bucket = e.within.byHash.get(e.hash);
    const at = bucket ? bucket.indexOf(e) : -1;
    if (bucket && at >= 0) {
      bucket.splice(at, 1);
      if (bucket.length === 0) {
        e.within.byHash.delete(e.hash);
      }
    }

    this.vertices -= e.vertices;
    e.vertices = -1;
  }
}
