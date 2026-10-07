// A SWF's scripts: the runtime with playerglobal's natives, the link
// between a display object and the AS3 object that is its other face
// (docs/architecture.md, "Scripts and the display list"), and the frame
// that runs them: its events, frame scripts, gotos' cycles and the
// construction of what timelines placed. The runtime allocates every
// DisplayObject through a hook that takes the display object the player
// has pending, when the player constructs a timeline child's class, or
// makes one for a `new`. The rest is in parts it holds, in scripting/:
// the SWFs' code, what SymbolClass binds, display objects' comings and
// goings, loads and timers.
import type { Codegen } from "@swf2es/codegen";
import type { Swf } from "@swf2es/format";
import { avm2 } from "@swf2es/runtime";
import { decodeInBrowser, type ImageDecode } from "./bitmap/images.js";
import {
  BitmapObject,
  ButtonObject,
  buttonStates,
  CLIP,
  Container,
  type DisplayObject,
  MovieClip,
  OTHER,
  scriptChildren,
  scriptWork,
  TRANSFORM,
} from "./display/display.js";
import type { ButtonCharacter, DisplayCharacter, Library } from "./display/timeline.js";
import {
  browserNavigate,
  type Drawer,
  defaultStorage,
  type ExternalInterfaceHost,
  type FetchRequest,
  type FetchResult,
  type Navigate,
  type PlatformCapabilities,
  platformCapabilities,
  type ScreenCapabilities,
  type SharedObjectStorage,
  type SocketHost,
} from "./hosts.js";
import type { Cursor, PointerInput } from "./input/pointer.js";
import { type AudioHost, browserAudioHost } from "./media/audio.js";
import { finishSounds, timelineSoundsOf } from "./media/sounds.js";
import { playerHooks, playerNatives } from "./playerglobal/index.js";
import { Code } from "./scripting/code.js";
import { dispatchTo } from "./scripting/events.js";
import { Lifecycle } from "./scripting/lifecycle.js";
import { Loads } from "./scripting/loads.js";
import { Symbols } from "./scripting/symbols.js";
import { Timers } from "./scripting/timers.js";

type AsObject = avm2.AsObject;
type Value = avm2.Value;

/** AS3 classes placed children are instances of when SymbolClass binds none. */
const DEFAULT_CLASS = {
  shape: "flash.display::Shape",
  morph: "flash.display::MorphShape",
  sprite: "flash.display::MovieClip",
  button: "flash.display::SimpleButton",
  bitmap: "flash.display::Bitmap",
  text: "flash.text::TextField",
  static: "flash.text::StaticText",
};

export class Scripting {
  readonly rt: avm2.Runtime;
  /**
   * The main SWF's application domain, a child of the runtime's root, which
   * holds the player's own classes as Flash's system domain does: a domain
   * made without a parent is the main one's sibling, and sees none of it.
   */
  readonly mainDomain: avm2.Domain;
  /** The SWFs' code, linked into their application domains, and whose code runs. */
  readonly code = new Code(this);
  /** What SymbolClass bound, the fonts registered and the sounds' shared decodes. */
  readonly symbols = new Symbols(this);
  /** What happens to display objects as they come and go: their events, and the orphans. */
  readonly lifecycle = new Lifecycle(this);
  /** What Loaders, URLStreams and host callbacks asked for, till the frame it comes in. */
  readonly loads: Loads;
  /** The frame clock, getTimer's, and the timers that fire by it. */
  readonly timers: Timers;
  readonly screenCapabilities: Readonly<ScreenCapabilities>;
  readonly externalInterface: ExternalInterfaceHost | null;
  /** How many calls the page has made into the SWF's ExternalInterface callbacks, which run outside a frame. */
  hostCalls = 0;
  /** Calls to an event's updateAfterEvent, and Stage.color set: a redraw asked for before the next frame. */
  updates = 0;
  /** How many goto cycles run inside one another now. */
  private cycles = 0;
  /**
   * Whether the frame's own frame scripts are running: a clip a script
   * makes with `new` then, around a button whose early scripts run, loses
   * its first frame's script to them, as in Flash; one made before keeps it.
   */
  private scriptPhase = false;
  /** The frames whose scripts rounds marked run, for checkRoundLeftOut. */
  private framesMarked = 0;
  /**
   * Whether a round of frame scripts left out as having nothing to do is
   * run anyway and must find nothing: the checked build's tests set it
   * (SWF2ES_CHECKED), to prove the rounds' count (scriptWork) complete.
   */
  static checkRounds = false;
  /** Whether they nested too deep this frame, which stops them all till the next. */
  private overflowed = false;
  /**
   * The clips runFrameScripts visits, a list for each depth it runs inside
   * itself at, kept: the whole display list's every frame, often more than
   * once.
   */
  private readonly scriptQueues: (MovieClip | null)[][] = [];
  private scriptDepth = 0;
  /**
   * Where an error nothing caught goes as it happens, so that the frame
   * goes on, as in Flash and Ruffle; null to have the frame throw them when
   * it ends.
   */
  readonly onUncaught: ((error: unknown) => void) | null;
  /** Errors kept for the frame's end: all, without onUncaught, else those it threw. */
  private uncaught: unknown[] = [];
  /** Children frames played on placed, to be made alive in the frame's construct phase. */
  private readonly toConstruct: {
    display: DisplayObject;
    character: DisplayCharacter;
    library: Library;
  }[] = [];
  /** The children of the gotos under way placed and not yet made alive, each goto's in order. */
  private readonly placing: {
    placed: { display: DisplayObject; character: DisplayCharacter }[];
    library: Library;
  }[] = [];
  readonly socket: SocketHost | null;
  readonly audio: AudioHost | null;
  /** Opens the pages navigateToURL asks for: the browser's window by default, null for none. */
  readonly navigate: Navigate | null;
  /** Takes what fscommand sends, or nothing does. */
  readonly fsCommand: ((command: string, args: string) => void) | null;
  /** What plays every library's timeline and button sounds. */
  private readonly timelineSounds = timelineSoundsOf(this);
  /** The host's fetch of a URL's bytes, for Loader.load, aborted when the load is closed or replaced; null where there is none. */
  fetch: ((request: FetchRequest, signal: AbortSignal) => Promise<FetchResult>) | null = null;
  /** Decodes the images of a SWF's JPEG tags as it is linked; the browser's by default, null for none. */
  readonly decodeImage: ImageDecode | null;
  /**
   * How BitmapData.draw renders a display object, set by the host once it
   * has a renderer (a PixiView); null where there is none.
   */
  drawer: Drawer | null = null;
  /** The main SWF's URL, as its LoaderInfo reports it. */
  url = "file:///";
  /** Where local SharedObjects are kept (flash/net/SharedObject.ts). */
  readonly storage: SharedObjectStorage;
  /** What Capabilities reports of the system (flash/system/Capabilities.ts). */
  readonly platform: PlatformCapabilities;
  /** The display object the next DisplayObject allocation is for, while the player constructs a timeline child's class. */
  pending: DisplayObject | null = null;
  /** The stage, once the player has made it, and the root it holds. */
  stage: Container | null = null;
  /** stage.focus: the object keys go to, a TextField that edits with them; null for the stage. */
  focus: DisplayObject | null = null;
  root: MovieClip | null = null;
  library: Library | null = null;
  /** Whether a script asked the stage to render (Stage.invalidate). */
  invalidated = false;
  /** The objects whose scrollRect was set since the last frame was drawn, which it takes effect at. */
  readonly scrolled = new Set<DisplayObject>();
  /** The clip whose frame script is running, while one is: a goto it asks for waits for it to return. */
  inFrameScript: MovieClip | null = null;
  /** The display objects listening for each frame event, in the order they first listened; a broadcast reaches these. */
  readonly broadcasts = new Map<string, Set<AsObject>>();
  /** What flash.display.Stage reports and sets; the player copies the frame rate back each frame. */
  stageWidth = 0;
  stageHeight = 0;
  /** Stage.color's 0xRRGGBB, the SWF's background until a script sets it; null before the stage is made. */
  stageColor: number | null = null;
  /** The latest pointer position in stage coordinates. */
  mouseStageX = 0;
  mouseStageY = 0;
  frameRate = 24;
  /** Frames played since the start. */
  frames = 0;
  quality = "HIGH";
  /** Display objects made with an AS3 object, which Flash numbers for their default names. */
  instances = 0;
  private statusClass: AsObject | null = null;
  /** The system cursor is visible until flash.ui.Mouse hides it. */
  mouseVisible = true;
  /** Mouse.cursor: "auto" for the player's choice, a flash.ui.MouseCursor name or a registered one. */
  mouseCursor = "auto";
  /** The cursors Mouse.registerCursor registered, by name, as CSS cursor values. */
  readonly cursors = new Map<string, Cursor>();
  pointer: PointerInput | null = null;
  /** Whether an HTML assignment drops its final line break, as some players do. */
  readonly trimTrailingHtmlBreak: boolean;

  constructor(
    readonly codegen: Codegen,
    options: avm2.RuntimeOptions & {
      fetch?: (request: FetchRequest, signal: AbortSignal) => Promise<FetchResult>;
      url?: string;
      /**
       * The main SWF's flashvars, as a page's FlashVars give them: its
       * loaderInfo.parameters, after its URL's query, whose names they
       * override, as Ruffle's do.
       */
      parameters?: Readonly<Record<string, string>>;
      /** Where local SharedObjects are kept: localStorage by default where the host has it, else memory. */
      storage?: SharedObjectStorage;
      /** What Capabilities reports of the system: by default the browser's, as Flash Player 32's plugin. */
      platform?: Partial<PlatformCapabilities>;
      externalInterface?: ExternalInterfaceHost;
      socket?: SocketHost;
      audio?: AudioHost | null;
      navigate?: Navigate | null;
      /**
       * What fscommand sends: a plug-in's page gets it as its DoFSCommand
       * call; none by default. The SWF chooses both strings: never evaluate
       * them, or use them as a URL or as HTML.
       */
      fsCommand?: ((command: string, args: string) => void) | null;
      decodeImage?: ImageDecode | null;
      screenCapabilities?: Partial<ScreenCapabilities>;
      /** Drop the final newline produced by an HTML paragraph or BR. */
      trimTrailingHtmlBreak?: boolean;
      /**
       * The clock getTimer reads, a monotonic one in milliseconds: by default
       * `performance.now`, as Flash's runs on in real time, while a script
       * does too; null for the frame clock, which a frame moves and nothing
       * else, the same on every run, as tests that compare traces want.
       */
      realTime?: (() => number) | null;
      /**
       * Each error that no script caught, as it happens: any listener's,
       * whoever dispatched, a frame script's, a constructor's, a load's,
       * those between frames, in a pointer, keyboard or ExternalInterface
       * handler, too. Without it, the frame throws them to its caller once
       * it has ended, those between frames with the next frame's. An error
       * the hook throws is thrown so too.
       */
      onUncaught?: (error: unknown) => void;
    } = {},
  ) {
    this.screenCapabilities = {
      screenResolutionX:
        options.screenCapabilities?.screenResolutionX ??
        (typeof screen === "undefined" ? 0 : screen.width),
      screenResolutionY:
        options.screenCapabilities?.screenResolutionY ??
        (typeof screen === "undefined" ? 0 : screen.height),
      pixelAspectRatio: options.screenCapabilities?.pixelAspectRatio ?? 1,
      screenDPI: options.screenCapabilities?.screenDPI ?? 72,
    };
    this.trimTrailingHtmlBreak = options.trimTrailingHtmlBreak ?? false;
    this.timers = new Timers(this, options);
    this.decodeImage = options.decodeImage === undefined ? decodeInBrowser : options.decodeImage;
    this.externalInterface = options.externalInterface ?? null;
    this.socket = options.socket ?? null;
    this.onUncaught = options.onUncaught ?? null;
    this.audio = options.audio === undefined ? browserAudioHost() : options.audio;
    this.navigate = options.navigate === undefined ? browserNavigate() : options.navigate;
    this.fsCommand = options.fsCommand ?? null;
    this.fetch = options.fetch ?? null;
    this.url = options.url ?? this.url;
    this.loads = new Loads(this, options);
    this.storage = options.storage ?? defaultStorage();
    this.platform = { ...platformCapabilities(), ...options.platform };
    this.rt = new avm2.Runtime(
      (rt) => ({ ...avm2.builtinNatives(rt), ...playerNatives(this) }),
      { ...avm2.builtinHooks(), ...playerHooks(this) },
      options,
    );
    this.mainDomain = this.rt.childDomain(this.rt.root);
    this.codegen.reset(50);
  }

  /** Load the libraries the SWF's code links against (builtin, playerglobal), whose scripts run on first use. */
  loadLibraries(abcs: Uint8Array[]): Promise<void> {
    return this.code.loadLibraries(abcs);
  }

  /** Resolves once every load and host request so far is ready or failed (Loads.settled). */
  settled(): Promise<void> {
    return this.loads.settled();
  }

  /** SymbolClass: bind the SWF's characters to their classes, in its library, and the library to this. */
  bind(swf: Swf, library: Library): void {
    this.symbols.bind(swf, library);

    library.construct = (display, character) => this.construct(display, character, library);
    library.uncaught = this.reportUncaught;
    library.constructLater = (display, character) => {
      // Its class is ready as the frame plays, its script run, as the frame's
      // tags have it in Flash; only the instance waits (`delayed_symbolclass`).
      const name = library.classes.get(character.id);
      if (name) {
        this.rt.classNamed(name, library.domain ?? null);
      }

      this.toConstruct.push({ display, character, library });
    };
    library.constructPlaced = (placed) => {
      const goto = { placed, library };
      this.placing.push(goto);
      try {
        this.constructGoto(goto);
      } finally {
        this.placing.splice(this.placing.indexOf(goto), 1);
      }
    };
    library.removing = (display, byTimeline) => this.lifecycle.removing(display, byTimeline);
    library.sounds = this.timelineSounds;
  }

  /**
   * The AS3 object of a timeline child the player just made: an instance
   * of the class SymbolClass binds its character to, else of MovieClip or
   * Shape, constructed with `display` as its other face. A clip's first
   * frame is entered by Sprite's constructChildren on the way.
   */
  construct(display: DisplayObject, character: DisplayCharacter, library: Library): void {
    // Its first frame's children are there before its constructor runs, made alive in its super().
    if (display instanceof MovieClip) {
      display.timelineChild = true;
      display.placeFirstFrame();
    }

    const name = library.classes.get(character.id) ?? DEFAULT_CLASS[character.type];
    const domain = library.domain ?? null;
    // Flash gives the parent a property of the child's instance name, which
    // a sealed class without it refuses: ReferenceError #1056, as Flash.
    const named = (object: avm2.AsObject) => {
      const parent = display.parent?.object;
      if (parent && display.timelineNamed) {
        this.rt.setProperty(parent, avm2.qname(avm2.publicNs, display.name), object);
      }
    };
    // A button's states are made before its constructor runs, as Flash has
    // them; in a SWF after 9, one whose up state has a clip has a frame run
    // then too: the frame scripts due on the display list, the orphans and
    // what scripts made, the button's states up, over, down, hit among them
    // (`button-frame-order`, Ruffle's frame_script_button_order). Its parent
    // has its property by then, as scripts there find it (`simplebutton_symbolclass`).
    if (display instanceof ButtonObject && character.type === "button") {
      // Named before its states, as Flash names an object when it is made.
      if (display.name === "") {
        display.name = `instance${++this.instances}`;
      }

      this.makeButtonStates(display, character, library);
      if ((library.version ?? 10) > 9 && hasClip(display.upState)) {
        const cls = this.rt.classNamed(name, domain);
        this.pending = display;
        let object: avm2.AsObject | null;
        try {
          object = this.rt.allocate(cls);
        } finally {
          this.pending = null;
        }

        // A name the parent refuses is thrown once the button is constructed, as another child's is.
        let refused: { error: unknown } | null = null;
        if (object) {
          try {
            named(object);
          } catch (error) {
            refused = { error };
          }
        }

        display.firstScripts = true;
        // What is placed and not yet alive is made first, as a frame's
        // construct phase makes it: the frame's other children, and those
        // of the gotos under way, which their parents' listeners look for.
        this.constructPending();
        for (const goto of [...this.placing]) {
          this.constructGoto(goto);
        }

        this.broadcast("frameConstructed");
        this.runFrameScripts(this.stage ?? display, display);
        this.broadcast("exitFrame");
        if (object) {
          this.rt.constructSuper(cls, object);
          if (refused) {
            throw refused.error;
          }

          this.lifecycle.added(display);
          return;
        }
      }
    }

    const object =
      character.type === "bitmap" && display instanceof BitmapObject
        ? this.constructBitmap(display, name, domain)
        : this.constructAs(display, this.rt.classNamed(name, domain));
    named(object);
    this.lifecycle.added(display);
  }

  /**
   * A bitmap a timeline placed: a Bitmap, or the Bitmap subclass bound to
   * it. A class extending BitmapData bound to it is its data's, made with
   * (1, 1) where PlaceObject3 has HasImage; without it Flash constructs
   * the class as a display object's and refuses it, TypeError 2022.
   */
  private constructBitmap(
    display: BitmapObject,
    name: string,
    domain: avm2.Domain | null,
  ): AsObject {
    const cls = this.rt.classNamed(name, domain);
    if (!extendsClass(cls, "flash.display::BitmapData")) {
      return this.constructAs(display, cls);
    }

    if (!display.hasImage) {
      this.rt.construct(cls);
      throw this.rt.error("TypeError", 2022, `${name.replace(/^.*::/, "")}$`);
    }

    const data = this.rt.construct(cls, 1, 1);
    return this.constructAs(display, this.rt.classNamed("flash.display::Bitmap"), data);
  }

  /** Construct `cls` for `display`: the allocation hook takes it as the instance's other face. */
  constructAs(display: DisplayObject, cls: AsObject, ...args: Value[]): AsObject {
    this.pending = display;
    try {
      return this.rt.construct(cls, ...args);
    } finally {
      this.pending = null;
    }
  }

  /** A button's states from its records, each a Sprite of its characters where it has other than one, all constructed. */
  makeButtonStates(button: ButtonObject, character: ButtonCharacter, library: Library): void {
    const sprite = this.rt.classNamed("flash.display::Sprite");
    buttonStates(
      button,
      character,
      library,
      (display, c) => this.construct(display, c, library),
      (holder) => this.constructAs(holder, sprite),
    );
  }

  /** A flash.events.Event of `type`. */
  event(type: string, bubbles = false): AsObject {
    return this.rt.construct(this.rt.classNamed("flash.events::Event"), type, bubbles, false);
  }

  /** Flash Player's status event; AIR-only response properties stay at their defaults. */
  httpStatus(status: number): AsObject {
    let cls = this.statusClass;
    if (!cls) {
      cls = this.rt.classNamed("flash.events::HTTPStatusEvent");
      this.statusClass = cls;
    }

    return this.rt.construct(cls, "httpStatus", false, false, status);
  }

  /** The display objects a broadcast of `type` reaches, for EventDispatcher to keep. */
  broadcastTargets(type: string): Set<AsObject> {
    let targets = this.broadcasts.get(type);
    if (!targets) {
      targets = new Set();
      this.broadcasts.set(type, targets);
    }

    return targets;
  }

  /**
   * Dispatch an event of `type` to every display object that listens for
   * it, on the display list or not, in the order they first listened, each
   * its own event and its own target only: Flash's frame events have no
   * capture or bubble phase.
   */
  broadcast(type: string): void {
    const targets = this.broadcasts.get(type);
    if (!targets) {
      return;
    }

    for (const target of [...targets]) {
      dispatchTo(this, target, this.event(type));
    }
  }

  /** An error that no script caught: to the host's hook now, or kept for the frame's end. */
  readonly reportUncaught = (error: unknown): void => {
    if (!this.onUncaught) {
      this.uncaught.push(error);
      return;
    }

    // A hook that throws stops nothing here either: its error is thrown
    // when the frame ends, after the listeners and scripts that follow.
    try {
      this.onUncaught(error);
    } catch (hookError) {
      this.uncaught.push(hookError);
    }
  };

  /**
   * Run the frame scripts of the clips that entered a frame with one since
   * they last ran: the orphans' first, newest first, then those under
   * `root`, each in tree order: a clip's own, again for the frame a goto of
   * its own lands it on, then its children's, as Flash runs a parent's
   * landing script before a child the jump made. A clip a script removes
   * still runs its own, as Flash queues them first. Rounds until none is
   * left, bounded, as a script that jumps on every run would never settle.
   * `also`, a button being made, is visited after them all, for one none
   * of them has; a clip visited twice still runs a frame's script once.
   */
  runFrameScripts(root: DisplayObject, also: DisplayObject | null = null): void {
    // A script's error is reported apart: its goto still happens, and the
    // scripts after it still run, as in Flash (the unit test "a frame
    // script's goto happens though the script throws after it").
    // Overflowed, cycles stop their script loops; the frame's own pass goes on.
    const stopped = () => this.overflowed && this.cycles > 0;
    const depth = this.scriptDepth++;
    const queue = this.scriptQueues[depth] ?? [];
    this.scriptQueues[depth] = queue;
    try {
      for (let round = 0; round < 64 && !stopped(); round++) {
        // Another round only finds a script if something it reads changed
        // since this one walked: every clip this one visited is left on a
        // frame whose script ran, or one held back as it will be again.
        const changes = scriptWork.changes;
        if (!this.frameScriptRound(queue, root, also, stopped)) {
          break;
        }

        if (scriptWork.changes === changes) {
          if (Scripting.checkRounds) {
            this.checkRoundLeftOut(queue, root, also, stopped);
          }

          break;
        }
      }
    } finally {
      this.scriptDepth--;
    }
  }

  /**
   * The checked build's proof that a round left out had nothing to do: run
   * it anyway, and throw if it ran a script, marked a frame's script run or
   * changed anything else a round reads.
   */
  private checkRoundLeftOut(
    queue: (MovieClip | null)[],
    root: DisplayObject,
    also: DisplayObject | null,
    stopped: () => boolean,
  ): void {
    const changes = scriptWork.changes;
    const marked = this.framesMarked;
    if (
      this.frameScriptRound(queue, root, also, stopped) ||
      this.framesMarked !== marked ||
      scriptWork.changes !== changes
    ) {
      throw new Error("a round of frame scripts left out had work to do");
    }
  }

  /** A round of runFrameScripts, its clips listed in `queue`: whether any script ran. */
  private frameScriptRound(
    queue: (MovieClip | null)[],
    root: DisplayObject,
    also: DisplayObject | null,
    stopped: () => boolean,
  ): boolean {
    let ran = false;
    const own = (o: MovieClip) => {
      // A clip whose super() is making the children that run this has
      // registered no script for its frame yet, unless it did so before
      // super(), and keeps the frame's for later: always, placed by a
      // timeline, made with `new`, only outside the frame's own scripts;
      // one a frame script makes loses it (`button-frame-order`).
      if (
        o.makingChildren &&
        !o.frameScripts.has(o.currentFrame) &&
        (o.timelineChild || !this.scriptPhase)
      ) {
        return;
      }

      for (let jumps = 0; jumps < 64 && o.scriptedFrame !== o.currentFrame && !stopped(); jumps++) {
        o.scriptedFrame = o.currentFrame;
        this.framesMarked++;
        const script = o.frameScripts.get(o.currentFrame);
        if (!script) {
          return;
        }

        ran = true;
        // The clip whose script runs, the one before it again after: a
        // goto's cycle runs scripts inside another's (`goto-cycle-nested`).
        const outer = this.inFrameScript;
        this.inFrameScript = o;
        try {
          this.rt.call(script, o.object);
        } catch (error) {
          this.reportUncaught(error);
        } finally {
          this.inFrameScript = outer;
        }

        // The goto the script asked for, now that it has returned, or
        // thrown; the frame it lands on has its script run next, in this
        // same phase, or, from version 10, in the goto's own cycle.
        if (o.queuedGoto !== null) {
          const frame = o.queuedGoto;
          o.queuedGoto = null;
          o.playing = o.queuedPlay;
          o.gotoFrame(frame);
          try {
            this.gotoCycle(o);
          } catch (error) {
            this.reportUncaught(error);
          }
        }
      }
    };
    let count = 0;
    const visit = (o: DisplayObject) => {
      if (o.kind === CLIP && o.object) {
        queue[count++] = o as MovieClip;
      }

      // An index, not for-of, and no call for a leaf: this visits every
      // object on the list. A button is visited for its states' first order.
      const children = scriptChildren(o);
      for (let i = 0; i < children.length; i++) {
        const child = children[i];
        if (child.kind !== OTHER || child.frameChildren.length !== 0) {
          visit(child);
        }
      }
    };
    for (const orphan of this.lifecycle.orphanRoots()) {
      visit(orphan);
    }

    visit(root);
    for (const display of this.lifecycle.fresh) {
      visit(display);
    }

    if (also) {
      visit(also);
    }

    // Each let go of as it runs, so that the kept list holds none past the round.
    for (let i = 0; i < count; i++) {
      const o = queue[i] as MovieClip;
      queue[i] = null;
      own(o);
    }

    return ran;
  }

  /**
   * What a goto that has happened runs in a SWF of version 10 or later, as
   * Flash does, from a listener, a frame script once it returns, or anyone:
   * FRAME_CONSTRUCTED, the frame scripts due on the whole display list, the
   * goto's frame's among them, and EXIT_FRAME (`goto-cycle`). What the goto
   * placed it made alive already. Version 9 runs none (`goto-children`).
   */
  gotoCycle(clip: MovieClip): void {
    if ((clip.library.version ?? 10) < 10 || !this.stage) {
      return;
    }

    // Two scripts that send their clip to each other's frame nest cycles
    // without end, in Flash till it gives up some 1400 deep; here a script's
    // stack overflow, before the JavaScript stack's. Overflowed once, no
    // cycle runs for the rest of the frame, and the cycles under way stop
    // their script loops, so a script that catches the error cannot start
    // it over; the frame's own scripts still run.
    if (this.overflowed) {
      return;
    }

    if (this.cycles >= MAX_GOTO_CYCLES) {
      this.overflowed = true;
      throw this.rt.error("Error", 1023);
    }

    // The cycle's errors are not the goto's: its scripts', listeners' and
    // constructors' are reported apart, as Flash reports them, and the rest
    // of the cycle and the goto's caller go on (the unit test "a goto's
    // caller goes on when a script its cycle runs throws"). An overflow
    // still reaches the goto that went too deep, which threw it above. A
    // goto between frames, from a pointer, keyboard or ExternalInterface
    // handler, has its cycle's errors reported by onUncaught at once, or
    // else thrown when the next frame ends.
    this.cycles++;
    try {
      // What frames placed and has yet to be made alive is made first.
      this.constructPending();
      this.broadcast("frameConstructed");
      this.runFrameScripts(this.stage);
      this.broadcast("exitFrame");
    } finally {
      this.cycles--;
    }
  }

  /**
   * The construct phase: what the frames placed is made alive after
   * ENTER_FRAME, before frameConstructed, or as a goto's cycle begins;
   * until then a script finds it in numChildren but getChildAt gives null
   * (`instantiation_on_enter_frame`). One taken off since is never made,
   * and one at a time: a constructor that throws is reported, and the rest
   * are still made.
   */
  private constructPending(): void {
    for (let next = this.toConstruct.shift(); next; next = this.toConstruct.shift()) {
      if (!next.display.object && next.display.parent) {
        try {
          this.construct(next.display, next.character, next.library);
        } catch (error) {
          this.reportUncaught(error);
        }
      }
    }
  }

  /**
   * The children a goto placed made alive, in order, each once: taken off
   * the list as it is made, so that a button's early frame among them that
   * makes the rest first leaves none to make again. A constructor that
   * throws is reported, and the rest are still made, as in Flash.
   */
  private constructGoto(goto: (typeof this.placing)[number]): void {
    for (let next = goto.placed.shift(); next; next = goto.placed.shift()) {
      if (next.display.object || !next.display.parent) {
        continue;
      }

      try {
        this.construct(next.display, next.character, goto.library);
      } catch (error) {
        this.reportUncaught(error);
      }
    }
  }

  /**
   * What follows the timelines' advance in a frame: the frame events and
   * scripts, in Flash's order. The first frame, after construction, has no
   * ENTER_FRAME: Flash goes to FRAME_CONSTRUCTED, the scripts and EXIT_FRAME.
   * Without onUncaught, the errors no script caught are thrown once the
   * frame has ended: one alone, or several as an AggregateError, after any
   * that stopped the frame early.
   */
  frame(root: DisplayObject, entered = true): void {
    const errors: unknown[] = [];
    try {
      this.playFrame(root, entered);
    } catch (error) {
      errors.push(error);
    }

    // Those of a goto between frames, as a pointer handler's, come with this frame's.
    errors.push(...this.uncaught.splice(0));
    if (errors.length === 1) {
      throw errors[0];
    }

    if (errors.length > 1) {
      throw new AggregateError(errors, `${errors.length} errors that nothing caught`);
    }
  }

  private playFrame(root: DisplayObject, entered: boolean): void {
    this.overflowed = false;
    finishSounds(this);
    if (entered) {
      this.frames++;
      this.broadcast("enterFrame");
    }

    this.constructPending();

    const ends = [...this.loads.frameEnds.splice(0), ...this.loads.completeLoads()];
    this.broadcast("frameConstructed");
    const outer = this.scriptPhase;
    this.scriptPhase = true;
    scriptWork.changes++;
    try {
      this.runFrameScripts(root);
    } finally {
      this.scriptPhase = outer;
      scriptWork.changes++;
    }
    this.lifecycle.afterScripts();
    this.broadcast("exitFrame");
    for (const end of ends) {
      try {
        end();
      } catch (error) {
        this.reportUncaught(error);
      }
    }

    this.loads.deliverAvm1Loads();

    if (this.invalidated) {
      this.invalidated = false;
      this.broadcast("render");
    }

    // The frame is drawn: the scroll rectangles set since take effect, as Flash's do.
    for (const d of this.scrolled) {
      d.scroll = d.scrollRect;
      d.invalidate(TRANSFORM);
    }

    this.scrolled.clear();
  }
}

/** How deep goto cycles may nest before a goto throws a stack overflow, Error #1023. */
const MAX_GOTO_CYCLES = 256;

/** Whether `cls` is the class named `name` or extends it. */
function extendsClass(cls: AsObject, name: string): boolean {
  for (let t: { name: string; base: unknown } | null = cls.$it; t; t = t.base as typeof t) {
    if (t.name === name) {
      return true;
    }
  }

  return false;
}

/** Whether a button's state is a clip or holds one among its own children. */
function hasClip(state: DisplayObject | null): boolean {
  return (
    state instanceof MovieClip ||
    (state instanceof Container && state.children.some((c) => c instanceof MovieClip))
  );
}
