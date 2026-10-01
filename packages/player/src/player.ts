// A SWF loaded and played: its root clip on its first frame, and each tick
// a frame on, in the order Flash runs one: the clips that were on the
// display list advance their timelines (a clip made in this frame does not
// advance until the next), then the frame is drawn.
import { backgroundColor, readSwf } from "@swf2es/format";
import { Container, type DisplayObject, MovieClip } from "./display.js";
import { type Library, readLibrary } from "./timeline.js";

export class Player {
  readonly root: MovieClip;
  readonly library: Library;
  readonly width: number;
  readonly height: number;
  readonly frameRate: number;
  readonly background: number;

  constructor(bytes: Uint8Array) {
    const swf = readSwf(bytes);
    this.library = readLibrary(swf);
    this.width = Math.round((swf.frameSize.xMax - swf.frameSize.xMin) / 20);
    this.height = Math.round((swf.frameSize.yMax - swf.frameSize.yMin) / 20);
    this.frameRate = swf.frameRate || 24;
    this.background = backgroundColor(swf);
    this.root = new MovieClip(this.library.root, this.library);
    this.root.enterFirstFrame();
  }

  /** The next frame: every clip on the display list advances, parents before children. */
  tick(): void {
    const clips: MovieClip[] = [];
    const collect = (o: DisplayObject) => {
      if (o instanceof MovieClip) {
        clips.push(o);
      }

      if (o instanceof Container) {
        for (const child of o.children) {
          collect(child);
        }
      }
    };
    collect(this.root);
    for (const clip of clips) {
      // One a clip before it removed is no longer on the display list.
      if (clip === this.root || attached(clip, this.root)) {
        clip.advance();
      }
    }
  }
}

function attached(o: DisplayObject, root: DisplayObject): boolean {
  for (let p = o.parent; p; p = p.parent) {
    if (p === root) {
      return true;
    }
  }

  return false;
}
