// A Shape or MorphShape a timeline placed or a script made, and what
// Flash's bitmap cache of one still shows after its shape is swapped.
import type { ColorTransform, Place } from "@swf2es/format";
import { IDENTITY_COLOR } from "./color.js";
import { CONTENT, DisplayObject, pickWork, TRANSFORM } from "./displayobject.js";
import type { Filter } from "./filters.js";
import { morphAt } from "./morph.js";
import type { MorphCharacter, ShapeCharacter } from "./timeline.js";

/**
 * Frames drawn, or played and not drawn (framePassed), so far: a MorphShape
 * placed at another ratio since the last is blending. One count for every
 * player on the page, as pickWork is.
 */
export const blendWork = { frames: 0 };

/** A frame drawn, or played with no draw to follow, which ends what blending its places began. */
export function framePassed(): void {
  blendWork.frames++;
}

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
  /** The blendWork frame in which a place last gave it another ratio or morph; -1 for none. */
  private placedIn = -1;
  /** Its ratio and morph as that frame began, which the last frame passed blended. */
  private settledRatio = 0;
  private settledMorph: MorphCharacter | null = null;

  /**
   * A MorphShape made by a place is blended at its ratio there and then;
   * one placed at another ratio is blending until a frame is drawn, or
   * played undrawn (framePassed): a script's test of a point against its
   * shape finds nothing of it meanwhile, as in adl, unless it is back at
   * the ratio the last frame had (the `morph-bounds` cases), and the
   * pointer meets the blend it last made, as Flash's does under a resting
   * or moving mouse. What scripts are told of its bounds is its start's
   * (ownBounds).
   */
  override applyPlace(place: Place): void {
    const ratio = this.ratio;
    super.applyPlace(place);

    const morph = this.morph;
    if (morph && this.unplaced) {
      this.shape = morphAt(morph, this.ratio);
      this.blended = { morph, ratio: this.ratio, shape: this.shape };
    } else if (morph && this.ratio !== ratio) {
      this.placing(ratio, morph);
    }

    this.unplaced = false;
    if (morph && this.ratio !== ratio) {
      this.invalidate(CONTENT);
    }
  }

  /** Another morph placed in its stead (movieclip.ts swap): blending, as a new ratio is. */
  takeMorph(morph: MorphCharacter): void {
    this.placing(this.ratio, this.morph);
    this.morph = morph;
  }

  /** A place changes its ratio or morph from these: the first in a frame keeps them as settled. */
  private placing(ratio: number, morph: MorphCharacter | null): void {
    if (this.placedIn !== blendWork.frames) {
      this.placedIn = blendWork.frames;
      this.settledRatio = ratio;
      this.settledMorph = morph;
    }
  }

  /**
   * Whether it is a MorphShape placed, since the last frame passed, at
   * another ratio or morph than that frame left it with. Only places and
   * frames passing change it: a blend a script's draw or readGraphicsData
   * makes meanwhile does not.
   */
  get blending(): boolean {
    return (
      this.morph !== null &&
      this.placedIn === blendWork.frames &&
      (this.ratio !== this.settledRatio || this.morph !== this.settledMorph)
    );
  }

  /** The shape to draw now: a MorphShape's blend at its ratio, which it keeps from here. */
  drawn(): ShapeCharacter | null {
    // The blend it has is kept while its morph and ratio are: asking the
    // morph again would turn over its few latest blends for nothing.
    const b = this.blended;
    if (
      this.morph &&
      (b?.morph !== this.morph || b.ratio !== this.ratio || b.shape !== this.shape)
    ) {
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
