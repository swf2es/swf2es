// A player's AVM1: a main AVM1 SWF's action blocks compiled to one module
// by codegen, and run as its timelines reach them (docs/avm1.md, "The
// frame"). Each clip, button and text field gets an AS2 face as it is made
// (globals/MovieClip.ts). The clips play in Flash's order, the newest
// first, each dispatching its load or enterFrame event and queueing the
// DoAction blocks of the frame it enters in tag order, a child placed
// before them running its first frame first; then the queue runs, its
// initialize events first, then its constructions, then the rest, and a
// goto in it queues the frames it enters, as Ruffle's
// (https://github.com/ruffle-rs/ruffle) Avm1::run_frame, ActionQueue,
// MovieClip::event_dispatch and construct_as_avm1_object have it (MIT OR
// Apache-2.0, Copyright (c) 2018-2022 Ruffle LLC and Ruffle contributors).
// Where adl parts from Ruffle, adl decides (docs/avm1.md, "Clip events").
// A root frame's DoInitAction blocks run as the root enters it, before
// its places, each sprite's once. setInterval's timers fire between
// frames by the player's clock, and scripts that run past the script
// timeout have the movie's actions disabled.
//
// Avm1 coordinates the frame; what changes for other reasons is in files
// of its own, each a part the movie owns: the action queue (queue.ts),
// the clock and timers (timers.ts), loadMovie's loads (loads.ts), what
// scripts make and remove (clips.ts), registered classes (classes.ts),
// the keys and pointer (input.ts), the focus (focus.ts), Sound
// (sound.ts) and calls out to the page (external.ts); a SWF's own record
// is swf.ts's.
import type { Codegen } from "@swf2es/codegen";
import { type ActionList, ClipEvent, isAs3, type Place, type Swf } from "@swf2es/format";
import { avm1 } from "@swf2es/runtime";
import { BitmapStore } from "../bitmap/bitmap.js";
import { decodeInBrowser, type ImageDecode } from "../bitmap/images.js";
import {
  BitmapObject,
  ButtonObject,
  Container,
  type DisplayObject,
  EMPTY_TIMELINE,
  MovieClip,
  TextObject,
  VideoObject,
} from "../display/display.js";
import type { Library } from "../display/timeline.js";
import {
  browserNavigate,
  type Drawer,
  defaultStorage,
  type ExternalInterfaceHost,
  type FetchRequest,
  type FetchResult,
  type Navigate,
  type SharedObjectStorage,
  type SocketHost,
} from "../hosts.js";
import { type AudioHost, browserAudioHost } from "../media/audio.js";
import {
  finishTimelineSounds,
  type SoundHost,
  stopTimelineSounds,
  timelineSoundsOf,
} from "../media/sounds.js";
import { evaluate } from "../scripting/evaluate.js";
import { type BindingHost, VariableBindings } from "./bindings.js";
import { RegisteredClasses } from "./classes.js";
import { constructBlocks, ScriptClips } from "./clips.js";
import { ExternalCalls } from "./external.js";
import { FocusTracker } from "./focus.js";
import { type BitmapHost, bitmapDataClass, bitmapObject, storeOf } from "./globals/BitmapData.js";
import { buttonClass } from "./globals/Button.js";
import { colorClass } from "./globals/Color.js";
import { externalInterfaceClass } from "./globals/ExternalInterface.js";
import { type FilterFaces, filtersPackage } from "./globals/filters.js";
import { flashPackage } from "./globals/geom.js";
import { keyObject, mouseObject } from "./globals/Key.js";
import { formRequest, loadVarsClass, parseForm } from "./globals/LoadVars.js";
import {
  ClipNative,
  DEPTH_BIAS,
  type Movie,
  movieClipClass,
  nativeOf,
  targetOf,
} from "./globals/MovieClip.js";
import { movieClipLoaderClass } from "./globals/MovieClipLoader.js";
import { netConnectionClass, Remoting } from "./globals/NetConnection.js";
import { printJobClass } from "./globals/PrintJob.js";
import { type FocusState, selectionObject } from "./globals/Selection.js";
import { sharedObjectClass } from "./globals/SharedObject.js";
import { soundClass } from "./globals/Sound.js";
import { styleSheetClass } from "./globals/StyleSheet.js";
import { textFieldClass } from "./globals/TextField.js";
import { textFormatClass } from "./globals/TextFormat.js";
import { textSnapshotClass } from "./globals/TextSnapshot.js";
import { xmlClass } from "./globals/XML.js";
import { type XmlNodes, xmlNodeClass, serialize as xmlString } from "./globals/XMLNode.js";
import { xmlSocketClass } from "./globals/XMLSocket.js";
import { Avm1Input } from "./input.js";
import { MovieLoads } from "./loads.js";
import { Avm1Net, textFor } from "./net.js";
import { asciiLower, atPath, childByName, pathOf, under } from "./paths.js";
import {
  ActionQueue,
  BLOCK,
  CONSTRUCT,
  CONSTRUCTION,
  FRAME,
  HALT,
  INIT,
  INITIALIZE,
  METHOD,
  NORMAL,
  Queued,
} from "./queue.js";
import { Avm1Sounds } from "./sound.js";
import { Avm1Swf, handlersOf, NO_HANDLERS, readRootFrames, stopOf } from "./swf.js";
import { defaultClock, Timers } from "./timers.js";

type Value = avm1.Value;

export interface Avm1Options {
  /**
   * Where trace's text goes, as it is, the console's log by default: a
   * "\r" in it breaks Flash's log's line as a "\n" does.
   */
  print?: (line: string) => void;
  /** An error a block threw that nothing caught: the console's by default. The SWF plays on. */
  onUncaught?: (error: unknown) => void;
  /** The SWF's URL, which `_url` gives. */
  url?: string;
  /**
   * The real clock, in ms, getTimer's and the timers' time: performance's
   * by default. With null they go by the frames, each a frame's duration
   * on, as the tests have them.
   */
  realTime?: (() => number) | null;
  /** The script timeout in seconds where the SWF sets none: Flash's 15 by default. */
  scriptTimeout?: number;
  /** Where SharedObject keeps its .sol files: the browser's localStorage by default, AS3's own. */
  storage?: SharedObjectStorage;
  /** What plays the timeline's sounds and Sound's: the browser's Web Audio by default; null for none. */
  audio?: AudioHost | null;
  /**
   * fscommand's commands, as a plug-in passed them to its page. Without
   * one, "quit" stops the SWF after its frame, as a projector quits and
   * as Ruffle's test harness ends a test, and the rest are dropped.
   * `callers` is the calling SWF's URL, or every URL of a SWF that has had
   * code where the caller cannot be told, as Scripting's: a host that
   * checks them lets the command through only if all pass.
   */
  fsCommand?: (command: string, args: string, callers: string[]) => void;
  /**
   * Opens getURL's pages: the browser's navigation by default (hosts.ts's
   * browserNavigate), null for none.
   */
  navigate?: Avm1Navigate | null;
  /**
   * What XML, LoadVars and loadVariables load by, the same fetch AS3's
   * URLLoader goes through; without one, every load fails as a missing
   * file does.
   */
  fetch?: (request: FetchRequest, signal: AbortSignal) => Promise<FetchResult>;
  /** XMLSocket's TCP, AS3's Socket's host; without one, every connect fails with onConnect(false). */
  socket?: SocketHost;
  /** Where relative URLs resolve, as a page's `base` parameter has it: the SWF's URL by default. */
  base?: string;
  /**
   * Whether XML.send, which sends without a window, sends: true by
   * default; false refuses it, as allowNetworking "internal" refuses AS3's
   * sendToURL.
   */
  sendToUrl?: boolean;
  /**
   * What decodes the images loadMovie brings, and those in the SWFs it
   * loads: the browser's by default.
   */
  decodeImage?: ImageDecode | null;
  /**
   * The page's ExternalInterface, as AS3's Scripting takes it; without
   * one, ExternalInterface is unavailable. AVM1's callbacks answer the
   * page's XML invocations whatever arguments come with them.
   */
  externalInterface?: ExternalInterfaceHost;
}

/**
 * getURL's page: the URL as the SWF gave it, the window or frame named,
 * and with a method, the variables the SWF sends.
 */
export type Avm1Navigate = (url: string, window: string, form: avm1.UrlForm | null) => void;

/**
 * `navigate` as getURL's: the URL resolved against the SWF's, a GET's
 * variables in its query and a POST's in its body as a form's, as Ruffle's
 * object_into_request has them; an empty URL opens nothing, as Ruffle's
 * navigators ignore it.
 */
function getUrlNavigate(navigate: Navigate | null, swfUrl: string): Avm1Navigate | null {
  if (navigate === null) {
    return null;
  }

  return (url, window, form) => {
    if (url === "") {
      return;
    }

    let resolved = url;
    try {
      resolved = new URL(url, swfUrl).href;
    } catch {
      // Against a relative SWF URL, or none: the host resolves it against its page.
    }

    const query = form === null ? "" : new URLSearchParams(form.vars).toString();
    if (form?.method === "POST") {
      const headers: [string, string][] = [["Content-Type", "application/x-www-form-urlencoded"]];
      const body = new TextEncoder().encode(query);
      navigate({ url: resolved, method: "POST", headers, body }, window);
    } else {
      const sent = form === null ? resolved : `${resolved}${url.includes("?") ? "&" : "?"}${query}`;
      navigate({ url: sent, method: "GET", headers: [], body: null }, window);
    }
  };
}

/** The AS2 methods a clip's events call from SWF 6, by the event's bit. */
const METHODS = new Map<number, string>([
  [ClipEvent.load, "onLoad"],
  [ClipEvent.enterFrame, "onEnterFrame"],
  [ClipEvent.unload, "onUnload"],
  [ClipEvent.mouseMove, "onMouseMove"],
  [ClipEvent.mouseDown, "onMouseDown"],
  [ClipEvent.mouseUp, "onMouseUp"],
  [ClipEvent.keyDown, "onKeyDown"],
  [ClipEvent.keyUp, "onKeyUp"],
  [ClipEvent.press, "onPress"],
  [ClipEvent.release, "onRelease"],
  [ClipEvent.releaseOutside, "onReleaseOutside"],
  [ClipEvent.rollOver, "onRollOver"],
  [ClipEvent.rollOut, "onRollOut"],
  [ClipEvent.dragOver, "onDragOver"],
  [ClipEvent.dragOut, "onDragOut"],
]);

/** Names the scripts of AVM1 modules, as their stack frames show them. */
let modules = 0;

export class Avm1 implements Movie, FocusState, BitmapHost, BindingHost {
  readonly rt = new avm1.Runtime();
  /** Whether the SWF has stopped for good at what Flash cannot read: nothing plays or runs after. */
  halted = false;
  /**
   * The main SWF, the one the player plays, and each SWF by its library,
   * loaded ones among them.
   */
  private main = new Avm1Swf(null, null, 0, "", 0);
  private readonly swfs = new WeakMap<Library, Avm1Swf>();
  /** The levels, the main SWF's root level 0, by number, and each one's number. */
  private readonly levels = new Map<number, MovieClip>();
  private readonly levelNumbers = new WeakMap<DisplayObject, number>();
  /** Object.registerClass's classes, which clips of their symbols are constructed as. */
  readonly classes = new RegisteredClasses(this);
  /** What scripts make, duplicate and remove on the display list. */
  readonly scriptClips = new ScriptClips(this);
  /** What each clip a load filled shows, the SWF's root it plays, by the clip. */
  readonly contents = new WeakMap<MovieClip, Avm1Swf>();
  /** loadMovie's and MovieClipLoader's loads, until they are done with. */
  private readonly loads: MovieLoads;
  /** The page's ExternalInterface, and which SWFs call it and fscommand. */
  readonly external: ExternalCalls;
  /** The operand stack, which every activation of a frame's actions shares. */
  private readonly st: avm1.Value[] = [];
  /** Whether the SWF stops as the next frame comes, at a clip's enterFrame. */
  private stopNext = false;
  /** The clips, in the order they were made, which play the newest first. */
  clips: MovieClip[] = [];
  /** What the frame, events and scripts queue, and what runs it. */
  readonly queue = new ActionQueue(this);
  /** Whether the module is loaded: until it is, the first frame's actions wait in the queue. */
  loaded = false;
  /** Each clip's latest frame entry, which its queued blocks are of. */
  private readonly entries = new WeakMap<MovieClip, number>();
  private entryCount = 0;
  /** What names the next object without a name of its own: instance1, instance2... */
  private instances = 0;
  private movieRoot: MovieClip | null = null;
  private swfVersion = 0;
  private swfLength = 0;
  private rate = 24;
  private readonly host: avm1.Host;
  readonly onUncaught: (error: unknown) => void;
  private readonly timelines = new WeakMap<MovieClip, avm1.Timeline>();
  private clipProto: avm1.Avm1Object | null = null;
  private buttonProto: avm1.Avm1Object | null = null;
  private textFieldProto: avm1.Avm1Object | null = null;
  /** The places of display objects being placed, until they are made. */
  private readonly places = new WeakMap<DisplayObject, Place>();
  /** The clips removed with an unload handler, kept until the next frame. */
  private pending: DisplayObject[] = [];
  /** The player's clock, the scripts' timeout and setInterval's timers. */
  readonly timers: Timers;

  quality = "HIGH";
  focusRect = true;
  soundBufferTime = 5;
  newInvalidBounds = false;
  /** XMLNode's nodes, once the class is made: what a remoting call writes as XML. */
  private xmlNodes: XmlNodes | null = null;
  /** NetConnection's connections, whose calls go at each frame's end. */
  readonly remoting = new Remoting(this);
  /** The filter objects a display object's `filters` reads, once flash.filters is made. */
  filterFaces: FilterFaces | null = null;
  /** Where the pointer last was, in the stage's coordinates (avm1/pointer.ts). */
  mouseX = 0;
  mouseY = 0;
  /** The screen's pixels to a stage pixel, as the host shows the stage; `_xmouse` is in them. */
  pixelRatio = 1;
  /** The pointer, where the host gives one: what drags a clip, and shows or hides itself. */
  pointer: {
    startDrag(d: DisplayObject, lockCenter: boolean, bounds: number[] | null): void;
    stopDrag(): void;
    updateCursor(): void;
  } | null = null;
  /** A dragged clip's `_droptarget`: what is under the pointer as it was last dragged. */
  readonly dropTargets = new WeakMap<DisplayObject, DisplayObject | null>();
  /** The keys, the pointer's buttons and Key's and Mouse's listeners. */
  readonly input = new Avm1Input(this);
  /** The focus, what Tab moves it through and Selection's listeners. */
  readonly focusTracker = new FocusTracker(this);
  readonly url: string;
  readonly storage: SharedObjectStorage;
  /** SharedObject's writes of what its scripts changed, as the player goes: none before attach. */
  private sharedObjects: { flush(version: number): void } | null = null;
  readonly audio: AudioHost | null;
  /** What the timeline's sounds, and Sound's, play by. */
  readonly sounds: SoundHost;
  /** Sound's side: its transforms, the sounds it decodes and those that ended. */
  private readonly media: Avm1Sounds;
  /** What XML, LoadVars, loadVariables and XMLSocket ask of the network, and its answers for the next frame. */
  readonly net: Avm1Net;

  constructor(
    readonly codegen: Codegen,
    options: Avm1Options = {},
  ) {
    const print = options.print ?? ((line: string) => console.log(line));
    this.onUncaught = options.onUncaught ?? ((error) => console.error(error));
    this.url = options.url ?? "";
    this.storage = options.storage ?? defaultStorage();
    this.net = new Avm1Net(
      options.fetch ?? null,
      options.socket ?? null,
      options.base ?? this.url,
      options.sendToUrl ?? true,
    );
    this.audio = options.audio === undefined ? browserAudioHost() : options.audio;
    this.loads = new MovieLoads(
      this,
      options.decodeImage === undefined ? decodeInBrowser : options.decodeImage,
    );
    this.external = new ExternalCalls(this, options.externalInterface ?? null);
    this.media = new Avm1Sounds(this, this.audio);
    this.sounds = this.media.sounds;
    this.timers = new Timers(
      this,
      options.realTime === undefined ? defaultClock() : options.realTime,
    );
    if (options.scriptTimeout !== undefined) {
      this.rt.scriptTimeout = options.scriptTimeout;
    }

    const face = (d: DisplayObject | null | undefined) => d?.avm1 ?? undefined;
    const display = (object: object) =>
      object instanceof avm1.Avm1Object && object.display !== null
        ? (object.display.target as DisplayObject)
        : undefined;
    this.host = {
      trace: print,
      play: (target) => {
        if (target instanceof MovieClip) {
          target.playing = true;
        }
      },
      stop: (target) => {
        if (target instanceof MovieClip) {
          target.playing = false;
        }
      },
      halt: () => {
        this.halted = true;
      },
      root: (base) => face(this.rootOf(base as DisplayObject)),
      level: (level) => face(this.levels.get(level)),
      parent: (object) => {
        const d = display(object);
        return d === undefined || this.levelNumbers.has(d) ? undefined : face(d.parent);
      },
      child: (object, name, caseSensitive) => {
        const d = display(object);
        const child = d === undefined ? null : childByName(d, name, caseSensitive);
        // An object without an AVM1 object of its own, a shape's, is its parent's.
        return child === null ? undefined : (face(child) ?? face(d));
      },
      clipOf: display,
      objectOf: (target) => (target as DisplayObject).avm1 ?? this.rt.newObject(),
      removed: (target) => this.removed(target as DisplayObject),
      timeline: (target) => (target instanceof MovieClip ? this.timeline(target) : null),
      toggleQuality: () => {
        this.quality = this.quality === "HIGH" || this.quality === "BEST" ? "LOW" : "HIGH";
      },
      time: () => this.timers.getTime(),
      duplicate: (target, name, depth) => {
        this.duplicate(target as DisplayObject, name, depth, null);
      },
      remove: (target) => this.remove(target as DisplayObject),
      startDrag: (target, lockCenter, bounds) =>
        this.startDrag(target as DisplayObject, lockCenter, bounds),
      stopDrag: () => this.stopDrag(),
      returned: () => this.queue.returned(),
      stopSounds: () => stopTimelineSounds(this.sounds),
      loadVariables: (into, url, form) => this.loadVariables(into as DisplayObject, url, form),
      loadMovie: (into, url, form) =>
        this.loadMovie(typeof into === "number" ? into : (into as DisplayObject), url, form),
      fsCommand: (command, args) => {
        if (options.fsCommand === undefined) {
          this.fsCommand(command);
        } else {
          options.fsCommand(command, args, this.external.callerUrls());
        }
      },
      navigate:
        (options.navigate === undefined
          ? getUrlNavigate(browserNavigate(), this.url)
          : options.navigate) ?? undefined,
    };
  }

  /** fscommand without a host's handler: "quit" stops the SWF after its frame, as a projector quits. */
  private fsCommand(command: string): void {
    if (asciiLower(command) === "quit") {
      this.stopNext = true;
    }
  }

  get root(): MovieClip {
    return this.movieRoot as MovieClip;
  }

  get realm(): avm1.Realm {
    return this.rt.realm;
  }

  get version(): number {
    return this.swfVersion;
  }

  get length(): number {
    return this.swfLength;
  }

  /**
   * Take the SWF's timelines, before the root enters its first frame: their
   * clips are made and play through this from now on.
   */
  attach(swf: Swf, library: Library, root: MovieClip, size = swf.header.fileLength): void {
    this.movieRoot = root;
    this.swfVersion = swf.header.version;
    this.swfLength = swf.header.fileLength;
    this.rate = swf.frameRate;
    this.levels.set(0, root);
    this.levelNumbers.set(root, 0);
    if (isAs3(swf) || !library.actions) {
      return;
    }

    root.avm1Root = true;
    const main = new Avm1Swf(
      library,
      library.actions,
      swf.header.version,
      this.url,
      swf.header.fileLength,
      size,
    );
    this.main = main;
    main.root = root;
    readRootFrames(swf, main);

    const clip = movieClipClass(this);
    this.clipProto = clip.proto;
    const realm = this.rt.realm;
    realm.global.define("MovieClip", clip.constr, avm1.DONT_ENUM);
    const button = buttonClass(this);
    this.buttonProto = button.proto;
    realm.global.define("Button", button.constr, avm1.DONT_ENUM);
    const textField = textFieldClass(this);
    this.textFieldProto = textField.proto;
    realm.global.define("TextField", textField.constr, avm1.DONT_ENUM);
    textField.constr.define("StyleSheet", styleSheetClass(this), avm1.DONT_ENUM | avm1.VERSION_7);
    realm.global.define("TextFormat", textFormatClass(this).constr, avm1.DONT_ENUM);
    this.input.keyFace = keyObject(realm, this.input, this.swfVersion);
    realm.global.define("Key", this.input.keyFace, avm1.DONT_ENUM);
    this.input.mouseFace = mouseObject(realm, this.input, this.swfVersion);
    realm.global.define("Mouse", this.input.mouseFace, avm1.DONT_ENUM);
    this.focusTracker.selectionFace = selectionObject(realm, this, this.swfVersion);
    realm.global.define("Selection", this.focusTracker.selectionFace, avm1.DONT_ENUM);
    realm.global.define("Color", colorClass(this), avm1.DONT_ENUM);
    const sharedObjects = sharedObjectClass(this);
    this.sharedObjects = sharedObjects;
    realm.global.define("SharedObject", sharedObjects.constr, avm1.DONT_ENUM);
    realm.global.define("Sound", soundClass(this.media), avm1.DONT_ENUM);
    const xmlNodes = xmlNodeClass(this);
    this.xmlNodes = xmlNodes;
    realm.global.define("XMLNode", xmlNodes.constr, avm1.DONT_ENUM);
    const xml = xmlClass(this, xmlNodes);
    realm.global.define("XML", xml, avm1.DONT_ENUM);
    realm.global.define("LoadVars", loadVarsClass(this), avm1.DONT_ENUM);
    realm.global.define("XMLSocket", xmlSocketClass(this, xml), avm1.DONT_ENUM);
    realm.global.define("NetConnection", netConnectionClass(this, this.remoting), avm1.DONT_ENUM);
    const flash = flashPackage(this);
    const external = new avm1.Avm1Object(realm.objectProto);
    external.define("ExternalInterface", externalInterfaceClass(this.external), 0);
    flash.define("external", external, 0);
    const display = avm1.get(flash, "display", this.swfVersion);
    const bitmapData = bitmapDataClass(this);
    if (display instanceof avm1.Avm1Object) {
      display.define("BitmapData", bitmapData, 0);
    }

    const bitmapProto = bitmapData.own("prototype", this.swfVersion)?.value;
    const filters = new avm1.Avm1Object(realm.objectProto);
    flash.define("filters", filters, 0);
    this.filterFaces = filtersPackage(
      { realm, bitmapObject: (store) => bitmapObject(bitmapProto, store), storeOf },
      filters,
    );
    realm.Object.define(
      "registerClass",
      realm.method((_, args, version) => this.classes.registerClass(args, version)),
      avm1.DONT_ENUM | avm1.DONT_DELETE | avm1.READ_ONLY,
    );
    realm.global.define(
      "MovieClipLoader",
      movieClipLoaderClass(this, this.swfVersion),
      avm1.DONT_ENUM,
    );
    realm.global.define("PrintJob", printJobClass(realm), avm1.DONT_ENUM);
    // Last, as Flash defines it: _global's names are enumerated from the last defined.
    realm.global.define("TextSnapshot", textSnapshotClass(realm), avm1.DONT_ENUM);
    this.adopt(main);
    this.made(root);
  }

  /** A SWF's timelines told to this: their clips are made and play through it from now on. */
  adopt(swf: Avm1Swf): void {
    const library = swf.library;
    if (library === null) {
      return;
    }

    this.swfs.set(library, swf);
    library.avm1 = {
      placing: (display, place) => this.places.set(display, place),
      made: (display) => this.made(display),
      entered: (clip, frame) => this.entered(clip, frame),
      actions: (clip, tag) => this.queueTag(clip, tag),
      occupied: (depth) => this.host.trace(`Warning: Failed to place object at depth ${depth}.`),
      keeps: (display) => this.keeps(display),
    };
    library.removing = (display) => this.removing(display);
    library.sounds = timelineSoundsOf(this.sounds);
  }

  /**
   * The SWF whose timeline `d` is in: its clip's, or the nearest clip's
   * above it; the main one's for none.
   */
  swfOf(d: DisplayObject | null): Avm1Swf {
    for (let o = d; o !== null; o = o.parent) {
      const filled = o instanceof MovieClip ? this.contents.get(o) : undefined;
      if (filled !== undefined) {
        return filled;
      }

      if (o instanceof Container && o.library !== null) {
        const swf = this.swfs.get(o.library);
        if (swf !== undefined) {
          return swf;
        }
      }
    }

    return this.main;
  }

  /** The SWF of the code running now, by its clip; the main one's outside any. */
  currentSwf(): Avm1Swf {
    const base = this.realm.current?.base as DisplayObject | undefined;
    return this.swfOf(base ?? null);
  }

  /**
   * Compile the SWF's blocks and load their module, then run what the
   * first frame queued. An ActionScript 3 SWF's blocks are left, as Flash
   * runs none of them.
   */
  async load(swf: Swf): Promise<void> {
    // Compiled here, not by compile(), which would put a tick more between the
    // first frame and its actions than the timeline's sounds have.
    const list = this.main.list;
    if (list !== null && list.blocks.length > 0) {
      const module = this.codegen.compileActionsModule(swf.bytes, list);
      const { factory } = await evaluate(module, `swf2es-avm1-${++modules}.js`);
      this.main.blocks = (factory as unknown as avm1.Factory)(this.rt);
      this.external.ownCode(this.main);
    }

    this.loaded = true;
    if (this.halted) {
      return;
    }

    this.frameStart();
    this.timers.begin();
    try {
      // The main movie's root gets its load once its first frame's actions
      // have run: an onLoad they set is called (the corpus's root_onload).
      if (this.movieRoot !== null) {
        this.method(this.movieRoot, ClipEvent.load, false);
      }

      this.queue.run();
      this.timers.afterFrame(this.rate);
    } finally {
      this.timers.end();
    }
  }

  /** The blocks of `list`, a loaded SWF's, compiled to a module and loaded. */
  async compile(swf: Swf, list: ActionList | null): Promise<avm1.Blocks> {
    if (list === null || list.blocks.length === 0) {
      return [];
    }

    const module = this.codegen.compileActionsModule(swf.bytes, list);
    const { factory } = await evaluate(module, `swf2es-avm1-${++modules}.js`);
    return (factory as unknown as avm1.Factory)(this.rt);
  }

  /**
   * The next frame: the clips play, the newest first, those a clip before
   * them took off the display list left out, each dispatching its
   * enterFrame and queueing the actions of the frame it enters; then the
   * queue runs, and the timers due by the next frame fire.
   */
  tick(): void {
    // A clip's enterFrame comes whether the root moved or not.
    if (this.stopNext) {
      this.halted = true;
    }

    if (this.halted) {
      this.net.destroy();
      return;
    }

    this.timers.begin();
    try {
      this.frameStart();
      this.dropPending();
      // Sounds whose time has run are over before the clips play on, as AS3's are: a stream
      // starts again at its first block, a NoMultiple may start again.
      this.media.frames++;
      // What the network answered since the last frame, before the clips play on.
      if (this.netDelivered()) {
        this.queue.run();
      }

      finishTimelineSounds(this.sounds);
      const clips = this.clips;
      for (let i = clips.length - 1; i >= 0; i--) {
        const clip = clips[i];
        if (this.removed(clip)) {
          continue;
        }

        // A clip a load has just filled enters its first frame, its load event its first;
        // one of no frames, unloaded or in error, stays before it.
        if (clip.currentFrame === 0) {
          if (clip.totalFrames > 0) {
            clip.enterFirstFrame();
          }
        } else {
          this.dispatch(clip, ClipEvent.enterFrame);
          clip.advance();
        }

        if (this.halted) {
          return;
        }
      }

      this.clips = clips.filter((clip) => !this.removed(clip));
      // A load's onLoadInit after the frame's actions of what it loaded, as Ruffle queues it.
      this.loads.loadsInitialized();
      this.queue.run();
      // onSoundComplete runs with the frame's actions, and what it queues runs with them too.
      if (this.media.soundsCompleted()) {
        this.queue.run();
      }

      this.timers.afterFrame(this.rate);
      // The frame's remoting calls go, a packet for each connection.
      this.remoting.flush();
    } finally {
      this.timers.end();
    }
  }

  /** Between frames: what the network answered is delivered, and the timers due by the real clock fire. */
  idle(): void {
    this.network();
    if (this.halted || !this.loaded || this.realm.timers.size === 0) {
      return;
    }

    this.timers.begin();
    try {
      this.timers.fire();
    } finally {
      this.timers.end();
    }
  }

  /**
   * Whether `d` is off the display list, on no level, no longer a clip
   * scripts reach but by its path.
   */
  removed(d: DisplayObject): boolean {
    let top = d;
    while (top.parent !== null && !this.levelNumbers.has(top)) {
      top = top.parent;
    }

    return !this.levelNumbers.has(top) || this.levels.get(this.levelNumbers.get(top) ?? -1) !== top;
  }

  faceOf(d: DisplayObject): avm1.Avm1Object | null {
    return d.avm1;
  }

  atPath(path: string): DisplayObject | null {
    return atPath(path, (n) => this.levels.get(n) ?? null, this.swfVersion > 6);
  }

  /** The level `d` is, null for a display object that is none. */
  levelOf(d: DisplayObject): number | null {
    return this.levelNumbers.get(d) ?? null;
  }

  /** The levels' clips, by number, the lowest first. */
  levelClips(): MovieClip[] {
    return [...this.levels.entries()].sort(([a], [b]) => a - b).map(([, clip]) => clip);
  }

  /**
   * `_root` for code of `d`'s: the first clip from it up whose `_lockroot`
   * is set, else its level (Ruffle's avm1_root); level 0 for one off the
   * display list.
   */
  rootOf(d: DisplayObject): MovieClip {
    for (let o: DisplayObject | null = d; o !== null; o = o.parent) {
      if (o instanceof MovieClip && (this.levelNumbers.has(o) || nativeOf(o)?.lockroot)) {
        return this.removed(o) ? this.root : o;
      }
    }

    return this.root;
  }

  /** What timeline actions do to `clip`. */
  timeline(clip: MovieClip): avm1.Timeline {
    let timeline = this.timelines.get(clip);
    if (timeline === undefined) {
      timeline = {
        get currentFrame() {
          return clip.currentFrame;
        },
        get totalFrames() {
          return clip.totalFrames;
        },
        goto: (frame, play) => {
          clip.playing = play;
          if (frame !== clip.currentFrame) {
            clip.gotoFrame(frame);
          }
        },
        labelFrame: (label) => {
          const key = asciiLower(label);
          return clip.timeline.gotoLabels.find((l) => asciiLower(l.name) === key)?.frame;
        },
        call: (frame) => this.queue.callFrame(clip, frame),
      };
      this.timelines.set(clip, timeline);
    }

    return timeline;
  }

  /** attachMovie (clips.ts). */
  attachMovie(
    parent: MovieClip,
    name: string,
    instance: string,
    depth: number,
    init: avm1.Avm1Object | null,
  ): DisplayObject | null {
    return this.scriptClips.attachMovie(parent, name, instance, depth, init);
  }

  /** createEmptyMovieClip (clips.ts). */
  createEmptyMovieClip(parent: MovieClip, instance: string, depth: number): DisplayObject {
    return this.scriptClips.createEmptyMovieClip(parent, instance, depth);
  }

  /** createTextField (clips.ts). */
  createTextField(
    parent: MovieClip,
    instance: string,
    depth: number,
    rect: [number, number, number, number],
  ): DisplayObject {
    return this.scriptClips.createTextField(parent, instance, depth, rect);
  }

  /** duplicateMovieClip and CloneSprite (clips.ts). */
  duplicate(
    d: DisplayObject,
    name: string,
    depth: number,
    init: avm1.Avm1Object | null,
  ): DisplayObject | null {
    return this.scriptClips.duplicate(d, name, depth, init);
  }

  /** removeMovieClip and RemoveSprite (clips.ts). */
  remove(d: DisplayObject): void {
    this.scriptClips.remove(d);
  }

  textChanged(field: TextObject): void {
    this.bindings.textChanged(field);
  }

  variableChanged(field: TextObject): void {
    this.bindings.variableChanged(field);
  }

  propertyChanged(d: DisplayObject, name: string, value: avm1.Value, version: number): void {
    this.bindings.propertyChanged(d, name, value, version);
  }

  /** The text fields bound to variables. */
  private readonly bindings = new VariableBindings(this);

  /** `body` run in an activation of `d`, as `d`'s code would run. */
  inActivation(d: DisplayObject, body: (cx: avm1.Activation) => void): void {
    const cx = this.halted ? null : this.activationOf(d);
    if (cx === null) {
      return;
    }

    this.timers.begin();
    try {
      this.rt.call(cx, () => body(cx));
    } finally {
      this.timers.end();
    }
  }

  /** The frame's stack empty and its registers undefined, as each frame starts in Flash. */
  private frameStart(): void {
    this.st.length = 0;
    this.rt.realm.registers.fill(undefined);
    this.timers.frameStarted();
  }

  /**
   * A display object made alive: its AS2 face, and a clip among those that
   * play, with the clip actions of its place, its initialize events and its
   * construction queued where the timeline placed it.
   */
  made(d: DisplayObject): void {
    if (d.avm1 !== null) {
      return;
    }

    // Shapes, morphs, bitmaps and static text have none: a script reaches their parent by their name.
    const clip = d instanceof MovieClip;
    if (
      !clip &&
      !(d instanceof ButtonObject) &&
      !(d instanceof TextObject) &&
      !(d instanceof VideoObject)
    ) {
      return;
    }

    // Flash names each clip, button, text field and video without a name of its own as it
    // is made (the corpus's default_names).
    if (d.name === "" && !this.levelNumbers.has(d)) {
      d.name = `instance${++this.instances}`;
    }

    // A registered class's prototype comes as it is constructed: its initialize
    // events see MovieClip's (adl; Ruffle gives the class's at once).
    const face = new avm1.Avm1Object(
      clip
        ? this.clipProto
        : d instanceof ButtonObject
          ? this.buttonProto
          : d instanceof TextObject
            ? this.textFieldPrototype()
            : this.rt.realm.objectProto,
    );
    const native = new ClipNative(this, d);
    face.display = native;
    d.avm1 = face;
    if (d instanceof TextObject) {
      this.madeField(d, face);
    }

    this.bindings.retry(d);

    if (!clip) {
      return;
    }

    this.clips.push(d);
    // The SWF that places or makes it, whose clip actions it runs: its place is in its
    // parent's timeline, of the SWF the clip's character is.
    native.swf = this.swfOf(d);
    const place = this.places.get(d);
    const source = this.scriptClips.handed.get(d);
    if (place !== undefined) {
      this.places.delete(d);
      native.corrupt = place.corrupt;
      native.handlers = handlersOf(place, native.swf);
      this.corruptPlace(d, place.corrupt);
    } else if (source !== undefined) {
      this.scriptClips.handed.delete(d);
      native.swf = source.swf;
      native.corrupt = source.corrupt;
      native.handlers = source.handlers;
    }

    // Its initialize events wait for the queue's first pass, before its children's.
    for (const h of native.handlers ?? NO_HANDLERS) {
      if (h.events & ClipEvent.initialize) {
        this.queue.enqueue(INITIALIZE, new Queued(BLOCK, d, native.swf, h.block));
      }
    }

    // Placed by a timeline, its class's constructor and its construct events wait too;
    // a script constructs what it makes itself.
    if (d === this.scriptClips.scripted) {
      return;
    }

    // Its class is the one registered as it is constructed: a first frame's
    // DoInitAction blocks run after its places are made, before the queue.
    const constructs = constructBlocks(native);
    if (constructs.length > 0 || this.exported(d)) {
      this.queue.enqueue(
        CONSTRUCT,
        new Queued(CONSTRUCTION, d, native.swf, 0, 0, false, "", constructs),
      );
    }
  }

  /** `_global.TextField.prototype` as it is now, the class's own where a script took it away. */
  private textFieldPrototype(): avm1.Value {
    const version = this.swfVersion;
    const constr = avm1.get(this.rt.realm.global, "TextField", version);
    const proto = constr instanceof avm1.Avm1Object ? avm1.get(constr, "prototype", version) : null;
    return proto instanceof avm1.Avm1Object ? proto : this.textFieldProto;
  }

  /**
   * A text field's AVM1 object made: a broadcaster, itself its first
   * listener, so that its own onChanged and onScroller come before the
   * others' (Ruffle's initialize_as_broadcaster).
   */
  private madeField(field: TextObject, face: avm1.Avm1Object): void {
    this.bindings.made(field);

    const version = this.swfVersion;
    avm1.initializeBroadcaster(face, this.rt.realm, version);
    const listeners = avm1.get(face, "_listeners", version);
    if (listeners instanceof avm1.Avm1Object) {
      avm1.set(listeners, "0", face, version);
    }
  }

  /** Whether `d`'s character has an export name, which a class may be registered by. */
  private exported(d: DisplayObject): boolean {
    const id = d.character?.id;
    return id !== undefined && this.swfOf(d).exportNames.has(id);
  }

  /**
   * A place in a sprite whose clip actions Flash cannot read: the SWF stops
   * as it places the clip for load and initialize, after the frame's
   * initializations for construct, at the next frame for enterFrame. A
   * root's place stops it as the root enters the frame (`entered`).
   */
  private corruptPlace(d: DisplayObject, events: number): void {
    if (events === 0 || d.parent === this.movieRoot) {
      return;
    }

    switch (stopOf(events)) {
      case "place":
        this.halted = true;
        break;
      case "construct":
        this.queue.enqueue(CONSTRUCT, new Queued(HALT, d));
        break;
      case "enterFrame":
        this.stopNext = true;
        break;
    }
  }

  /** The name Object.registerClass gave `constr`, as SharedObject's AMF0 types an object; null for none. */
  xmlText(o: avm1.Avm1Object): string | null {
    const node = this.xmlNodes?.nodeOf(o) ?? null;
    return node === null ? null : xmlString(node, this.swfVersion);
  }

  registeredName(constr: Value): string | null {
    return this.classes.registeredName(constr);
  }

  /** The player gone: SharedObject writes what its scripts changed, as Flash did as a SWF closed. */
  destroy(): void {
    this.net.destroy();
    this.sharedObjects?.flush(this.swfVersion);
    stopTimelineSounds(this.sounds);
    this.audio?.close?.();
  }

  /** Resolves once every request the SWF has made so far has come back, for the next frame. */
  settled(): Promise<void> {
    return this.net.settled();
  }

  /** `o[name](...args)` in the root's activation, as a network callback between frames runs it. */
  callback(o: avm1.Avm1Object, name: string, args: Value[]): void {
    const cx = this.movieRoot === null || this.halted ? null : this.activationOf(this.movieRoot);
    if (cx !== null) {
      this.rt.callMethod(cx, o, name, args, this.swfVersion);
    }
  }

  /** LoadVars.send's page, as getURL's opens it. */
  navigate(url: string, window: string, form: avm1.UrlForm): void {
    this.host.navigate?.(url, window, form);
  }

  /**
   * Between frames: what the network has answered since delivered, its
   * callbacks run and what they queued, as Flash's come between frames.
   */
  network(): void {
    // A SWF stopped for good takes nothing more: its loads and connections end.
    if (this.halted) {
      this.net.destroy();
      return;
    }

    if (!this.loaded) {
      return;
    }

    this.timers.begin();
    try {
      if (this.netDelivered()) {
        this.queue.run();
      }
    } finally {
      this.timers.end();
    }
  }

  /**
   * The network's answers since the last frame delivered, each in the
   * root's activation as a callback runs, so that a setter or watcher it
   * sets off that throws or runs out of time ends that one alone, and an
   * error of the player's own goes to onUncaught and the rest go on:
   * whether there were any.
   */
  private netDelivered(): boolean {
    const ready = this.net.take();
    const cx = this.movieRoot === null ? null : this.activationOf(this.movieRoot);
    for (const deliver of ready) {
      if (this.halted || cx === null) {
        break;
      }

      try {
        this.rt.call(cx, deliver);
      } catch (error) {
        this.onUncaught(error);
      }
    }

    return ready.length > 0;
  }

  /**
   * loadVariables and loadVariablesNum: the variables at `url` set on
   * `into` between frames, then a clip's onData and its data event, as
   * Ruffle's load_form_into_object has them. A SWF up to 5 reads the text
   * as Windows-1252, a later one as UTF-8.
   */
  loadVariables(into: DisplayObject, url: string, form: avm1.UrlForm | null): void {
    const request =
      form === null
        ? { url, method: "GET" as const, headers: [], body: null }
        : formRequest(url, form.method, form.vars);
    this.net.fetch(request, (result) => {
      const face = into.avm1;
      if (result.bytes === null || face === null || this.removed(into)) {
        return;
      }

      const v = this.swfVersion;
      const text = new TextDecoder(v <= 5 ? "windows-1252" : "utf-8").decode(result.bytes);
      for (const [name, value] of parseForm(textFor(text, v), v)) {
        avm1.set(face, name, value, v);
      }

      if (into instanceof MovieClip) {
        this.queue.enqueue(NORMAL, new Queued(METHOD, into, null, 0, 0, false, "onData"));
        this.dispatch(into, ClipEvent.data, false);
      }
    });
  }

  /**
   * loadMovie and loadMovieNum: the SWF or image at `url` into a clip, or
   * into a level, which the load makes where there is none; an empty URL
   * unloads what is there.
   */
  loadMovie(into: DisplayObject | number, url: string, form: avm1.UrlForm | null): void {
    this.loads.loadMovie(into, url, form);
  }

  /**
   * MovieClipLoader.loadClip: the SWF or image at `url` into `target`,
   * `loader`'s listeners told of it; false for a target that is no clip.
   */
  loadClip(loader: avm1.Avm1Object, target: DisplayObject, url: string): boolean {
    return this.loads.loadClip(loader, target, url);
  }

  /** unloadMovie: what `d` shows unloaded and it left empty (loads.ts). */
  unloadMovie(d: DisplayObject): void {
    this.loads.unloadMovie(d);
  }

  /** Level `n`'s clip, null where there is none. */
  level(n: number): MovieClip | null {
    return this.levels.get(n) ?? null;
  }

  /** Level `n`'s clip, an empty one made where there is none. */
  levelToLoad(n: number): MovieClip {
    return this.levels.get(n) ?? this.makeLevel(n);
  }

  /** The size of the SWF `d` is of, as it came. */
  sizeOf(d: DisplayObject): number {
    return this.swfOf(d).size;
  }

  /**
   * A level of an empty clip, the main SWF's, on the stage at depth `n`,
   * above those below it, as a load into a level makes one before what it
   * loads arrives (Ruffle's get_or_create_level).
   */
  private makeLevel(n: number): MovieClip {
    const clip = new MovieClip(EMPTY_TIMELINE, this.root.library);
    this.levels.set(n, clip);
    this.levelNumbers.set(clip, n);
    this.root.parent?.placeAtDepth(clip, n);
    this.made(clip);
    return clip;
  }

  /**
   * `target` made to show `swf`, as Flash keeps a clip a load fills: what
   * it showed taken off, references to it kept by their paths, and its
   * timeline the SWF's root's, before its first frame, which it enters as
   * the next frame plays; one without a library shows nothing.
   */
  fill(target: MovieClip, swf: Avm1Swf, frames = EMPTY_TIMELINE): void {
    for (const child of target.children) {
      this.markPaths(child);
      target.library.sounds?.removed(child);
    }

    this.realm.removals++;
    target.replaceTimeline(swf.library?.root ?? frames, swf.library ?? target.library);
    // Level 0's SWF is the main one, whose version and size the movie gives; the frame rate
    // stays the first's.
    if (target === this.root) {
      this.main = swf;
      if (swf.library !== null) {
        this.swfVersion = swf.version;
        this.swfLength = swf.length;
      }
    }

    this.contents.set(target, swf);
    swf.root = target;
    this.entries.set(target, ++this.entryCount);
    const native = nativeOf(target);
    if (native !== null) {
      native.loaded = false;
      native.unloaded = false;
      native.pending = false;
    }
  }

  /** An activation of `d`'s code, as a frame's block has. */
  activationOf(d: DisplayObject, pool: Value[] = []): avm1.Activation | null {
    const face = d.avm1;
    return face === null ? null : this.rt.activation(this.st, pool, d, face, this.host);
  }

  /** A display object about to leave the display list: its unload, and where it and what is in it are. */
  private removing(d: DisplayObject): void {
    const focused = this.focusTracker.focusedObject;
    if (focused !== null && (focused === d || under(focused, d))) {
      this.focus(null);
    }

    this.markPaths(d);
    this.unload(d);
  }

  /** The host's renderer, which BitmapData's draw of a display object draws by; null where there is none. */
  drawer: Drawer | null = null;

  /** The library's bitmap exported as `name`, as a new transparent store, as loadBitmap makes one. */
  libraryBitmap(name: string): BitmapStore | null {
    const swf = this.currentSwf();
    const id = swf.exports.get(asciiLower(name));
    const character = id === undefined ? undefined : swf.library?.characters.get(id);
    if (character?.type !== "bitmap" || character.pixels === null) {
      return null;
    }

    return BitmapStore.of({ ...character.pixels, transparent: true });
  }

  /** attachBitmap: `store` shown in `parent` at AVM1 depth `depth`, as a bitmap with no AVM1 object of its own. */
  attachBitmap(parent: MovieClip, store: BitmapStore, depth: number, smoothing: boolean): void {
    const bitmap = new BitmapObject(store);
    bitmap.smoothing = smoothing;
    parent.placeAtDepth(bitmap, (depth + DEPTH_BIAS) | 0);
  }

  /** The stage a clip is on, which flash.geom.Transform measures to. */
  stageOf(_d: DisplayObject): DisplayObject | null {
    return this.root?.parent ?? null;
  }

  dropTargetOf(d: DisplayObject): DisplayObject | null {
    return this.dropTargets.get(d) ?? null;
  }

  hidden(d: DisplayObject): void {
    if (this.focusTracker.focusedObject === d) {
      this.focus(null);
    }
  }

  get focused(): DisplayObject | null {
    return this.focusTracker.focusedObject;
  }

  /** Focus `d`, or none, telling those it concerns at once (focus.ts). */
  focus(d: DisplayObject | null): void {
    this.focusTracker.focus(d);
  }

  /** Whether a script may focus `d` (focus.ts). */
  focusable(d: DisplayObject): boolean {
    return this.focusTracker.focusable(d);
  }

  pathOf(d: DisplayObject): string {
    return pathOf(d, (o) => this.levelOf(o));
  }

  resolve(value: avm1.Value, version: number): DisplayObject | null {
    const target = this.rt.realm.current?.target as DisplayObject | null | undefined;
    return targetOf(this, target ?? this.root, value, version);
  }

  /** Where `d` and what is in it are, the paths their references keep. */
  private markPaths(d: DisplayObject): void {
    const mark = (o: DisplayObject) => {
      const native = o.avm1?.display;
      if (native instanceof ClipNative && native.removedAt === null) {
        native.removedAt = pathOf(o, (p) => this.levelOf(p));
      }

      if (o instanceof MovieClip || o instanceof ButtonObject) {
        for (const child of o.children) {
          mark(child);
        }
      }
    };
    mark(d);
  }

  /** `d` and what is in it unloaded, the children first, each clip's unload dispatched once. */
  unload(d: DisplayObject): void {
    // Code running on a clip in it returns after the call that removed it.
    this.realm.removals++;
    this.bindings.unloaded(d);
    if (d instanceof Container) {
      for (const child of [...d.children]) {
        this.unload(child);
      }
    }

    const native = nativeOf(d);
    if (d instanceof MovieClip && native !== null && !native.unloaded) {
      native.unloaded = true;
      this.dispatch(d, ClipEvent.unload);
    }
  }

  /**
   * Whether `d`, being removed, stays a frame: a clip with an unload
   * handler, a clip event's or an onUnload anywhere on its object, or one
   * with such a clip in it, as Flash keeps it to run them. Its unload and
   * theirs come now.
   */
  private keeps(d: DisplayObject): boolean {
    if (this.swfOf(d).version < 5 || nativeOf(d)?.pending || !this.delays(d)) {
      return false;
    }

    const mark = (o: DisplayObject) => {
      const native = nativeOf(o);
      if (native !== null) {
        native.pending = true;
      }

      if (o instanceof Container) {
        for (const child of o.children) {
          mark(child);
        }
      }
    };
    mark(d);
    this.unload(d);
    this.pending.push(d);
    return true;
  }

  /** Whether `d` or a clip in it has an unload handler. */
  private delays(d: DisplayObject): boolean {
    const native = nativeOf(d);
    if (d instanceof MovieClip && native !== null) {
      if (native.handlers?.some((h) => h.events & ClipEvent.unload)) {
        return true;
      }

      const face = d.avm1;
      if (face !== null && avm1.find(face, "onUnload", this.swfOf(d).version) !== undefined) {
        return true;
      }
    }

    return d instanceof Container && d.children.some((child) => this.delays(child));
  }

  /** The clips kept a frame for their unload handlers go, as the next frame starts. */
  private dropPending(): void {
    if (this.pending.length === 0) {
      return;
    }

    for (const d of this.pending.splice(0)) {
      const parent = d.parent;
      if (parent instanceof Container) {
        this.markPaths(d);
        this.realm.removals++;
        parent.removeChild(d);
        parent.library?.sounds?.removed(d);
      }
    }
  }

  /** A clip entered a frame: its load on its first; the root's frames have their exports, inits, limits and stops. */
  private entered(clip: MovieClip, frame: number): void {
    this.entries.set(clip, ++this.entryCount);
    const native = nativeOf(clip);
    if (native !== null && !native.loaded) {
      native.loaded = true;
      // The main movie's root gets its load once its first frame's actions run (`load`).
      if (clip !== this.movieRoot) {
        this.dispatch(clip, ClipEvent.load);
      }
    }

    const swf = this.swfOf(clip);
    if (clip !== swf.root) {
      return;
    }

    const actions = swf.frames.get(frame);
    if (actions === undefined) {
      return;
    }

    if (actions.stop === "place") {
      this.halted = true;
      return;
    }

    if (actions.limits !== null) {
      [this.rt.maxRecursion, this.rt.scriptTimeout] = actions.limits;
    }

    for (const { id, name } of actions.exports) {
      swf.exports.set(asciiLower(name), id);
      swf.exportNames.set(id, name);
    }

    for (const { sprite, block } of actions.inits) {
      if (!swf.initialized.has(sprite)) {
        swf.initialized.add(sprite);
        this.queue.enqueue(INIT, new Queued(BLOCK, clip, swf, block));
      }
    }

    if (actions.stop === "construct") {
      this.queue.enqueue(CONSTRUCT, new Queued(HALT, clip));
    }

    this.stopNext ||= actions.stop === "enterFrame";
  }

  /**
   * An event of `clip`'s: from SWF 5 its clip actions for it queued, an
   * initialize's among the initializations, and from SWF 6 the AS2
   * method it calls after them. One whose place's clip actions Flash
   * cannot read stops the SWF instead.
   */
  dispatch(clip: MovieClip, event: number, methods = true): void {
    const native = nativeOf(clip);
    // Its clip actions are the SWF's that placed it, whatever a load put in it since.
    if (native === null || (native.swf ?? this.swfOf(clip)).version < 5) {
      return;
    }

    if (native.corrupt & event) {
      this.halted = true;
      return;
    }

    const unload = event === ClipEvent.unload;
    for (const h of native.handlers ?? NO_HANDLERS) {
      if (h.events & event) {
        this.queue.enqueue(
          event === ClipEvent.initialize ? INITIALIZE : NORMAL,
          new Queued(BLOCK, clip, native.swf, h.block, 0, unload),
        );
      }
    }

    if (methods) {
      this.method(clip, event, unload);
    }
  }

  /**
   * The version that decides whether a clip's AS2 event methods run: the
   * SWF it shows (Ruffle's movie version), but where a load left an image,
   * the error state or nothing, which have none, the SWF that made it.
   */
  private methodVersion(clip: DisplayObject): number {
    const shown = this.swfOf(clip);
    const made = nativeOf(clip)?.swf ?? null;
    return shown.library === null && made !== null ? made.version : shown.version;
  }

  /** From SWF 6, the AS2 method of `event` on `clip`'s object, queued. */
  method(clip: DisplayObject, event: number, unload: boolean): void {
    const name = METHODS.get(event);
    if (name !== undefined && this.methodVersion(clip) >= 6) {
      this.queue.enqueue(NORMAL, new Queued(METHOD, clip, null, 0, 0, unload, name));
    }
  }

  startDrag(d: DisplayObject, lockCenter: boolean, bounds: number[] | null): void {
    this.pointer?.startDrag(d, lockCenter, bounds);
  }

  stopDrag(): void {
    this.pointer?.stopDrag();
  }

  /** Every key let go, with no event, as the player loses focus (input.ts). */
  releaseKeys(): void {
    this.input.releaseKeys();
  }

  /** Broadcast a pointer's event (input.ts): every clip's clip actions for it, then Mouse's listeners. */
  clipEvent(event: number): void {
    this.input.clipEvent(event);
  }

  /** A DoAction tag a clip's frame reached: its blocks wait for the queue. */
  private queueTag(clip: MovieClip, tag: number): void {
    this.queue.enqueue(
      NORMAL,
      new Queued(FRAME, clip, this.swfOf(clip), tag, this.entries.get(clip) ?? 0),
    );
  }
}
