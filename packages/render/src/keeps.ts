import { type Handle, Registry } from "./registry.js";

/** A kept output as its owner holds it: its id, and the generation the id had. */
export type KeepHandle = Handle;

/** Frames a kept output may go undrawn before it is let go of. */
export const KEEP_IDLE_FRAMES = 60;

/**
 * The layers kept from one frame to the next, as Flash keeps a filtered
 * object's bitmap while nothing in it changed: an owner adds one, names it
 * on the layer whose output it keeps, and composites it again while it
 * stands (SceneList.keptLayer). The backend holds their targets, and lets
 * go of those removed; what goes undrawn for KEEP_IDLE_FRAMES is removed.
 */
export class Keeps extends Registry {
  add(): KeepHandle {
    return this.hold(KEEP_IDLE_FRAMES);
  }
}
