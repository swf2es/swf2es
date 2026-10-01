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
import {
  Container,
  type DisplayObject,
  displayFor,
  EMPTY_TIMELINE,
  MovieClip,
  ShapeObject,
} from "./display.js";
import { rootOf } from "./playerglobal/flash/display/DisplayObject.js";
import { dispatchEvent, dispatchTo } from "./playerglobal/flash/events/EventDispatcher.js";
import { playerHooks, playerNatives } from "./playerglobal/index.js";
import { type Character, type Library, readLibrary } from "./timeline.js";

type AsObject = avm2.AsObject;
type Value = avm2.Value;

/** AS3 classes placed children are instances of when SymbolClass binds none. */
const DEFAULT_CLASS = { shape: "flash.display::Shape", sprite: "flash.display::MovieClip" };

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
  /** What the content's frame does: it returns what the frame's end does, INIT and COMPLETE. */
  ready: (() => () => void) | null;
  /** The IOErrorEvent text the load ended in, as Flash words one. */
  failed: string | null;
}

export class Scripting {
  readonly rt: avm2.Runtime;
  /** The character, and its SWF's library, each class SymbolClass bound makes, for a `new` of the class from a script. */
  readonly symbols = new Map<string, { character: Character; library: Library }>();
  /** Loads asked for and not yet completed, in order; each prepared after the one before it. */
  private readonly loads: Load[] = [];
  private preparing: Promise<void> = Promise.resolve();
  /** How many loads from bytes there have been: each gets a URL of its own under the main SWF's. */
  private dynamic = 0;
  /** The host's fetch of a URL's bytes, for Loader.load, aborted when the load is closed or replaced; null where there is none. */
  fetch: ((url: string, signal: AbortSignal) => Promise<Uint8Array>) | null = null;
  /** The main SWF's URL, as its LoaderInfo reports it. */
  url = "file:///";
  /** The display object the next DisplayObject allocation is for, while the player constructs a timeline child's class. */
  pending: DisplayObject | null = null;
  /** The stage, once the player has made it, and the root it holds. */
  stage: Container | null = null;
  root: MovieClip | null = null;
  library: Library | null = null;
  /** Whether a script asked the stage to render (Stage.invalidate). */
  invalidated = false;
  /** The clip whose frame script is running, while one is: a goto it asks for waits for it to return. */
  inFrameScript: MovieClip | null = null;
  /** The display objects listening for each frame event, in the order they first listened; a broadcast reaches these. */
  private readonly broadcasts = new Map<string, Set<AsObject>>();
  /** What flash.display.Stage reports and sets; the player copies the frame rate back each frame. */
  stageWidth = 0;
  stageHeight = 0;
  frameRate = 24;
  quality = "HIGH";
  private readonly hashes: string[] = [];

  constructor(
    readonly codegen: Codegen,
    options: avm2.RuntimeOptions & {
      fetch?: (url: string, signal: AbortSignal) => Promise<Uint8Array>;
      url?: string;
    } = {},
  ) {
    this.fetch = options.fetch ?? null;
    this.url = options.url ?? this.url;
    this.rt = new avm2.Runtime(
      (rt) => ({ ...avm2.builtinNatives(rt), ...playerNatives(this) }),
      { ...avm2.builtinHooks(), ...playerHooks(this) },
      options,
    );
    this.codegen.reset(50);
  }

  /** Load the libraries the SWF's code links against (builtin, playerglobal), whose scripts run on first use. */
  async loadLibraries(abcs: Uint8Array[]): Promise<void> {
    for (const abc of abcs) {
      await this.load(abc, true);
    }
  }

  /** Load the SWF's DoABCs in tag order, each run unless its lazy flag defers it to first use, then its SymbolClass. */
  async loadSwf(swf: Swf, library: Library): Promise<void> {
    this.library = library;
    (await this.link(swf))();
    this.bind(swf, library);
  }

  /**
   * The SWF's DoABCs compiled and linked, in tag order: what runs them,
   * each unless its lazy flag defers it to first use. Linking is
   * asynchronous, running is not, so a load can run its code in a frame.
   */
  private async link(swf: Swf): Promise<() => void> {
    const runs: (() => void)[] = [];
    for (const t of swf.tags) {
      if (t.code === tags.DoABC || t.code === tags.DoABC2) {
        const { lazy, abc } = readDoAbc(swf.bytes, t);
        const linked = await this.load(abc, false);
        if (!lazy) {
          runs.push(() => this.rt.run(linked));
        }
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
    for (const t of swf.tags) {
      if (t.code === tags.SymbolClass) {
        for (const [id, name] of readSymbolClass(swf.bytes, t)) {
          const qualified = qualify(name);
          library.classes.set(id, qualified);
          const character = library.characters.get(id);
          if (character) {
            this.symbols.set(qualified, { character, library });
          }
        }
      }
    }

    library.construct = (display, character) => this.construct(display, character, library);
    library.removing = (display) => this.removing(display);
  }

  /** An ABC compiled and linked into the runtime, its scripts not yet run: what `rt.run` takes. */
  private async load(abc: Uint8Array, builtin: boolean): Promise<Value> {
    const error = this.codegen.add(abc, builtin);
    if (error) {
      throw new Error(`an ABC was rejected: VerifyError #${error}`);
    }

    this.hashes.push(hashOf(abc));
    const { module } = this.codegen.compile(this.hashes);
    const factory = (await import(`data:text/javascript,${encodeURIComponent(module)}`)).default;
    return factory(this.rt);
  }

  /**
   * The AS3 object of a timeline child the player just made: an instance
   * of the class SymbolClass binds its character to, else of MovieClip or
   * Shape, constructed with `display` as its other face. A clip's first
   * frame is entered by Sprite's constructChildren on the way.
   */
  construct(display: DisplayObject, character: Character, library: Library): void {
    const name = library.classes.get(character.id) ?? DEFAULT_CLASS[character.type];
    const object = this.constructAs(display, this.rt.classNamed(name));
    // Flash gives the parent a property of the child's instance name, which
    // a sealed class without it refuses: ReferenceError #1056, as Flash.
    const parent = display.parent?.object;
    if (parent && display.name) {
      this.rt.setProperty(parent, avm2.qname(avm2.publicNs, display.name), object);
    }

    this.added(display);
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
    if (display.object) {
      dispatchEvent(this, display.object, this.event("added", true));
    }

    if (this.onStage(display)) {
      this.eachObject(display, (o) => dispatchEvent(this, o, this.event("addedToStage")));
    }
  }

  /** `display` is about to lose its parent: REMOVED, bubbling, and REMOVED_FROM_STAGE through the subtree if it was on the display list. */
  removing(display: DisplayObject): void {
    if (display.object) {
      dispatchEvent(this, display.object, this.event("removed", true));
    }

    if (this.onStage(display)) {
      this.eachObject(display, (o) => dispatchEvent(this, o, this.event("removedFromStage")));
    }
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
  constructAs(display: DisplayObject, cls: AsObject): AsObject {
    this.pending = display;
    try {
      return this.rt.construct(cls);
    } finally {
      this.pending = null;
    }
  }

  /**
   * The display object for an instance a script makes with `new`: the
   * character of a class SymbolClass bound, if the class or a base of it
   * is one, else an empty clip, shape or container by the nearest base.
   */
  displayFor(traits: {
    name: string;
    base: { name: string; base: unknown } | null;
  }): DisplayObject {
    const library: Library = this.library ?? {
      characters: new Map(),
      root: EMPTY_TIMELINE,
      classes: new Map(),
      construct: null,
      removing: null,
    };
    for (let t: typeof traits | null = traits; t; t = t.base as typeof traits | null) {
      const symbol = this.symbols.get(t.name);
      if (symbol) {
        return displayFor(symbol.character, symbol.library);
      }

      if (t.name === "flash.display::MovieClip") {
        return new MovieClip(EMPTY_TIMELINE, library);
      }

      if (t.name === "flash.display::Shape") {
        return new ShapeObject(null);
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
    info.$loaderURL = loader ? null : this.url;
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

  /** The one ApplicationDomain there is until child domains, the current one: a new object at each ask, as Flash's. */
  applicationDomain(): AsObject {
    return this.rt.construct(this.rt.classNamed("flash.system::ApplicationDomain"), null);
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
  requestLoad(loader: AsObject, bytes: Uint8Array): void {
    const info = this.begin(loader);
    info.$dynamic = `${info.$loaderURL}/[[DYNAMIC]]/${++this.dynamic}`;
    info.$bytes = bytes;
    info.$total = bytes.length;
    this.progress(info, 0);
    this.progress(info, bytes.length);
    this.enqueue(loader, null, Promise.resolve(bytes));
  }

  /**
   * A load begins: the one before it is dropped, pending or complete, and
   * its LoaderInfo knows nothing again, as Flash's load() does at the call
   * (Ruffle's `loader_reuse` trace).
   */
  private begin(loader: AsObject): AsObject {
    this.unload(loader);
    const info = this.loaderInfoOf(loader);
    info.$loaderURL = this.ownerUrl(loader);
    return info;
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
  requestLoadUrl(loader: AsObject, url: string): void {
    const info = this.begin(loader);
    const resolved = resolve(info.$loaderURL, url);
    const abort = new AbortController();
    loader.$abort = abort;
    const fetch = this.fetch;
    this.enqueue(loader, resolved, fetch ? fetch(resolved, abort.signal) : Promise.reject());
  }

  /**
   * Resolves once every load asked for so far has its code linked or has
   * failed, so that a host stepping frames by hand sees each complete in
   * the frame after its request, as Flash's loadBytes does.
   */
  settled(): Promise<void> {
    return this.preparing;
  }

  private enqueue(loader: AsObject, url: string | null, bytes: Promise<Uint8Array>): void {
    const load: Load = {
      loader,
      generation: loader.$generation,
      url,
      bytes: new Uint8Array(0),
      ready: null,
      failed: null,
    };
    this.loads.push(load);
    this.preparing = this.preparing.then(async () => {
      try {
        load.bytes = await bytes;
      } catch {
        load.failed = `${this.errorText(2035)} URL: ${url}`;
        return;
      }

      try {
        load.ready = await this.prepare(load);
      } catch (e) {
        load.failed = e instanceof LoadError ? e.message : this.errorText(2124);
      }
    });
  }

  /** "Error #id: message", as Flash's IOErrorEvent texts begin, debugger or not. */
  private errorText(id: number): string {
    return `Error #${id}: ${avm2.messages[id]}`;
  }

  /** The SWF read and its code linked, off the frame; what the frame then does with it. */
  private async prepare(load: Load): Promise<() => () => void> {
    const swf = readSwf(load.bytes);
    if (!isAs3(swf)) {
      throw new LoadError(this.errorText(2124));
    }

    const library = readLibrary(swf);
    const run = await this.link(swf);
    return () => this.complete(load, swf, library, run);
  }

  /** A Loader's unload: a pending load dropped, its content out of the display list, its LoaderInfo empty, the Loader kept. */
  unload(loader: AsObject): void {
    this.closeLoad(loader);
    const content: AsObject | null = loader.$content ?? null;
    const display: Container = loader.$display;
    if (content?.$display?.parent === display) {
      this.removing(content.$display);
      display.removeChild(content.$display);
    }

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
  }

  /**
   * Give the loads whose code is linked their content, oldest first, and
   * stop at one still linking: they complete in the order asked. What
   * each does at the frame's end is returned.
   */
  private completeLoads(): (() => void)[] {
    const ends: (() => void)[] = [];
    while (this.loads.length && (this.loads[0].ready || this.loads[0].failed)) {
      const load = this.loads.shift() as Load;
      if (load.generation !== load.loader.$generation) {
        continue;
      }

      if (load.ready) {
        ends.push(load.ready());
      } else {
        const info = this.loaderInfoOf(load.loader);
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
    if (load.url !== null) {
      // A load from bytes told these in the call; one of a URL tells them as
      // the bytes come: OPEN knowing nothing, the total, then the bytes.
      dispatchEvent(this, info, this.event("open"));
      info.$total = load.bytes.length;
      this.progress(info, 0);
      this.describe(info, load.bytes, swf);
      this.progress(info, load.bytes.length);
    } else {
      this.describe(info, load.bytes, swf);
    }

    run();
    this.bind(swf, library);
    const root = new MovieClip(library.root, library);
    root.loaderInfo = info;
    const object = this.constructAs(
      root,
      this.rt.classNamed(library.classes.get(0) ?? "flash.display::MovieClip"),
    );
    dispatchEvent(this, object, this.event("added", true));
    info.$url = load.url ?? info.$dynamic ?? info.$loaderURL;
    info.$content = object;
    load.loader.$content = object;
    const display: Container = load.loader.$display;
    display.addChildAt(root, display.children.length);
    this.added(root);
    return () => {
      dispatchEvent(this, info, this.event("init"));
      dispatchEvent(this, info, this.event("complete"));
    };
  }

  /** A flash.events.Event of `type`. */
  event(type: string, bubbles = false): AsObject {
    return this.rt.construct(this.rt.classNamed("flash.events::Event"), type, bubbles, false);
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
   * Run the frame scripts of the clips under `root` that entered a frame
   * with one since they last ran, in tree order: a clip's own, again for
   * the frame a goto of its own lands it on, then its children's, as Flash
   * runs a parent's landing script before a child the jump made. A clip a
   * script removes still runs its own, as Flash queues them first. Rounds
   * until none is left, bounded, as a script that jumps on every run would
   * never settle.
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
      visit(root);
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
      this.broadcast("enterFrame");
    }

    const ends = this.completeLoads();
    this.broadcast("frameConstructed");
    this.runFrameScripts(root);
    this.broadcast("exitFrame");
    for (const end of ends) {
      end();
    }

    if (this.invalidated) {
      this.invalidated = false;
      this.broadcast("render");
    }
  }
}

/** A load's failure, worded as its IOErrorEvent's text. */
class LoadError extends Error {}

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

/**
 * A hash of an ABC's bytes for the modules' record of what they were
 * linked against: FNV-1a, twice, which tells ABCs apart within one SWF.
 * A cache shared between machines keys on the SHA-256 the AOT side has.
 */
function hashOf(bytes: Uint8Array): string {
  let a = 0x811c9dc5;
  let b = 0x050c5d1f;
  for (const byte of bytes) {
    a = Math.imul(a ^ byte, 0x01000193);
    b = Math.imul(b ^ byte, 0x01000193);
  }

  return (a >>> 0).toString(16).padStart(8, "0") + (b >>> 0).toString(16).padStart(8, "0");
}
