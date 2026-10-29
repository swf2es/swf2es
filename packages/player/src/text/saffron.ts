// What both views draw advanced anti-aliasing (Saffron) from, apart from
// their renderers (render/saffron.ts for the Pixi view, scene/advanced.ts
// for the renderer of swf2es's own): the store of glyphs' outlines as
// segments, x0 y0 x1 y1 a texel, which a shader goes through for each
// pixel; and the quads of a text's glyphs, each vertex its corner and what
// the shader needs of its glyph (GlyphQuads).
import type { Glyph } from "@swf2es/format";
import { CURVE, LINE, MOVE, shapeLayers } from "../display/shapes.js";
import type { CsmTable } from "./csm.js";

/** Most table entries a text's uniforms hold. */
export const ENTRIES = 48;

/**
 * Chords a curve is cut into stray from it by this fraction of the em at
 * most: a 2048th, a hundredth of a pixel at 20 pixels, and few chords.
 */
const TOLERANCE = 2048;

/** Segments to a row of the store's texture. */
export const ROW = 1024;
/** The most segments kept: 16 bytes each, 16 MB. Past it the store starts again. */
export const MOST = ROW * 1024;
/**
 * The most segments a glyph may have: every pixel of its quad goes through
 * them all, so a glyph past this is drawn as normal text is.
 */
export const GLYPH_MOST = 2048;
/**
 * The most a field may ask of the shader, its glyphs' segments times the
 * pixels of their quads: past it, the field is drawn as normal text, so
 * that no SWF has the GPU go through millions of segments a pixel.
 */
export const FIELD_BUDGET = 2 ** 25;

/** Floats a vertex: its position 2, then its origin, glyph, run and colour 4 each. */
export const STRIDE = 18;

/**
 * The glyphs' outlines as segments, in the font's units over 20 (as
 * shapeLayers reads them), each glyph's a run of its own: added as a glyph
 * is first drawn, kept until the store is full, when it starts again. Its
 * `resets` count those, after which every glyph's run is another; its
 * `epoch` moves on with each, and as it grows, for a renderer to upload it
 * whole.
 */
export const store = {
  data: new Float32Array(ROW * 4 * 16),
  used: 0,
  epoch: 0,
  resets: 0,
};

/**
 * Whether a full store may start again as a glyph is reserved: not while
 * the renderer of swf2es's own walks a frame, whose texts drawn before
 * would then name runs let go of; it starts the store again between frames
 * instead, and a text that finds it full meanwhile is drawn as normal text.
 */
let resetsAllowed = true;

export function allowResets(allowed: boolean): void {
  resetsAllowed = allowed;
}

/** A glyph's run of segments and its outline's bounds, in the font's units over 20. */
interface Outline {
  start: number;
  count: number;
  xMin: number;
  yMin: number;
  xMax: number;
  yMax: number;
}

/** What a glyph of more segments than GLYPH_MOST is known by, so that it is not cut again. */
const TOO_MANY: Outline = { start: 0, count: 0, xMin: 0, yMin: 0, xMax: 0, yMax: 0 };

/** Each glyph's outline in the store as it now is; null for an empty one. */
let outlines = new WeakMap<Glyph, Outline | null>();

/** What a view does as the store starts again: the texts drawn from it are drawn again. */
const resets = new Set<() => void>();

/** `listener` told each time the store starts again, until it is taken off. */
export function onSegmentsReset(listener: () => void): () => void {
  resets.add(listener);
  return () => resets.delete(listener);
}

/** Start the store again: every outline is cut again on its next draw. */
export function resetSegments(): void {
  store.used = 0;
  store.epoch++;
  store.resets++;
  outlines = new WeakMap();
  for (const listener of resets) {
    listener();
  }
}

/** The store let go of, back to its first size, as the last view that draws from it goes. */
export function freeSegments(): void {
  resetSegments();
  store.data = new Float32Array(ROW * 4 * 16);
}

/** The views that draw from the store, by which it is kept. */
let holders = 0;

/** The store kept for a view, till the view lets go of it by what this returns: it goes with the last. */
export function holdSegments(): () => void {
  holders++;
  let held = true;
  return () => {
    if (held) {
      held = false;
      holders--;
      if (holders === 0) {
        freeSegments();
      }
    }
  };
}

/** How many segments the store holds, for tests. */
export function segmentsUsed(): number {
  return store.used;
}

/** Room for `count` more segments, the store grown to hold them: false past MOST. */
function room(count: number): boolean {
  const used = store.used;
  if (used + count > MOST) {
    return false;
  }

  if ((used + count) * 4 > store.data.length) {
    let length = store.data.length;
    while ((used + count) * 4 > length) {
      length *= 2;
    }

    const grown = new Float32Array(length);
    grown.set(store.data.subarray(0, used * 4));
    store.data = grown;
    store.epoch++;
  }

  return true;
}

/**
 * A glyph's outline cut into segments, its curves into chords that stray
 * from them by `tolerance` at most, as x0 y0 x1 y1 each.
 */
export function chordsOf(glyph: Glyph, tolerance: number): number[] {
  const shape = {
    id: 0,
    bounds: { xMin: 0, xMax: 0, yMin: 0, yMax: 0 },
    edgeBounds: null,
    fills: [{ type: "solid" as const, color: 0xffffffff }],
    lines: [],
    records: glyph.records,
    truncated: false,
  };
  const layers = shapeLayers(shape);
  const points: number[] = [];
  const contours = layers.length > 0 ? layers[0].fills.flatMap((f) => f.contours) : [];
  for (const path of contours) {
    let x = 0;
    let y = 0;
    let startX = 0;
    let startY = 0;
    for (let i = 0; i < path.length; ) {
      switch (path[i]) {
        case MOVE:
          if (x !== startX || y !== startY) {
            points.push(x, y, startX, startY);
          }

          x = startX = path[i + 1];
          y = startY = path[i + 2];
          i += 3;
          break;
        case LINE:
          points.push(x, y, path[i + 1], path[i + 2]);
          x = path[i + 1];
          y = path[i + 2];
          i += 3;
          break;
        case CURVE: {
          const cx = path[i + 1];
          const cy = path[i + 2];
          const ax = path[i + 3];
          const ay = path[i + 4];
          // A quadratic strays from its chords of a nth of it by |p0 - 2c + p1| / 4n² at most.
          const bend = Math.hypot(x - 2 * cx + ax, y - 2 * cy + ay);
          const n = Math.max(1, Math.min(64, Math.ceil(Math.sqrt(bend / (4 * tolerance)))));
          let px = x;
          let py = y;
          for (let k = 1; k <= n; k++) {
            const t = k / n;
            const u = 1 - t;
            const qx = u * u * x + 2 * u * t * cx + t * t * ax;
            const qy = u * u * y + 2 * u * t * cy + t * t * ay;
            points.push(px, py, qx, qy);
            px = qx;
            py = qy;
          }

          x = ax;
          y = ay;
          i += 5;
          break;
        }
        default:
          // A cubic, which no glyph has.
          i += 7;
      }
    }

    if (x !== startX || y !== startY) {
      points.push(x, y, startX, startY);
    }
  }

  return points;
}

/**
 * A glyph's outline in the store, cut on its first draw: null for an empty
 * glyph, undefined for one of more segments than GLYPH_MOST or past the
 * store's room.
 */
function outlineOf(glyph: Glyph, tolerance: number): Outline | null | undefined {
  const known = outlines.get(glyph);
  if (known !== undefined) {
    return known === TOO_MANY ? undefined : known;
  }

  const points = chordsOf(glyph, tolerance);
  const count = points.length / 4;
  if (count === 0) {
    outlines.set(glyph, null);
    return null;
  }

  if (count > GLYPH_MOST) {
    outlines.set(glyph, TOO_MANY);
    return undefined;
  }

  if (!room(count)) {
    return undefined;
  }

  const outline: Outline = {
    start: store.used,
    count,
    xMin: Number.POSITIVE_INFINITY,
    yMin: Number.POSITIVE_INFINITY,
    xMax: Number.NEGATIVE_INFINITY,
    yMax: Number.NEGATIVE_INFINITY,
  };
  for (let i = 0; i < points.length; i += 2) {
    outline.xMin = Math.min(outline.xMin, points[i]);
    outline.xMax = Math.max(outline.xMax, points[i]);
    outline.yMin = Math.min(outline.yMin, points[i + 1]);
    outline.yMax = Math.max(outline.yMax, points[i + 1]);
  }

  store.data.set(points, store.used * 4);
  store.used += count;
  outlines.set(glyph, outline);
  return outline;
}

/** The corners of a glyph's quad, as signs: the margin goes out from it so. */
const CORNERS = [-1, -1, 1, -1, 1, 1, -1, 1];

/** The vertices a builder writes, reused by the next: builders build one at a time. */
let scratch = new Float32Array(STRIDE * 4 * 64);

/** Indices of quads in order, two triangles each: views of one array, which only grows. */
let quads = new Uint32Array(0);

/** The indices of `count` quads of four vertices each, in order. */
export function quadIndices(count: number): Uint32Array {
  if (quads.length < count * 6) {
    const n = Math.max(count, quads.length / 3);
    quads = new Uint32Array(n * 6);
    for (let i = 0; i < n; i++) {
      const v = i * 4;
      const at = i * 6;
      quads[at] = v;
      quads[at + 1] = v + 1;
      quads[at + 2] = v + 2;
      quads[at + 3] = v;
      quads[at + 4] = v + 2;
      quads[at + 5] = v + 3;
    }
  }

  return quads.subarray(0, count * 6);
}

/** The finite value of `v`, 0 for NaN or an infinity, as a field's settings reach the shader. */
const finite = (v: number) => (Number.isFinite(v) ? v : 0);

/** The table's furthest cutoff from the outline, in pixels. */
function reachOf(table: CsmTable): number {
  let reach = 0;
  for (let i = 0; i < table.length; i += 3) {
    reach = Math.max(reach, Math.abs(table[i + 1]), Math.abs(table[i + 2]));
  }

  return reach;
}

/** A text's glyph quads as built: their vertices, how many, and its mode and tables for the shader. */
export interface BuiltQuads {
  /** STRIDE floats a vertex, four a glyph. */
  vertices: Float32Array;
  glyphs: number;
  /** gridFitType (0 none, 1 pixel, 2 subpixel), thickness, sharpness, and 0. */
  mode: Float32Array;
  /** ENTRIES entries of four floats: size, inside, outside, 0. */
  table: Float32Array;
}

/**
 * The glyphs of a text drawn with advanced anti-aliasing: each glyph first
 * reserved (reserve), which cuts its outline and counts what it asks of
 * the shader, then, if all fit, added (add), and the quads taken (built).
 * One builds at a time: they share the vertices they write.
 */
export class GlyphQuads {
  private glyphs = 0;
  private readonly tables: CsmTable[] = [];
  private readonly starts: number[] = [];
  private entries = 0;
  private cost = 0;
  private readonly thickness: number;
  private readonly sharpness: number;
  /** The epoch the reserved glyphs' outlines are of. */
  private reserved = store.epoch;

  constructor(
    /** 0 none, 1 pixel, 2 subpixel. */
    private readonly grid: number,
    thickness: number,
    sharpness: number,
    /** Flash's pixels to a pixel of the text, as it is placed now, for the quads' reach and cost. */
    private readonly scale: number,
  ) {
    this.thickness = finite(thickness);
    this.sharpness = finite(sharpness);
  }

  /** Flash's pixels the shader may reach past the outline, at `size` pixels to the em, by `tables`. */
  private reach(size: number, tables: readonly [CsmTable, CsmTable]): number {
    const ppem = size * this.scale;
    const moved = 0.0001 * ppem * (Math.abs(this.thickness) + Math.abs(this.sharpness) / 2);
    // And a pixel round, and two for the pen's snapping.
    return Math.max(reachOf(tables[0]), reachOf(tables[1])) + moved + 3;
  }

  /**
   * Cut a glyph of a font of `em` units and count it at `size` pixels to the
   * em: false where the text cannot be drawn so, a glyph past GLYPH_MOST
   * or the field past FIELD_BUDGET, for the whole text to be drawn as
   * normal text. The store may start again here: reserving every glyph
   * then goes again (intact).
   */
  reserve(glyph: Glyph, em: number, size: number, tables: readonly [CsmTable, CsmTable]): boolean {
    const units = em / 20;
    let outline = outlineOf(glyph, units / TOLERANCE);
    if (outline === undefined && outlines.get(glyph) !== TOO_MANY && resetsAllowed) {
      resetSegments();
      outline = outlineOf(glyph, units / TOLERANCE);
    }

    if (outline === undefined) {
      return false;
    }

    if (outline === null) {
      return true;
    }

    const s = (size / units) * this.scale;
    const margin = 2 * this.reach(size, tables);
    const area =
      ((outline.xMax - outline.xMin) * s + margin) * ((outline.yMax - outline.yMin) * s + margin);
    this.cost += outline.count * area;
    return this.cost <= FIELD_BUDGET;
  }

  /**
   * Whether every glyph reserved since restart is still in the store as it
   * was: false where the store started again while they were reserved.
   */
  intact(): boolean {
    return this.reserved === store.epoch;
  }

  /** Reserve afresh, the store's epoch now. */
  restart(): void {
    this.cost = 0;
    this.reserved = store.epoch;
  }

  /**
   * Add a reserved glyph, its pen at (x, y) in the text's pixels, `size`
   * pixels to the em, in 0xRRGGBB and `alpha`, by the light or the dark of
   * `tables` as its colour is drawn: false where the tables' room is full,
   * which leaves the text to be drawn as normal text.
   */
  add(
    glyph: Glyph,
    em: number,
    x: number,
    y: number,
    size: number,
    color: number,
    alpha: number,
    tables: readonly [CsmTable, CsmTable],
  ): boolean {
    const units = em / 20;
    const outline = outlineOf(glyph, units / TOLERANCE);
    if (outline === null) {
      return true;
    }

    if (outline === undefined) {
      return false;
    }

    const light = this.code(tables[0]);
    const dark = this.code(tables[1]);
    if (light < 0 || dark < 0) {
      return false;
    }

    if ((this.glyphs + 1) * 4 * STRIDE > scratch.length) {
      const grown = new Float32Array(scratch.length * 2);
      grown.set(scratch.subarray(0, this.glyphs * 4 * STRIDE));
      scratch = grown;
    }

    const scale = size / units;
    // Where the quad reaches in the text's pixels, for bounds (filters, culling, layers): the
    // shader moves it out by the cutoffs from where the pen snaps.
    const out = this.reach(size, tables) / Math.max(this.scale, 1 / 64);
    const r = ((color >> 16) & 0xff) / 255;
    const g = ((color >> 8) & 0xff) / 255;
    const b = (color & 0xff) / 255;
    let at = this.glyphs * 4 * STRIDE;
    for (let k = 0; k < 8; k += 2) {
      const sx = CORNERS[k];
      const sy = CORNERS[k + 1];
      const gx = sx < 0 ? outline.xMin : outline.xMax;
      const gy = sy < 0 ? outline.yMin : outline.yMax;
      scratch[at] = x + gx * scale + sx * out;
      scratch[at + 1] = y + gy * scale + sy * out;
      scratch[at + 2] = x;
      scratch[at + 3] = y;
      scratch[at + 4] = light;
      scratch[at + 5] = dark;
      scratch[at + 6] = gx;
      scratch[at + 7] = gy;
      scratch[at + 8] = sx;
      scratch[at + 9] = sy;
      scratch[at + 10] = outline.start;
      scratch[at + 11] = outline.count;
      scratch[at + 12] = scale;
      scratch[at + 13] = size;
      scratch[at + 14] = r;
      scratch[at + 15] = g;
      scratch[at + 16] = b;
      scratch[at + 17] = alpha;
      at += STRIDE;
    }

    this.glyphs++;
    return true;
  }

  /** A table's place in the uniforms, its first entry plus 64 times its entries, added where new; -1 past their room. */
  code(table: CsmTable): number {
    let t = this.tables.indexOf(table);
    if (t < 0) {
      if (this.entries + table.length / 3 > ENTRIES) {
        return -1;
      }

      t = this.tables.length;
      this.tables.push(table);
      this.starts.push(this.entries);
      this.entries += table.length / 3;
    }

    return this.starts[t] + (table.length / 3) * 64;
  }

  /** The quads of the glyphs added, null for none. */
  built(): BuiltQuads | null {
    if (this.glyphs === 0) {
      return null;
    }

    const table = new Float32Array(ENTRIES * 4);
    for (let t = 0; t < this.tables.length; t++) {
      const entries = this.tables[t];
      for (let i = 0; i < entries.length; i += 3) {
        const at = (this.starts[t] + i / 3) * 4;
        table[at] = entries[i];
        table[at + 1] = entries[i + 1];
        table[at + 2] = entries[i + 2];
      }
    }

    return {
      vertices: scratch.slice(0, this.glyphs * 4 * STRIDE),
      glyphs: this.glyphs,
      mode: new Float32Array([this.grid, this.thickness, this.sharpness, 0]),
      table,
    };
  }
}

/**
 * `quads` built anew as `each` reserves a text's glyphs, or null where one
 * cannot be drawn so, a glyph or the whole asking too much of the shader:
 * the text is then drawn as normal text, all of it alike. Reserving goes
 * again where the store started again meanwhile.
 */
export function reserveAll<T extends GlyphQuads>(quads: T, each: (quads: T) => boolean): T | null {
  for (let tries = 0; tries < 2; tries++) {
    quads.restart();
    if (!each(quads)) {
      return null;
    }

    if (quads.intact()) {
      return quads;
    }
  }

  return null;
}
