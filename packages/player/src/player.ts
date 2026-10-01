// A SWF loaded and played: its root clip on its first frame, and each tick
// a frame on, in the order Flash runs one: the clips that were on the
// display list advance their timelines (a clip made in this frame does not
// advance until the next); with scripts, the frame's events and scripts
// follow; then the frame is drawn.
import { backgroundColor, readSwf, type Swf } from "@swf2es/format";
import { Container, type DisplayObject, MovieClip } from "./display.js";
import type { Scripting } from "./scripting.js";
import { type Library, readLibrary } from "./timeline.js";

export class Player {
  readonly swf: Swf;
  readonly root: MovieClip;
  /** The stage, which holds the root; with scripts, flash.display.Stage's other face. */
  readonly stage = new Container();
  readonly library: Library;
  readonly width: number;
  readonly height: number;
  frameRate: number;
  readonly background: number;

  /**
   * Without scripts the player is ready at once; with them, `start`
   * loads the SWF's code and constructs the root, which is asynchronous.
   */
  constructor(
    readonly bytes: Uint8Array,
    readonly scripting: Scripting | null = null,
  ) {
    this.swf = readSwf(bytes);
    this.library = readLibrary(this.swf);
    this.width = Math.round((this.swf.frameSize.xMax - this.swf.frameSize.xMin) / 20);
    this.height = Math.round((this.swf.frameSize.yMax - this.swf.frameSize.yMin) / 20);
    this.frameRate = this.swf.frameRate || 24;
    this.background = backgroundColor(this.swf);
    this.root = new MovieClip(this.library.root, this.library);
    this.stage.addChildAt(this.root, 0);
    if (!scripting) {
      this.root.enterFirstFrame();
    }
  }

  /**
   * With scripts: load the SWF's code, make the stage's and the root's
   * AS3 objects (the root's of the document class, SymbolClass's id 0, or
   * MovieClip), which enters the first frame, and run its scripts, as
   * Flash has done when it dispatches INIT.
   */
  async start(): Promise<void> {
    const s = this.scripting;
    if (!s) {
      return;
    }

    await s.loadSwf(this.swf, this.library);
    s.stage = this.stage;
    s.root = this.root;
    s.stageWidth = this.width;
    s.stageHeight = this.height;
    s.frameRate = this.frameRate;
    s.constructAs(this.stage, s.rt.classNamed("flash.display::Stage"));
    // The main SWF's LoaderInfo: on the root, which every display object under it reports.
    const info = s.loaderInfo(null);
    s.describe(info, this.bytes, this.swf);
    info.$loaded = this.bytes.length;
    info.$url = s.url;
    this.root.loaderInfo = info;
    const object = s.constructAs(
      this.root,
      s.rt.classNamed(this.library.classes.get(0) ?? "flash.display::MovieClip"),
    );
    info.$content = object;
    this.root.enterFirstFrame();
    s.frame(this.stage, false);
    this.frameRate = s.frameRate;
  }

  /**
   * The next frame: every clip advances, those on the display list, parents
   * before children, loaded SWFs' too, and the orphans a script took off it,
   * which play on; all of them, found first, so that one a parent's frame
   * takes off still has its frame, as in Flash. Then the frame's scripts.
   */
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
    collect(this.stage);
    for (const orphan of this.scripting?.orphanRoots() ?? []) {
      collect(orphan);
    }

    for (const clip of clips) {
      clip.advance();
    }

    if (this.scripting) {
      this.scripting.frame(this.stage);
      this.frameRate = this.scripting.frameRate;
    }
  }
}
