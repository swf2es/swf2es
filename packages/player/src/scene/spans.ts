// Each object's span of the stage's scene list (docs/renderer.md, "Spans"):
// the entries and rows its subtree wrote in a frame, kept with what they
// were drawn under, so that a frame in which nothing of it changed may take
// them from the frame before rather than walk it again.
import type { ColorTransform } from "@swf2es/format";
import { DRAW, type Geometries, Rows, SceneList, type Span, type Textures } from "@swf2es/render";
import { Container } from "../display/container.js";
import { CLEAN, type DisplayObject } from "../display/displayobject.js";

/**
 * An object's span of the frame it was written in, its entries and rows;
 * and, for a container, what its children's spans stand under (Children).
 */
export interface ObjectSpan extends Span {
  /** The Spans that wrote it (Spans.id): another view drawing the same object writes its own. */
  owner: number;
  /** The frame its span was written in, or taken into; -1 for none. */
  frame: number;
  /**
   * Its parent then (its serial, -1 for none), under whose context it stood:
   * a child moved to another parent is not flagged itself. A number, so that
   * a span holds no object.
   */
  parent: number;
  /** A container's walk's record (Children), made at its first; null for any other object. */
  children: Children | null;
}

/**
 * From a container's last walk, where its span began then and, for its
 * children, the transform on the stage and the colour they were drawn
 * under, which each child's span written then stands under alike. Apart
 * from ObjectSpan, since only containers have children: most objects walked
 * are leaves, which would otherwise carry its fields too.
 */
export interface Children {
  /**
   * The frame it was last walked in with its children's spans written (under),
   * -1 for none, and where its span began then: its own span taken whole
   * since moved what it holds by as much as it moved.
   */
  walked: number;
  walkedFirst: number;
  walkedRowsFirst: number;
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

/**
 * Where an object's children's spans lie, as its walk finds them (Spans.under):
 * written in `frame`'s walk, and in the frame before's list `entries` and
 * `rows` on from where they were written; `frame` -1 where none may stand.
 */
export interface Context {
  frame: number;
  entries: number;
  rows: number;
}

/** Whether nothing in `o` changed since it was last walked: its flags, and its descendants'. */
export function clean(o: DisplayObject): boolean {
  return o.dirty === CLEAN && !(o instanceof Container && o.descendantsDirty);
}

/** The Spans made, which numbers each. */
let made = 0;

/**
 * Each display list's last stage walk, by its topmost object: the Spans of
 * the view that walked it, and that view's count of walks then. A walk
 * clears the flags of what it visits, so another view's walk of the same
 * list since leaves a span unflagged that changed.
 */
const lastWalks = new WeakMap<object, { spans: number; walk: number }>();

/**
 * The spans of the stage's walks: written as each object is walked, read
 * the frame after. The frame before's scene list and rows are kept, which
 * the spans name, with the generation each draw's geometry and texture had,
 * so that one let go of since is never named again.
 */
export class Spans {
  /** Its number, which its spans carry: a number, so that what it spans holds no view. */
  private readonly id = ++made;
  /** The stage's walks begun, the one under way the last. */
  private frame = 0;
  /** Whether the frame before's spans may be read: it walked to its end, at this generation. */
  private usable = false;
  private ended = false;
  private generation = -1;
  /** Where the stage's walk began the frame before, the viewport's corner (root). */
  private rootX = 0;
  private rootY = 0;
  /** Where the span `kept` found lies in the frame before's list: its first entry and row. */
  from = 0;
  rowsFrom = 0;
  /** The frame before's list and rows, which its spans name. */
  scene = new SceneList();
  rows = new Rows();
  /** Each of the frame before's draws' geometry's generation and texture's, or -1. */
  private geometryGenerations = new Int32Array(1024);
  private textureGenerations = new Int32Array(1024);

  /**
   * A stage's walk of the display list under `top`, its topmost object,
   * begun into `scene` and `rows`, at kept outputs' `generation` (the view's
   * scale, quality and screen): the lists the frame before wrote are kept
   * for its spans, and the ones before those given back to be written
   * again, as this frame's. Its spans are read only where this view walked
   * that list last: another view's walk cleared flags they follow.
   */
  begin(
    scene: SceneList,
    rows: Rows,
    generation: number,
    top: object,
  ): { scene: SceneList; rows: Rows } {
    let last = lastWalks.get(top);
    const mine = last !== undefined && last.spans === this.id && last.walk === this.frame;
    if (!last) {
      last = { spans: 0, walk: 0 };
      lastWalks.set(top, last);
    }

    last.spans = this.id;
    last.walk = this.frame + 1;
    this.usable = this.ended && mine && generation === this.generation;
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

  /** `o`'s span, this Spans', made empty if there was none. */
  private own(o: DisplayObject): ObjectSpan {
    let s = o.span as ObjectSpan | null;
    if (s === null || s.owner !== this.id) {
      s = {
        owner: this.id,
        frame: -1,
        parent: -1,
        first: 0,
        end: 0,
        rowsFirst: 0,
        rowsEnd: 0,
        children: null,
      };
      o.span = s;
    }

    return s;
  }

  /**
   * Where `o`'s children's spans lie in the frame before's list, if they may
   * stand for them now: `o` walked now from entry `first` and row
   * `rowsFirst`, under the transform on the stage at `places[at]` and the
   * colour `tint` (its children's), its own span found as `parent` says of
   * its parent's children (Context). Its children's spans were written in
   * its last walk, under what it noted then, which must be what they stand
   * under now; they lie where they were then, moved as `o`'s span was moved
   * since, as copied whole with it, and as the spans holding it were (the
   * parent's context). Noted for the next frame, and `out` set to it.
   */
  under(
    o: DisplayObject,
    first: number,
    rowsFirst: number,
    places: Float64Array,
    at: number,
    tint: ColorTransform | null,
    parent: Context,
    out: Context,
  ): void {
    const s = this.own(o);
    let w = s.children;
    if (w === null) {
      w = {
        walked: -1,
        walkedFirst: 0,
        walkedRowsFirst: 0,
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
      s.children = w;
    }

    const a = places[at];
    const b = places[at + 1];
    const c = places[at + 2];
    const d = places[at + 3];
    const tx = places[at + 4];
    const ty = places[at + 5];
    const same =
      this.usable &&
      w.walked >= 0 &&
      w.a === a &&
      w.b === b &&
      w.c === c &&
      w.d === d &&
      w.tx === tx &&
      w.ty === ty &&
      (tint
        ? w.tinted &&
          w.rMul === tint.rMul &&
          w.gMul === tint.gMul &&
          w.bMul === tint.bMul &&
          w.aMul === tint.aMul &&
          w.rAdd === tint.rAdd &&
          w.gAdd === tint.gAdd &&
          w.bAdd === tint.bAdd &&
          w.aAdd === tint.aAdd
        : !w.tinted);
    const before = this.frame - 1;
    out.frame = -1;
    if (!same) {
      // Nothing of the children's stands.
    } else if (w.walked === before) {
      out.frame = before;
      out.entries = 0;
      out.rows = 0;
    } else if (s.frame === before) {
      out.frame = w.walked;
      out.entries = s.first - w.walkedFirst;
      out.rows = s.rowsFirst - w.walkedRowsFirst;
    } else if (
      parent.frame >= 0 &&
      s.frame === parent.frame &&
      s.parent === (o.parent ? o.parent.serial : -1)
    ) {
      // Its span lay in its parent's, as copied whole since, only where that parent was its own then.
      out.frame = w.walked;
      out.entries = s.first + parent.entries - w.walkedFirst;
      out.rows = s.rowsFirst + parent.rows - w.walkedRowsFirst;
    }

    w.walked = this.frame;
    w.walkedFirst = first;
    w.walkedRowsFirst = rowsFirst;
    if (!same) {
      w.a = a;
      w.b = b;
      w.c = c;
      w.d = d;
      w.tx = tx;
      w.ty = ty;
      w.tinted = tint !== null;
      if (tint) {
        w.rMul = tint.rMul;
        w.gMul = tint.gMul;
        w.bMul = tint.bMul;
        w.aMul = tint.aMul;
        w.rAdd = tint.rAdd;
        w.gAdd = tint.gAdd;
        w.bAdd = tint.bAdd;
        w.aAdd = tint.aAdd;
      }
    }
  }

  /** The root's context (Context): the stage's walk beginning at the viewport's corner (`x`, `y`) as the frame before's did. */
  root(x: number, y: number, out: Context): void {
    const same = this.usable && x === this.rootX && y === this.rootY;
    this.rootX = x;
    this.rootY = y;
    out.frame = same ? this.frame - 1 : -1;
    out.entries = 0;
    out.rows = 0;
  }

  /**
   * `o`'s span, if it may stand for `o` now: written where `context` says
   * its parent's children's spans were (Context), its parent then the one
   * it has, its draws' geometries and textures those still kept; where it
   * lies in the frame before's list then `from` and `rowsFrom`. Whether
   * nothing in `o` changed is its caller's to know.
   */
  kept(
    o: DisplayObject,
    context: Context,
    geometries: Geometries,
    textures: Textures,
  ): ObjectSpan | null {
    const s = o.span as ObjectSpan | null;
    if (
      !this.usable ||
      context.frame < 0 ||
      s === null ||
      s.owner !== this.id ||
      s.frame !== context.frame ||
      s.parent !== (o.parent ? o.parent.serial : -1)
    ) {
      return null;
    }

    const from = s.first + context.entries;
    const ids = this.scene.geometry;
    const texture = this.scene.texture;
    const g = this.geometryGenerations;
    const t = this.textureGenerations;
    for (let e = from; e < from + s.end - s.first; e++) {
      const id = ids[e];
      if (g[e] < 0 || !geometries.holds(id) || geometries.generation(id) !== g[e]) {
        return null;
      }

      const k = texture[e];
      if (k >= 0 && (t[e] < 0 || !textures.holds(k) || textures.generation(k) !== t[e])) {
        return null;
      }
    }

    this.from = from;
    this.rowsFrom = s.rowsFirst + context.rows;
    return s;
  }

  /**
   * `o`'s span of this frame: entries `first` to `end`, rows `rowsFirst` to
   * `rowsEnd`. A walk that wrote none of its children's spans (under), as
   * of children walked hidden, leaves none of theirs to be found through it.
   */
  record(o: DisplayObject, first: number, end: number, rowsFirst: number, rowsEnd: number): void {
    const s = this.own(o);
    if (s.children !== null && s.children.walked !== this.frame) {
      s.children.walked = -1;
    }

    s.frame = this.frame;
    s.parent = o.parent ? o.parent.serial : -1;
    s.first = first;
    s.end = end;
    s.rowsFirst = rowsFirst;
    s.rowsEnd = rowsEnd;
  }

  /** Span `s`, taken into this frame, noted where it now lies. */
  moved(s: ObjectSpan, first: number, end: number, rowsFirst: number, rowsEnd: number): void {
    s.frame = this.frame;
    s.first = first;
    s.end = end;
    s.rowsFirst = rowsFirst;
    s.rowsEnd = rowsEnd;
  }
}
