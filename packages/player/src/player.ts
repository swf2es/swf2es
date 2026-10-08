// A SWF loaded and played: its root clip on its first frame, and each tick
// a frame on, in the order Flash runs one: the clips that were on the
// display list advance their timelines (a clip made in this frame does not
// advance until the next); with scripts, the frame's events and scripts
// follow; then the frame is drawn.
import { backgroundColor, readSwf, type Swf } from "@swf2es/format";
import { decodeImages, decodeInBrowser } from "./bitmap/images.js";
import { CLIP, Container, type DisplayObject, MovieClip, OTHER } from "./display/display.js";
import { type Library, readLibrary } from "./display/timeline.js";
import { KeyboardInput } from "./input/keyboard.js";
import { PointerInput } from "./input/pointer.js";
import type { Scripting } from "./scripting.js";

/** Frames one advance() may run at most, however fast the SWF and slow the display. */
const MAX_FRAMES_PER_CALL = 5;
/** The host's recent calls to advance() whose lower median is its typical interval. */
const INTERVALS = 9;
/** Calls seen before the typical interval is trusted; until then, a frame per call at most. */
const MIN_INTERVALS = 3;
/**
 * The longest typical interval taken for a display's, in ms: none
 * refreshes slower than about 30 Hz. Longer, the host is lagging, its
 * calls stretched by the frames themselves, and more frames a call would
 * feed the lag; it gets one a call and the content slows down, as Flash's.
 */
const DISPLAY_INTERVAL = 36;

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

    await s.code.loadSwf(this.swf, this.library);
    s.stage = this.stage;
    s.root = this.root;
    s.stageWidth = this.width;
    s.stageHeight = this.height;
    s.stageColor = this.swfBackground;
    s.frameRate = this.frameRate;
    s.constructAs(this.stage, s.rt.classNamed("flash.display::Stage"));
    // The first frame has its time too: the clock is a frame's duration on as it runs, as in Flash.
    s.timers.beginFrame(1000 / this.frameRate);
    // The main SWF's LoaderInfo: on the root, which every display object under it reports.
    const info = s.loads.loaderInfo(null);
    s.loads.describe(info, this.bytes, this.swf);
    info.$loaded = this.bytes.length;
    info.$url = s.url;
    info.$params = s.loads.mainParameters();
    this.root.loaderInfo = info;
    // The stage's too: what a script puts on the stage itself has the stage
    // for its root and this for its LoaderInfo, and takes hits, as in Flash.
    this.stage.loaderInfo = info;
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
    s.loads.mainLoaded(info);
    this.root.enterFirstFrame();
    s.frame(this.stage, false);
    this.frameRate = s.frameRate;
  }

  /** Whether destroy has been called. */
  get destroyed(): boolean {
    return this.stopped;
  }

  private stopped = false;

  /**
   * Stop for good: no frame plays after, and with scripts their sounds,
   * connections and fetches end (Scripting.destroy). What the host made
   * for the player, its renderer, its input bindings and its loop, is the
   * host's to let go.
   */
  destroy(): void {
    this.stopped = true;
    this.scripting?.destroy();
  }

  /** Time a host has let pass, in ms, still to be played as frames. */
  private owed = 0;
  /** The last INTERVALS times passed to advance(), a ring, for the host's typical interval. */
  private readonly intervals: number[] = [];
  private nextInterval = 0;
  private readonly sortedIntervals: number[] = [];
  /** Frames played. */
  private played = 0;
  /** The clips a tick advances, kept: the whole display list's, every frame. Null while in use. */
  private ticking: (MovieClip | null)[] | null = [];

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
   * Play what `dt` milliseconds are worth, as Flash paces: frames on a
   * grid of the frame rate's duration, and those a long frame or a stall
   * lost dropped, not caught up with. Flash runs the frame due at once
   * after an overrun and the next one at its slot on the grid, never two
   * back to back (measured in adl, docs/architecture.md), so content that
   * moves by the time between frames always sees time pass between them.
   * A call runs as many frames as the host's typical interval holds, the
   * lower median of its recent calls and never the current one, so a
   * hitch does not become a burst: one where the SWF's frame is as long
   * as the display's or longer, more for a SWF faster than the display,
   * and one while the interval is longer than a display's. A `dt` that is
   * not a finite positive number counts as none. A host playing in real
   * time calls this each animation frame; the tests step frames with
   * tick(). Returns how many frames it played.
   */
  advance(dt: number): number {
    if (this.stopped) {
      return 0;
    }

    // The pointer's last move, so the frame's scripts see where it is now.
    this.pointer?.flush();
    const passed = Number.isFinite(dt) && dt > 0 ? dt : 0;
    const frame = 1000 / this.frameRate;
    const typical = this.typicalInterval(passed);
    const most =
      typical > DISPLAY_INTERVAL
        ? 1
        : Math.min(MAX_FRAMES_PER_CALL, Math.max(1, Math.round(typical / frame)));
    this.owed += passed;
    // How many frames play and what is owed after, worked out first: the
    // timers fire by each frame's time on the grid, not the call's.
    let n = 0;
    let rest = this.owed;
    while (n < most && rest >= frame) {
      rest -= frame;
      n++;
    }

    // Whole frames lost are dropped, the part of one kept for the grid's
    // phase; but not within half an interval of the next, where a call
    // that came a little early leaves one owed under ordinary jitter.
    if (rest >= frame + Math.min(frame, typical) / 2) {
      rest %= frame;
    }

    this.owed = rest;
    const timers = this.scripting?.timers;
    timers?.hostPassed(passed);
    try {
      for (let i = 0; i < n; i++) {
        timers?.frameAt((n - 1 - i) * frame, rest);
        this.tick();
      }
    } finally {
      timers?.frameAt(Number.NaN, Number.NaN);
    }

    // Flash fires timers shorter than a frame between frames too: a call
    // that played none checks them.
    if (n === 0) {
      timers?.betweenFrames(frame);
    }

    return n;
  }

  /** `dt` recorded, and the lower median of the recent intervals; 0 until there are a few. */
  private typicalInterval(dt: number): number {
    const intervals = this.intervals;
    if (intervals.length < INTERVALS) {
      intervals.push(dt);
    } else {
      intervals[this.nextInterval] = dt;
      this.nextInterval = (this.nextInterval + 1) % INTERVALS;
    }

    if (intervals.length < MIN_INTERVALS) {
      return 0;
    }

    const sorted = this.sortedIntervals;
    sorted.length = 0;
    for (let i = 0; i < intervals.length; i++) {
      sorted.push(intervals[i]);
    }

    sorted.sort((a, b) => a - b);
    return sorted[(sorted.length - 1) >> 1];
  }

  /**
   * The next frame: every clip advances, those on the display list, parents
   * before children, loaded SWFs' too, and the orphans a script took off it,
   * which play on; all of them, found first, so that one a parent's frame
   * takes off still has its frame, as in Flash. Then the frame's scripts.
   */
  tick(): void {
    if (this.stopped) {
      return;
    }

    this.played++;
    this.scripting?.timers.beginFrame(1000 / this.frameRate);
    const clips = this.ticking ?? [];
    this.ticking = null;
    let count = 0;
    const collect = (o: DisplayObject) => {
      if (o.kind === CLIP) {
        // One a goto made sit this frame out takes all in it along.
        const clip = o as MovieClip;
        if (clip.skipsAfter >= 0 && clip.skipsAfter === this.scripting?.frames) {
          return;
        }

        clips[count++] = clip;
      }

      // A button's states all play, whichever it shows. An index, not for-of,
      // and no call for a leaf: this visits every object on the list each frame.
      const children = o.frameChildren;
      for (let i = 0; i < children.length; i++) {
        const child = children[i];
        if (child.kind !== OTHER || child.frameChildren.length !== 0) {
          collect(child);
        }
      }
    };
    collect(this.stage);
    for (const orphan of this.scripting?.lifecycle.orphanRoots() ?? []) {
      collect(orphan);
    }

    // Let go of once advanced, so that the kept list holds none past the tick.
    try {
      for (let i = 0; i < count; i++) {
        (clips[i] as MovieClip).advance();
      }
    } finally {
      clips.fill(null, 0, count);
      this.ticking = clips;
    }

    if (this.scripting) {
      this.scripting.frame(this.stage);
      this.frameRate = this.scripting.frameRate;
    }
  }
}
