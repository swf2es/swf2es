import { DisplayObject } from "./displayobject.js";

/** A Video: a box of the size it was made at, its bounds; the player plays no video in it, so it draws nothing. */
export class VideoObject extends DisplayObject {
  boxWidth = 320;
  boxHeight = 240;
}
