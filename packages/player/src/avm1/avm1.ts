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
import type { Codegen } from "@swf2es/codegen";
import {
  type ActionList,
  ButtonCondition,
  ClipEvent,
  isAs3,
  type Place,
  type Swf,
} from "@swf2es/format";
import { avm1 } from "@swf2es/runtime";
import { BitmapStore } from "../bitmap/bitmap.js";
import { decodeInBrowser, type ImageDecode } from "../bitmap/images.js";
import { boundsIn } from "../display/bounds.js";
import {
  BitmapObject,
  ButtonObject,
  CONTENT,
  Container,
  construct,
  type DisplayObject,
  displayFor,
  EMPTY_TIMELINE,
  MovieClip,
  TextObject,
  VideoObject,
} from "../display/display.js";
import type { DisplayCharacter, Library, SoundCharacter, Timeline } from "../display/timeline.js";
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
import { type AudioHost, browserAudioHost, type DecodedSound } from "../media/audio.js";
import {
  finishTimelineSounds,
  type SoundHost,
  stopTimelineSounds,
  timelineSoundsOf,
  updateMixes,
} from "../media/sounds.js";
import { evaluate } from "../scripting/evaluate.js";
import { resolve } from "../scripting/loads.js";
import { type BindingHost, VariableBindings } from "./bindings.js";
import { type TabHost, tabOrder } from "./focus.js";
import { type BitmapHost, bitmapDataClass } from "./globals/BitmapData.js";
import { buttonClass } from "./globals/Button.js";
import { colorClass } from "./globals/Color.js";
import { type ExternalHost, externalInterfaceClass } from "./globals/ExternalInterface.js";
import { flashPackage } from "./globals/geom.js";
import { type InputState, keyObject, mouseObject } from "./globals/Key.js";
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
import { type FocusState, selectionObject } from "./globals/Selection.js";
import { sharedObjectClass } from "./globals/SharedObject.js";
import { type Avm1SoundTransform, FULL, mixOfTransform, soundClass } from "./globals/Sound.js";
import { styleSheetClass } from "./globals/StyleSheet.js";
import { stateOf, textFieldClass } from "./globals/TextField.js";
import { textFormatClass } from "./globals/TextFormat.js";
import { textSnapshotClass } from "./globals/TextSnapshot.js";
import { xmlClass } from "./globals/XML.js";
import { xmlNodeClass } from "./globals/XMLNode.js";
import { xmlSocketClass } from "./globals/XMLSocket.js";
import { type Arrival, arrive, queryVariables } from "./loads.js";
import { Avm1Net, textFor } from "./net.js";
import { asciiLower, atPath, childByName, pathOf, under } from "./paths.js";
import {
  ActionQueue,
  BLOCK,
  CALL,
  CONSTRUCT,
  CONSTRUCTION,
  FRAME,
  HALT,
  INIT,
  INITIALIZE,
  METHOD,
  NO_ARGS,
  NO_BLOCKS,
  NORMAL,
  NOTIFY,
  Queued,
} from "./queue.js";
import {
  Avm1Swf,
  handlersOf,
  handlersOfButton,
  NO_HANDLERS,
  readRootFrames,
  stopOf,
} from "./swf.js";
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

/** The pointer's events that make a clip a button where its clip actions have one (Ruffle's BUTTON_EVENT_FLAGS). */
const BUTTON_EVENTS =
  ClipEvent.press |
  ClipEvent.release |
  ClipEvent.releaseOutside |
  ClipEvent.rollOver |
  ClipEvent.rollOut |
  ClipEvent.dragOver |
  ClipEvent.dragOut |
  ClipEvent.keyPress;

/** The AS2 methods that make a clip a button where its object, or what it inherits, has one. */
const BUTTON_METHODS = [
  "onPress",
  "onRelease",
  "onReleaseOutside",
  "onRollOver",
  "onRollOut",
  "onDragOver",
  "onDragOut",
];

/** The button transition each of the pointer's events is, by the event's bit (Ruffle's Avm1Button). */
const CONDITIONS = new Map<number, number>([
  [ClipEvent.rollOver, ButtonCondition.idleToOverUp],
  [ClipEvent.rollOut, ButtonCondition.overUpToIdle],
  [ClipEvent.press, ButtonCondition.overUpToOverDown],
  [ClipEvent.release, ButtonCondition.overDownToOverUp],
  [ClipEvent.releaseOutside, ButtonCondition.outDownToIdle],
  [ClipEvent.dragOut, ButtonCondition.overDownToOutDown],
  [ClipEvent.dragOver, ButtonCondition.outDownToOverDown],
]);

/** The frame label a clip in button mode goes to and stops at on each of the pointer's events. */
const LABELS = new Map<number, string>([
  [ClipEvent.rollOut, "_up"],
  [ClipEvent.releaseOutside, "_up"],
  [ClipEvent.rollOver, "_over"],
  [ClipEvent.release, "_over"],
  [ClipEvent.dragOut, "_over"],
  [ClipEvent.press, "_down"],
  [ClipEvent.dragOver, "_down"],
]);

/** What Mouse's listeners hear of the pointer's clip events. */
const MOUSE_MESSAGES = new Map<number, string>([
  [ClipEvent.mouseMove, "onMouseMove"],
  [ClipEvent.mouseDown, "onMouseDown"],
  [ClipEvent.mouseUp, "onMouseUp"],
]);

/** The state a button goes to on each of the pointer's events (Ruffle's Avm1Button: a drag out shows over). */
const BUTTON_STATES = new Map<number, "up" | "over" | "down">([
  [ClipEvent.rollOver, "over"],
  [ClipEvent.rollOut, "up"],
  [ClipEvent.press, "down"],
  [ClipEvent.release, "over"],
  [ClipEvent.releaseOutside, "up"],
  [ClipEvent.dragOut, "over"],
  [ClipEvent.dragOver, "down"],
]);

/** Names the scripts of AVM1 modules, as their stack frames show them. */
let modules = 0;

export class Avm1
  implements Movie, InputState, FocusState, TabHost, BitmapHost, BindingHost, ExternalHost
{
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
  /**
   * Object.registerClass's classes, by symbol name, one for every SWF:
   * named in its case from SWF 7, folded up to SWF 6, by the code that
   * registers and by the SWF of the clip it is looked up for (the
   * corpus's register_class).
   */
  private readonly registered = new Map<string, avm1.Avm1Function>();
  /** What each clip a load filled shows, the SWF's root it plays, by the clip. */
  private readonly contents = new WeakMap<MovieClip, Avm1Swf>();
  /** The loads asked, in order, until they are done with. */
  private movieLoads: MovieLoad[] = [];
  /**
   * The last load's arrival, nothing, into each clip and by each
   * MovieClipLoader, which the next one's waits for: they arrive in the
   * order asked.
   */
  private readonly arrivals = new WeakMap<object, Promise<void>>();
  private readonly decodeImage: ImageDecode | null;
  private readonly externalInterface: ExternalInterfaceHost | null;
  /** Each SWF's blocks, by which a function's or block's code is known as that SWF's. */
  private readonly codeSwfs = new WeakMap<avm1.Region[], Avm1Swf>();
  /** The URLs of every SWF that has had code to run, unloaded ones too. */
  private readonly codeUrls = new Set<string>();
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
  /** The display object a script is making, which it constructs itself; its children are the timeline's. */
  private scripted: DisplayObject | null = null;
  /** The player's clock, the scripts' timeout and setInterval's timers. */
  private readonly timers: Timers;

  quality = "HIGH";
  focusRect = true;
  soundBufferTime = 5;
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
  /** The keys down by Flash's codes, the mouse's buttons among them as 1, 2 and 4. */
  private readonly keysDown = new Set<number>();
  /**
   * The keys toggled on, by their codes: each press of a key, a mouse
   * button's too, turns it on or off, Caps Lock's as any other's (the
   * corpus's `key_isToggled`).
   */
  private readonly toggled = new Set<number>();
  keyCode = 0;
  keyAscii = 0;
  private shown = true;
  /** `_global.Key` and `_global.Mouse`, whose listeners the player sends their messages. */
  private keyFace: avm1.Avm1Object | null = null;
  private mouseFace: avm1.Avm1Object | null = null;
  private selectionFace: avm1.Avm1Object | null = null;
  /** The button or clip with the focus. */
  private focusedObject: DisplayObject | null = null;
  /**
   * Whether keyboard navigation shows the focus (Ruffle's highlight): a
   * focused object's onKeyDown and onKeyUp fire while it is not inactive,
   * and Enter and Space press it while it is visible.
   */
  private highlight: "inactive" | "visible" | "hidden" = "inactive";
  readonly url: string;
  readonly storage: SharedObjectStorage;
  /** SharedObject's writes of what its scripts changed, as the player goes: none before attach. */
  private sharedObjects: { flush(version: number): void } | null = null;
  readonly audio: AudioHost | null;
  /** What the timeline's sounds, and Sound's, play by. */
  readonly sounds: SoundHost;
  /** Each sound decoded once for the device. */
  private readonly decodes = new WeakMap<SoundCharacter, Promise<DecodedSound>>();
  /** The transforms Sound gave clips, and the global one. */
  private readonly soundTransforms = new WeakMap<DisplayObject, Avm1SoundTransform>();
  private globalSoundTransform: Avm1SoundTransform = FULL;
  /** What XML, LoadVars, loadVariables and XMLSocket ask of the network, and its answers for the next frame. */
  readonly net: Avm1Net;
  /** The Sounds whose sound ended, for their onSoundComplete after the frame's actions. */
  private completed: avm1.Avm1Object[] = [];
  private frameCount = 0;

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
    this.decodeImage = options.decodeImage === undefined ? decodeInBrowser : options.decodeImage;
    this.externalInterface = options.externalInterface ?? null;
    const movie = this;
    this.sounds = {
      get audio() {
        return movie.audio;
      },
      get now() {
        return movie.timers.now();
      },
      get frames() {
        return movie.frameCount;
      },
      soundClip: (character) => this.soundClip(character),
      ownMix: (d) => {
        const t = this.soundTransforms.get(d);
        return t === undefined ? undefined : mixOfTransform(t);
      },
      get mixer() {
        return mixOfTransform(movie.globalSoundTransform);
      },
      scriptSounds: () => 0,
    };
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
          options.fsCommand(command, args, this.callerUrls());
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
    this.keyFace = keyObject(realm, this, this.swfVersion);
    realm.global.define("Key", this.keyFace, avm1.DONT_ENUM);
    this.mouseFace = mouseObject(realm, this, this.swfVersion);
    realm.global.define("Mouse", this.mouseFace, avm1.DONT_ENUM);
    this.selectionFace = selectionObject(realm, this, this.swfVersion);
    realm.global.define("Selection", this.selectionFace, avm1.DONT_ENUM);
    realm.global.define("Color", colorClass(this), avm1.DONT_ENUM);
    const sharedObjects = sharedObjectClass(this);
    this.sharedObjects = sharedObjects;
    realm.global.define("SharedObject", sharedObjects.constr, avm1.DONT_ENUM);
    realm.global.define("Sound", soundClass(this), avm1.DONT_ENUM);
    const xmlNodes = xmlNodeClass(this);
    realm.global.define("XMLNode", xmlNodes.constr, avm1.DONT_ENUM);
    const xml = xmlClass(this, xmlNodes);
    realm.global.define("XML", xml, avm1.DONT_ENUM);
    realm.global.define("LoadVars", loadVarsClass(this), avm1.DONT_ENUM);
    realm.global.define("XMLSocket", xmlSocketClass(this, xml), avm1.DONT_ENUM);
    const flash = flashPackage(this);
    const external = new avm1.Avm1Object(realm.objectProto);
    external.define("ExternalInterface", externalInterfaceClass(this), 0);
    flash.define("external", external, 0);
    const display = avm1.get(flash, "display", this.swfVersion);
    if (display instanceof avm1.Avm1Object) {
      display.define("BitmapData", bitmapDataClass(this), 0);
    }
    realm.Object.define(
      "registerClass",
      realm.method((_, args, version) => this.registerClass(args, version)),
      avm1.DONT_ENUM | avm1.DONT_DELETE | avm1.READ_ONLY,
    );
    realm.global.define(
      "MovieClipLoader",
      movieClipLoaderClass(this, this.swfVersion),
      avm1.DONT_ENUM,
    );
    // Last, as Flash defines it: _global's names are enumerated from the last defined.
    realm.global.define("TextSnapshot", textSnapshotClass(realm), avm1.DONT_ENUM);
    this.adopt(main);
    this.made(root);
  }

  /** A SWF's timelines told to this: their clips are made and play through it from now on. */
  private adopt(swf: Avm1Swf): void {
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
  private currentSwf(): Avm1Swf {
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
      this.ownCode(this.main);
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
  private async compile(swf: Swf, list: ActionList | null): Promise<avm1.Blocks> {
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
      this.frameCount++;
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
      this.loadsInitialized();
      this.queue.run();
      // onSoundComplete runs with the frame's actions, and what it queues runs with them too.
      if (this.soundsCompleted()) {
        this.queue.run();
      }

      this.timers.afterFrame(this.rate);
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
  private levelClips(): MovieClip[] {
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

  /**
   * attachMovie: the character exported as `name` placed in `parent` at
   * AVM1 depth `depth` as `instance`, made as a script makes one; null
   * where there is no such character or the depth is out of range.
   */
  attachMovie(
    parent: MovieClip,
    name: string,
    instance: string,
    depth: number,
    init: avm1.Avm1Object | null,
  ): DisplayObject | null {
    const timelineDepth = (depth + DEPTH_BIAS) | 0;
    if (timelineDepth < 0 || timelineDepth > MAX_DEPTH) {
      return null;
    }

    const swf = this.swfOf(parent);
    const id = swf.exports.get(asciiLower(name));
    const character = id === undefined ? undefined : swf.library?.characters.get(id);
    if (!isDisplayCharacter(character)) {
      return null;
    }

    const child = displayFor(character, parent.library);
    return this.scriptPlace(parent, child, character, instance, timelineDepth, init);
  }

  /** createEmptyMovieClip: an empty clip in `parent` at AVM1 depth `depth` as `instance`. */
  createEmptyMovieClip(parent: MovieClip, instance: string, depth: number): DisplayObject {
    const child = new MovieClip(EMPTY_TIMELINE, parent.library);
    return this.scriptPlace(parent, child, null, instance, (depth + DEPTH_BIAS) | 0, null);
  }

  /** createTextField: an empty field in `parent` at AVM1 depth `depth` as `instance`. */
  createTextField(
    parent: MovieClip,
    instance: string,
    depth: number,
    [x, y, width, height]: [number, number, number, number],
  ): DisplayObject {
    const field = new TextObject(null);
    field.fonts = parent.library.fonts;
    field.width = width;
    field.height = height;
    field.matrix = { ...field.matrix, tx: x, ty: y };
    return this.scriptPlace(parent, field, null, instance, (depth + DEPTH_BIAS) | 0, null);
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

  /**
   * duplicateMovieClip and CloneSprite: a new one of `d`'s character, or an
   * empty clip for a script's, beside it at timeline depth `depth` as
   * `name`, with its matrix, colour and clip actions; null where `d` has
   * no clip for a parent or the depth is out of range.
   */
  duplicate(
    d: DisplayObject,
    name: string,
    depth: number,
    init: avm1.Avm1Object | null,
  ): DisplayObject | null {
    const parent = this.levelNumbers.has(d) ? null : d.parent;
    if (!(parent instanceof MovieClip) || this.removed(d) || depth < 0 || depth > MAX_DEPTH) {
      return null;
    }

    const character = d.character as DisplayCharacter | null;
    let child: DisplayObject;
    if (isDisplayCharacter(character)) {
      child = displayFor(character, parent.library);
    } else if (d instanceof MovieClip) {
      child = new MovieClip(EMPTY_TIMELINE, parent.library);
    } else {
      return null;
    }

    child.matrix = { ...d.matrix };
    child.colorTransform = d.colorTransform === null ? null : { ...d.colorTransform };
    const native = nativeOf(d);
    if (native !== null && native.handlers !== null) {
      this.handed.set(child, native);
    }

    return this.scriptPlace(
      parent,
      child,
      isDisplayCharacter(character) ? character : null,
      name,
      depth,
      init,
    );
  }

  /** The clips a duplicate takes the clip actions of, until it is made. */
  private readonly handed = new WeakMap<DisplayObject, ClipNative>();

  /**
   * removeMovieClip and RemoveSprite: `d` removed, where it is at a depth
   * scripts place at (a timeline's clip swapped there too), as Flash
   * removes only those.
   */
  remove(d: DisplayObject): void {
    const parent = this.levelNumbers.has(d) ? null : d.parent;
    const depth = d.depth;
    if (
      !(parent instanceof Container) ||
      depth === null ||
      depth < DEPTH_BIAS ||
      depth >= MAX_REMOVE_DEPTH ||
      this.removed(d)
    ) {
      return;
    }

    parent.removeAtDepth(depth);
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
  private made(d: DisplayObject): void {
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
    const source = this.handed.get(d);
    if (place !== undefined) {
      this.places.delete(d);
      native.corrupt = place.corrupt;
      native.handlers = handlersOf(place, native.swf);
      this.corruptPlace(d, place.corrupt);
    } else if (source !== undefined) {
      this.handed.delete(d);
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
    if (d === this.scripted) {
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

  /**
   * The class Object.registerClass bound to `d`'s character's export name
   * in its SWF, null for none.
   */
  classOf(d: DisplayObject): avm1.Avm1Function | null {
    // A sprite's only: a button's symbol stays a Button (the corpus's register_class).
    const id = d instanceof MovieClip ? d.character?.id : undefined;
    const swf = this.swfOf(d);
    const name = id === undefined ? undefined : swf.exportNames.get(id);
    return name === undefined ? null : (this.registered.get(classKey(name, swf.version)) ?? null);
  }

  /** The name Object.registerClass gave `constr`, as SharedObject's AMF0 types an object; null for none. */
  registeredName(constr: Value): string | null {
    if (!(constr instanceof avm1.Avm1Function)) {
      return null;
    }

    for (const [name, registered] of this.registered) {
      if (registered === constr) {
        return name;
      }
    }

    return null;
  }

  /** The player gone: SharedObject writes what its scripts changed, as Flash did as a SWF closed. */
  destroy(): void {
    this.net.destroy();
    this.sharedObjects?.flush(this.swfVersion);
    stopTimelineSounds(this.sounds);
    this.audio?.close?.();
  }

  /** The DefineSound ExportAssets named `name`, any case, as attachSound finds it. */
  exportedSound(name: string): SoundCharacter | null {
    const swf = this.currentSwf();
    const id = swf.exports.get(asciiLower(name));
    const character = id === undefined ? undefined : swf.library?.characters.get(id);
    return character?.type === "sound" ? character : null;
  }

  soundTransform(d: DisplayObject | null): Avm1SoundTransform {
    return d === null ? this.globalSoundTransform : (this.soundTransforms.get(d) ?? FULL);
  }

  setSoundTransform(d: DisplayObject | null, transform: Avm1SoundTransform): void {
    if (d === null) {
      this.globalSoundTransform = transform;
    } else {
      this.soundTransforms.set(d, transform);
    }

    updateMixes(this.sounds);
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

  /** The page's ExternalInterface, where it lets the SWF of the code running now use it. */
  /**
   * The page's ExternalInterface, where it lets the code calling use it:
   * the SWF whose block or function is running, known by its code; where
   * a native is called with no code of a SWF's running, as a timer, a
   * network callback or the page's call calls one straight, every SWF that
   * has run code so far must be allowed, as AS3's natives ask when they
   * cannot tell their caller (hosts.ts's allows). The clip a function was
   * made in is not enough: a load can put another SWF in it.
   */
  externalBridge(): ExternalInterfaceHost | null {
    const host = this.externalInterface;
    const allows = host?.allows;
    if (host === null || allows === undefined) {
      return host;
    }

    return this.callerUrls().every((url) => allows.call(host, url)) ? host : null;
  }

  /**
   * The URL of the SWF whose code is running, known by its blocks; where
   * no SWF's code is running, as a timer, a network callback or the page
   * calls a native straight, every URL of a SWF that has had code.
   */
  private callerUrls(): string[] {
    const caller = this.codeSwfs.get(this.realm.current?.code ?? []);
    return caller !== undefined ? [caller.url] : [...this.codeUrls];
  }

  /** `swf`'s code compiled: its blocks known as its own, and its URL among those that ran code. */
  private ownCode(swf: Avm1Swf): void {
    for (const block of swf.blocks) {
      this.codeSwfs.set(block, swf);
    }

    if (swf.blocks.length > 0) {
      this.codeUrls.add(swf.url);
    }
  }

  /**
   * `body`, the page's call into a callback, run between frames or inside
   * a call out, in the root's activation as a timer's callback runs, and
   * what it queued run after it: what it returned, undefined where it did
   * not run or threw.
   */
  callIn(body: () => Value): Value {
    const cx =
      this.movieRoot === null || this.halted || !this.loaded
        ? null
        : this.activationOf(this.movieRoot);
    if (cx === null) {
      return undefined;
    }

    let result: Value;
    this.timers.begin();
    try {
      this.rt.call(cx, () => {
        result = body();
      });
      this.queue.run();
    } finally {
      this.timers.end();
    }

    return result;
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
    if (typeof into === "number") {
      const level = this.levels.get(into);
      if (url !== "") {
        this.startLoad(level ?? this.makeLevel(into), url, form, null);
      } else if (level !== undefined) {
        this.unloadMovie(level);
      }
    } else if (into instanceof MovieClip) {
      if (url !== "") {
        this.startLoad(into, url, form, null);
      } else {
        this.unloadMovie(into);
      }
    }
  }

  /**
   * MovieClipLoader.loadClip: the SWF or image at `url` into `target`,
   * `loader`'s listeners told of it; false for a target that is no clip.
   */
  loadClip(loader: avm1.Avm1Object, target: DisplayObject, url: string): boolean {
    if (!(target instanceof MovieClip)) {
      return false;
    }

    this.startLoad(target, url, null, loader);
    return true;
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
   * A load into `target` asked: the request goes now, and what it brings,
   * read and its code compiled, arrives between frames, each load in the
   * order asked, as Ruffle's test runner has them arrive; one whose answer
   * is slow to come holds those after it a while at most.
   */
  private startLoad(
    target: MovieClip,
    url: string,
    form: avm1.UrlForm | null,
    loader: avm1.Avm1Object | null,
  ): void {
    // A load into a clip that another is under way into replaces it, which tells nothing.
    for (const earlier of this.movieLoads) {
      if (earlier.target === target && earlier.status === "pending") {
        earlier.status = "done";
      }
    }

    const request =
      form === null
        ? { url, method: "GET" as const, headers: [], body: null }
        : formRequest(url, form.method, form.vars);
    const load: MovieLoad = { target, loader, url: resolve(this.url, url), status: "pending" };
    this.movieLoads.push(load);
    const arrival = this.net
      .request(request, "content")
      .then(async (result): Promise<Arrived> => {
        // One replaced or cancelled meanwhile is not read, nor its code compiled.
        if (load.status !== "pending") {
          return SKIPPED;
        }

        // What came is the final URL's: a redirect to another origin must not pass as the one asked for.
        if (result.url) {
          load.url = result.url;
        }

        const a = await arrive(result, this.decodeImage);
        if (a.type !== "swf") {
          return a;
        }

        if (load.status !== "pending") {
          return SKIPPED;
        }

        return { ...a, blocks: await this.compile(a.swf, a.library.actions ?? null) };
      })
      .catch((): Arrived => ({ type: "unknown", status: 0 }));
    // After the loads asked before it into the same clip or by the same loader, which
    // are kept by what they settle to, nothing, not by what they brought.
    const keys: object[] = loader === null ? [target] : [target, loader];
    const previous = Promise.all(keys.map((key) => this.arrivals.get(key)));
    const ordered = within(previous, ORDER_WAIT).then(() => arrival);
    const settled = ordered.then(() => {});
    for (const key of keys) {
      this.arrivals.set(key, settled);
    }

    this.net.after(ordered, (arrived) => this.arrived(load, arrived));
  }

  /**
   * A load's bytes arrived, between frames: as Ruffle's movie_loader has
   * it, what the clip showed unloads, its variables go, and onLoadStart;
   * then the SWF or image takes its place, or an empty one where the bytes
   * are neither, with onLoadProgress and onLoadComplete, or onLoadError
   * where nothing came. A clip removed meanwhile takes nothing, and
   * nothing is told; one a listener removes or unloads is told no more.
   */
  private arrived(load: MovieLoad, arrived: Arrived): void {
    const target = load.target;
    const face = target.avm1 ?? undefined;
    const over = () => load.status !== "pending" || this.removed(target);
    // Told, and whether the load goes on.
    const told = (name: string, args: Value[]) => {
      this.tell(load, name, args);
      return !over();
    };
    if (over()) {
      // One an unload cancelled still starts, and no more (the corpus's load_cancel_*).
      if (load.status === "cancelled" && !this.removed(target)) {
        this.tell(load, "onLoadStart", [face]);
      }

      load.status = "done";
      return;
    }

    const version = this.swfOf(target).version;
    this.unload(target);
    if (face !== undefined) {
      for (const p of [...face.ownProperties()]) {
        if ((p.flags & avm1.DONT_DELETE) === 0) {
          face.remove(p);
        }
      }
    }

    this.fill(target, new Avm1Swf(null, null, version, load.url, 0));
    if (!told("onLoadStart", [face])) {
      load.status = "done";
      return;
    }

    // Flash's error state: no frames, none loaded, no version, and -1 bytes (the corpus's
    // movieclip_state_values).
    const error = () => this.fill(target, new Avm1Swf(null, null, 0, load.url, -1), NO_FRAMES);
    let going = true;
    switch (arrived.type) {
      case "failed":
        error();
        load.status = "done";
        this.tell(load, "onLoadError", [face, "URLNotFound", arrived.status]);
        return;
      case "unknown":
        error();
        going = told("onLoadProgress", [face, 0, 0]);
        break;
      case "image": {
        // An image is a movie of no version, its one frame the image at depth 1.
        const swf = new Avm1Swf(null, null, 0, load.url, arrived.size);
        this.fill(target, swf);
        if (arrived.pixels !== null) {
          target.placeAtDepth(new BitmapObject(BitmapStore.of(arrived.pixels)), 1);
        }

        going = told("onLoadProgress", [face, arrived.size, arrived.size]);
        break;
      }
      case "swf": {
        const { swf: file, library, size } = arrived;
        const swf = new Avm1Swf(
          library,
          library.actions ?? null,
          file.header.version,
          load.url,
          file.header.fileLength,
          size,
        );
        swf.blocks = arrived.blocks;
        this.ownCode(swf);
        this.adopt(swf);
        readRootFrames(file, swf);
        this.fill(target, swf);
        // The URL's query as the root's variables, as a movie's parameters.
        if (face !== undefined) {
          for (const [name, value] of queryVariables(load.url)) {
            face.define(name, textFor(value, swf.version), 0);
          }
        }

        // Ruffle tells a load into level 0 twice.
        going =
          (target !== this.root || told("onLoadProgress", [face, size, size])) &&
          told("onLoadProgress", [face, size, size]);
        break;
      }
    }

    if (!going) {
      load.status = "done";
      return;
    }

    load.status = "loaded";
    this.tell(load, "onLoadComplete", [face, arrived.status]);
    // No onLoadInit for one a listener removed or unloaded.
    if (this.removed(target)) {
      load.status = "done";
    }
  }

  /**
   * `load`'s loader's listeners told `name`, through its broadcastMessage,
   * as a script would call it.
   */
  private tell(load: MovieLoad, name: string, args: Value[]): void {
    if (load.loader !== null && !this.halted) {
      this.callback(load.loader, "broadcastMessage", [name, ...args]);
    }
  }

  /**
   * Each load that has arrived done with: one that loaded has its
   * loader's onLoadInit queued, after the frame's actions of what it
   * loaded, the latest load's first (Ruffle's movie_clip_on_load).
   */
  private loadsInitialized(): void {
    for (let i = this.movieLoads.length - 1; i >= 0; i--) {
      const load = this.movieLoads[i];
      if (load.status === "pending") {
        continue;
      }

      this.movieLoads.splice(i, 1);
      if (load.status === "loaded" && load.loader !== null) {
        this.queue.enqueue(
          NORMAL,
          new Queued(
            CALL,
            this.root,
            null,
            0,
            0,
            false,
            "broadcastMessage",
            NO_BLOCKS,
            load.loader,
            ["onLoadInit", load.target.avm1 ?? undefined],
          ),
        );
      }
    }
  }

  /**
   * unloadMovie: what `d` shows unloaded, its unload events, and it left
   * empty, as an empty movie of its parent's SWF; a level's or a loaded
   * movie's root's between frames, a frame later, as Ruffle's
   * avm1_unload_movie has them. A load into it under way is cancelled: it
   * tells of its start as it arrives, and no more.
   */
  unloadMovie(d: DisplayObject): void {
    if (!(d instanceof MovieClip)) {
      return;
    }

    // One under way tells of its start as it arrives; one arrived has no onLoadInit.
    for (const load of this.movieLoads) {
      if (load.target === d && load.status === "pending") {
        load.status = "cancelled";
      } else if (load.target === d && load.status === "loaded") {
        load.status = "done";
      }
    }

    if (this.levelNumbers.has(d) || this.contents.has(d)) {
      this.net.after(Promise.resolve(), () => this.unloaded(d));
    } else {
      this.unloaded(d);
    }
  }

  /** `d` unloaded and left empty. */
  private unloaded(d: MovieClip): void {
    if (this.removed(d)) {
      return;
    }

    const parent = this.levelNumbers.has(d) ? null : d.parent;
    const swf = parent === null ? this.swfOf(d) : this.swfOf(parent);
    this.unload(d);
    this.fill(
      d,
      new Avm1Swf(null, null, swf.version, parent === null ? "" : swf.url, 0),
      NO_FRAMES,
    );
  }

  /**
   * `target` made to show `swf`, as Flash keeps a clip a load fills: what
   * it showed taken off, references to it kept by their paths, and its
   * timeline the SWF's root's, before its first frame, which it enters as
   * the next frame plays; one without a library shows nothing.
   */
  private fill(target: MovieClip, swf: Avm1Swf, frames = EMPTY_TIMELINE): void {
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

  /** A Sound's sound has ended: its onSoundComplete runs once the frame's actions have. */
  complete(o: avm1.Avm1Object): void {
    this.completed.push(o);
  }

  /** Each ended Sound's onSoundComplete, in the root's activation: whether any ran. */
  private soundsCompleted(): boolean {
    const completed = this.completed;
    this.completed = [];
    if (completed.length === 0 || this.movieRoot === null) {
      return false;
    }

    const cx = this.activationOf(this.movieRoot);
    for (const o of completed) {
      if (cx !== null && !this.halted) {
        this.rt.callMethod(cx, o, "onSoundComplete", NO_ARGS, this.swfVersion);
      }
    }

    return true;
  }

  private soundClip(character: SoundCharacter): Promise<DecodedSound> | null {
    const audio = this.audio;
    if (audio === null) {
      return null;
    }

    let clip = this.decodes.get(character);
    if (clip === undefined) {
      clip = Promise.resolve().then(() => audio.decode(character.definition));
      this.decodes.set(character, clip);
    }

    return clip;
  }

  /** Object.registerClass(name, constructor): true where it binds or unbinds (null) the name. */
  private registerClass(args: Value[], version: number): Value {
    if (args.length < 2) {
      return false;
    }

    const constr = args[1];
    if (constr !== undefined && constr !== null && !(constr instanceof avm1.Avm1Function)) {
      return false;
    }

    const key = classKey(avm1.stringOf(args[0], version), version);
    if (constr instanceof avm1.Avm1Function) {
      this.registered.set(key, constr);
    } else {
      this.registered.delete(key);
    }

    return true;
  }

  /**
   * A display object a script made, put in `parent` at timeline depth
   * `depth` as `name` and made: its first frame entered, its children
   * placed, its load queued; then its construct events, its init
   * object's properties, before them up to SWF 6, its class's constructor
   * and its onConstruct at once, its initialize events queued as it was
   * made (adl:
   * Ruffle runs neither event, and onConstruct only for
   * createEmptyMovieClip's).
   */
  private scriptPlace(
    parent: MovieClip,
    child: DisplayObject,
    character: DisplayCharacter | null,
    name: string,
    depth: number,
    init: avm1.Avm1Object | null,
  ): DisplayObject {
    child.name = name;
    parent.placeAtDepth(child, depth);
    const outer = this.scripted;
    this.scripted = child;
    try {
      if (character !== null) {
        construct(child, character, parent.library);
      } else {
        this.made(child);
        if (child instanceof MovieClip) {
          child.enterFirstFrame();
        }
      }
    } finally {
      this.scripted = outer;
    }

    const face = child.avm1;
    const native = face?.display;
    if (face === null || !(native instanceof ClipNative)) {
      return child;
    }

    const version = this.swfOf(child).version;
    const constr = this.classOf(child);
    if (constr !== null) {
      face.define(
        "__proto__",
        avm1.get(constr, "prototype", version),
        avm1.DONT_ENUM | avm1.DONT_DELETE,
      );
    }

    // It is constructed as the queue's constructions are: a function returning in it
    // runs only initializations queued (the corpus's register_and_init_order).
    const pass = this.queue.priority;
    this.queue.priority = CONSTRUCT;
    try {
      // A SWF 6 sets the init object's properties before the construct events, a later one
      // after (adl).
      if (version <= 6) {
        this.initProperties(face, init, version);
      }

      for (const block of constructBlocks(native)) {
        this.queue.runOne(new Queued(BLOCK, child, native.swf, block), []);
      }

      if (version > 6) {
        this.initProperties(face, init, version);
      }

      if (constr !== null) {
        this.construct(child, face, constr);
      }

      // Then its onConstruct, from MovieClip's prototype or its class's, what it
      // throws caught there (adl, and the corpus's movieclip_onconstruct).
      const cx = this.activationOf(child);
      if (cx !== null) {
        this.rt.callMethod(cx, face, "onConstruct", NO_ARGS, version);
      }
    } finally {
      this.queue.priority = pass;
    }

    return child;
  }

  /** An init object's properties set on `face`, in the reverse of for..in's order, as Flash sets them. */
  private initProperties(
    face: avm1.Avm1Object,
    init: avm1.Avm1Object | null,
    version: number,
  ): void {
    const cx = init === null ? null : this.activationOf(this.root);
    if (init === null || cx === null) {
      return;
    }

    this.rt.call(cx, () => {
      const names = avm1.keys(init, version);
      for (let i = names.length - 1; i >= 0; i--) {
        avm1.set(face, names[i], avm1.get(init, names[i], version), version);
      }
    });
  }

  /** `constr` run on the clip's object as its constructor, as `new` runs one. */
  construct(clip: DisplayObject, face: avm1.Avm1Object, constr: avm1.Avm1Function): void {
    const cx = this.activationOf(clip);
    if (cx === null) {
      return;
    }

    const version = this.swfOf(clip).version;
    face.define("__constructor__", constr, avm1.DONT_ENUM);
    if (version < 7) {
      face.define("constructor", constr, avm1.DONT_ENUM);
    }

    this.rt.call(cx, () => {
      constr.callConstructor(face, NO_ARGS, version, 1);
    });
  }

  /** An activation of `d`'s code, as a frame's block has. */
  activationOf(d: DisplayObject, pool: Value[] = []): avm1.Activation | null {
    const face = d.avm1;
    return face === null ? null : this.rt.activation(this.st, pool, d, face, this.host);
  }

  /** A display object about to leave the display list: its unload, and where it and what is in it are. */
  private removing(d: DisplayObject): void {
    const focused = this.focusedObject;
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
    if (this.focusedObject === d) {
      this.focus(null);
    }
  }

  get focused(): DisplayObject | null {
    return this.focusedObject;
  }

  /**
   * Focus `d`, or none: where it changes, the one that had it hears
   * onKillFocus(new), `d` onSetFocus(old), then Selection's listeners
   * onSetFocus(old, new), at once, not queued (Ruffle's FocusTracker). The
   * highlight shows where `d` may show it.
   */
  focus(d: DisplayObject | null): void {
    const old = this.focusedObject;
    this.focusedObject = d;
    this.highlight =
      d === null
        ? "inactive"
        : !(d instanceof TextObject) && this.highlightable(d)
          ? "visible"
          : "hidden";
    if (d === old) {
      this.selectFocused();
      return;
    }

    // A field that loses the focus loses its selection.
    if (old instanceof TextObject) {
      old.focused = false;
      stateOf(old).selected = false;
      old.invalidate(CONTENT);
    }

    if (d instanceof TextObject) {
      d.focused = true;
      d.invalidate(CONTENT);
    }

    // Each object's method in an activation of its own, as its other event methods run.
    const version = this.swfVersion;
    const oldFace = old?.avm1 ?? null;
    const newFace = d?.avm1 ?? null;
    this.timers.begin();
    try {
      const oldCx = old === null ? null : this.activationOf(old);
      if (oldFace !== null && oldCx !== null) {
        this.rt.callMethod(oldCx, oldFace, "onKillFocus", [newFace], version);
      }

      const newCx = d === null ? null : this.activationOf(d);
      if (newFace !== null && newCx !== null) {
        this.rt.callMethod(newCx, newFace, "onSetFocus", [oldFace], version);
      }

      const selection = this.selectionFace;
      const cx = this.root !== null ? this.activationOf(this.root) : null;
      if (selection !== null && cx !== null) {
        this.rt.call(cx, () => {
          avm1.broadcastMessage(selection, "onSetFocus", [oldFace, newFace], version);
        });
      }
    } finally {
      this.timers.end();
    }

    this.selectFocused();
  }

  /**
   * A field given the focus, again too, has all its text selected, after
   * the focus's events, which see none (Ruffle's update_edittext_selection;
   * the corpus's `selection` and `edittext_programmatic_focus`).
   */
  private selectFocused(): void {
    const d = this.focusedObject;
    if (d instanceof TextObject) {
      stateOf(d).selected = true;
      d.select(0, d.model.text.length);
    }
  }

  /** Whether a script may focus `d`: a button, or a clip below the root in button mode or with focusEnabled true. */
  focusable(d: DisplayObject): boolean {
    // A field, selectable or not, as a script may focus any (Ruffle).
    if (d instanceof ButtonObject || d instanceof TextObject) {
      return true;
    }

    return (
      d instanceof MovieClip &&
      d !== this.root &&
      (this.buttonMode(d) || avm1.toBoolean(this.read(d, "focusEnabled"), this.swfVersion))
    );
  }

  pathOf(d: DisplayObject): string {
    return pathOf(d, (o) => this.levelOf(o));
  }

  resolve(value: avm1.Value, version: number): DisplayObject | null {
    const target = this.rt.realm.current?.target as DisplayObject | null | undefined;
    return targetOf(this, target ?? this.root, value, version);
  }

  /**
   * Whether the focus shows on `d`: not the root, something drawn, and its
   * `_focusrect`, from SWF 6 its own where it has one, else the stage's.
   */
  private highlightable(d: DisplayObject): boolean {
    if (d === this.root || d.parent === null) {
      return false;
    }

    const own = this.swfVersion >= 6 ? (nativeOf(d)?.focusRect ?? null) : null;
    if (!(own ?? this.focusRect)) {
      return false;
    }

    // A button's by its hit area, which it is tested by whatever it shows.
    const area = d instanceof ButtonObject ? d.hitTestState : null;
    const parent = area?.parent ?? null;
    if (area) {
      area.parent = d as ButtonObject;
    }

    try {
      const r = boundsIn(area ?? d, d.parent, null, true);
      return r.xMax > r.xMin || r.yMax > r.yMin;
    } finally {
      if (area) {
        area.parent = parent;
      }
    }
  }

  tabEnabled(d: DisplayObject): boolean | undefined {
    const value = this.read(d, "tabEnabled");
    return value === undefined ? undefined : avm1.toBoolean(value, this.swfVersion);
  }

  tabChildren(d: DisplayObject): boolean {
    const value = this.read(d, "tabChildren");
    return value === undefined || avm1.toBoolean(value, this.swfVersion);
  }

  /** A tabIndex as an int: a number's or a boolean's, any other value's the least; -1 is none (Ruffle). */
  tabIndex(d: DisplayObject): number | undefined {
    const value = this.read(d, "tabIndex");
    if (value === undefined || value === null) {
      return undefined;
    }

    const index =
      typeof value === "number" || typeof value === "boolean"
        ? avm1.toNumber(value, this.swfVersion) | 0
        : -2147483648;
    return index === -1 ? undefined : index;
  }

  /** Tab, or Shift+Tab: the focus to the next object in the tab order, or the one before, round. */
  private tab(reverse: boolean): boolean {
    const root = this.movieRoot;
    const stage = root?.parent;
    if (!(root instanceof MovieClip) || !stage) {
      return false;
    }

    const order = tabOrder(root, stage, this);
    if (order.length === 0) {
      return false;
    }

    const at = this.focusedObject === null ? -1 : order.indexOf(this.focusedObject);
    const step = reverse ? order.length - 1 : 1;
    const next = at < 0 ? (reverse ? order.length - 1 : 0) : (at + step) % order.length;
    this.focus(order[next]);
    return true;
  }

  /**
   * Enter or Space on what has the focus, where the highlight shows: a press
   * and a release of it. Whether it was pressed, the key then the SWF's.
   */
  private activate(): boolean {
    const d = this.focusedObject;
    if (this.highlight !== "visible" || d === null || this.removed(d) || !this.flag(d, "enabled")) {
      return false;
    }

    this.buttonDispatch(d, ClipEvent.press);
    this.buttonDispatch(d, ClipEvent.release);
    return true;
  }

  /**
   * The pointer's input, which hides the focus's highlight until Tab moves
   * the focus again: a left press always, and, below SWF 9, any press,
   * release or move.
   */
  pointerInput(type: "move" | "down" | "up", button: number): void {
    const left = button === 0;
    if (
      (type === "down" && left) ||
      (this.swfVersion < 9 && (left || button === 2 || type === "move"))
    ) {
      this.highlight = "inactive";
    }
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
  private unload(d: DisplayObject): void {
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
  private dispatch(clip: MovieClip, event: number, methods = true): void {
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
  private method(clip: DisplayObject, event: number, unload: boolean): void {
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

  keyIsDown(code: number): boolean {
    return this.keysDown.has(code);
  }

  keyToggled(code: number): boolean {
    return this.toggled.has(code);
  }

  /**
   * Every key let go, with no event, as the player loses focus
   * (Player.setActive): their releases go elsewhere and never come. The
   * mouse's buttons, 1, 2 and 4, stay the pointer's, which tells their
   * releases. What is toggled stays, as a release toggles nothing.
   */
  releaseKeys(): void {
    for (const code of this.keysDown) {
      if (code !== 1 && code !== 2 && code !== 4) {
        this.keysDown.delete(code);
      }
    }
  }

  get mouseShown(): boolean {
    return this.shown;
  }

  set mouseShown(shown: boolean) {
    this.shown = shown;
    this.pointer?.updateCursor();
  }

  /** A mouse button, as the pointer gives it (0 left, 1 middle, 2 right), down or up: Key's 1, 4 or 2. */
  mouseButton(button: number, down: boolean): void {
    const code = button === 0 ? 1 : button === 1 ? 4 : button === 2 ? 2 : 0;
    if (code === 0) {
      return;
    }

    this.keyState(code, down);
  }

  /**
   * A key down or up in Key's state: the last key, a press toggling it
   * unless it was already down (a held key's repeats do not), as Ruffle's
   * input state has it.
   */
  private keyState(code: number, down: boolean): void {
    this.keyCode = code;
    if (code === 0) {
      return;
    }

    if (!down) {
      this.keysDown.delete(code);
      return;
    }

    if (!this.keysDown.has(code) && !this.toggled.delete(code)) {
      this.toggled.add(code);
    }

    this.keysDown.add(code);
  }

  /**
   * A key pressed or let go (avm1/keyboard.ts), as Ruffle orders it:
   * every clip's keyDown or keyUp clip actions, as they are drawn, then Key's
   * listeners' onKeyDown or onKeyUp; then, for a press of a key that
   * `press` is a keyPress of, the first button or clip in the order they
   * are drawn whose keyPress it is runs its actions for it. The queue runs
   * once. Whether a keyPress ran.
   */
  key(
    down: boolean,
    keyCode: number,
    charCode: number,
    press: number,
    typed = 0,
    shift = false,
  ): boolean {
    if (this.halted || !this.loaded) {
      return false;
    }

    this.keyState(keyCode, down);
    this.keyAscii = charCode;
    this.timers.begin();
    try {
      // To the clips as they are drawn, the lowest first, what is in one before it (Ruffle's order).
      // What has the focus also hears onKeyDown or onKeyUp, from SWF 6, while the highlight is active.
      const event = down ? ClipEvent.keyDown : ClipEvent.keyUp;
      const focused = this.focusedObject;
      const heard =
        this.swfVersion >= 6 &&
        this.highlight !== "inactive" &&
        focused !== null &&
        this.flag(focused, "enabled")
          ? focused
          : null;
      const visit = (d: DisplayObject) => {
        if (d instanceof Container) {
          for (const child of d.children) {
            visit(child);
          }
        }

        if (d instanceof MovieClip) {
          this.dispatch(d, event, d === heard);
        } else if (d instanceof ButtonObject && d === heard) {
          this.method(d, event, false);
        }
      };
      for (const level of this.levelClips()) {
        visit(level);
      }

      this.notify(this.keyFace, down ? "onKeyDown" : "onKeyUp");
      const pressed = down && press !== 0 && this.queueKeyPress(press);

      // A key no keyPress took: Tab moves the focus, after what is queued runs; Enter and Space
      // press what has it.
      let used = pressed;
      if (down && !pressed && keyCode === 9) {
        this.queue.run();
        // A movie with nothing to tab to leaves Tab to the page.
        used = this.tab(shift);
      } else if (down && !pressed && (keyCode === 13 || typed === 32)) {
        // A press it made keeps the page from acting on the key too: Space would scroll it.
        used = this.activate();
      }

      this.queue.run();
      return used;
    } finally {
      this.timers.end();
    }
  }

  /** Text typed with no key events (avm1/keyboard.ts): a keyPress of its character, as `key` runs one. */
  keyPress(press: number): boolean {
    if (this.halted || !this.loaded || press === 0) {
      return false;
    }

    this.timers.begin();
    try {
      const pressed = this.queueKeyPress(press) || (press === 32 && this.activate());
      this.queue.run();
      return pressed;
    } finally {
      this.timers.end();
    }
  }

  /**
   * The first button or clip, as they are drawn, the lowest first and what
   * is in one before it, whose keyPress is `press`: a button's condition
   * blocks with that key, enabled or not, with its parent as target; a
   * clip's `on (keyPress)` clip actions. A hidden clip takes none, nor what
   * is in it, a hidden button none while it is up, and a button in a button
   * none. Whether one was queued.
   */
  private queueKeyPress(press: number): boolean {
    const visit = (d: DisplayObject, inButton: boolean): boolean => {
      const button = d instanceof ButtonObject ? d : null;
      if (!d.visible && (button === null || button.state === "up")) {
        return false;
      }

      if (d instanceof Container) {
        for (const child of d.children) {
          if (visit(child, inButton || button !== null)) {
            return true;
          }
        }
      }

      if (button) {
        const id = button.character?.id;
        let found = false;
        if (!inButton && button.parent !== null && id !== undefined) {
          const swf = this.swfOf(button);
          for (const h of handlersOfButton(swf, id)) {
            if (h.key === press) {
              this.queue.enqueue(NORMAL, new Queued(BLOCK, button.parent, swf, h.block));
              found = true;
            }
          }
        }

        return found;
      }

      const native = d instanceof MovieClip ? nativeOf(d) : null;
      if (native !== null && this.swfOf(d).version >= 5) {
        let found = false;
        for (const h of native.handlers ?? NO_HANDLERS) {
          if (h.events & ClipEvent.keyPress && h.key === press) {
            this.queue.enqueue(NORMAL, new Queued(BLOCK, d, native.swf, h.block));
            found = true;
          }
        }

        return found;
      }

      return false;
    };

    return this.levelClips().some((level) => visit(level, false));
  }

  /** `object`'s listeners told `name` with `args`, queued after what is queued now. */
  private notify(object: avm1.Avm1Object | null, name: string, args: avm1.Value[] = NO_ARGS): void {
    if (object !== null && this.root !== null) {
      this.queue.enqueue(
        NORMAL,
        new Queued(NOTIFY, this.root, null, 0, 0, false, name, NO_BLOCKS, object, args),
      );
    }
  }

  /** Whether Mouse has listeners, which the wheel would tell: the page keeps it otherwise. */
  get mouseHeard(): boolean {
    const face = this.mouseFace;
    const listeners = face === null ? undefined : avm1.get(face, "_listeners", this.swfVersion);
    return (
      listeners instanceof avm1.Avm1Object &&
      avm1.toNumber(avm1.get(listeners, "length", this.swfVersion), this.swfVersion) > 0
    );
  }

  /** The wheel turned by `delta` lines over `target`: Mouse's listeners' onMouseWheel, then the queue runs. */
  mouseWheel(delta: number, target: DisplayObject | null): void {
    if (this.halted || !this.loaded) {
      return;
    }

    this.timers.begin();
    try {
      this.notify(this.mouseFace, "onMouseWheel", [delta, target?.avm1 ?? undefined]);
      this.queue.run();
    } finally {
      this.timers.end();
    }
  }

  /**
   * Whether the pointer takes `clip` as a button (Ruffle's is_button_mode):
   * its clip actions have one of the pointer's button events, or, below
   * the root, its object has one of their AS2 methods, its own or
   * inherited, a class's among them.
   */
  buttonMode(clip: MovieClip): boolean {
    const native = nativeOf(clip);
    for (const h of native?.handlers ?? NO_HANDLERS) {
      if (h.events & BUTTON_EVENTS) {
        return true;
      }
    }

    const face = clip.avm1;
    if (face === null || clip === this.root || this.swfVersion < 6) {
      return false;
    }

    for (const name of BUTTON_METHODS) {
      if (avm1.has(face, name, this.swfVersion)) {
        return true;
      }
    }

    return false;
  }

  /** A button's or clip's AS2 flag, `enabled` or `useHandCursor`: true where it is undefined, as Flash reads it. */
  flag(d: DisplayObject, name: "enabled" | "useHandCursor"): boolean {
    const value = this.read(d, name);
    return value === undefined || avm1.toBoolean(value, this.swfVersion);
  }

  /** What a clip's `hitArea` names, a clip or button the pointer tests in its place; null for none. */
  hitArea(clip: MovieClip): DisplayObject | null {
    if (this.swfVersion < 6) {
      return null;
    }

    const area = this.read(clip, "hitArea");
    const display = area instanceof avm1.Avm1Object ? area.display : null;
    return display instanceof ClipNative ? display.target : null;
  }

  /**
   * `d`'s AVM1 object's property `name`, read as code reads it, in an
   * activation of `d`'s, as a getter `addProperty` gave it may be AVM1
   * code; undefined where it has no object, or the read throws. Within
   * a script, the begin and end go for nothing: the script's own hold.
   */
  private read(d: DisplayObject, name: string): avm1.Value {
    const face = d.avm1;
    const cx = this.halted ? null : this.activationOf(d);
    if (face === null || cx === null) {
      return undefined;
    }

    let value: avm1.Value;
    this.timers.begin();
    try {
      this.rt.call(cx, () => {
        value = avm1.get(face, name, this.swfVersion);
      });
    } finally {
      this.timers.end();
    }

    return value;
  }

  /**
   * The pointer's button events, each to its object, in the order given,
   * then the queue runs once. A button runs its condition blocks for the
   * transition, with its parent as target, plays the transition's sound
   * and changes state, then, from SWF 6, its AS2 method; a clip in button
   * mode goes to the event's frame label, if it has one, and stops, then
   * runs its clip actions and method for it. Ruffle's order (Avm1Button
   * and MovieClip's event_dispatch).
   */
  buttonEvents(events: readonly (readonly [DisplayObject, number])[]): void {
    if (this.halted || !this.loaded || events.length === 0) {
      return;
    }

    this.timers.begin();
    try {
      for (const [d, event] of events) {
        this.buttonDispatch(d, event);
      }

      this.queue.run();
    } finally {
      this.timers.end();
    }
  }

  /** One of the pointer's button events to `d`, a button or a clip in button mode, queued. */
  private buttonDispatch(d: DisplayObject, event: number): void {
    if (this.removed(d)) {
      return;
    }

    if (d instanceof ButtonObject) {
      this.buttonEvent(d, event);
    } else if (d instanceof MovieClip) {
      const label = LABELS.get(event);
      const timeline = this.timeline(d);
      const frame = label === undefined ? undefined : timeline.labelFrame(label);
      if (frame !== undefined) {
        timeline.goto(frame, false);
      }

      this.dispatch(d, event);
    }
  }

  private buttonEvent(button: ButtonObject, event: number): void {
    const condition = CONDITIONS.get(event) ?? 0;
    const parent = button.parent;
    const id = button.character?.id;
    if (parent !== null && id !== undefined) {
      const swf = this.swfOf(button);
      for (const h of handlersOfButton(swf, id)) {
        if (h.conditions & condition) {
          this.queue.enqueue(NORMAL, new Queued(BLOCK, parent, swf, h.block));
        }
      }
    }

    const state = BUTTON_STATES.get(event);
    if (state !== undefined && state !== button.state) {
      // A drag's transitions are silent.
      button.setState(state, event !== ClipEvent.dragOut && event !== ClipEvent.dragOver);
    }

    this.method(button, event, false);
  }

  /**
   * Broadcast a pointer's event (avm1/pointer.ts): every clip's clip
   * actions for it, the newest first, then Mouse's listeners, then the
   * queue runs. A key's go by `key`.
   */
  clipEvent(event: number): void {
    if (this.halted || !this.loaded) {
      return;
    }

    this.timers.begin();
    try {
      for (let i = this.clips.length - 1; i >= 0; i--) {
        const clip = this.clips[i];
        if (!this.removed(clip)) {
          this.dispatch(clip, event);
        }
      }

      // Mouse's listeners after every clip's, as Ruffle queues them.
      const message = MOUSE_MESSAGES.get(event);
      if (message !== undefined) {
        this.notify(this.mouseFace, message);
      }

      this.queue.run();
    } finally {
      this.timers.end();
    }
  }

  /** A DoAction tag a clip's frame reached: its blocks wait for the queue. */
  private queueTag(clip: MovieClip, tag: number): void {
    this.queue.enqueue(
      NORMAL,
      new Queued(FRAME, clip, this.swfOf(clip), tag, this.entries.get(clip) ?? 0),
    );
  }
}

/** A load of loadMovie's or MovieClipLoader's, from when it is asked until it is done with. */
interface MovieLoad {
  /** The clip it fills: the target's, or a level's. */
  target: MovieClip;
  /** The MovieClipLoader whose listeners hear of it; null for loadMovie's. */
  loader: avm1.Avm1Object | null;
  /**
   * Its URL against the SWF's, then where a redirect took it once it
   * arrives, as AS3's loads and Ruffle's take it: what it loaded's `_url`,
   * its query variables and the URL every access check asks about.
   */
  url: string;
  /**
   * Under way, or cancelled by an unload before it arrived; arrived and
   * loaded, its onLoadInit to come; or done, with nothing more to tell.
   */
  status: "pending" | "cancelled" | "loaded" | "done";
}

/** What a load brought, its blocks compiled where it is a SWF. */
type Arrived =
  | Exclude<Arrival, { type: "swf" }>
  | (Extract<Arrival, { type: "swf" }> & { blocks: avm1.Blocks });

/** What a load replaced or cancelled before it was read brings: nothing it reads. */
const SKIPPED: Arrived = { type: "failed", status: 0 };

/** The longest a load waits for the one asked before it, in ms, to arrive in their order. */
const ORDER_WAIT = 2000;

/** `previous` settled, or `ms` passed, whichever comes first. */
function within(previous: Promise<unknown>, ms: number): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const passed = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  return Promise.race([previous, passed]).finally(() => clearTimeout(timer));
}

/** What a clip unloaded or in error shows: no frames, which it never enters. */
const NO_FRAMES: Timeline = { ...EMPTY_TIMELINE, frames: [] };

/** The highest timeline depth scripts place at, 2^31 - 16777220, as Ruffle has it. */
const MAX_DEPTH = 2130706428;
/** The depth from which removeMovieClip removes nothing. */
const MAX_REMOVE_DEPTH = 2130706416;

/** A symbol name as registerClass keys it, by a SWF of `version`: in its case from SWF 7. */
function classKey(name: string, version: number): string {
  return version > 6 ? name : avm1.fold(name);
}

/** The blocks of a clip's construct events. */
function constructBlocks(native: ClipNative): number[] {
  const blocks: number[] = [];
  for (const h of native.handlers ?? NO_HANDLERS) {
    if (h.events & ClipEvent.construct) {
      blocks.push(h.block);
    }
  }

  return blocks;
}

/** Whether a character is one a timeline places. */
function isDisplayCharacter(c: unknown): c is DisplayCharacter {
  const type = (c as { type?: string } | null | undefined)?.type;
  return (
    type === "sprite" ||
    type === "shape" ||
    type === "morph" ||
    type === "button" ||
    type === "text" ||
    type === "static" ||
    type === "bitmap"
  );
}
