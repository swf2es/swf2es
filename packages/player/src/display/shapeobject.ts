// A Shape or MorphShape a timeline placed or a script made, and what
// Flash's bitmap cache of one still shows after its shape is swapped.
import type { ColorTransform, Place } from "@swf2es/format";
import { IDENTITY_COLOR } from "./color.js";
import { CONTENT, DisplayObject, pickWork, TRANSFORM } from "./displayobject.js";
import type { Filter } from "./filters.js";
import { morphAt } from "./morph.js";
import type { MorphCharacter, ShapeCharacter } from "./timeline.js";

export class ShapeObject extends DisplayObject {
  /** The shape it draws, or last drew; null for a Shape a script made, which draws nothing yet. */
  shape: ShapeCharacter | null;
  /** A MorphShape's morph, which `shape` is a blend of. */
  morph: MorphCharacter | null = null;
  /**
   * The blend drawn() last made, and its morph and ratio: it stands while
   * `shape` is still it, which a swap to a shape is not.
   */
  private blended: { morph: MorphCharacter; ratio: number; shape: ShapeCharacter } | null = null;
  /**
   * The shape Flash's bitmap cache of it still shows, given another of the
   * same bounds while cached (`swap`), and the look it was cached with;
   * null where it draws what it is. It goes for good when the look does.
   */
  stale: StaleCache | null = null;

  constructor(shape: ShapeCharacter | null) {
    super();
    this.shape = shape;
    this.character = shape;
  }

  /** A MorphShape, its morph's start until its first place gives it a ratio. */
  static ofMorph(morph: MorphCharacter): ShapeObject {
    const shape = morphAt(morph, 0);
    const object = new ShapeObject(shape);
    object.morph = morph;
    object.blended = { morph, ratio: 0, shape };
    object.character = morph;
    object.unplaced = true;
    return object;
  }

  /** A MorphShape not yet placed, which its first place blends at once. */
  private unplaced = false;

  /**
   * A MorphShape made by a place is blended at its ratio there and then;
   * one placed again takes on a new ratio only when it is next drawn
   * (drawn), and until then a test of a point against its shape finds
   * nothing (blending), as in Flash (the `morph-bounds` cases). What
   * scripts are told of its bounds is its start's (ownBounds).
   */
  override applyPlace(place: Place): void {
    const ratio = this.ratio;
    super.applyPlace(place);

    const morph = this.morph;
    if (morph && this.unplaced) {
      this.shape = morphAt(morph, this.ratio);
      this.blended = { morph, ratio: this.ratio, shape: this.shape };
    }

    this.unplaced = false;
    if (morph && this.ratio !== ratio) {
      this.invalidate(CONTENT);
    }
  }

  /** Whether it is a MorphShape whose ratio or morph has changed since it was last blended. */
  get blending(): boolean {
    const b = this.blended;
    return (
      this.morph !== null &&
      (b?.morph !== this.morph || b.ratio !== this.ratio || b.shape !== this.shape)
    );
  }

  /** The shape to draw now: a MorphShape's blend at its ratio, which it keeps from here. */
  drawn(): ShapeCharacter | null {
    // The blend it has is kept while its morph and ratio are: asking the
    // morph again would turn over its few latest blends for nothing.
    if (this.morph && this.blending) {
      this.shape = morphAt(this.morph, this.ratio);
      this.blended = { morph: this.morph, ratio: this.ratio, shape: this.shape };
      // New bounds, which no invalidate tells of: the change of ratio did,
      // but those it marked may have been measured since, with the old blend.
      pickWork.changes++;
      this.pickChanged(true);
    }

    return this.shape;
  }

  /**
   * Flash draws the object again, its cache gone stale or not, for another
   * scale, turn or skew, colour or filters; not when it only moves
   * (`cache-replace`). The cache turned off counts only where a frame is
   * drawn so: off and on again in between, it stands (the view's to tell).
   */
  override invalidate(what: number): void {
    const stale = this.stale;
    if (stale && what & TRANSFORM && !stale.stands(this)) {
      this.stale = null;
      what |= CONTENT;
    }

    super.invalidate(what);
  }
}

/** What a bitmap cache was drawn of, and the look it was drawn with. */
export class StaleCache {
  private readonly a: number;
  private readonly b: number;
  private readonly c: number;
  private readonly d: number;
  private readonly color: ColorTransform | null;
  private readonly filters: readonly Filter[];

  constructor(
    readonly shape: ShapeCharacter,
    o: DisplayObject,
  ) {
    ({ a: this.a, b: this.b, c: this.c, d: this.d } = o.matrix);
    this.color = o.colorTransform;
    this.filters = o.filters;
  }

  stands(o: DisplayObject): boolean {
    const m = o.matrix;
    return (
      m.a === this.a &&
      m.b === this.b &&
      m.c === this.c &&
      m.d === this.d &&
      sameColor(o.colorTransform, this.color) &&
      sameFilters(o.filters, this.filters)
    );
  }
}

/**
 * A place's filters are read anew at each move, the same or not. Those
 * from a SWF are plain records; a script's displacement map holds its
 * bitmap, so another list with one counts as other filters.
 */
function sameFilters(a: readonly Filter[], b: readonly Filter[]): boolean {
  if (a === b) {
    return true;
  }

  if (a.length !== b.length || a.some((f) => f.kind === "displacementMap")) {
    return false;
  }

  return JSON.stringify(a) === JSON.stringify(b);
}

/** Whether Flash draws `o` from a bitmap it keeps: cacheAsBitmap set, or filters. */
export function cached(o: DisplayObject): boolean {
  return o.cachedAsBitmap || o.filters.length > 0;
}

function sameColor(a: ColorTransform | null, b: ColorTransform | null): boolean {
  const x = a ?? IDENTITY_COLOR;
  const y = b ?? IDENTITY_COLOR;
  return (
    x.rMul === y.rMul &&
    x.gMul === y.gMul &&
    x.bMul === y.bMul &&
    x.aMul === y.aMul &&
    x.rAdd === y.rAdd &&
    x.gAdd === y.gAdd &&
    x.bAdd === y.bAdd &&
    x.aAdd === y.aAdd
  );
}
