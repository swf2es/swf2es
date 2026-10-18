import type { BitmapStore } from "../bitmap/bitmap.js";
import { CONTENT, DisplayObject } from "./displayobject.js";
import type { BitmapCharacter } from "./timeline.js";

/** A Bitmap: a display object that shows a BitmapData's pixels, its bounds the data's size. */
export class BitmapObject extends DisplayObject {
  private shown: BitmapStore | null = null;
  smoothing = false;
  pixelSnapping = "auto";
  /** The SWF's bitmap it shows a copy of, placed by a timeline or made by its class; null for one a script made. */
  character: BitmapCharacter | null = null;
  /** PlaceObject3's HasImage where a timeline placed it: Flash then takes a bound class for its data's. */
  hasImage = false;

  constructor(store: BitmapStore | null) {
    super();
    this.store = store;
  }

  /** The store shown; the object watches it, so a pixel set marks the object for the renderer. */
  get store(): BitmapStore | null {
    return this.shown;
  }

  set store(store: BitmapStore | null) {
    this.shown?.views.delete(this.ref);
    this.shown = store;
    store?.views.add(this.ref);
    this.invalidate(CONTENT);
  }
}
