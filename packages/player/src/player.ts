// A SWF loaded and played: its root clip on its first frame, and each tick
// a frame on, in the order Flash runs one: the clips that were on the
// display list advance their timelines (a clip made in this frame does not
// advance until the next); with scripts, the frame's events and scripts
// follow, or an AVM1 SWF's actions; then the frame is drawn.
import { backgroundColor, readSwf, type Swf } from "@swf2es/format";
import type { Avm1 } from "./avm1/avm1.js";
import { Avm1Keyboard } from "./avm1/keyboard.js";
import { Avm1Pointer } from "./avm1/pointer.js";
import { decodeImages, decodeInBrowser } from "./bitmap/images.js";
import { drawKernelFrame, drawKernelLetGo, drawKernelUsed } from "./bitmap/kernel.js";
import {
  BUTTON,
  type ButtonObject,
  CLIP,
  Container,
  type DisplayObject,
  MovieClip,
  OTHER,
  unloads,
  walkList,
} from "./display/display.js";
import { setStageSize } from "./display/perspective.js";
import { type Library, readLibrary } from "./display/timeline.js";
import { customContextMenu, type MenuItem } from "./input/context-menu.js";
import { type Keyboard, KeyboardInput } from "./input/keyboard.js";
import { type Pointer, PointerInput, type PointerState } from "./input/pointer.js";
import { TouchInput } from "./input/touch.js";
import { soundHostOf, streamFrames } from "./media/sounds.js";
import type { Scripting } from "./scripting.js";

/** Ordinary frames one advance() may run at most, however fast the SWF and slow the display. */
const MAX_FRAMES_PER_CALL = 5;
/** A stream may catch up further when its scripts are cheap; input still gets a bounded turn. */
const MAX_STREAM_FRAMES = 60;
const MIN_STREAM_BUDGET_MS = 8;
const MAX_STREAM_BUDGET_MS = 50;
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
/**
 * The longest a frame waits for a load from bytes, in ms of the host's
 * time (Scripting.holdsFrame): a load that never ends does not stop the
 * player for good.
 */
const HOLD_LIMIT = 10_000;

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

  /**
   * The stage's quality, "LOW" to "BEST": the host's at the start, then what
   * a script sets, Stage.quality or AVM1's _quality; a host that reads it
   * each frame draws by it.
   */
  get quality(): string {
    return this.scripting?.quality ?? this.avm1?.quality ?? "HIGH";
  }

  set quality(quality: string) {
    if (this.scripting) {
      this.scripting.quality = quality;
    }

    if (this.avm1) {
      this.avm1.quality = quality;
    }
  }

  /** The host's build, a short commit or a version, which the context menu's About item names. */
  build: string | null = null;

  private defaultContextMenu = true;

  get showDefaultContextMenu(): boolean {
    return this.scripting?.showDefaultContextMenu ?? this.defaultContextMenu;
  }

  set showDefaultContextMenu(value: boolean) {
    this.defaultContextMenu = value;
    if (this.scripting) {
      this.scripting.showDefaultContextMenu = value;
    }
  }

  /** Renderer-independent mouse routing, once scripts have been loaded. */
  readonly pointer: Pointer | null;
  private readonly avm1Pointer: Avm1Pointer | null;
  /** The keyboard's, likewise: keys to the focused object, and typing into a focused field. */
  readonly keyboard: Keyboard | null;
  /** Touches, likewise: TouchEvents, and the mouse the primary touch moves. */
  readonly touch: TouchInput | null;

  /**
   * Without scripts the player is ready at once, but for the images of
   * its bitmap fills, which `start` decodes; with them, `start` loads the
   * SWF's code and constructs the root, which is asynchronous. An AVM1
   * SWF's actions run with `avm1`, which `start` compiles them for; an
   * ActionScript 3 SWF's never do.
   */
  constructor(
    readonly bytes: Uint8Array,
    readonly scripting: Scripting | null = null,
    readonly avm1: Avm1 | null = null,
  ) {
    this.swf = readSwf(bytes);
    this.library = readLibrary(this.swf);
    this.width = Math.round((this.swf.frameSize.xMax - this.swf.frameSize.xMin) / 20);
    this.height = Math.round((this.swf.frameSize.yMax - this.swf.frameSize.yMin) / 20);
    setStageSize(this.stage, this.width, this.height);
    this.frameRate = this.swf.frameRate || 24;
    this.swfBackground = backgroundColor(this.swf);
    drawKernelUsed();
    const keyboard = scripting ? new KeyboardInput(this.stage, scripting) : null;
    // An AVM1 SWF's keys go to Key, its buttons and its clips.
    this.keyboard = keyboard ?? (avm1 && !scripting ? new Avm1Keyboard(avm1) : null);
    const pointer = scripting ? new PointerInput(this.stage, scripting, keyboard) : null;
    // An AVM1 SWF's buttons and clips take the pointer by AVM1's rules.
    this.avm1Pointer = avm1 && !scripting ? new Avm1Pointer(this.stage, avm1) : null;
    this.pointer = pointer ?? this.avm1Pointer;
    this.touch = pointer && scripting ? new TouchInput(this.stage, scripting, pointer) : null;
    if (scripting) {
      scripting.pointer = pointer;
    }
    this.root = new MovieClip(this.library.root, this.library);
    this.stage.addChildAt(this.root, 0);
    // An AVM1 SWF's clips play through its AVM1, from the first frame on.
    avm1?.attach(this.swf, this.library, this.root, bytes.length);
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
      // Its first frame's actions, once its code is loaded.
      if (this.avm1) {
        await this.avm1.load(this.swf);
      }

      return;
    }

    await s.code.loadSwf(this.swf, this.library);
    s.stage = this.stage;
    s.root = this.root;
    s.stageWidth = this.width;
    s.stageHeight = this.height;
    s.onStageLayout?.();
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
    let constructed = false;
    try {
      s.constructAs(
        this.root,
        s.rt.classNamed(this.library.classes.get(0) ?? "flash.display::MovieClip", s.mainDomain),
      );
      constructed = true;
      s.lifecycle.rootConstructed(this.root);
    } catch (error) {
      s.reportUncaught(error);
    }

    info.$content = this.root.object ?? null;
    s.loads.mainLoaded(info, constructed);
    this.root.enterFirstFrame();
    s.frame(this.stage, false);
    this.frameRate = s.frameRate;
  }

  /** Whether destroy has been called. */
  get destroyed(): boolean {
    return this.stopped;
  }

  private stopped = false;

  /** Snapshot the SWF's menu on demand; hosts keep the callbacks only while it is open. */
  contextMenu(p: PointerState): MenuItem[] {
    if (this.stopped) {
      return [];
    }

    this.pointer?.flush();
    const s = this.scripting;
    let menu = { items: [] as MenuItem[], quality: this.showDefaultContextMenu };
    try {
      if (s) {
        menu = s.clipboard.gesture(() => customContextMenu(s, this.stage, p));
        s.updates++;
      }
    } catch (error) {
      s?.reportUncaught(error);
    }

    if (menu.quality) {
      const qualities = ["LOW", "MEDIUM", "HIGH", "BEST"];
      for (let i = 0; i < qualities.length; i++) {
        const quality = qualities[i];
        menu.items.push({
          caption: `Quality: ${quality[0]}${quality.slice(1).toLowerCase()}`,
          enabled: true,
          checked: this.quality === quality,
          separatorBefore: i === 0 && menu.items.length > 0,
          select: () => {
            if (!this.stopped) {
              this.quality = quality;
            }
          },
        });
      }
    }

    return menu.items;
  }

  /**
   * Stop for good: no frame plays after, and with scripts their sounds,
   * connections and fetches end (Scripting.destroy). What the host made
   * for the player, its renderer, its input bindings and its loop, is the
   * host's to let go.
   */
  destroy(): void {
    if (!this.stopped) {
      drawKernelLetGo();
    }

    this.stopped = true;
    this.scripting?.destroy();
    this.avm1?.destroy();
    unloads.count++;
  }

  private active = true;
  /** The activation the host last asked for, applied once no script runs. */
  private wanted = true;
  private applying = false;
  /** How many times the player has been activated or deactivated: each may run listeners. */
  private activations = 0;

  /** Whether the player has the system's focus, as last applied; true until a host says otherwise. */
  get isActive(): boolean {
    return this.active;
  }

  /**
   * The host's window or page gained or lost focus, or was hidden or shown.
   * Losing it, the keys held are let go, the AVM1 Key's too, and then
   * DEACTIVATE is broadcast to every EventDispatcher that listens, display
   * object or not; gaining it back, ACTIVATE. Keys are let go with no
   * keyUp: Flash sends none when it loses focus, which is why content
   * clears its own keys on DEACTIVATE, and a keyUp the user never made
   * could fire an action in a game. The mouse's buttons stay the
   * pointer's, which finds a release it never saw at its next move.
   *
   * It applies once the JavaScript that called it has returned, or at the
   * next frame, whichever comes first: the page may move its focus in a
   * call a script made, an ExternalInterface call's, and no listener runs
   * inside another script. Only the last state asked for counts, so a blur
   * and a focus in one call send nothing, and a host may call this on
   * every focus, blur and visibility change it sees.
   */
  setActive(active: boolean): void {
    this.wanted = active;
    if (!this.applying && active !== this.active) {
      this.applying = true;
      queueMicrotask(() => this.applyActive());
    }
  }

  /** The activation asked for, if it changed; once per change. */
  private applyActive(): void {
    this.applying = false;
    const active = this.wanted;
    if (this.stopped || active === this.active) {
      return;
    }

    this.active = active;
    this.activations++;
    if (!active) {
      this.avm1?.releaseKeys();
    }

    this.scripting?.broadcastActivation(active ? "activate" : "deactivate");
  }

  /** Time a host has let pass, in ms, still to be played as frames. */
  private owed = 0;
  /** The host's time the frame due has waited for a load from bytes so far. */
  private held = 0;
  /** The last INTERVALS times passed to advance(), a ring, for the host's typical interval. */
  private readonly intervals: number[] = [];
  private nextInterval = 0;
  /** Frames the last call to advance() played. */
  private lastRan = 0;
  private readonly sortedIntervals: number[] = [];
  /** Frames played. */
  private played = 0;
  /** The clips a tick advances, kept: the whole display list's, every frame. Null while in use. */
  private ticking: (MovieClip | null)[] | null = [];

  /**
   * A count that moves whenever what the player shows may have changed: a
   * frame played, a key, a pointer event that changes a button, focus or a
   * selection, a script's updateAfterEvent, a call from the page into
   * one of the SWF's ExternalInterface callbacks, or the player activated
   * or deactivated. A plain pointer move does not: what its listeners
   * change shows at the next frame, as Flash and Ruffle draw it, so a fast
   * mouse does not draw faster than the SWF. Loads and socket data arrive
   * in a frame. A host that draws only when this moved draws every frame
   * Flash would, and none in between, once it has drawn after start; what
   * the host itself changes, a resize, it draws for itself.
   */
  get changes(): number {
    return (
      this.played +
      (this.pointer?.redraws ?? 0) +
      (this.touch?.redraws ?? 0) +
      (this.scripting?.updates ?? 0) +
      (this.keyboard?.handled ?? 0) +
      (this.scripting?.hostCalls ?? 0) +
      this.activations
    );
  }

  /**
   * Play what `dt` milliseconds are worth, as Flash paces: frames on a
   * grid of the frame rate's duration. Without streamed audio, those a
   * long frame or a stall lost are dropped, not caught up with. Flash runs
   * the frame due at once after an overrun and the next at its grid slot, never two
   * back to back (measured in adl, docs/architecture/input.md), so content that
   * moves by the time between frames always sees time pass between them.
   * A call runs as many frames as the host's typical interval holds, the
   * lower median of its recent calls and never the current one, so a
   * hitch does not become a burst: one where the SWF's frame is as long
   * as the display's or longer, more for a SWF faster than the display,
   * and one while the interval is longer than a display's. `busy` is the
   * ms the host's last call took, by its own clock: where its frames each
   * took longer than a frame, they overran, and the call runs one, as
   * Flash runs the frame after an overrun alone. The interval cannot tell
   * that from a display's: a SWF that spins on getTimer to hold itself to
   * a slower rate makes the calls a display's interval apart, and two
   * frames a call would wait twice as long. A `dt` that is
   * not a finite positive number counts as none. A host playing in real
   * time calls this each animation frame; the tests step frames with
   * tick(). A stream's device cursor can request a bounded batch of frames
   * to catch its timeline up, with scripts and events on each; the host
   * draws once after the batch. Returns how many frames it played.
   */
  advance(dt: number, busy = 0): number {
    if (this.stopped) {
      return 0;
    }

    drawKernelFrame();

    // The pointer's and the touches' last moves, so the frame's scripts see where they are now.
    this.pointer?.flush();
    this.touch?.flush();
    const passed = Number.isFinite(dt) && dt > 0 ? dt : 0;
    const frame = 1000 / this.frameRate;
    const typical = this.typicalInterval(passed);
    const overran = this.lastRan > 0 && busy / this.lastRan > frame;
    let most =
      typical > DISPLAY_INTERVAL || overran
        ? 1
        : Math.min(MAX_FRAMES_PER_CALL, Math.max(1, Math.round(typical / frame)));
    // A frame that waits for a load from bytes plays once it is ready, as
    // Flash's waits for the parse. The frames do not catch up the time
    // held: they stop at the frame's slot. The timers count it, as Flash's
    // do, but fire nothing due after that slot until the frame has played,
    // its content made and INIT and COMPLETE told: Flash's parse takes a
    // few tens of milliseconds where a compile here may take seconds, and
    // content counts on having its content before a timer set at the call.
    // That holds for the call in which the load came too, which its
    // compile may have taken whole. Each load waited for has the ten
    // seconds to itself: one asked as the last comes does not inherit its
    // wait.
    const timers = this.scripting?.timers;
    let holding = false;
    let resuming = false;
    if (!this.scripting?.heldTime()) {
      this.held = 0;
    } else if (!this.scripting.holdsFrame()) {
      this.held = 0;
      resuming = true;
    } else if (this.held < HOLD_LIMIT) {
      this.held += passed;
      holding = true;
      most = 0;
    }

    let framePassed = passed;
    if (holding || resuming) {
      timers?.holdAfter(Math.max(0, frame - this.owed));
      framePassed = Math.max(0, Math.min(passed, frame - this.owed));
    } else {
      timers?.release();
    }

    this.owed += framePassed;
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

    // Streamed audio keeps running through render lag. Catch its timeline
    // up in bounded batches, without drawing the intermediate frames or
    // changing the pacing of movies with only event sounds.
    const ordinary = n;
    if (!holding && !resuming) {
      n = Math.max(n, Math.min(MAX_STREAM_FRAMES, this.streamFrames()));
    }

    // Render lag leaves fewer calls to do the same timeline work. Give
    // those calls more CPU time, while still yielding between batches.
    const deadline =
      n > ordinary
        ? performance.now() +
          Math.max(MIN_STREAM_BUDGET_MS, Math.min(MAX_STREAM_BUDGET_MS, passed / 2))
        : Infinity;
    timers?.hostPassed(passed);
    const deferRender = n > 1;
    let ran = false;
    try {
      for (let i = 0; i < n; i++) {
        if (
          i >= ordinary &&
          (this.streamFrames() === 0 ||
            (i > 0 &&
              (performance.now() >= deadline ||
                (this.scripting?.heldTime() && this.scripting.holdsFrame()))))
        ) {
          n = i;
          break;
        }

        // Owed as each frame starts: a frame that throws leaves those after it owed.
        this.owed = rest + Math.max(0, ordinary - 1 - i) * frame;
        timers?.frameAt((n - 1 - i) * frame, rest);
        ran = true;
        this.tick(!deferRender);
      }
    } catch (error) {
      if (ran && deferRender) {
        this.scripting?.renderFrame([error]);
      }

      throw error;
    } finally {
      timers?.frameAt(Number.NaN, Number.NaN);
      this.lastRan = n;
      if (resuming) {
        timers?.release();
      }
    }

    if (ran && deferRender) {
      this.scripting?.renderFrame();
    }

    // Flash fires timers shorter than a frame between frames too: a call
    // that played none checks them.
    if (n === 0) {
      this.owed = rest;
      timers?.betweenFrames(frame);
      // An AVM1 SWF's setInterval timers too.
      this.avm1?.idle();
      this.scripting?.renderPending();
    }

    return n;
  }

  private streamFrames(): number {
    if (this.avm1) {
      return streamFrames(this.avm1.sounds);
    }

    const s = this.scripting;
    return s ? Math.max(streamFrames(soundHostOf(s)), s.loads.streamFrames()) : 0;
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
   * A batch defers rendering until its last frame has played.
   */
  tick(render = true): void {
    this.applyActive();
    // An AVM1 SWF halted at what Flash cannot read plays no more.
    if (this.stopped || this.avm1?.halted) {
      return;
    }

    this.played++;
    // An AVM1 SWF's clips play in its order, the newest first.
    if (this.avm1 && !this.scripting) {
      this.avm1.tick();
      this.avm1Pointer?.frameEnded();
      return;
    }

    this.scripting?.timers.beginFrame(1000 / this.frameRate);
    const clips = this.ticking ?? [];
    this.ticking = null;
    let count = 0;
    const frames = this.scripting?.frames;
    // One a goto made sit this frame out takes all in it along.
    const sitsOut = (clip: MovieClip) => clip.skipsAfter >= 0 && clip.skipsAfter === frames;
    const collect = (o: DisplayObject) => {
      if (o.kind === CLIP && sitsOut(o as MovieClip)) {
        return;
      }

      // The clips under a container from the list it keeps (walkList); a button's states all
      // play, whichever it shows, walked as they are.
      if (o instanceof Container && o.kind !== BUTTON) {
        const { items, ends } = walkList(o);
        for (let i = 0; i < items.length; ) {
          const item = items[i];
          if (item.kind === BUTTON) {
            collect(item);
          } else if (sitsOut(item as MovieClip)) {
            i = ends[i];
            continue;
          } else {
            clips[count++] = item as MovieClip;
          }

          i++;
        }

        return;
      }

      if (o.kind === CLIP) {
        clips[count++] = o as MovieClip;
      }

      const children = o.kind === BUTTON ? (o as ButtonObject).playingStates() : o.frameChildren;
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
      this.scripting.frame(this.stage, true, render);
      this.frameRate = this.scripting.frameRate;
    }
  }
}
