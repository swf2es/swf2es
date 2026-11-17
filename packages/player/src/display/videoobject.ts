import type { VideoPicture, VideoSource } from "../media/video.js";
import { CONTENT, DisplayObject, PIXELS } from "./displayobject.js";

/** Video's display box is independent of the attached frame's dimensions. */
export class VideoObject extends DisplayObject {
  boxWidth = 320;
  boxHeight = 240;
  smoothing = false;
  private attached: VideoSource | null = null;
  private clearedVersion = -1;

  get source(): VideoSource | null {
    return this.attached;
  }

  set source(source: VideoSource | null) {
    this.attached?.views.delete(this.ref);
    this.attached = source;
    source?.views.add(this.ref);
    this.clearedVersion = -1;
    this.invalidate(CONTENT);
  }

  get picture(): VideoPicture | null {
    const source = this.attached;
    return source && source.version !== this.clearedVersion ? source.picture : null;
  }

  override pixelsChanged(disposed: boolean): void {
    let hidden: DisplayObject | null = null;
    for (let object: DisplayObject | null = this; object; object = object.parent) {
      if (object.maskOf || object.clipDepth > 0 || disposed) {
        super.pixelsChanged(disposed);
        return;
      }
      if (!object.visible && !hidden) {
        hidden = object;
      }
    }

    if (!hidden) {
      super.pixelsChanged(disposed);
      return;
    }

    // Keep cached layers fresh if shown before another render, without waking the stage.
    this.dirty |= PIXELS;
    for (let object: DisplayObject = this; object !== hidden && object.parent; ) {
      object.parent.descendantsDirty = true;
      object = object.parent;
    }
  }

  /** Adobe documents clear as clearing the image, not stopping the stream. */
  clear(): void {
    this.clearedVersion = this.attached?.version ?? -1;
    this.invalidate(CONTENT);
  }
}
