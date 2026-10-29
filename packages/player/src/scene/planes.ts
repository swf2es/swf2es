// 3D objects as the view draws them (RenderView.drawPlane): what each one's
// bitmap was last drawn of, which keeps it while nothing in it changes;
// its quad's geometry, placed in perspective; and the lists of the passes
// that draw their content, one a depth of 3D objects nested.
import type { ColorTransform } from "@swf2es/format";
import {
  Commands,
  Filters,
  type Geometries,
  type GeometryHandle,
  type KeepHandle,
  Rows,
  SceneList,
} from "@swf2es/render";
import type { PixelRect } from "../bitmap/bitmap.js";
import { IDENTITY_COLOR } from "../display/color.js";
import { Container } from "../display/container.js";
import { type DisplayObject, TRANSFORM } from "../display/displayobject.js";
import { type Filter as FilterRecord, sameFilterRecords } from "../display/filters.js";
import type { PlaneQuad } from "../display/plane.js";

/** A geometry's colours where its vertices carry none, a 3D object's quad's. */
const NO_COLORS = new Uint32Array(0);

/**
 * A 3D object's quad written into its geometry's arrays in place: its
 * corners, its texels the bitmap's, `width` by `height`, and each corner's
 * depth its w's inverse. Whether any of it changed, as stored.
 */
function planeQuadData(
  data: { positions: Float32Array; texels: Float32Array; depths: Float32Array },
  quad: PlaneQuad,
  width: number,
  height: number,
): boolean {
  let changed = false;
  const set = (array: Float32Array, i: number, v: number) => {
    const stored = Math.fround(v);
    if (array[i] !== stored) {
      array[i] = stored;
      changed = true;
    }
  };

  for (let i = 0; i < 8; i++) {
    set(data.positions, i, quad.positions[i]);
  }

  for (let i = 0; i < 4; i++) {
    set(data.texels, i * 2, i === 1 || i === 2 ? width : 0);
    set(data.texels, i * 2 + 1, i >= 2 ? height : 0);
    set(data.depths, i, 1 / quad.ws[i]);
  }

  return changed;
}

/** What a 3D object's bitmap was last drawn of, and its bounds then (RenderView.drawPlane). */
export interface PlaneState {
  seenAt: number;
  generation: number;
  rect: PixelRect | null;
  scrolled: boolean;
  filters: readonly FilterRecord[];
  /** Whether its pass placed a 3D object or an outside mask, which move as all above does. */
  unkeepable: boolean;
  mask: DisplayObject | null;
  left: number;
  top: number;
  texels: number;
  samples: number;
  width: number;
  height: number;
  color: ColorTransform;
  colored: boolean;
}

export class Planes {
  /** Each 3D object's kept bitmap, and its quad as last made (drawPlane). */
  readonly keeps: WeakMap<DisplayObject, KeepHandle> = new WeakMap();
  private readonly quads = new WeakMap<
    DisplayObject,
    {
      handle: GeometryHandle;
      data: {
        positions: Float32Array;
        colors: Uint32Array;
        texels: Float32Array;
        depths: Float32Array;
        indices: Uint32Array;
      };
    }
  >();
  /** What each 3D object's bitmap was drawn of, which it is kept while unchanged (drawPlane). */
  private readonly states = new WeakMap<DisplayObject, PlaneState>();
  /** BitmapData.draw's kept bitmaps of 3D objects, apart from the stage's. */
  readonly drawnKeeps: WeakMap<DisplayObject, KeepHandle> = new WeakMap();
  /**
   * How many 3D objects and masks from outside them passes have placed: a
   * pass that places one draws a bitmap that cannot be kept (drawPlane).
   */
  placed = 0;
  /** Where drawPlane works out a quad. */
  readonly quad: PlaneQuad = {
    x: 0,
    y: 0,
    width: 0,
    height: 0,
    positions: new Float64Array(8),
    ws: new Float64Array(4),
  };
  /** How many 3D objects' passes the walk is in, and each depth's lists, kept for the next. */
  depth = 0;
  private readonly passes: {
    scene: SceneList;
    rows: Rows;
    filters: Filters;
    commands: Commands;
  }[] = [];

  constructor(private readonly geometries: Geometries) {}

  /** What `o`'s bitmap was last drawn of (drawPlane), made on its first. */
  state(o: DisplayObject): PlaneState {
    let k = this.states.get(o);
    if (!k) {
      k = {
        seenAt: -1,
        generation: -1,
        rect: null,
        scrolled: false,
        filters: [],
        unkeepable: false,
        mask: null,
        left: 0,
        top: 0,
        texels: 0,
        samples: 0,
        width: 0,
        height: 0,
        color: { ...IDENTITY_COLOR },
        colored: false,
      };
      this.states.set(o, k);
    }

    return k;
  }

  /**
   * `o`'s quad as `quad` has it, made again as it moves: its texels the bitmap's, `width` by
   * `height`, each corner's depth its w.
   */
  quadGeometry(o: DisplayObject, width: number, height: number): GeometryHandle {
    let kept = this.quads.get(o);
    if (!kept || !this.geometries.alive(kept.handle)) {
      const data = {
        positions: new Float32Array(8),
        colors: NO_COLORS,
        texels: new Float32Array(8),
        depths: new Float32Array(4),
        indices: Uint32Array.of(0, 1, 2, 0, 2, 3),
      };
      planeQuadData(data, this.quad, width, height);
      kept = { handle: this.geometries.add(data), data };
      this.quads.set(o, kept);
    } else if (planeQuadData(kept.data, this.quad, width, height)) {
      this.geometries.update(kept.handle.id);
    }

    return kept.handle;
  }

  /** The lists of a pass at `depth`, made on its first. */
  pass(depth: number): { scene: SceneList; rows: Rows; filters: Filters; commands: Commands } {
    let pass = this.passes[depth];
    if (!pass) {
      pass = {
        scene: new SceneList(),
        rows: new Rows(),
        filters: new Filters(),
        commands: new Commands(),
      };
      this.passes[depth] = pass;
    }

    return pass;
  }
}

/**
 * Whether nothing a 3D object's bitmap holds changed since the frame
 * before drew it: in it but its own transform, which moves its quad
 * alone, nor its filters' values, which setting flags as a transform.
 * One whose pass placed a 3D object or a mask from outside it in it
 * (unkeepable) is drawn anew on every frame, as those move with what
 * above them moves, which flags nothing in it; and BitmapData.draw draws
 * anew.
 */
export function planeUnchanged(
  o: DisplayObject,
  k: PlaneState,
  frames: number,
  snapshotting: boolean,
): boolean {
  return (
    !snapshotting &&
    !k.unkeepable &&
    k.seenAt === frames - 1 &&
    (o.dirty & ~TRANSFORM) === 0 &&
    !(o.dirty & TRANSFORM && (o.scroll !== null || k.scrolled)) &&
    !(o instanceof Container && o.descendantsDirty) &&
    sameFilterRecords(k.filters, o.filters)
  );
}
