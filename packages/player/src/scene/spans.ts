// Each object's span of the stage's scene list (docs/renderer.md, "Spans"):
// the entries and rows its subtree wrote in a frame, kept with what they
// were drawn under, so that a frame in which nothing of it changed may take
// them from the frame before rather than walk it again.
import type { ColorTransform } from "@swf2es/format";
import { DRAW, type Geometries, Rows, SceneList, type Span, type Textures } from "@swf2es/render";
import { Container } from "../display/container.js";
import { CLEAN, type DisplayObject } from "../display/displayobject.js";

/**
 * An object's span of the frame it was written in: its entries and rows,
 * and what it was drawn under, its parent's transform on the stage and the
 * colour transform its ancestors gave it.
 */
export interface ObjectSpan extends Span {
  frame: number;
  a: number;
  b: number;
  c: number;
  d: number;
  tx: number;
  ty: number;
  tinted: boolean;
  rMul: number;
  gMul: number;
  bMul: number;
  aMul: number;
  rAdd: number;
  gAdd: number;
  bAdd: number;
  aAdd: number;
}

/** Whether nothing in `o` changed since it was last walked: its flags, and its descendants'. */
export function clean(o: DisplayObject): boolean {
  return o.dirty === CLEAN && !(o instanceof Container && o.descendantsDirty);
}

/**
 * The spans of the stage's walks: written as each object is walked, read
 * the frame after. The frame before's scene list and rows are kept, which
 * the spans name, with the generation each draw's geometry and texture had,
 * so that one let go of since is never named again.
 */
export class Spans {
  private readonly spans = new WeakMap<DisplayObject, ObjectSpan>();
  /** The stage's walks begun, the one under way the last. */
  private frame = 0;
  /** Whether the frame before's spans may be read: it walked to its end, at this generation. */
  private usable = false;
  private ended = false;
  private generation = -1;
  /** The frame before's list and rows, which its spans name. */
  scene = new SceneList();
  rows = new Rows();
  /** Each of the frame before's draws' geometry's generation and texture's, or -1. */
  private geometryGenerations = new Int32Array(1024);
  private textureGenerations = new Int32Array(1024);

  /**
   * A stage's walk begun into `scene` and `rows`, at kept outputs'
   * `generation` (the view's scale, quality and screen): the lists the frame
   * before wrote are kept for its spans, and the ones before those given
   * back to be written again, as this frame's.
   */
  begin(scene: SceneList, rows: Rows, generation: number): { scene: SceneList; rows: Rows } {
    this.usable = this.ended && generation === this.generation;
    this.ended = false;
    this.generation = generation;
    this.frame++;
    const free = { scene: this.scene, rows: this.rows };
    this.scene = scene;
    this.rows = rows;
    return free;
  }

  /**
   * The stage's walk ended, having written `scene`: the generation of
   * each draw's geometry and texture noted, which its spans are read
   * against.
   */
  end(scene: SceneList, geometries: Geometries, textures: Textures): void {
    // Written into the arrays the frame before's lists' noted, which are free now.
    if (this.geometryGenerations.length < scene.length) {
      let length = this.geometryGenerations.length * 2;
      while (length < scene.length) {
        length *= 2;
      }

      this.geometryGenerations = new Int32Array(length);
      this.textureGenerations = new Int32Array(length);
    }

    const kinds = scene.kind;
    const ids = scene.geometry;
    const texture = scene.texture;
    const g = this.geometryGenerations;
    const t = this.textureGenerations;
    for (let e = 0; e < scene.length; e++) {
      const draw = kinds[e] === DRAW;
      g[e] = draw && geometries.holds(ids[e]) ? geometries.generation(ids[e]) : -1;
      t[e] =
        draw && texture[e] >= 0 && textures.holds(texture[e])
          ? textures.generation(texture[e])
          : -1;
    }

    this.ended = true;
  }

  /** Every span forgotten, as a context lost and given back takes the textures they name. */
  drop(): void {
    this.usable = false;
    this.ended = false;
  }

  /**
   * `o`'s span of the frame before, if it may stand for `o` now: written
   * then, under the parent's transform at `places[at]` and the colour
   * `tint` it has now, its draws' geometries and textures those still
   * kept. Whether nothing in `o` changed is its caller's to know.
   */
  kept(
    o: DisplayObject,
    places: Float64Array,
    at: number,
    tint: ColorTransform | null,
    geometries: Geometries,
    textures: Textures,
  ): ObjectSpan | null {
    const s = this.usable ? this.spans.get(o) : undefined;
    if (
      !s ||
      s.frame !== this.frame - 1 ||
      s.a !== places[at] ||
      s.b !== places[at + 1] ||
      s.c !== places[at + 2] ||
      s.d !== places[at + 3] ||
      s.tx !== places[at + 4] ||
      s.ty !== places[at + 5] ||
      (tint
        ? !s.tinted ||
          s.rMul !== tint.rMul ||
          s.gMul !== tint.gMul ||
          s.bMul !== tint.bMul ||
          s.aMul !== tint.aMul ||
          s.rAdd !== tint.rAdd ||
          s.gAdd !== tint.gAdd ||
          s.bAdd !== tint.bAdd ||
          s.aAdd !== tint.aAdd
        : s.tinted)
    ) {
      return null;
    }

    const scene = this.scene;
    const ids = scene.geometry;
    const texture = scene.texture;
    const g = this.geometryGenerations;
    const t = this.textureGenerations;
    for (let e = s.first; e < s.end; e++) {
      const id = ids[e];
      if (g[e] < 0 || !geometries.holds(id) || geometries.generation(id) !== g[e]) {
        return null;
      }

      const k = texture[e];
      if (k >= 0 && (t[e] < 0 || !textures.holds(k) || textures.generation(k) !== t[e])) {
        return null;
      }
    }

    return s;
  }

  /**
   * `o`'s span of this frame, entries `first` to `end` and rows `rowsFirst`
   * to `rowsEnd`, written under the parent's transform at `places[at]` and
   * the colour `tint`.
   */
  record(
    o: DisplayObject,
    first: number,
    end: number,
    rowsFirst: number,
    rowsEnd: number,
    places: Float64Array,
    at: number,
    tint: ColorTransform | null,
  ): void {
    let s = this.spans.get(o);
    if (!s) {
      s = {
        frame: 0,
        first: 0,
        end: 0,
        rowsFirst: 0,
        rowsEnd: 0,
        a: 0,
        b: 0,
        c: 0,
        d: 0,
        tx: 0,
        ty: 0,
        tinted: false,
        rMul: 1,
        gMul: 1,
        bMul: 1,
        aMul: 1,
        rAdd: 0,
        gAdd: 0,
        bAdd: 0,
        aAdd: 0,
      };
      this.spans.set(o, s);
    }

    s.frame = this.frame;
    s.first = first;
    s.end = end;
    s.rowsFirst = rowsFirst;
    s.rowsEnd = rowsEnd;
    s.a = places[at];
    s.b = places[at + 1];
    s.c = places[at + 2];
    s.d = places[at + 3];
    s.tx = places[at + 4];
    s.ty = places[at + 5];
    s.tinted = tint !== null;
    if (tint) {
      s.rMul = tint.rMul;
      s.gMul = tint.gMul;
      s.bMul = tint.bMul;
      s.aMul = tint.aMul;
      s.rAdd = tint.rAdd;
      s.gAdd = tint.gAdd;
      s.bAdd = tint.bAdd;
      s.aAdd = tint.aAdd;
    }
  }
}
