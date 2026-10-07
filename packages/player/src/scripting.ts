// A SWF's scripts: its DoABCs compiled through @swf2es/codegen and loaded
// into a runtime with playerglobal's natives, its SymbolClass binding
// characters to classes, and the link between a display object and the
// AS3 object that is its other face (docs/architecture.md, "Scripts and
// the display list"). The runtime allocates every DisplayObject through a
// hook that takes the display object the player has pending, when the
// player constructs a timeline child's class, or makes one for a `new`.
import type { Codegen } from "@swf2es/codegen";
import { isAs3, readSwf, type Swf } from "@swf2es/format";
import { avm2 } from "@swf2es/runtime";
import { decodeImages, decodeInBrowser, hasUndecoded, type ImageDecode } from "./bitmap/images.js";
import {
  BitmapObject,
  ButtonObject,
  buttonStates,
  Container,
  type DisplayObject,
  MovieClip,
  rootOf,
  scriptChildren,
  TRANSFORM,
} from "./display/display.js";
import {
  type ButtonCharacter,
  type DisplayCharacter,
  type Library,
  readLibrary,
} from "./display/timeline.js";
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
import { dispatchEvent, dispatchTo } from "./scripting/events.js";
import { Lifecycle } from "./scripting/lifecycle.js";
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

/**
 * A load a Loader asked for. Its SWF's code is compiled and linked as
 * the bytes come, off the frame; what it then does on the display list
 * waits for a frame, as `ready`, or is the error it ended in.
 */
interface Load {
  loader: AsObject;
  /** The Loader's count of requests when this was asked: an older one was closed or replaced, and does nothing. */
  generation: number;
  /** The URL asked for, resolved; null for a load from bytes, which told its progress in the call. */
  url: string | null;
  bytes: Uint8Array;
  status: number;
  /** What the content's frame does: it returns what the frame's end does, INIT and COMPLETE. */
  ready: (() => () => void) | null;
  /** The IOErrorEvent text the load ended in, as Flash words one. */
  failed: string | null;
  /** The application domain its code loads into, as the Loader's context chose it when asked. */
  domain: avm2.Domain;
  /** The LoaderContext's parameters, which take the place of the URL's query; null when it set none. */
  parameters: ReadonlyMap<string, string> | null;
  /** The SWF, where the call read it already: a load from bytes. */
  swf: Swf | null;
}

/**
 * An AVM1 movie a loadBytes made, for the end of a frame: Flash makes its
 * AVM1Movie in the call and has it by the end of the frame, once its
 * images are decoded here; `failed` if they could not be.
 */
interface Avm1Load {
  load: Load;
  swf: Swf;
  library: Library;
  movie: AsObject;
  ready: boolean;
  failed: boolean;
}

export class Scripting {
  readonly rt: avm2.Runtime;
  /**
   * The main SWF's application domain, a child of the runtime's root, which
   * holds the player's own classes as Flash's system domain does: a domain
   * made without a parent is the main one's sibling, and sees none of it.
   */
  readonly mainDomain: avm2.Domain;
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
  /** Whether they nested too deep this frame, which stops them all till the next. */
  private overflowed = false;
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
  /** What SymbolClass bound classes to, the fonts registered, and the sounds' decodes the libraries share. */
  readonly symbols = new Symbols(this);
  /** Loads asked for and not yet completed, in order; each prepared after the one before it. */
  private readonly loads: Load[] = [];
  /** AVM1 movies from bytes, in the order asked, for the end of a frame. */
  private readonly avm1Loads: Avm1Load[] = [];
  private preparing: Promise<void> = Promise.resolve();
  /** Host requests are independent of Loader's ordered preparation chain. */
  private readonly pendingRequests = new Set<Promise<void>>();

  /** Keep an asynchronous host task visible to settled(). */
  trackRequest(task: Promise<void>): void {
    this.pendingRequests.add(task);
    void task.then(
      () => this.pendingRequests.delete(task),
      () => this.pendingRequests.delete(task),
    );
  }
  /** Completed host byte requests delivered at the next frame, with scripts on the player thread. */
  private readonly readyBytes: (() => void)[] = [];

  /** Cross a host callback into the next player frame, where scripts may run. */
  deferHostEvent(deliver: () => void): void {
    this.readyBytes.push(deliver);
  }
  /** How many loads from bytes there have been: each gets a URL of its own under the main SWF's. */
  private dynamic = 0;
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
  /** The main SWF's flashvars, as the host gave them. */
  private readonly flashvars: Readonly<Record<string, string>>;
  /** Where local SharedObjects are kept (flash/net/SharedObject.ts). */
  readonly storage: SharedObjectStorage;
  /** What Capabilities reports of the system (flash/system/Capabilities.ts). */
  readonly platform: PlatformCapabilities;
  /** What happens to display objects as they come and go: their events, and the orphans. */
  readonly lifecycle = new Lifecycle(this);
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
  /** The frame clock, getTimer's, and the timers that fire by it. */
  readonly timers: Timers;
  quality = "HIGH";
  /** The SWFs' code, compiled and linked into the application domains, and what tells whose code runs. */
  readonly code = new Code(this);
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
    this.flashvars = options.parameters ?? {};
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

  /**
   * A LoaderInfo for `loader` (null for the main SWF's), empty until its
   * SWF is known: what its natives read is kept on it as $ fields.
   */
  loaderInfo(loader: AsObject | null): AsObject {
    const info = this.rt.construct(this.rt.classNamed("flash.display::LoaderInfo"));
    info.$loader = loader;
    info.$content = null;
    info.$bytes = null;
    info.$swf = null;
    info.$url = null;
    info.$params = NO_PARAMETERS;
    info.$loaderURL = loader ? this.ownerUrl(loader) : this.url;
    info.$loaded = 0;
    info.$total = 0;
    return info;
  }

  /** The main SWF's loaderInfo.parameters: its URL's query, then the flashvars. */
  mainParameters(): ReadonlyMap<string, string> {
    const parameters = queryParameters(this.url);
    // A host in plain JavaScript may give other values: Flash's are strings.
    for (const [name, value] of Object.entries(this.flashvars)) {
      parameters.set(name, String(value));
    }

    return parameters;
  }

  /** What a LoaderInfo knows once its SWF is: the bytes, the header's version, frame rate and size. */
  describe(info: AsObject, bytes: Uint8Array, swf: Swf): void {
    info.$bytes = bytes;
    info.$total = bytes.length;
    info.$swf = {
      version: swf.header.version,
      frameRate: swf.frameRate,
      width: Math.round((swf.frameSize.xMax - swf.frameSize.xMin) / 20),
      height: Math.round((swf.frameSize.yMax - swf.frameSize.yMin) / 20),
      as3: isAs3(swf),
    };
  }

  /**
   * The domain a load goes into: the LoaderContext's applicationDomain, or
   * by default a new child of the domain of the code that asked, as
   * Flash's `new ApplicationDomain(ApplicationDomain.currentDomain)`.
   */
  loadDomain(applicationDomain: Value): avm2.Domain {
    const chosen: avm2.Domain | undefined = applicationDomain?.$domain;
    return chosen ?? this.rt.childDomain(this.code.codeDomain());
  }

  /**
   * The URL of the SWF a Loader belongs to, which its content's loaderURL
   * reports and its relative URLs resolve against: Flash's is the SWF whose
   * code made the Loader, which the runtime does not track, so it is the
   * SWF the Loader is on the display list of when it loads, else the main.
   */
  private ownerUrl(loader: AsObject): string {
    return rootOf(loader.$display)?.loaderInfo?.$url ?? this.url;
  }

  /**
   * A Loader's loadBytes. Flash tells the whole of the progress at once, in
   * the call, the URL still null; the content comes in a later frame, under
   * a URL of the bytes' own.
   */
  requestLoad(
    loader: AsObject,
    bytes: Uint8Array,
    domain = this.loadDomain(null),
    parameters: ReadonlyMap<string, string> | null = null,
  ): void {
    const begun = this.begin(loader, domain, parameters);
    if (!begun) {
      return;
    }

    const { info, generation } = begun;
    info.$dynamic = `${info.$loaderURL}/[[DYNAMIC]]/${++this.dynamic}`;
    info.$bytes = bytes;
    info.$total = bytes.length;
    // A listener of either event may close the Loader or load anew, which ends this load.
    this.progress(info, 0);
    if (loader.$generation !== generation) {
      return;
    }

    this.progress(info, bytes.length);
    if (loader.$generation !== generation) {
      return;
    }

    let swf: Swf | null = null;
    try {
      swf = readSwf(bytes);
    } catch {
      // Not a SWF: refused when its turn comes, as Flash refuses it in a later frame.
    }

    if (swf && !isAs3(swf)) {
      const load = this.newLoad(loader, generation, null, domain, parameters, swf);
      load.bytes = bytes;
      this.requestAvm1(load, swf);
      return;
    }

    this.enqueue(
      loader,
      generation,
      null,
      Promise.resolve({ bytes, status: 0, headers: [] }),
      domain,
      parameters,
      swf,
    );
  }

  /**
   * An AVM1 SWF from bytes. Flash makes its AVM1Movie in the call, named
   * then, and has it in the Loader at the end of the frame, after
   * EXIT_FRAME, before the next frame begins: the last asked first, INIT
   * and COMPLETE with each, as adl traces it (the `avm1-movie` case). A
   * SWF with images has them decoded first, which may take frames; one
   * whose images the decoder refuses ends in IOError #2124 there instead.
   */
  private requestAvm1(load: Load, swf: Swf): void {
    const library = this.avm1Library(swf, load.domain);
    const pending: Avm1Load = {
      load,
      swf,
      library,
      movie: this.avm1Movie(library),
      ready: false,
      failed: false,
    };
    this.avm1Loads.push(pending);
    if (!hasUndecoded(library)) {
      pending.ready = true;
      return;
    }

    this.trackRequest(
      decodeImages(library, this.decodeImage).then(
        () => {
          pending.ready = true;
        },
        () => {
          pending.ready = true;
          pending.failed = true;
        },
      ),
    );
  }

  /** An AVM1 SWF's library: its timelines play by themselves, with no AS3 objects but the root's. */
  private avm1Library(swf: Swf, domain: avm2.Domain): Library {
    const library = readLibrary(swf);
    library.domain = domain;
    return library;
  }

  /**
   * An AVM1 SWF's root, not yet on its first frame, as AS3 sees it: an
   * AVM1Movie, which is no InteractiveObject, so the pointer's hits on the
   * movie go to its Loader (input/pointer.ts).
   */
  private avm1Movie(library: Library): AsObject {
    const root = new MovieClip(library.root, library);
    root.avm1Root = true;
    return this.constructAs(root, this.rt.classNamed("flash.display::AVM1Movie"));
  }

  /** The AVM1 movies from bytes ready by the end of this frame, the last asked first. */
  private deliverAvm1Loads(): void {
    for (let i = this.avm1Loads.length - 1; i >= 0; i--) {
      const pending = this.avm1Loads[i];
      if (!pending.ready) {
        continue;
      }

      this.avm1Loads.splice(i, 1);
      try {
        this.deliverAvm1(pending);
      } catch (error) {
        this.reportUncaught(error);
      }
    }
  }

  /**
   * An AVM1 movie from bytes as the Loader's content, then its INIT and
   * COMPLETE. It keeps its first frame through the next frame's advance,
   * as adl shows it, then plays at the stage's frame rate.
   */
  private deliverAvm1(pending: Avm1Load): void {
    const { load, swf, library, movie } = pending;
    if (load.generation !== load.loader.$generation) {
      return;
    }

    if (pending.failed) {
      dispatchEvent(this, this.loaderInfoOf(load.loader), this.ioError(this.errorText(2124)));
      return;
    }

    const end = this.complete(load, swf, library, null, movie);
    (movie.$display as MovieClip).fresh = true;
    end();
  }

  /**
   * A load begins: the one before it is dropped, pending or complete, and
   * its LoaderInfo knows nothing again, as Flash's load() does at the call
   * (Ruffle's `loader_reuse` trace), but the parameters its context gave,
   * which Flash tells from the call on. The old content's REMOVED listeners
   * may load anew themselves, and that load is then the one that counts:
   * null tells the caller so.
   */
  private begin(
    loader: AsObject,
    domain: avm2.Domain,
    parameters: ReadonlyMap<string, string> | null,
  ): { info: AsObject; generation: number } | null {
    this.closeLoad(loader);
    const generation: number = loader.$generation;
    this.dropContent(loader);
    if (loader.$generation !== generation) {
      return null;
    }

    const info = this.loaderInfoOf(loader);
    info.$loaderURL = this.ownerUrl(loader);
    info.$domain = domain;
    info.$params = parameters ?? NO_PARAMETERS;
    return { info, generation };
  }

  /** A Loader's close, and what a new load does first: a pending load does nothing when its turn comes, and its fetch is aborted. */
  closeLoad(loader: AsObject): void {
    loader.$generation = (loader.$generation ?? 0) + 1;
    loader.$abort?.abort();
    loader.$abort = null;
  }

  private progress(info: AsObject, loaded: number): void {
    info.$loaded = loaded;
    dispatchEvent(
      this,
      info,
      this.rt.construct(
        this.rt.classNamed("flash.events::ProgressEvent"),
        "progress",
        false,
        false,
        loaded,
        info.$total,
      ),
    );
  }

  /** A Loader's load of a URL: the host fetches it, resolved, and the load completes in a frame after the bytes arrive. */
  requestLoadUrl(
    loader: AsObject,
    request: AsObject | string,
    domain = this.loadDomain(null),
    parameters: ReadonlyMap<string, string> | null = null,
  ): void {
    const begun = this.begin(loader, domain, parameters);
    if (!begun) {
      return;
    }

    const { info, generation } = begun;
    const outgoing = this.fetchRequest(request, info.$loaderURL);
    const abort = new AbortController();
    loader.$abort = abort;
    const fetch = this.fetch;
    this.enqueue(
      loader,
      generation,
      outgoing.url,
      fetch ? fetch(outgoing, abort.signal) : Promise.reject(),
      domain,
      parameters,
    );
  }

  /** A URLStream's host request, delivered in a frame after the bytes arrive. */
  requestBytes(
    request: AsObject | string,
    signal: AbortSignal,
    deliver: (result: FetchResult, url: string) => void,
  ): void {
    const outgoing = this.fetchRequest(request, this.url);
    const fetch = this.fetch;
    // Attach both handlers at once; an early rejection must not be unhandled.
    const fetched = (fetch ? fetch(outgoing, signal) : Promise.reject()).then(
      (result) => result,
      () => ({ bytes: null, status: 0, headers: [] }),
    );
    const completed = fetched.then((result) => {
      this.readyBytes.push(() => deliver(result, outgoing.url));
    });
    this.trackRequest(completed);
  }

  /**
   * navigateToURL's page, resolved as a load's URL is; nothing where the
   * host opens none, or for an empty URL, which Ruffle's navigators ignore
   * rather than open the SWF's own directory. A browser navigates only by
   * GET or POST, so any other method goes as a GET, its data in the query,
   * as Flash's does from a browser.
   */
  navigateTo(request: AsObject, window: string | null): void {
    if (String(request.$url) === "") {
      return;
    }

    const post = String(request.$method ?? "GET").toUpperCase() === "POST";
    this.navigate?.(this.fetchRequest(request, this.url, post ? "POST" : "GET"), window);
  }

  /** sendToURL's request, sent by the host's fetch and its response dropped, as Flash ignores it. */
  sendTo(request: AsObject): void {
    const fetch = this.fetch;
    if (!fetch) {
      return;
    }

    fetch(this.fetchRequest(request, this.url), new AbortController().signal).catch(() => {});
  }

  /** Snapshot a URLRequest at load time, before scripts can change its data or headers. */
  private fetchRequest(request: AsObject | string, base: string, as?: string): FetchRequest {
    if (typeof request === "string") {
      return { url: resolve(base, request), method: "GET", headers: [], body: null };
    }

    let url = String(request?.$url ?? "");
    const method = as ?? String(request?.$method ?? "GET");
    const get = method.toUpperCase() === "GET";
    const post = method.toUpperCase() === "POST";
    const data = request?.$data as Value;
    let body: Uint8Array | null = null;
    if (data !== null && data !== undefined) {
      if (typeof data === "object" && this.rt.traitsOf(data).name === "flash.utils::ByteArray") {
        if (!get) {
          const bytes = avm2.bytesOf(this.rt, data);
          body = bytes.buffer.slice(0, bytes.length);
        }
      } else {
        const text = this.rt.toString(data);
        if (get) {
          url = appendQuery(url, text);
        } else {
          body = new TextEncoder().encode(text);
        }
      }
    }

    const headers: [string, string][] = [];
    if (post) {
      for (const header of request?.$headers?.$a ?? []) {
        headers.push([
          this.rt.toString(this.rt.getProperty(header, this.rt.publicName("name"))),
          this.rt.toString(this.rt.getProperty(header, this.rt.publicName("value"))),
        ]);
      }
    }

    if (body && !headers.some(([name]) => name.toLowerCase() === "content-type")) {
      headers.push([
        "Content-Type",
        String(request?.$contentType ?? "application/x-www-form-urlencoded"),
      ]);
    }

    return { url: resolve(base, url), method, headers, body };
  }

  /** The text a failed stream reports, using Flash Player's message and the resolved URL. */
  streamError(url: string, local = false): string {
    const text = this.errorText(2032);
    return local ? text.replace(/\.$/, "") : `${text} URL: ${resolve(this.url, url)}`;
  }

  /**
   * Resolves once every load asked for so far has its code linked or has
   * failed, so that a host stepping frames by hand sees each complete in
   * the frame after its request, as Flash's loadBytes does.
   */
  settled(): Promise<void> {
    return Promise.all([this.preparing, ...this.pendingRequests]).then(() => {});
  }

  private newLoad(
    loader: AsObject,
    generation: number,
    url: string | null,
    domain: avm2.Domain,
    parameters: ReadonlyMap<string, string> | null,
    swf: Swf | null,
  ): Load {
    return {
      loader,
      generation,
      url,
      domain,
      parameters,
      bytes: new Uint8Array(0),
      status: 0,
      ready: null,
      failed: null,
      swf,
    };
  }

  private enqueue(
    loader: AsObject,
    generation: number,
    url: string | null,
    bytes: Promise<FetchResult>,
    domain: avm2.Domain,
    parameters: ReadonlyMap<string, string> | null,
    swf: Swf | null = null,
  ): void {
    const load = this.newLoad(loader, generation, url, domain, parameters, swf);
    this.loads.push(load);
    // Settled at once, not when its turn in the chain comes: a rejection must find its handler.
    const fetched = bytes.then(
      (result) => result,
      () => ({ bytes: null, status: 0, headers: [] }),
    );
    this.preparing = this.preparing.then(async () => {
      const result = await fetched;
      load.status = result.status;
      if (!result.bytes) {
        load.failed = `${this.errorText(2035)} URL: ${url}`;
        return;
      }

      load.bytes = result.bytes;
      try {
        load.ready = await this.prepare(load);
      } catch {
        // Bytes that are no SWF, or code that does not link.
        load.failed = this.errorText(2124);
      }
    });
  }

  /** "Error #id: message", as Flash's IOErrorEvent texts begin, debugger or not. */
  private errorText(id: number): string {
    return `Error #${id}: ${avm2.errorMessages[id]}`;
  }

  /** The SWF read and its code linked, off the frame; what the frame then does with it. */
  private async prepare(load: Load): Promise<() => () => void> {
    const swf = load.swf ?? readSwf(load.bytes);
    if (!isAs3(swf)) {
      // An AVM1 SWF from a URL: its content comes as an AS3 SWF's does.
      const library = this.avm1Library(swf, load.domain);
      await decodeImages(library, this.decodeImage);
      return () => this.complete(load, swf, library, null);
    }

    const library = readLibrary(swf);
    library.domain = load.domain;
    // Its images first: once its code is linked, a script in the domain can
    // make its symbols, whose bitmaps take the pixels there are then.
    await decodeImages(library, this.decodeImage);
    // One from bytes is its Loader's SWF's, as far as its own URL goes.
    const run = await this.code.link(
      swf,
      load.domain,
      load.url ?? this.ownerUrl(load.loader),
      library,
    );
    // Bound as soon as linked, as its classes are found in the domain from
    // here: one made before the load completes, as another SWF loaded into
    // the domain completes, is its symbol's. Not a load closed or replaced
    // meanwhile, which never completes.
    if (load.generation === load.loader.$generation) {
      this.bind(swf, library);
    }

    return () => this.complete(load, swf, library, run);
  }

  /** A Loader's unload: a pending load dropped, its content out of the display list, its LoaderInfo empty, the Loader kept; stopped for good if `stop`, as unloadAndStop has it, else playing on as an orphan. */
  unload(loader: AsObject, stop = false): void {
    this.closeLoad(loader);
    const content: AsObject | null = loader.$content ?? null;
    this.dropContent(loader);
    if (stop && content) {
      this.lifecycle.stopAll(content.$display);
    }
  }

  /**
   * The content let go of, as unload() and a new load do: the Loader's and
   * the LoaderInfo's first, so an unload a listener asks for finds none,
   * then UNLOAD on the LoaderInfo with the child still attached, as Flash's
   * trace has it (the `loads-init` case), then the child out.
   */
  private dropContent(loader: AsObject): void {
    const content: AsObject | null = loader.$content ?? null;
    loader.$content = null;
    const info: AsObject | undefined = loader.$loaderInfo;
    if (info) {
      info.$content = null;
      info.$bytes = null;
      info.$swf = null;
      info.$url = null;
      info.$params = NO_PARAMETERS;
      info.$loaded = 0;
      info.$total = 0;
    }

    if (content && info) {
      dispatchEvent(this, info, this.event("unload"));
    }

    const display: Container = loader.$display;
    if (content?.$display?.parent === display) {
      this.lifecycle.removing(content.$display);
      display.removeChild(content.$display);
    }
  }

  /** What the next frame does after EXIT_FRAME, before the loads' ends: the main SWF's INIT and COMPLETE. */
  private frameEnds: (() => void)[] = [];

  /**
   * The main SWF, all of it loaded, as its LoaderInfo tells it: INIT, then
   * COMPLETE, at the end of its first frame, after EXIT_FRAME, as Flash
   * (the corpus's loaderinfo_events and delayed_symbolclass).
   */
  mainLoaded(info: AsObject): void {
    this.frameEnds.push(() => {
      dispatchEvent(this, info, this.event("init"));
      dispatchEvent(this, info, this.event("complete"));
    });
  }

  /**
   * Give the loads whose code is linked their content, oldest first, and
   * stop at one still linking: they complete in the order asked. What
   * each does at the frame's end is returned. Each delivery and each load
   * is on its own: one whose code throws, as a loaded SWF's document
   * class's constructor, is reported, and those after it still come.
   */
  private completeLoads(): (() => void)[] {
    const ends: (() => void)[] = [];
    if (this.readyBytes.length !== 0) {
      for (const deliver of this.readyBytes.splice(0)) {
        try {
          deliver();
        } catch (error) {
          this.reportUncaught(error);
        }
      }
    }

    while (this.loads.length && (this.loads[0].ready || this.loads[0].failed)) {
      const load = this.loads.shift() as Load;
      try {
        this.completeLoad(load, ends);
      } catch (error) {
        this.reportUncaught(error);
      }
    }

    return ends;
  }

  private completeLoad(load: Load, ends: (() => void)[]): void {
    if (load.generation !== load.loader.$generation) {
      return;
    }

    if (load.ready) {
      ends.push(load.ready());
      return;
    }

    const info = this.loaderInfoOf(load.loader);
    if (load.url !== null) {
      dispatchEvent(this, info, this.httpStatus(load.status));
      if (load.generation !== load.loader.$generation) {
        return;
      }
    }

    dispatchEvent(this, info, this.ioError(load.failed ?? ""));
  }

  /** An IOErrorEvent of `text`, as a failed load ends. */
  private ioError(text: string): AsObject {
    return this.rt.construct(
      this.rt.classNamed("flash.events::IOErrorEvent"),
      "ioError",
      false,
      false,
      text,
    );
  }

  private loaderInfoOf(loader: AsObject): AsObject {
    loader.$generation ??= 0;
    loader.$loaderInfo ??= this.loaderInfo(loader);
    return loader.$loaderInfo;
  }

  /**
   * A load's content, in the frame after its bytes came, after ENTER_FRAME
   * and before FRAME_CONSTRUCTED, as Flash: the SWF's code run; its
   * document class constructed, with parent and stage null; ADDED to it
   * while it still has no parent, as Flash does; then the LoaderInfo's
   * content, and the Loader's child, with ADDED again and ADDED_TO_STAGE
   * if the loader is on the stage. Its first frame's script runs with
   * the frame's, and INIT and COMPLETE follow EXIT_FRAME.
   */
  private complete(
    load: Load,
    swf: Swf,
    library: Library,
    run: (() => void) | null,
    made: AsObject | null = null,
  ): () => void {
    const info = this.loaderInfoOf(load.loader);
    load.loader.$abort = null;
    // A listener of any of these may close the Loader or load anew, and this load then ends here.
    const live = () => load.generation === load.loader.$generation;
    if (load.url !== null) {
      // A load from bytes told these in the call; one of a URL tells them as
      // the bytes come: OPEN knowing nothing, the total, then the bytes.
      dispatchEvent(this, info, this.event("open"));
      if (!live()) {
        return () => {};
      }

      info.$total = load.bytes.length;
      this.progress(info, 0);
      if (!live()) {
        return () => {};
      }

      // Its URL's query comes with the SWF, as Flash tells it from the
      // second PROGRESS on, unless the context gave parameters.
      if (!load.parameters) {
        info.$params = queryParameters(load.url);
      }

      this.describe(info, load.bytes, swf);
      this.progress(info, load.bytes.length);
      if (!live()) {
        return () => {};
      }
    } else {
      this.describe(info, load.bytes, swf);
    }

    let object: AsObject;
    let root: MovieClip;
    if (run) {
      run();
      this.symbols.addFontLibrary(library);
      root = new MovieClip(library.root, library);
      root.loaderInfo = info;
      root.placeFirstFrame();
      object = this.constructAs(
        root,
        this.rt.classNamed(library.classes.get(0) ?? "flash.display::MovieClip", load.domain),
      );
      dispatchEvent(this, object, this.event("added", true));
      // The SWF's own code has run by now, its document class's constructor
      // among it, which reaches the Loader through loaderInfo.loader.
      if (!live()) {
        return () => {};
      }
    } else {
      // An AVM1 SWF: no code of its own runs, and its root is an AVM1Movie.
      object = made ?? this.avm1Movie(library);
      root = object.$display;
      root.loaderInfo = info;
      root.enterFirstFrame();
    }

    info.$url = load.url ?? info.$dynamic ?? info.$loaderURL;
    info.$content = object;
    load.loader.$content = object;
    const display: Container = load.loader.$display;
    display.addChildAt(root, display.children.length);
    this.lifecycle.added(root);
    return () => {
      if (!live()) {
        return;
      }

      dispatchEvent(this, info, this.event("init"));
      if (!live()) {
        return;
      }

      if (load.url !== null) {
        dispatchEvent(this, info, this.httpStatus(load.status));
      }

      // An INIT or status listener that unloads has no COMPLETE, as Flash.
      if (live()) {
        dispatchEvent(this, info, this.event("complete"));
      }
    };
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
    for (let round = 0; round < 64 && !stopped(); round++) {
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

        for (
          let jumps = 0;
          jumps < 64 && o.scriptedFrame !== o.currentFrame && !stopped();
          jumps++
        ) {
          o.scriptedFrame = o.currentFrame;
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
      const queue: MovieClip[] = [];
      const visit = (o: DisplayObject) => {
        if (o instanceof MovieClip && o.object) {
          queue.push(o);
        }

        // An index, not for-of: this visits every object on the list.
        const children = scriptChildren(o);
        for (let i = 0; i < children.length; i++) {
          visit(children[i]);
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

      for (const o of queue) {
        own(o);
      }

      if (!ran) {
        break;
      }
    }
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

    const ends = [...this.frameEnds.splice(0), ...this.completeLoads()];
    this.broadcast("frameConstructed");
    const outer = this.scriptPhase;
    this.scriptPhase = true;
    try {
      this.runFrameScripts(root);
    } finally {
      this.scriptPhase = outer;
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

    this.deliverAvm1Loads();

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

const NO_PARAMETERS: ReadonlyMap<string, string> = new Map();

/**
 * The names and values of a URL's query, as Flash reads them into
 * loaderInfo.parameters: decoded, `+` as a space, a name without `=` an
 * empty value, an empty name left out, and the last of a name kept.
 */
function queryParameters(url: string): Map<string, string> {
  const parameters = new Map<string, string>();
  const path = url.split("#", 1)[0];
  const at = path.indexOf("?");
  if (at < 0) {
    return parameters;
  }

  for (const [name, value] of new URLSearchParams(path.slice(at + 1))) {
    if (name !== "") {
      parameters.set(name, value);
    }
  }

  return parameters;
}

function appendQuery(url: string, query: string): string {
  if (!query) {
    return url;
  }

  const at = url.indexOf("#");
  const path = at < 0 ? url : url.slice(0, at);
  const fragment = at < 0 ? "" : url.slice(at);
  const separator = path.includes("?") ? (/[?&]$/.test(path) ? "" : "&") : "?";
  return path + separator + query + fragment;
}

/**
 * `url` against `base`, enough for a SWF's relative paths: one with a
 * scheme is itself, one from the root keeps the base's origin, and any
 * other replaces the base's last segment.
 */
function resolve(base: string, url: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) {
    return url;
  }

  const origin = base.match(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i)?.[0] ?? "";
  if (url.startsWith("/")) {
    return origin + url;
  }

  return base.slice(0, base.lastIndexOf("/") + 1) + url;
}

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
