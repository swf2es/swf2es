// A SWF loaded and played: its root clip on its first frame, and each tick
// a frame on, in the order Flash runs one: the clips that were on the
// display list advance their timelines (a clip made in this frame does not
// advance until the next); with scripts, the frame's events and scripts
// follow; then the frame is drawn.
import { backgroundColor, readSwf, type Swf } from "@swf2es/format";
import { Container, type DisplayObject, frameChildren, MovieClip } from "./display.js";
import { decodeImages, decodeInBrowser } from "./images.js";
import { PointerInput } from "./input.js";
import { KeyboardInput } from "./keyboard.js";
import type { Scripting } from "./scripting.js";
import { type Library, readLibrary } from "./timeline.js";

/** Frames one advance() may run to catch up with time passed. */
const MAX_CATCH_UP = 5;

export class Player {
  readonly swf: Swf;
  readonly root: MovieClip;
  /**
   * The stage, which holds the root and what scripts put beside it, as a
   * loader does the SWF it loads: what a host draws. With scripts,
   * flash.display.Stage's other face.
   */
  readonly stage = new Container();
  readonly library: Library;
  readonly width: number;
  readonly height: number;
  frameRate: number;
  private readonly swfBackground: number;
  /** The stage's colour, 0xRRGGBB: the SWF's SetBackgroundColor until a script sets Stage.color; a host that reads it each frame follows that. */
  get background(): number {
    return this.scripting?.stageColor ?? this.swfBackground;
  }

  /** Renderer-independent mouse routing, once scripts have been loaded. */
  readonly pointer: PointerInput | null;
  /** The keyboard's, likewise: keys to the focused object, and typing into a focused field. */
  readonly keyboard: KeyboardInput | null;

  /**
   * Without scripts the player is ready at once, but for the images of
   * its bitmap fills, which `start` decodes; with them, `start` loads the
   * SWF's code and constructs the root, which is asynchronous.
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
    this.swfBackground = backgroundColor(this.swf);
    this.keyboard = scripting ? new KeyboardInput(this.stage, scripting) : null;
    this.pointer = scripting ? new PointerInput(this.stage, scripting, this.keyboard) : null;
    if (scripting) {
      scripting.pointer = this.pointer;
    }
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
      // Its bitmap fills' images, which a SWF with scripts decodes as it links.
      await decodeImages(this.library, decodeInBrowser);
      return;
    }

    await s.loadSwf(this.swf, this.library);
    s.stage = this.stage;
    s.root = this.root;
    s.stageWidth = this.width;
    s.stageHeight = this.height;
    s.stageColor = this.swfBackground;
    s.frameRate = this.frameRate;
    s.constructAs(this.stage, s.rt.classNamed("flash.display::Stage"));
    // The first frame has its time too: the clock is a frame's duration on as it runs, as in Flash.
    s.beginFrame(1000 / this.frameRate);
    // The main SWF's LoaderInfo: on the root, which every display object under it reports.
    const info = s.loaderInfo(null);
    s.describe(info, this.bytes, this.swf);
    info.$loaded = this.bytes.length;
    info.$url = s.url;
    info.$params = s.mainParameters();
    this.root.loaderInfo = info;
    // The main SWF's root is root1, as Flash names the root at depth 0.
    this.root.name = "root1";
    // Its first frame's children are there before the document class's constructor runs.
    this.root.placeFirstFrame();
    // A document class's constructor that throws is reported, and the SWF
    // plays on as far as it got, as in Flash and Ruffle: the object is the
    // root's from its super() on, its listeners and frame scripts kept.
    try {
      s.constructAs(
        this.root,
        s.rt.classNamed(this.library.classes.get(0) ?? "flash.display::MovieClip", s.mainDomain),
      );
    } catch (error) {
      s.reportUncaught(error);
    }

    info.$content = this.root.object ?? null;
    s.mainLoaded(info);
    this.root.enterFirstFrame();
    s.frame(this.stage, false);
    this.frameRate = s.frameRate;
  }

  /** Time a host has let pass, in ms, still to be played as frames. */
  private owed = 0;
  /** Frames played. */
  private played = 0;
  /** The clips a frame advances, kept for the next: thousands in a crowded room, grown anew each frame else. */
  private readonly advancing: MovieClip[] = [];

  /**
   * A count that moves whenever what the player shows may have changed: a
   * frame played, a key, a pointer event that changes a button, focus or a
   * selection, a script's updateAfterEvent, or a call from the page into
   * one of the SWF's ExternalInterface callbacks. A plain pointer move
   * does not: what its listeners change shows at the next frame, as Flash
   * and Ruffle draw it, so a fast mouse does not draw faster than the SWF.
   * Loads and socket data arrive in a frame. A host that draws only when
   * this moved draws every frame Flash would, and none in between, once it
   * has drawn after start; what the host itself changes, a resize, it
   * draws for itself.
   */
  get changes(): number {
    return (
      this.played +
      (this.pointer?.redraws ?? 0) +
      (this.scripting?.updates ?? 0) +
      (this.keyboard?.handled ?? 0) +
      (this.scripting?.hostCalls ?? 0)
    );
  }

  /**
   * Play what `dt` milliseconds are worth, a frame per frame's duration at
   * the frame rate, the rest kept for the next call; at most MAX_CATCH_UP
   * frames at once, so that a long pause does not become a spiral of
   * catching up, as Ruffle paces. A host playing in real time calls this
   * each animation frame; the tests step frames with tick(). Returns how
   * many frames it played.
   */
  advance(dt: number): number {
    // The pointer's last move, so the frame's scripts see where it is now.
    this.pointer?.flush();
    this.owed += Math.max(0, dt);
    let n = 0;
    while (n < MAX_CATCH_UP && this.owed >= 1000 / this.frameRate) {
      this.owed -= 1000 / this.frameRate;
      this.tick();
      n++;
    }

    // What could not be caught up with is let go, not owed for ever; less than a frame is kept.
    if (this.owed >= 1000 / this.frameRate) {
      this.owed = 0;
    }

    return n;
  }

  /**
   * The next frame: every clip advances, those on the display list, parents
   * before children, loaded SWFs' too, and the orphans a script took off it,
   * which play on; all of them, found first, so that one a parent's frame
   * takes off still has its frame, as in Flash. Then the frame's scripts.
   */
  tick(): void {
    this.played++;
    this.scripting?.beginFrame(1000 / this.frameRate);
    const clips = this.advancing;
    const collect = (o: DisplayObject) => {
      if (o instanceof MovieClip) {
        // One a goto made sit this frame out takes all in it along.
        if (o.skipsAfter >= 0 && o.skipsAfter === this.scripting?.frames) {
          return;
        }

        clips.push(o);
      }

      // A button's states all play, whichever it shows. An index, not for-of:
      // this visits every object on the list each frame.
      const children = frameChildren(o);
      for (let i = 0; i < children.length; i++) {
        collect(children[i]);
      }
    };
    collect(this.stage);
    for (const orphan of this.scripting?.orphanRoots() ?? []) {
      collect(orphan);
    }

    for (const clip of clips) {
      clip.advance();
    }

    // Emptied, so that a clip taken off since is not held till the next frame.
    clips.length = 0;

    if (this.scripting) {
      this.scripting.frame(this.stage);
      this.frameRate = this.scripting.frameRate;
    }
  }
}
