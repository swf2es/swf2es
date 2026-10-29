// A shape layer's lines as the renderer of swf2es's own keeps them: stroked
// (scene/strokes.ts) for each transform a layer is seen through, found again
// by a hash of the transform's numbers, and kept while the geometries keep
// them, within a budget of vertices for those not drawn lately.
import { type Geometries, type GeometryHandle, IDLE_FRAMES } from "@swf2es/render";
import type { ShapeLayer } from "../display/shapes.js";
import { same } from "../display/value-lists.js";
import type { FillTessellator } from "./fills.js";
import { layerStrokes } from "./strokes.js";

/**
 * The vertices kept lines may hold before those not drawn this frame go,
 * the least lately drawn first: a layer seen through ever new transforms,
 * as a zoom shows it, would otherwise keep each for the geometries' idle
 * frames. Past it with nothing idle, it grows to half again what is drawn.
 */
export const LINE_VERTICES = 1_000_000;

/** The bits of a number, read as two ints, for mixHash. */
const hashFloat = new Float64Array(1);
const hashInts = new Int32Array(hashFloat.buffer);

/** `h` mixed with the bits of `x`, zero's two signs alike, as same() takes them. */
function mixHash(h: number, x: number): number {
  hashFloat[0] = x === 0 ? 0 : x;
  return Math.imul(Math.imul(h ^ hashInts[0], 0x9e3779b1) ^ hashInts[1], 0x85ebca6b);
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
  handle: GeometryHandle | null;
  version: number;
  /** Its layer, its key's hash there (take), its vertices and the frame it was last drawn. */
  layer: ShapeLayer;
  hash: number;
  vertices: number;
  usedAt: number;
}

/** Each shape layer's lines, by the transform they are stroked through (take). */
export class LineCache {
  /** Lines stroked anew and lines found stroked already, as the Pixi view counts its contexts. */
  readonly counts = { strokeContexts: 0, strokeReuses: 0 };
  /** Each layer's lines by their key's hash, and every entry with the vertices they hold. */
  private readonly byLayer = new WeakMap<ShapeLayer, Map<number, LineEntry[]>>();
  private readonly entries: LineEntry[] = [];
  private vertices = 0;
  private limit: number;

  constructor(
    private readonly geometries: Geometries,
    private readonly tessellator: FillTessellator,
    private readonly budget = LINE_VERTICES,
  ) {
    this.limit = budget;
  }

  /**
   * `layer`'s lines through the linear transform (a b c d), at least `least`
   * wide: stroked again for another transform, screen or version of its
   * drawing, the old ones kept while drawn as the geometries keep them.
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
    // Only a line of whole alpha draws otherwise when opaque (layerStrokes): a layer of none keeps
    // one geometry through a fade.
    let opaque = false;
    for (let i = 0; drawnOpaque && !opaque && i < layer.strokes.length; i++) {
      opaque = layer.strokes[i].line.color >>> 24 === 255;
    }

    let byHash = this.byLayer.get(layer);
    if (!byHash) {
      byHash = new Map();
      this.byLayer.set(layer, byHash);
    }

    // Found by a hash of the key's numbers, compared as numbers: a layer seen by many instances
    // keeps a transform for each, and a key formatted on every frame cost more than drawing it.
    let hash = mixHash(mixHash(mixHash(mixHash(mixHash(opaque ? 1 : 0, a), b), c), d), least);
    if (by) {
      hash = mixHash(mixHash(mixHash(mixHash(hash, by[0]), by[1]), by[2]), by[3]);
    }

    let bucket = byHash.get(hash);
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

    const frame = this.geometries.frame;
    if (
      known &&
      known.version === version &&
      (!known.handle || this.geometries.alive(known.handle))
    ) {
      known.usedAt = frame;
      this.counts.strokeReuses++;
      return known.handle;
    }

    if (known?.handle && this.geometries.alive(known.handle)) {
      this.geometries.remove(known.handle.id);
    }

    this.counts.strokeContexts++;
    const data = layerStrokes(layer, a, b, c, d, least, this.tessellator, by, opaque);
    const handle = data ? this.geometries.add(data) : null;
    const vertices = data ? data.positions.length / 2 : 0;
    if (known) {
      this.vertices += vertices - known.vertices;
      known.handle = handle;
      known.version = version;
      known.vertices = vertices;
      known.usedAt = frame;
    } else {
      if (!bucket) {
        bucket = [];
        byHash.set(hash, bucket);
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
        version,
        layer,
        hash,
        vertices,
        usedAt: frame,
      };
      bucket.push(entry);
      this.entries.push(entry);
      this.vertices += vertices;
    }

    if (this.vertices > this.limit) {
      this.trim(frame);
    }

    return handle;
  }

  /**
   * Kept lines past the limit: those the geometries let go of forgotten,
   * then those drawn neither in this `frame` nor the last let go of, the
   * least lately drawn first, down to three quarters of it; the limit
   * raised to half again what is left where that is more.
   */
  private trim(frame: number): void {
    const entries = this.entries;
    let kept = 0;
    for (const e of entries) {
      if (e.handle ? this.geometries.alive(e.handle) : frame - e.usedAt <= IDLE_FRAMES) {
        entries[kept++] = e;
      } else {
        this.forget(e);
      }
    }

    entries.length = kept;
    if (this.vertices > (this.budget * 3) / 4) {
      // Mid-walk, those drawn last frame may yet be drawn in this one.
      const idle = entries.filter((e) => e.usedAt < frame - 1).sort((x, y) => x.usedAt - y.usedAt);
      for (let i = 0; i < idle.length && this.vertices > (this.budget * 3) / 4; i++) {
        if (idle[i].handle) {
          this.geometries.remove((idle[i].handle as GeometryHandle).id);
        }

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

  /** Line entry `e` taken out of its layer's lines, its vertices no longer counted; -1 marks it. */
  private forget(e: LineEntry): void {
    const bucket = this.byLayer.get(e.layer)?.get(e.hash);
    const at = bucket ? bucket.indexOf(e) : -1;
    if (bucket && at >= 0) {
      bucket.splice(at, 1);
      if (bucket.length === 0) {
        this.byLayer.get(e.layer)?.delete(e.hash);
      }
    }

    this.vertices -= e.vertices;
    e.vertices = -1;
  }
}
