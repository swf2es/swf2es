// A SWF's scripts: its DoABCs compiled through @swf2es/codegen and loaded
// into a runtime with playerglobal's natives, its SymbolClass binding
// characters to classes, and the link between a display object and the
// AS3 object that is its other face (docs/architecture.md, "Scripts and
// the display list"). The runtime allocates every DisplayObject through a
// hook that takes the display object the player has pending, when the
// player constructs a timeline child's class, or makes one for a `new`.
import type { Codegen } from "@swf2es/codegen";
import {
  isAs3,
  readDoAbc,
  readSwf,
  readSymbolClass,
  type Sound,
  type Swf,
  tags,
} from "@swf2es/format";
import { avm2 } from "@swf2es/runtime";
import { type AudioHost, browserAudioHost, type DecodedSound } from "./audio.js";
import { BitmapStore } from "./bitmap.js";
import {
  BitmapObject,
  ButtonObject,
  buttonStates,
  Container,
  type DisplayObject,
  displayFor,
  EMPTY_TIMELINE,
  MovieClip,
  ShapeObject,
  scriptChildren,
  TextObject,
  TRANSFORM,
  VideoObject,
} from "./display.js";
import { FontSet } from "./fonts.js";
import { decodeImages, decodeInBrowser, hasUndecoded, type ImageDecode } from "./images.js";
import type { Cursor, PointerInput } from "./input.js";
import { rootOf } from "./playerglobal/flash/display/DisplayObject.js";
import { dispatchEvent, dispatchTo } from "./playerglobal/flash/events/EventDispatcher.js";
import {
  finishSounds,
  stopTimelineSoundsUnder,
  timelineSoundsOf,
} from "./playerglobal/flash/media/Sound.js";
import { browserNavigate, type Navigate } from "./playerglobal/flash/net/navigateToURL.js";
import { defaultStorage, type SharedObjectStorage } from "./playerglobal/flash/net/SharedObject.js";
import {
  type PlatformCapabilities,
  platformCapabilities,
} from "./playerglobal/flash/system/Capabilities.js";
import { playerHooks, playerNatives } from "./playerglobal/index.js";
import { sha256 } from "./sha256.js";
import {
  type AnyFontCharacter,
  type BitmapCharacter,
  type ButtonCharacter,
  type Character,
  type DisplayCharacter,
  INVALID_PIXELS,
  type Library,
  readLibrary,
  type SoundCharacter,
} from "./timeline.js";

type AsObject = avm2.AsObject;
type Value = avm2.Value;

/** The host side of playerglobal's synchronous ExternalInterface protocol. */
export interface ExternalInterfaceHost {
  /** JavaScript source from playerglobal; the host decides whether to evaluate it. */
  evalJS(source: string): string | null;
  /** An XML invocation when evalJS declined the call. */
  callOut(request: string): string | null;
  /** A wrapper produced by playerglobal. Its arguments and result use AVM2 values. */
  addCallback(name: string, callback: ((request: string, args: Value[]) => Value) | null): void;
  objectID?: string | null;
}

/** Screen values reported by flash.system.Capabilities, captured when the player starts. */
export interface ScreenCapabilities {
  screenResolutionX: number;
  screenResolutionY: number;
  pixelAspectRatio: number;
  screenDPI: number;
}

type Affine = { a: number; b: number; c: number; d: number; tx: number; ty: number };

/** A renderer's part in BitmapData.draw of a display object. */
export interface Drawer {
  /** `o` through `m` into a w x h texture at `samples` a side, read back as premultiplied ARGB. */
  snapshot(
    o: DisplayObject,
    m: Affine,
    width: number,
    height: number,
    samples: number,
  ): Uint32Array;
  /**
   * `o` the same, composited source over into `store` at (x, y) on the GPU,
   * left there until read; false, having done nothing, where it cannot.
   */
  drawInto(
    store: BitmapStore,
    o: DisplayObject,
    m: Affine,
    x: number,
    y: number,
    width: number,
    height: number,
    samples: number,
  ): boolean;
}

/** A host request's bytes and transport result; a local file reports status 0. */
export interface FetchResult {
  bytes: Uint8Array | null;
  status: number;
  headers: readonly (readonly [name: string, value: string])[];
  /** Set for `file:` URLs: Flash reports status 0 and leaves the URL out of #2032. */
  local?: boolean;
}

/** The request the player asks its host to send. */
export interface FetchRequest {
  url: string;
  method: string;
  headers: readonly (readonly [name: string, value: string])[];
  body: Uint8Array | null;
}

/** A TCP connection supplied by the embedding host. */
export interface SocketTransport {
  send(bytes: Uint8Array): void;
  close(): void;
}

/** Transport notifications; the player delivers them to ActionScript on a frame. */
export interface SocketEvents {
  open(): void;
  data(bytes: Uint8Array): void;
  close(): void;
  error(message: string): void;
}

export interface SocketHost {
  connect(host: string, port: number, events: SocketEvents): SocketTransport;
}

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

/** What SymbolClass bound a class to: a character of a SWF's library. */
interface Symbol {
  character: Character;
  library: Library;
}

interface SharedAudio {
  definition: WeakRef<Sound>;
  decoded: DecodedSound | null;
  pending: Promise<DecodedSound> | null;
  serial: number;
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
  private readonly audioEntries = new WeakMap<SoundCharacter, SharedAudio>();
  /** What plays every library's timeline and button sounds. */
  private readonly timelineSounds = timelineSoundsOf(this);
  private readonly sharedAudio = new Map<number, SharedAudio[]>();
  private readonly sharedAudioGone = new FinalizationRegistry<{
    hash: number;
    entry: SharedAudio;
    serial: number;
  }>(({ hash, entry, serial }) => {
    if (entry.serial !== serial || entry.definition.deref()) {
      return;
    }

    this.removeSharedAudio(hash, entry);
  });
  /**
   * The character, and its SWF's library, each class SymbolClass bound
   * makes, for a `new` of the class from a script: by the module that
   * defines the class, as the SWF's domain found it, then its name, so a
   * class of the same name in another domain has its own; null for a name
   * nothing defined when it was bound.
   */
  readonly symbols = new Map<avm2.Abc | null, Map<string, Symbol>>();
  /** Libraries whose embedded fonts have been made visible to this player. */
  readonly fontLibraries = new Set<Library>();
  /** Font classes explicitly registered by scripts, in registration order. */
  readonly registeredFonts = new Map<AsObject, AnyFontCharacter>();
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
  /**
   * Clips taken off the display list, which play on as Flash's do: held
   * weakly, as Ruffle holds them, so one nothing refers to stops as Flash's
   * does once collected. One the timeline took is kept for its frame only.
   */
  private readonly orphans = new Map<number, { ref: WeakRef<DisplayObject>; keep: boolean }>();
  /** Display objects scripts made with `new` this frame: their first frame's script runs after everything else's, and they are orphans after. */
  private fresh: DisplayObject[] = [];
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
  private readonly broadcasts = new Map<string, Set<AsObject>>();
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
  /** The clock, in milliseconds since the start, moved by the frame step and nothing else; Timer fires by it. */
  clock = 0;
  /**
   * The time getTimer tells and a timer started now counts from: the clock,
   * except while a timer's closure runs, when it is the time the timer fell
   * due, as Flash fires timers between frames at their own times, so that
   * one timer set from another keeps the first's pace, not the frame's.
   */
  now = 0;
  private readonly realTime: (() => number) | null;
  private readonly realStart: number;

  /**
   * What getTimer tells: whole milliseconds since the start, by the real
   * clock, truncated as Flash's are, or by the frame clock's now, rounded
   * as it always has been, so that the traces recorded by it stay.
   */
  timer(): number {
    return this.realTime ? Math.floor(this.realTime() - this.realStart) : Math.round(this.now);
  }
  /** The timers started, by their Timer objects, and a heap of them by when they fall due. */
  private readonly running = new Map<AsObject, TimerRecord>();
  private readonly timers = new TimerHeap();
  quality = "HIGH";
  private readonly hashes: string[] = [];
  /**
   * The compiler's application domain for each of the runtime's, by its
   * number; the compiler's index of each ABC added into one, in order; and
   * the findings each has been told (see add).
   */
  private readonly codegenDomains = new Map<number, number>([[0, 0]]);
  private readonly codegenAbcs = new Map<number, number[]>([[0, []]]);
  private readonly reported = new Map<number, Set<string>>();
  /** Modules imported, each under a script name of its own for Runtime.codeDomain. */
  private modules = 0;
  /** The URL of the SWF each module's code came from, by its script name, for codeUrl. */
  private readonly moduleUrls = new Map<string, string>();
  private readonly moduleLibraries = new Map<string, Library>();
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
    this.realTime = options.realTime === undefined ? defaultClock() : options.realTime;
    // getTimer's zero: when the player is made, as Flash's is when it starts.
    this.realStart = this.realTime ? this.realTime() : 0;
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
  async loadLibraries(abcs: Uint8Array[]): Promise<void> {
    for (const abc of abcs) {
      await this.compileAt(await this.add(abc, true, this.rt.root), this.rt.root, true);
    }
  }

  /** Load the SWF's DoABCs in tag order, each run unless its lazy flag defers it to first use, then its SymbolClass. */
  async loadSwf(swf: Swf, library: Library): Promise<void> {
    this.library = library;
    this.addFontLibrary(library);

    library.domain = this.mainDomain;
    this.rt.swfVersion = swf.header.version;
    const decoded = decodeImages(library, this.decodeImage);
    const run = await this.link(swf, this.mainDomain, this.url, library);
    await decoded;
    run();
    this.bind(swf, library);
  }

  /**
   * The SWF's DoABCs compiled and linked, in tag order: what runs them,
   * each unless its lazy flag defers it to first use. Linking is
   * asynchronous, running is not, so a load can run its code in a frame.
   */
  private async link(
    swf: Swf,
    domain: avm2.Domain,
    url: string,
    library: Library,
  ): Promise<() => void> {
    // Every DoABC added before any compiles: avmplus has a frame's ABCs all
    // loaded before it verifies a method, so a class in the first tag may
    // extend or name one in the last (the corpus's property_priority).
    const added: { index: number; lazy: boolean }[] = [];
    for (const t of swf.tags) {
      if (t.code === tags.DoABC || t.code === tags.DoABC2) {
        const { lazy, abc } = readDoAbc(swf.bytes, t);
        added.push({ index: await this.add(abc, false, domain), lazy });
      }
    }

    const runs: (() => void)[] = [];
    for (const { index, lazy } of added) {
      const linked = await this.compileAt(index, domain, false, url, library);
      if (!lazy) {
        runs.push(() => this.rt.run(linked));
      }
    }

    return () => {
      for (const run of runs) {
        run();
      }
    };
  }

  /** SymbolClass: bind the SWF's characters to their classes, in its library, and the library to this. */
  private bind(swf: Swf, library: Library): void {
    const domain = library.domain ?? this.mainDomain;
    for (const t of swf.tags) {
      if (t.code === tags.SymbolClass) {
        for (const [id, name] of readSymbolClass(swf.bytes, t)) {
          const qualified = qualify(name);
          library.classes.set(id, qualified);
          const character = library.characters.get(id);
          if (character) {
            const abc = this.rt.definingAbc(qualified, domain);
            let byName = this.symbols.get(abc);
            if (!byName) {
              byName = new Map();
              this.symbols.set(abc, byName);
            }

            // A class keeps the symbol first bound to it: another SWF that
            // binds it, one that finds it in a parent's domain, makes its own
            // timeline's instances of it but not a script's (the corpus's
            // loader_duplicate_class).
            if (!byName.has(qualified)) {
              byName.set(qualified, { character, library });
            }
          }
        }
      }
    }

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
    library.removing = (display, byTimeline) => this.removing(display, byTimeline);
    library.sounds = this.timelineSounds;
  }

  /**
   * An ABC added to the compiler's domain, into the application domain of
   * the runtime's `domain`, linked against what that domain sees of those
   * before it, with what it has found: its index among all added.
   */
  private async add(abc: Uint8Array, builtin: boolean, domain: avm2.Domain): Promise<number> {
    const target = this.codegenDomainOf(domain);
    if (domain !== this.rt.root) {
      const told = this.reported.get(domain.id) ?? new Set<string>();
      this.reported.set(domain.id, told);
      for (const f of this.rt.compileUnit(domain).found) {
        const key = JSON.stringify([f.asType, f.nsKind, f.uri, f.name, f.domain, f.index]);
        const at = this.codegenAbcs.get(f.domain)?.[f.index];
        if (at !== undefined && !told.has(key)) {
          told.add(key);
          this.codegen.found({ ...f, domain: target, abc: at });
        }
      }
    }

    const error = this.codegen.add(abc, builtin, target);
    if (error) {
      throw new Error(`an ABC was rejected: VerifyError #${error}`);
    }

    this.codegenAbcs.get(domain.id)?.push(this.hashes.length);
    this.hashes.push(await sha256(abc));
    return this.hashes.length - 1;
  }

  /** The compiler's application domain for the runtime's `domain`, made with its ancestors' as needed. */
  private codegenDomainOf(domain: avm2.Domain): number {
    let target = this.codegenDomains.get(domain.id);
    if (target === undefined) {
      target = this.codegen.childDomain(this.codegenDomainOf(domain.parent ?? this.rt.root));
      this.codegenDomains.set(domain.id, target);
      this.codegenAbcs.set(domain.id, []);
    }

    return target;
  }

  /**
   * ABC `index`'s module, compiled against every ABC added so far that its
   * domain sees, loaded into the runtime's `domain`; `builtin` for the
   * player's own libraries. Each is imported under a script name of its
   * own, by which Runtime.codeDomain finds the domain of the code running.
   */
  private async compileAt(
    index: number,
    domain: avm2.Domain,
    builtin = false,
    url?: string,
    library?: Library,
  ): Promise<Value> {
    const module = this.codegen.compileModule(this.hashes, index);
    const script = `swf2es-${++this.modules}.js`;
    if (url !== undefined) {
      this.moduleUrls.set(script, url);
    }
    if (library) {
      this.moduleLibraries.set(script, library);
    }

    const named = `${module}//# sourceURL=${script}\n`;
    const factory = (await importSource(named)).default;
    return this.rt.loadInto(domain, () => factory(this.rt), builtin);
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

          this.added(display);
          return;
        }
      }
    }

    const object =
      character.type === "bitmap" && display instanceof BitmapObject
        ? this.constructBitmap(display, name, domain)
        : this.constructAs(display, this.rt.classNamed(name, domain));
    named(object);
    this.added(display);
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

  /** The bitmap a class SymbolClass bound is of, if `traits` or a base is one's. */
  bitmapSymbol(traits: SymbolTraits): BitmapCharacter | null {
    for (let t: SymbolTraits | null = traits; t; t = t.base as SymbolTraits | null) {
      const symbol = this.symbolOf(t);
      if (symbol) {
        return symbol.character.type === "bitmap" ? symbol.character : null;
      }
    }

    return null;
  }

  /**
   * The bytes of the DefineBinaryData a class SymbolClass bound, if
   * `traits` or a base is one's: one buffer for all its instances, which
   * see each other's writes, as Flash's.
   */
  binarySymbol(traits: SymbolTraits): Uint8Array<ArrayBuffer> | null {
    for (let t: SymbolTraits | null = traits; t; t = t.base as SymbolTraits | null) {
      const symbol = this.symbolOf(t);
      if (symbol) {
        const character = symbol.character;
        if (character.type !== "binary") {
          return null;
        }

        character.shared ??= new Uint8Array(character.data);
        return character.shared;
      }
    }

    return null;
  }

  /** A DefineSound a class or one of its bases was bound to. */
  soundSymbol(traits: SymbolTraits): SoundCharacter | null {
    for (let t: SymbolTraits | null = traits; t; t = t.base as SymbolTraits | null) {
      const symbol = this.symbolOf(t);
      if (symbol) {
        return symbol.character.type === "sound" ? symbol.character : null;
      }
    }

    return null;
  }

  /** A DefineFont a class or one of its bases was bound to. */
  fontSymbol(traits: SymbolTraits): AnyFontCharacter | null {
    for (let t: SymbolTraits | null = traits; t; t = t.base as SymbolTraits | null) {
      const symbol = this.symbolOf(t);
      if (symbol) {
        return symbol.character.type === "font" || symbol.character.type === "fontCff"
          ? symbol.character
          : null;
      }
    }

    return null;
  }

  /** Keep a SWF's own fonts and fonts registered elsewhere available to its fields. */
  private addFontLibrary(library: Library): void {
    if (this.fontLibraries.has(library)) {
      return;
    }

    this.fontLibraries.add(library);
    for (const font of this.registeredFonts.values()) {
      if (font.type === "font") {
        library.fonts.add(font.font);
      }
    }
  }

  /** Make a registered font available to fields made by every loaded SWF. */
  registerFont(cls: AsObject, font: AnyFontCharacter): void {
    if (
      this.registeredFonts.has(cls) ||
      [...this.registeredFonts.values()].some(
        (registered) =>
          registered.name.toLowerCase() === font.name.toLowerCase() &&
          registered.type === font.type &&
          registered.bold === font.bold &&
          registered.italic === font.italic,
      )
    ) {
      return;
    }

    this.registeredFonts.set(cls, font);
    for (const library of this.fontLibraries) {
      if (font.type === "font") {
        library.fonts.add(font.font);
      }
    }
  }

  /** Decode a sound on first play; live libraries can share an identical decode. */
  soundClip(character: SoundCharacter): Promise<DecodedSound> | null {
    if (!this.audio) {
      return null;
    }

    const own = this.audioEntries.get(character);
    if (own?.pending) {
      return own.pending;
    }

    const ownDecoded = own?.decoded;
    if (ownDecoded) {
      return Promise.resolve(ownDecoded);
    }

    const definition = character.definition;
    const hash = soundHash(definition);
    for (const entry of this.sharedAudio.get(hash) ?? []) {
      const prior = entry.definition.deref();
      if (!prior || !sameSound(prior, definition)) {
        continue;
      }

      const decoded = entry.decoded;
      const clip = entry.pending ?? (decoded ? Promise.resolve(decoded) : null);
      if (clip) {
        entry.definition = new WeakRef(definition);
        this.sharedAudioGone.register(definition, {
          hash,
          entry,
          serial: ++entry.serial,
        });
        this.audioEntries.set(character, entry);
        return clip;
      }
    }

    const entry: SharedAudio = {
      definition: new WeakRef(definition),
      decoded: null,
      pending: null,
      serial: 1,
    };
    const audio = this.audio;
    const clip = Promise.resolve().then(() => audio.decode(definition));
    entry.pending = clip;
    const matches = this.sharedAudio.get(hash) ?? [];
    matches.push(entry);
    this.sharedAudio.set(hash, matches);
    this.sharedAudioGone.register(definition, { hash, entry, serial: 1 });
    void clip.then(
      (decoded) => {
        entry.decoded = decoded;
        entry.pending = null;
      },
      () => this.removeSharedAudio(hash, entry),
    );
    this.audioEntries.set(character, entry);
    return clip;
  }

  private removeSharedAudio(hash: number, entry: SharedAudio): void {
    const matches = this.sharedAudio.get(hash)?.filter((candidate) => candidate !== entry) ?? [];
    if (matches.length > 0) {
      this.sharedAudio.set(hash, matches);
    } else {
      this.sharedAudio.delete(hash);
    }
  }

  /** What SymbolClass bound the class of `traits` to, if anything: by its defining module, then its name. */
  private symbolOf(traits: SymbolTraits): Symbol | undefined {
    const abc = (traits.abc as avm2.Abc | null | undefined) ?? null;
    return this.symbols.get(abc)?.get(traits.name) ?? this.symbols.get(null)?.get(traits.name);
  }

  /** A new plain BitmapData of a bitmap's pixels, as a Bitmap of the bitmap gets. */
  bitmapDataOf(character: BitmapCharacter): AsObject {
    const data = this.rt.construct(
      this.rt.classNamed("flash.display::BitmapData"),
      1,
      1,
    ) as AsObject;
    data.$store = BitmapStore.of(character.pixels ?? INVALID_PIXELS);
    return data;
  }

  /** Whether `d` is on the display list: under the stage. */
  onStage(d: DisplayObject): boolean {
    for (let o: DisplayObject | null = d; o; o = o.parent) {
      if (o === this.stage) {
        return true;
      }
    }

    return false;
  }

  /**
   * `display` has a parent now: ADDED to it, bubbling, and, if it is on
   * the display list, ADDED_TO_STAGE to it and each descendant, in tree
   * order, as Flash dispatches them.
   */
  added(display: DisplayObject): void {
    this.orphans.delete(display.serial);
    if (display.object) {
      dispatchEvent(this, display.object, this.event("added", true));
    }

    if (this.onStage(display)) {
      this.eachObject(display, (o) => dispatchEvent(this, o, this.event("addedToStage")));
    }
  }

  /**
   * `display` is about to lose its parent: REMOVED, bubbling, and
   * REMOVED_FROM_STAGE through the subtree if it was on the display list.
   * It then plays on as an orphan; the timeline's removal has it play its
   * removal frame only, and takes the parent's property of its name away.
   */
  removing(display: DisplayObject, byTimeline = false): void {
    if (display.object) {
      dispatchEvent(this, display.object, this.event("removed", true));
    }

    if (this.onStage(display)) {
      this.eachObject(display, (o) => dispatchEvent(this, o, this.event("removedFromStage")));
    }

    this.orphan(display, !byTimeline);
    const parent = display.parent?.object;
    if (byTimeline && parent && display.timelineNamed) {
      const name = avm2.qname(avm2.publicNs, display.name);
      if (this.rt.getProperty(parent, name) === display.object) {
        this.rt.setProperty(parent, name, null);
      }
    }
  }

  /**
   * `display` is off the display list with an AS3 object that may play
   * it, taken off by a script, or by the timeline, which keeps it for its
   * frame only, not `keep`.
   */
  orphan(display: DisplayObject, keep = true): void {
    if (display.object && !this.orphans.has(display.serial)) {
      this.orphans.set(display.serial, { ref: new WeakRef(display), keep });
    }
  }

  /**
   * A script made `display` with `new`. Flash runs its first frame's
   * script at the end of this frame's, in the order made, has it sit out
   * the next frame's advance, and plays it on from there, on the display
   * list or as an orphan.
   */
  made(display: DisplayObject): void {
    this.fresh.push(display);
    if (display instanceof MovieClip) {
      display.fresh = true;
    }
  }

  /** The orphans still there, newest first, as Flash runs their frames. */
  orphanRoots(): DisplayObject[] {
    const roots: DisplayObject[] = [];
    for (const [serial, orphan] of this.orphans) {
      const display = orphan.ref.deref();
      if (!display) {
        this.orphans.delete(serial);
        continue;
      }

      roots.push(display);
    }

    return roots.sort((a, b) => b.serial - a.serial);
  }

  /**
   * Stop `display` and everything under it for good, as unloadAndStop
   * does: timelines stopped, frame broadcasts no longer heard, no orphan.
   */
  stopAll(display: DisplayObject): void {
    this.orphans.delete(display.serial);
    stopTimelineSoundsUnder(this, display);
    const stop = (o: DisplayObject) => {
      if (o instanceof MovieClip) {
        o.playing = false;
      }

      if (o.object) {
        for (const targets of this.broadcasts.values()) {
          targets.delete(o.object);
        }
      }

      if (o instanceof Container) {
        for (const child of o.children) {
          stop(child);
        }
      }
    };
    stop(display);
  }

  private eachObject(display: DisplayObject, f: (o: AsObject) => void): void {
    if (display.object) {
      f(display.object);
    }

    if (display instanceof Container) {
      for (const child of [...display.children]) {
        this.eachObject(child, f);
      }
    }
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

  /**
   * The display object for an instance a script makes with `new`: the
   * character of a class SymbolClass bound, if the class or a base of it
   * is one, else an empty clip, shape or container by the nearest base.
   */
  /** A button's states from its records, each a Sprite of its characters where it has other than one, all constructed. */
  private makeButtonStates(
    button: ButtonObject,
    character: ButtonCharacter,
    library: Library,
  ): void {
    const sprite = this.rt.classNamed("flash.display::Sprite");
    buttonStates(
      button,
      character,
      library,
      (display, c) => this.construct(display, c, library),
      (holder) => this.constructAs(holder, sprite),
    );
  }

  displayFor(traits: SymbolTraits): DisplayObject {
    const library: Library = this.library ?? {
      characters: new Map(),
      root: EMPTY_TIMELINE,
      classes: new Map(),
      construct: null,
      constructLater: null,
      constructPlaced: null,
      uncaught: null,
      removing: null,
      fonts: new FontSet(),
    };
    for (let t: SymbolTraits | null = traits; t; t = t.base as SymbolTraits | null) {
      // A display object's class bound to data has no display of it.
      const symbol = this.symbolOf(t);
      if (
        symbol &&
        symbol.character.type !== "binary" &&
        symbol.character.type !== "font" &&
        symbol.character.type !== "fontCff" &&
        symbol.character.type !== "sound"
      ) {
        if (symbol.character.type === "text") {
          // A new linked TextField has its symbol's bounds, but not its timeline's initial text.
          const text = new TextObject(symbol.character, false);
          text.fonts = symbol.library.fonts;
          return text;
        }

        const display = displayFor(symbol.character, symbol.library);
        // A bound button a script makes has its states, as a timeline's does.
        if (display instanceof ButtonObject && symbol.character.type === "button") {
          this.makeButtonStates(display, symbol.character, symbol.library);
        }

        return display;
      }

      if (t.name === "flash.display::SimpleButton") {
        return new ButtonObject();
      }

      if (t.name === "flash.display::MovieClip") {
        return new MovieClip(EMPTY_TIMELINE, library);
      }

      if (t.name === "flash.display::Shape") {
        return new ShapeObject(null);
      }

      // Only a timeline makes a MorphShape or a StaticText.
      if (t.name === "flash.display::MorphShape") {
        throw this.rt.error("ArgumentError", 2012, "MorphShape$");
      }

      if (t.name === "flash.text::StaticText") {
        throw this.rt.error("ArgumentError", 2012, "StaticText$");
      }

      // Only a load of an AVM1 SWF makes one (requestLoad).
      if (t.name === "flash.display::AVM1Movie") {
        throw this.rt.error("ArgumentError", 2012, "AVM1Movie$");
      }

      if (t.name === "flash.display::Bitmap") {
        return new BitmapObject(null);
      }

      if (t.name === "flash.media::Video") {
        return new VideoObject();
      }

      if (t.name === "flash.text::TextField") {
        const text = new TextObject(null);
        text.fonts = (this.codeLibrary() ?? library).fonts;
        return text;
      }
    }

    return new Container();
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

  /** An ApplicationDomain object for the runtime's `domain`: a new one at each ask, as Flash's, without running its constructor. */
  applicationDomainOf(domain: avm2.Domain): AsObject {
    const object = this.rt.classNamed("flash.system::ApplicationDomain").$it.instance();
    object.$domain = domain;
    return object;
  }

  /**
   * The domain a load goes into: the LoaderContext's applicationDomain, or
   * by default a new child of the domain of the code that asked, as
   * Flash's `new ApplicationDomain(ApplicationDomain.currentDomain)`.
   */
  loadDomain(applicationDomain: Value): avm2.Domain {
    const chosen: avm2.Domain | undefined = applicationDomain?.$domain;
    return chosen ?? this.rt.childDomain(this.codeDomain());
  }

  /**
   * The domain of the code that asks (Runtime.codeDomain): the main SWF's
   * when no SWF's code is on the stack, only the player's.
   */
  codeDomain(): avm2.Domain {
    const domain = this.rt.codeDomain();
    return domain === this.rt.root ? this.mainDomain : domain;
  }

  /**
   * The URL of the SWF whose code asks, the innermost on the stack, as
   * Flash's code context has it; the main SWF's when only the player's is.
   */
  codeUrl(): string {
    for (const at of avm2.frameScripts(new Error().stack)) {
      const url = this.moduleUrls.get(at);
      if (url !== undefined) {
        return url;
      }
    }

    return this.url;
  }

  /** The SWF whose code called a playerglobal native. */
  codeLibrary(): Library | null {
    for (const at of avm2.frameScripts(new Error().stack)) {
      const library = this.moduleLibraries.get(at);
      if (library) {
        return library;
      }
    }

    return this.library;
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
   * movie go to its Loader (input.ts).
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
    const decoded = decodeImages(library, this.decodeImage);
    // One from bytes is its Loader's SWF's, as far as its own URL goes.
    const run = await this.link(swf, load.domain, load.url ?? this.ownerUrl(load.loader), library);
    await decoded;
    return () => this.complete(load, swf, library, run);
  }

  /** A Loader's unload: a pending load dropped, its content out of the display list, its LoaderInfo empty, the Loader kept; stopped for good if `stop`, as unloadAndStop has it, else playing on as an orphan. */
  unload(loader: AsObject, stop = false): void {
    this.closeLoad(loader);
    const content: AsObject | null = loader.$content ?? null;
    this.dropContent(loader);
    if (stop && content) {
      this.stopAll(content.$display);
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
      this.removing(content.$display);
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
      this.addFontLibrary(library);
      this.bind(swf, library);
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
    this.added(root);
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

  /**
   * A frame begins: the clock moves on by `ms`, and the timers that fall
   * due by then fire, before the timeline advances, each firing the
   * earliest due, so that two timers interleave as their times do and
   * one started from another with time to spare fires in the same pass.
   */
  beginFrame(ms: number): void {
    this.clock += ms;
    try {
      for (;;) {
        const next = this.timers.pop(this.clock);
        if (!next) {
          break;
        }

        this.now = next.due;
        next.due += next.delay;
        try {
          this.rt.call(next.closure, next.object);
        } catch (error) {
          // Reported, and the timers after it and the frame still run.
          this.reportUncaught(error);
        } finally {
          // Pushed back whatever the call did, unless it stopped the timer or
          // started it anew: one whose closure throws still has its next time.
          if (!next.stopped) {
            this.timers.push(next);
          }
        }
      }
    } finally {
      this.now = this.clock;
    }
  }

  /** Timer._start: `closure` is called every `delay` ms from now, until stopped; a timer running already is started anew. */
  startTimer(object: AsObject, delay: number, closure: Value): void {
    this.stopTimer(object);
    const record: TimerRecord = {
      object,
      delay: Math.max(delay, 1),
      closure,
      due: this.now + delay,
      seq: 0,
      stopped: false,
    };
    this.running.set(object, record);
    this.timers.push(record);
  }

  stopTimer(object: AsObject): void {
    const record = this.running.get(object);
    if (record) {
      record.stopped = true;
      this.running.delete(object);
      this.timers.stopped();
    }
  }

  timerRunning(object: AsObject): boolean {
    return this.running.has(object);
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

        for (const child of scriptChildren(o)) {
          visit(child);
        }
      };
      for (const orphan of this.orphanRoots()) {
        visit(orphan);
      }

      visit(root);
      for (const display of this.fresh) {
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
    // What the timeline took off this frame has had its frame; it stops here.
    for (const [serial, orphan] of this.orphans) {
      if (!orphan.keep) {
        this.orphans.delete(serial);
      }
    }
    // What scripts made this frame and left off the display list plays on as an orphan.
    for (const display of this.fresh.splice(0)) {
      if (!display.parent) {
        this.orphan(display);
      }
    }
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

/** Compare the bytes too: a 32-bit hash only narrows a bucket, never decides identity. */
function sameSound(a: Sound, b: Sound): boolean {
  if (
    a.format !== b.format ||
    a.sampleRate !== b.sampleRate ||
    a.sampleSize !== b.sampleSize ||
    a.channels !== b.channels ||
    a.sampleCount !== b.sampleCount ||
    a.seekSamples !== b.seekSamples ||
    a.data.length !== b.data.length
  ) {
    return false;
  }

  for (let i = 0; i < a.data.length; i++) {
    if (a.data[i] !== b.data[i]) {
      return false;
    }
  }

  return true;
}

function soundHash(sound: Sound): number {
  let hash = 0x811c9dc5;
  for (const value of [
    sound.format,
    sound.sampleRate,
    sound.sampleSize,
    sound.channels,
    sound.sampleCount,
    sound.seekSamples,
  ]) {
    hash = Math.imul(hash ^ value, 0x01000193);
  }

  for (const byte of sound.data) {
    hash = Math.imul(hash ^ byte, 0x01000193);
  }

  return hash >>> 0;
}

/** The real clock where the host has one, browsers and node alike; else none, and the frame clock. */
function defaultClock(): (() => number) | null {
  return typeof performance !== "undefined" ? () => performance.now() : null;
}

/** A class's traits as the symbol lookups read them: its name, its module, its base's. */
interface SymbolTraits {
  name: string;
  abc?: unknown;
  base: unknown;
}

interface TimerRecord {
  object: AsObject;
  delay: number;
  closure: Value;
  due: number;
  /** Its place among timers due at the same time: the one scheduled first fires first. */
  seq: number;
  /** Stopped, and so to be dropped when it surfaces; a Timer started anew gets a record of its own. */
  stopped: boolean;
}

/**
 * The started timers by due time, a binary min-heap as asyncio keeps its
 * scheduled callbacks: the next due is found and rescheduled in O(log n)
 * where a scan of all timers is O(n) per firing, which at a thousand
 * timers is the difference between 0.3 and 2.5 ms a frame. A stopped
 * timer stays until it surfaces, and the heap is rebuilt without the
 * stopped when they are more than half of it.
 */
class TimerHeap {
  private heap: TimerRecord[] = [];
  private seq = 0;
  private stoppedCount = 0;

  push(record: TimerRecord): void {
    record.seq = this.seq++;
    this.insert(record);
  }

  /** `record` in its place by due time and the sequence it has. */
  private insert(record: TimerRecord): void {
    const h = this.heap;
    h.push(record);
    let i = h.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!before(h[i], h[parent])) {
        break;
      }

      [h[i], h[parent]] = [h[parent], h[i]];
      i = parent;
    }
  }

  /** The earliest due timer at or before `clock`, taken out; stopped ones in the way are dropped. */
  pop(clock: number): TimerRecord | null {
    for (;;) {
      const top = this.heap[0];
      if (!top || top.due > clock) {
        return null;
      }

      this.remove();
      if (top.stopped) {
        this.stoppedCount--;
        continue;
      }

      return top;
    }
  }

  stopped(): void {
    this.stoppedCount++;
    if (this.stoppedCount > this.heap.length / 2) {
      // Rebuilt with each record's own sequence: the order of two due at once must not change.
      const live = this.heap.filter((r) => !r.stopped);
      this.heap = [];
      this.stoppedCount = 0;
      for (const record of live) {
        this.insert(record);
      }
    }
  }

  private remove(): void {
    const h = this.heap;
    const last = h.pop() as TimerRecord;
    if (!h.length) {
      return;
    }

    h[0] = last;
    let i = 0;
    for (;;) {
      const left = 2 * i + 1;
      const right = left + 1;
      let least = i;
      if (left < h.length && before(h[left], h[least])) {
        least = left;
      }

      if (right < h.length && before(h[right], h[least])) {
        least = right;
      }

      if (least === i) {
        break;
      }

      [h[i], h[least]] = [h[least], h[i]];
      i = least;
    }
  }
}

function before(a: TimerRecord, b: TimerRecord): boolean {
  return a.due < b.due || (a.due === b.due && a.seq < b.seq);
}

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

/** "pkg.Name", as SymbolClass writes a class, as "pkg::Name". */
function qualify(name: string): string {
  const i = name.lastIndexOf(".");
  return i < 0 ? name : `${name.slice(0, i)}::${name.slice(i + 1)}`;
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

/**
 * A module imported from its source: in a browser from a blob, as V8 keeps
 * a module's URL as its script's name, and a data URL is the whole source
 * again, tens of megabytes for a large SWF's; node, which imports no blob,
 * from a data URL.
 */
async function importSource(source: string): Promise<{ default: (rt: avm2.Runtime) => Value }> {
  if (typeof window !== "undefined" && typeof URL.createObjectURL === "function") {
    const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
    try {
      return await import(url);
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  return import(`data:text/javascript,${encodeURIComponent(source)}`);
}
