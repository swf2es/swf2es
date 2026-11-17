import type { VideoPicture, VideoSource } from "../media/video.js";
import { CONTENT, DisplayObject } from "./displayobject.js";

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

  /** Adobe documents clear as clearing the image, not stopping the stream. */
  clear(): void {
    this.clearedVersion = this.attached?.version ?? -1;
    this.invalidate(CONTENT);
  }
}
