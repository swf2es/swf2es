// A SWF's scripts: its DoABCs compiled through @swf2es/codegen and loaded
// into a runtime with playerglobal's natives, its SymbolClass binding
// characters to classes, and the link between a display object and the
// AS3 object that is its other face (docs/architecture.md, "Scripts and
// the display list"). The runtime allocates every DisplayObject through a
// hook that takes the display object the player has pending, when the
// player constructs a timeline child's class, or makes one for a `new`.
import type { Codegen } from "@swf2es/codegen";
import { isAs3, readDoAbc, readSwf, readSymbolClass, type Swf, tags } from "@swf2es/format";
import { avm2 } from "@swf2es/runtime";
import { BitmapStore } from "./bitmap.js";
import {
  BitmapObject,
  Container,
  type DisplayObject,
  displayFor,
  EMPTY_TIMELINE,
  MovieClip,
  ShapeObject,
  TextObject,
  TRANSFORM,
} from "./display.js";
import { FontSet } from "./fonts.js";
import { decodeImages, decodeInBrowser, type ImageDecode } from "./images.js";
import { rootOf } from "./playerglobal/flash/display/DisplayObject.js";
import { dispatchEvent, dispatchTo } from "./playerglobal/flash/events/EventDispatcher.js";
import { playerHooks, playerNatives } from "./playerglobal/index.js";
import { sha256 } from "./sha256.js";
import {
  type BitmapCharacter,
  type Character,
  type DisplayCharacter,
  INVALID_PIXELS,
  type Library,
  readLibrary,
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
  sprite: "flash.display::MovieClip",
  bitmap: "flash.display::Bitmap",
  text: "flash.text::TextField",
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
}

/** What SymbolClass bound a class to: a character of a SWF's library. */
interface Symbol {
  character: Character;
  library: Library;
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
  readonly socket: SocketHost | null;
  /**
   * The character, and its SWF's library, each class SymbolClass bound
   * makes, for a `new` of the class from a script: by the module that
   * defines the class, as the SWF's domain found it, then its name, so a
   * class of the same name in another domain has its own; null for a name
   * nothing defined when it was bound.
   */
  readonly symbols = new Map<avm2.Abc | null, Map<string, Symbol>>();
  /** Loads asked for and not yet completed, in order; each prepared after the one before it. */
  private readonly loads: Load[] = [];
  private preparing: Promise<void> = Promise.resolve();
  /** Stream fetches are independent of Loader's ordered preparation chain. */
  private readonly pendingStreams = new Set<Promise<void>>();
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
  /**
   * Clips taken off the display list, which play on as Flash's do: held
   * weakly, as Ruffle holds them, so one nothing refers to stops as Flash's
   * does once collected. One the timeline took is kept for its frame only.
   */
  private orphans: { ref: WeakRef<DisplayObject>; serial: number; keep: boolean }[] = [];
  /** Display objects scripts made with `new` this frame: their first frame's script runs after everything else's, and they are orphans after. */
  private fresh: DisplayObject[] = [];
  /** The display object the next DisplayObject allocation is for, while the player constructs a timeline child's class. */
  pending: DisplayObject | null = null;
  /** The stage, once the player has made it, and the root it holds. */
  stage: Container | null = null;
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
  private statusClass: AsObject | null = null;

  constructor(
    readonly codegen: Codegen,
    options: avm2.RuntimeOptions & {
      fetch?: (request: FetchRequest, signal: AbortSignal) => Promise<FetchResult>;
      url?: string;
      externalInterface?: ExternalInterfaceHost;
      socket?: SocketHost;
      decodeImage?: ImageDecode | null;
      screenCapabilities?: Partial<ScreenCapabilities>;
      /**
       * The clock getTimer reads, a monotonic one in milliseconds: by default
       * `performance.now`, as Flash's runs on in real time, while a script
       * does too; null for the frame clock, which a frame moves and nothing
       * else, the same on every run, as tests that compare traces want.
       */
      realTime?: (() => number) | null;
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
    this.realTime = options.realTime === undefined ? defaultClock() : options.realTime;
    // getTimer's zero: when the player is made, as Flash's is when it starts.
    this.realStart = this.realTime ? this.realTime() : 0;
    this.decodeImage = options.decodeImage === undefined ? decodeInBrowser : options.decodeImage;
    this.externalInterface = options.externalInterface ?? null;
    this.socket = options.socket ?? null;
    this.fetch = options.fetch ?? null;
    this.url = options.url ?? this.url;
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
    library.domain = this.mainDomain;
    this.rt.swfVersion = swf.header.version;
    const decoded = decodeImages(library, this.decodeImage);
    const run = await this.link(swf, this.mainDomain);
    await decoded;
    run();
    this.bind(swf, library);
  }

  /**
   * The SWF's DoABCs compiled and linked, in tag order: what runs them,
   * each unless its lazy flag defers it to first use. Linking is
   * asynchronous, running is not, so a load can run its code in a frame.
   */
  private async link(swf: Swf, domain: avm2.Domain): Promise<() => void> {
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
      const linked = await this.compileAt(index, domain);
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
    library.removing = (display, byTimeline) => this.removing(display, byTimeline);
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
  private async compileAt(index: number, domain: avm2.Domain, builtin = false): Promise<Value> {
    const { module } = this.codegen.compile(this.hashes, index);
    const named = `${module}//# sourceURL=swf2es-${++this.modules}.js\n`;
    const factory = (await import(`data:text/javascript,${encodeURIComponent(named)}`)).default;
    return this.rt.loadInto(domain, () => factory(this.rt), builtin);
  }

  /**
   * The AS3 object of a timeline child the player just made: an instance
   * of the class SymbolClass binds its character to, else of MovieClip or
   * Shape, constructed with `display` as its other face. A clip's first
   * frame is entered by Sprite's constructChildren on the way.
   */
  construct(display: DisplayObject, character: DisplayCharacter, library: Library): void {
    const name = library.classes.get(character.id) ?? DEFAULT_CLASS[character.type];
    const domain = library.domain ?? null;
    const object =
      character.type === "bitmap" && display instanceof BitmapObject
        ? this.constructBitmap(display, name, domain)
        : this.constructAs(display, this.rt.classNamed(name, domain));
    // Flash gives the parent a property of the child's instance name, which
    // a sealed class without it refuses: ReferenceError #1056, as Flash.
    const parent = display.parent?.object;
    if (parent && display.name) {
      this.rt.setProperty(parent, avm2.qname(avm2.publicNs, display.name), object);
    }

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
    this.orphans = this.orphans.filter((o) => o.ref.deref() !== display);
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
    if (byTimeline && parent && display.name) {
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
    if (display.object && !this.orphans.some((o) => o.ref.deref() === display)) {
      this.orphans.push({ ref: new WeakRef(display), serial: display.serial, keep });
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
    this.orphans = this.orphans.filter((o) => {
      const display = o.ref.deref();
      if (!display) {
        return false;
      }

      roots.push(display);
      return true;
    });

    return roots.sort((a, b) => b.serial - a.serial);
  }

  /**
   * Stop `display` and everything under it for good, as unloadAndStop
   * does: timelines stopped, frame broadcasts no longer heard, no orphan.
   */
  stopAll(display: DisplayObject): void {
    this.orphans = this.orphans.filter((o) => o.ref.deref() !== display);
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
  displayFor(traits: SymbolTraits): DisplayObject {
    const library: Library = this.library ?? {
      characters: new Map(),
      root: EMPTY_TIMELINE,
      classes: new Map(),
      construct: null,
      removing: null,
      fonts: new FontSet(),
    };
    for (let t: SymbolTraits | null = traits; t; t = t.base as SymbolTraits | null) {
      // A display object's class bound to data has no display of it.
      const symbol = this.symbolOf(t);
      if (symbol && symbol.character.type !== "binary" && symbol.character.type !== "font") {
        if (symbol.character.type === "text") {
          // A new linked TextField has its symbol's bounds, but not its timeline's initial text.
          const text = new TextObject(symbol.character, false);
          text.fonts = symbol.library.fonts;
          return text;
        }

        return displayFor(symbol.character, symbol.library);
      }

      if (t.name === "flash.display::MovieClip") {
        return new MovieClip(EMPTY_TIMELINE, library);
      }

      if (t.name === "flash.display::Shape") {
        return new ShapeObject(null);
      }

      if (t.name === "flash.display::Bitmap") {
        return new BitmapObject(null);
      }

      if (t.name === "flash.text::TextField") {
        const text = new TextObject(null);
        text.fonts = library.fonts;
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
    info.$loaderURL = loader ? this.ownerUrl(loader) : this.url;
    info.$loaded = 0;
    info.$total = 0;
    return info;
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
  requestLoad(loader: AsObject, bytes: Uint8Array, domain = this.loadDomain(null)): void {
    const begun = this.begin(loader, domain);
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

    this.enqueue(
      loader,
      generation,
      null,
      Promise.resolve({ bytes, status: 0, headers: [] }),
      domain,
    );
  }

  /**
   * A load begins: the one before it is dropped, pending or complete, and
   * its LoaderInfo knows nothing again, as Flash's load() does at the call
   * (Ruffle's `loader_reuse` trace). The old content's REMOVED listeners
   * may load anew themselves, and that load is then the one that counts:
   * null tells the caller so.
   */
  private begin(
    loader: AsObject,
    domain: avm2.Domain,
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
  ): void {
    const begun = this.begin(loader, domain);
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
    this.pendingStreams.add(completed);
    void completed.then(
      () => this.pendingStreams.delete(completed),
      () => this.pendingStreams.delete(completed),
    );
  }

  /** Snapshot a URLRequest at load time, before scripts can change its data or headers. */
  private fetchRequest(request: AsObject | string, base: string): FetchRequest {
    if (typeof request === "string") {
      return { url: resolve(base, request), method: "GET", headers: [], body: null };
    }

    let url = String(request?.$url ?? "");
    const method = String(request?.$method ?? "GET");
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
    return Promise.all([this.preparing, ...this.pendingStreams]).then(() => {});
  }

  private enqueue(
    loader: AsObject,
    generation: number,
    url: string | null,
    bytes: Promise<FetchResult>,
    domain: avm2.Domain,
  ): void {
    const load: Load = {
      loader,
      generation,
      url,
      domain,
      bytes: new Uint8Array(0),
      status: 0,
      ready: null,
      failed: null,
    };
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
      } catch (e) {
        load.failed = e instanceof LoadError ? e.message : this.errorText(2124);
      }
    });
  }

  /** "Error #id: message", as Flash's IOErrorEvent texts begin, debugger or not. */
  private errorText(id: number): string {
    return `Error #${id}: ${avm2.errorMessages[id]}`;
  }

  /** The SWF read and its code linked, off the frame; what the frame then does with it. */
  private async prepare(load: Load): Promise<() => () => void> {
    const swf = readSwf(load.bytes);
    if (!isAs3(swf)) {
      throw new LoadError(this.errorText(2124));
    }

    const library = readLibrary(swf);
    library.domain = load.domain;
    const decoded = decodeImages(library, this.decodeImage);
    const run = await this.link(swf, load.domain);
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
   * each does at the frame's end is returned.
   */
  private completeLoads(): (() => void)[] {
    const ends: (() => void)[] = [];
    if (this.readyBytes.length !== 0) {
      for (const deliver of this.readyBytes.splice(0)) {
        deliver();
      }
    }

    while (this.loads.length && (this.loads[0].ready || this.loads[0].failed)) {
      const load = this.loads.shift() as Load;
      if (load.generation !== load.loader.$generation) {
        continue;
      }

      if (load.ready) {
        ends.push(load.ready());
      } else {
        const info = this.loaderInfoOf(load.loader);
        if (load.url !== null) {
          dispatchEvent(this, info, this.httpStatus(load.status));
          if (load.generation !== load.loader.$generation) {
            continue;
          }
        }

        const error = this.rt.construct(
          this.rt.classNamed("flash.events::IOErrorEvent"),
          "ioError",
          false,
          false,
          load.failed,
        );
        dispatchEvent(this, info, error);
      }
    }

    return ends;
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
  private complete(load: Load, swf: Swf, library: Library, run: () => void): () => void {
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

      this.describe(info, load.bytes, swf);
      this.progress(info, load.bytes.length);
      if (!live()) {
        return () => {};
      }
    } else {
      this.describe(info, load.bytes, swf);
    }

    run();
    this.bind(swf, library);
    const root = new MovieClip(library.root, library);
    root.loaderInfo = info;
    const object = this.constructAs(
      root,
      this.rt.classNamed(library.classes.get(0) ?? "flash.display::MovieClip", load.domain),
    );
    dispatchEvent(this, object, this.event("added", true));
    // The SWF's own code has run by now, its document class's constructor
    // among it, which reaches the Loader through loaderInfo.loader.
    if (!live()) {
      return () => {};
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

  /**
   * Run the frame scripts of the clips that entered a frame with one since
   * they last ran: the orphans' first, newest first, then those under
   * `root`, each in tree order: a clip's own, again for the frame a goto of
   * its own lands it on, then its children's, as Flash runs a parent's
   * landing script before a child the jump made. A clip a script removes
   * still runs its own, as Flash queues them first. Rounds until none is
   * left, bounded, as a script that jumps on every run would never settle.
   */
  runFrameScripts(root: DisplayObject): void {
    for (let round = 0; round < 64; round++) {
      let ran = false;
      const own = (o: MovieClip) => {
        for (let jumps = 0; jumps < 64 && o.scriptedFrame !== o.currentFrame; jumps++) {
          o.scriptedFrame = o.currentFrame;
          const script = o.frameScripts.get(o.currentFrame);
          if (!script) {
            return;
          }

          ran = true;
          this.inFrameScript = o;
          try {
            this.rt.call(script, o.object);
          } finally {
            this.inFrameScript = null;
          }

          // The goto the script asked for, now that it has returned; the
          // frame it lands on has its script run next, in this same phase.
          if (o.queuedGoto !== null) {
            const frame = o.queuedGoto;
            o.queuedGoto = null;
            o.gotoFrame(frame);
          }
        }
      };
      const queue: MovieClip[] = [];
      const visit = (o: DisplayObject) => {
        if (o instanceof MovieClip && o.object) {
          queue.push(o);
        }

        if (o instanceof Container) {
          for (const child of o.children) {
            visit(child);
          }
        }
      };
      for (const orphan of this.orphanRoots()) {
        visit(orphan);
      }

      visit(root);
      for (const display of this.fresh) {
        visit(display);
      }

      for (const o of queue) {
        own(o);
      }

      if (!ran) {
        return;
      }
    }
  }

  /**
   * What follows the timelines' advance in a frame: the frame events and
   * scripts, in Flash's order. The first frame, after construction, has no
   * ENTER_FRAME: Flash goes to FRAME_CONSTRUCTED, the scripts and EXIT_FRAME.
   */
  frame(root: DisplayObject, entered = true): void {
    if (entered) {
      this.frames++;
      this.broadcast("enterFrame");
    }

    const ends = [...this.frameEnds.splice(0), ...this.completeLoads()];
    this.broadcast("frameConstructed");
    this.runFrameScripts(root);
    // What the timeline took off this frame has had its frame; it stops here.
    this.orphans = this.orphans.filter((o) => o.keep);
    // What scripts made this frame and left off the display list plays on as an orphan.
    for (const display of this.fresh.splice(0)) {
      if (!display.parent) {
        this.orphan(display);
      }
    }
    this.broadcast("exitFrame");
    for (const end of ends) {
      end();
    }

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

/** The real clock where the host has one, browsers and node alike; else none, and the frame clock. */
function defaultClock(): (() => number) | null {
  return typeof performance !== "undefined" ? () => performance.now() : null;
}

/** A load's failure, worded as its IOErrorEvent's text. */
class LoadError extends Error {}

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
