// A Shape's stale bitmap cache as the view draws it (RenderView): Flash
// shows the cache of a Shape given another of the same bounds while
// cached, until it is drawn at another scale or turn, or its cache goes.
import { cached, type ShapeObject, type StaleCache } from "../display/shapeobject.js";
import type { ShapeCharacter } from "../display/timeline.js";

export class StaleShapes {
  /** Each stale cache a Shape has shown, and the scale and turn it was first drawn at. */
  private readonly stales = new WeakMap<
    ShapeObject,
    { cache: StaleCache; a: number; b: number; c: number; d: number; spent: boolean }
  >();

  /**
   * The shape a Shape draws: the one Flash's stale bitmap cache shows, given
   * another of the same bounds while cached (display/shapeobject.ts), while
   * it stands on the stage at the scale and turn (a b c d) it was first
   * drawn at and stays cached; from a frame either changes, what it is
   * (`cache-replace`). Only a frame that
   * draws it decides: one walked hidden draws nothing of it, and
   * BitmapData.draw's walk is in the bitmap's space, which shows the cache
   * as the stage last did.
   */
  staleShape(
    o: ShapeObject,
    hidden: boolean,
    snapshotting: boolean,
    a: number,
    b: number,
    c: number,
    d: number,
  ): ShapeCharacter | null {
    const cache = o.stale;
    if (!cache || hidden) {
      return o.drawn();
    }

    let seen = this.stales.get(o);
    if (snapshotting) {
      return seen?.cache === cache && seen.spent ? o.drawn() : cache.shape;
    }

    if (!seen || seen.cache !== cache) {
      // A first frame with its cache off already draws it as it is.
      seen = { cache, a, b, c, d, spent: !cached(o) };
      this.stales.set(o, seen);
    } else if (
      !seen.spent &&
      (seen.a !== a || seen.b !== b || seen.c !== c || seen.d !== d || !cached(o))
    ) {
      seen.spent = true;
    }

    return seen.spent ? o.drawn() : cache.shape;
  }
}
