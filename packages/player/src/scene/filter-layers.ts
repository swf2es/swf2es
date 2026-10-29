// A filtered object's layer (RenderView): its filters worked out for the
// units it is drawn at, again only as they change, and cut to what fits a
// texture; their passes added to the frame's filters; and their output
// kept, to be composited again where nothing it was made of changed.
import {
  drawnArea,
  type Filters,
  filteredRect,
  type Geometries,
  type KeepHandle,
  type Keeps,
  type MeasureTarget,
  type Rows,
  type SceneList,
  type Textures,
} from "@swf2es/render";
import { Container } from "../display/container.js";
import { type DisplayObject, TRANSFORM } from "../display/displayobject.js";
import {
  type Filter as FilterRecord,
  filterRoom,
  paddingCap,
  sameFilterRecords,
} from "../display/filters.js";
import { type FilterPlan, planFilters } from "./filters.js";
import { GRADIENT_IDLE_FRAMES, type Paints } from "./paints.js";

/**
 * A filtered object's output as last made: whether it was kept, as which
 * kept output, for which plan and generation; its scale and turn on the
 * stage and its place there in target pixels; its area as measured and
 * its rectangle; and how many frames in a row it changed. `reused` and
 * `keeping` say what this frame does with it.
 */
export interface KeptOutput {
  handle: KeepHandle | null;
  plan: FilterPlan;
  generation: number;
  /** The stage's frame it was last drawn on, whether it scrolled then, and whether it was measured. */
  seenAt: number;
  /** The key of the 9-slice that reshaped what it drew, or "". */
  sliceKey: string;
  scrolled: boolean;
  measured: boolean;
  kept: boolean;
  reused: boolean;
  keeping: boolean;
  changing: number;
  linear: number[];
  x: number;
  y: number;
  pad: number;
  area: Float64Array;
  rect: Int32Array;
}

/**
 * A filtered object's filters worked out for its records at its units,
 * and cut to the last cap its padding needed, if any.
 */
interface KeptPlan {
  records: readonly FilterRecord[];
  units: number;
  plan: FilterPlan | null;
  cap: number;
  capped: FilterPlan | null;
}

export class FilterLayers {
  /** Each filtered object's filters worked out, for the records, units and room they were for. */
  private readonly filterPlans = new WeakMap<DisplayObject, KeptPlan>();
  /** A filtered object's drawn area, measured where its padding may not fit (fitFilters). */
  private readonly drawn: number[] = [];
  /** What each filtered object's output was kept for. */
  private readonly outputs = new WeakMap<DisplayObject, KeptOutput>();
  /** The filtered layers drawn this frame, each its output's record and its layer number. */
  readonly ran: (KeptOutput | number)[] = [];
  private readonly movedArea = new Float64Array(4);
  /** A reused output's rectangle (keptOutput). */
  readonly keptRect = new Int32Array(4);

  constructor(
    private readonly geometries: Geometries,
    private readonly textures: Textures,
    private readonly keeps: Keeps,
    private readonly paints: Paints,
    /** The largest texture side the context makes, which a filtered layer's padding must fit. */
    private readonly textureLimit: number,
  ) {}

  /**
   * Whether `o`'s filters' output kept last can be drawn again, its rectangle then in keptRect;
   * else whether to keep what they make now. Kept while nothing they ran on changed but where it is
   * on the stage: not past a change in `o` but a move, in what is in it, in its scale or turn on
   * the stage (a b c d), a move of what it scrolls, its filters, or the screen's scale; and drawn
   * again only while its rectangle moved with it, its size the same and its corner within a pixel.
   * One that changes frame after frame is not kept, as keeping it would cost a target for nothing.
   * `frames` and `generation` are the view's: the stage's frames drawn, and what outputs are kept at.
   */
  keptOutput(
    o: DisplayObject,
    plan: FilterPlan,
    sliceKey: string,
    a: number,
    b: number,
    c: number,
    d: number,
    tx: number,
    ty: number,
    target: MeasureTarget,
    frames: number,
    generation: number,
  ): KeptOutput {
    let k = this.outputs.get(o);
    if (!k) {
      k = {
        handle: null,
        plan,
        generation,
        seenAt: -1,
        sliceKey,
        scrolled: false,
        measured: false,
        kept: false,
        reused: false,
        keeping: false,
        changing: 0,
        linear: [a, b, c, d],
        x: 0,
        y: 0,
        pad: 0,
        area: new Float64Array(4),
        rect: new Int32Array(4),
      };
      this.outputs.set(o, k);
    }

    const x = tx * target.scale;
    const y = ty * target.scale;
    const l = k.linear;
    // One not drawn on the frame before was hidden, or off the list, where a walk cleared its flags
    // and its children's without it hearing of a change.
    // A slice moves what it draws as its owner's other children change, which its flags miss.
    const changed =
      k.seenAt !== frames - 1 ||
      k.sliceKey !== sliceKey ||
      k.plan !== plan ||
      k.generation !== generation ||
      (o.dirty & ~TRANSFORM) !== 0 ||
      (o.dirty & TRANSFORM && (o.scroll !== null || k.scrolled)) ||
      (o instanceof Container && o.descendantsDirty) ||
      l[0] !== a ||
      l[1] !== b ||
      l[2] !== c ||
      l[3] !== d;
    k.seenAt = frames;
    k.sliceKey = sliceKey;
    k.scrolled = o.scroll !== null;
    let same = false;
    if (!changed && k.measured) {
      // Its area as measured, moved as it moved, measured into a rectangle again.
      const moved = this.movedArea;
      moved[0] = k.area[0] + x - k.x;
      moved[1] = k.area[1] + y - k.y;
      moved[2] = k.area[2] + x - k.x;
      moved[3] = k.area[3] + y - k.y;
      const rect = this.keptRect;
      filteredRect(moved, 0, k.pad, target, rect, 0);
      same =
        rect[2] === k.rect[2] &&
        rect[3] === k.rect[3] &&
        Math.abs(rect[0] - x - (k.rect[0] - k.x)) <= 1 &&
        Math.abs(rect[1] - y - (k.rect[1] - k.y)) <= 1;
    }

    k.reused = !changed && same && k.kept && k.handle !== null && this.keeps.alive(k.handle);
    if (k.reused) {
      k.changing = 0;
      return k;
    }

    // Unchanged but not kept, as after it was filtered without keeping: kept now.
    k.changing = changed || !same ? k.changing + 1 : 0;
    k.keeping = k.changing <= 1;
    k.kept = false;
    k.plan = plan;
    k.generation = generation;
    l[0] = a;
    l[1] = b;
    l[2] = c;
    l[3] = d;
    k.x = x;
    k.y = y;
    // Let go of at the end of the first frame it is not drawn: one whose object was not drawn on
    // the frame before is drawn anew (`changed`), and a timeline makes filtered objects anew as it
    // plays, whose outputs, kept for a second, held hundreds of MB.
    if (k.keeping && (!k.handle || !this.keeps.alive(k.handle))) {
      k.handle = this.keeps.add(0);
    }

    if (k.keeping) {
      this.keeps.use((k.handle as KeepHandle).id);
    }

    return k;
  }

  /** What the filtered layers drawn this frame measured, for their outputs kept to be drawn again. */
  noteKept(scene: SceneList): void {
    const ran = this.ran;
    for (let i = 0; i < ran.length; i += 2) {
      const k = ran[i] as KeptOutput;
      const layer = ran[i + 1] as number;
      for (let j = 0; j < 4; j++) {
        k.area[j] = scene.areas[layer * 4 + j];
        k.rect[j] = scene.layers[layer * 4 + j];
      }

      // Kept where its output was: a layer of no size draws nothing, and keeps nothing, nor does one
      // in a layer of no size, which the planner leaves out with all in it.
      k.measured = k.rect[2] > 0 && k.rect[3] > 0;
      k.kept = k.keeping && k.measured && drawnWithin(scene, layer);
    }

    ran.length = 0;
  }

  /**
   * `o`'s filters worked out for the units they are drawn at and the room a
   * texture has, again only as one of those or their values change: null
   * where it has none drawn.
   */
  filterPlan(
    o: DisplayObject,
    filterUnits: number | null,
    scale: number,
    drawing: boolean,
  ): FilterPlan | null {
    const records = o.filters;
    // A stage scaled to nothing filters at a unit a pixel rather than not at all.
    const units = filterUnits ?? (Number.isFinite(scale) && scale > 0 ? scale : 1);
    const kept = this.filterPlans.get(o);
    // A draw for BitmapData plans at its own units, leaving the stage's plans be.
    if (drawing) {
      return kept?.units === units
        ? kept.plan
        : planFilters(records, units, Number.POSITIVE_INFINITY, kept?.plan ?? null);
    }

    if (kept && kept.units === units) {
      if (kept.records === records) {
        return kept.plan;
      }

      // Set again with the same values, as a tween writes them on each frame.
      if (sameFilterRecords(records, kept.records)) {
        kept.records = records;
        return kept.plan;
      }
    }

    const plan = planFilters(records, units, Number.POSITIVE_INFINITY, kept?.plan ?? null);
    this.filterPlans.set(o, { records, units, plan, cap: Number.POSITIVE_INFINITY, capped: null });
    return plan;
  }

  /**
   * `plan`, `o`'s, with its padding cut where it would not fit a texture
   * round what `o` drew, the scene's entries from `from` on: its area cut
   * to the target, as PixiJS's filter system measures it (measure.ts in
   * @swf2es/render). Only a padding past what fits round the whole target asks
   * for the area.
   */
  fitFilters(
    o: DisplayObject,
    plan: FilterPlan,
    from: number,
    scene: SceneList,
    rows: Rows,
    target: MeasureTarget,
    resolution: number,
    scale: number,
    drawing: boolean,
  ): FilterPlan {
    const res = resolution;
    const width = target.width / res;
    const height = target.height / res;
    if (plan.padding <= filterRoom(this.textureLimit, res, width, height)) {
      return plan;
    }

    const area = this.drawn;
    drawnArea(scene, rows, this.geometries, from, scale * res, area);
    const room = filterRoom(
      this.textureLimit,
      res,
      Math.min(area[2] / res, width) - Math.max(area[0] / res, 0),
      Math.min(area[3] / res, height) - Math.max(area[1] / res, 0),
    );
    const cap = paddingCap(plan.wanted, room);
    const kept = this.filterPlans.get(o);
    if (cap === Number.POSITIVE_INFINITY || !kept) {
      return plan;
    }

    if (drawing) {
      return planFilters(kept.records, kept.units, cap, plan) ?? plan;
    }

    if (kept.cap !== cap || !kept.capped) {
      kept.cap = cap;
      kept.capped = planFilters(kept.records, kept.units, cap, kept.capped ?? plan) ?? plan;
    }

    return kept.capped;
  }

  /** `plan`'s passes added to the frame's filters as a chain, their gradients' textures uploaded: its number. */
  chainOf(plan: FilterPlan, filters: Filters): number {
    for (const pass of plan.passes) {
      let texture = -1;
      if (pass.colors) {
        if (!pass.texture || !this.textures.alive(pass.texture)) {
          // A copy, as the backend lets the pixels it uploads go.
          pass.texture = this.textures.add(256, 1, pass.colors.slice(), GRADIENT_IDLE_FRAMES);
        }

        texture = pass.texture.id;
        this.textures.use(texture);
      } else if (pass.map) {
        // Its map as it is now, a texture of its pixels kept as a bitmap's is.
        if (pass.map.disposed) {
          continue;
        }

        // A map set anew is a copy anew, as a tween writing the filters takes one each frame:
        // its texture goes soon once the next one takes its place.
        texture = this.paints.storeTexture(pass.map, GRADIENT_IDLE_FRAMES).id;
        this.textures.use(texture);
      }

      filters.add(pass.kind, pass.values, texture);
    }

    return filters.close();
  }
}

/** Whether every layer `layer` is in has a size, as the planner draws only such. */
function drawnWithin(scene: SceneList, layer: number): boolean {
  const r = scene.layers;
  for (let p = scene.parents[layer]; p >= 0; p = scene.parents[p]) {
    if (r[p * 4 + 2] <= 0 || r[p * 4 + 3] <= 0) {
      return false;
    }
  }

  return true;
}
