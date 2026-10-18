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
  readExports,
  type Swf,
  tags,
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
import { flashPackage } from "./globals/geom.js";
import { type InputState, keyObject, mouseObject } from "./globals/Key.js";
import { formRequest, loadVarsClass, parseForm } from "./globals/LoadVars.js";
import {
  ClipNative,
  DEPTH_BIAS,
  type Movie,
  movieClipClass,
  targetOf,
} from "./globals/MovieClip.js";
import { movieClipLoaderClass } from "./globals/MovieClipLoader.js";
import { type FocusState, selectionObject } from "./globals/Selection.js";
import { sharedObjectClass } from "./globals/SharedObject.js";
import { type Avm1SoundTransform, FULL, mixOfTransform, soundClass } from "./globals/Sound.js";
import { styleSheetClass } from "./globals/StyleSheet.js";
import { stateOf, textFieldClass } from "./globals/TextField.js";
import { textFormatClass } from "./globals/TextFormat.js";
import { xmlClass } from "./globals/XML.js";
import { xmlNodeClass } from "./globals/XMLNode.js";
import { xmlSocketClass } from "./globals/XMLSocket.js";
import { type Arrival, arrive, queryVariables } from "./loads.js";
import { Avm1Net, textFor } from "./net.js";
import { asciiLower, atPath, childByName, pathOf, under } from "./paths.js";

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
   */
  fsCommand?: (command: string, args: string) => void;
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

/**
 * Where in a frame Flash stops the SWF at a place whose clip actions it
 * cannot read: it reads them as the first of the place's events comes, so
 * as it places the clip for load and initialize, before any of the
 * frame's actions; after the frame's DoInitActions for construct; at the
 * next frame for enterFrame, the frame's actions run. A place of other
 * events stops it as one comes to the clip (`dispatch`).
 */
type Stop = "place" | "construct" | "enterFrame";

/** The first of `events`, a place's field of all events, by which Flash stops. */
function stopOf(events: number): Stop | null {
  if (events & (ClipEvent.load | ClipEvent.initialize)) {
    return "place";
  }

  if (events & ClipEvent.construct) {
    return "construct";
  }

  return events & ClipEvent.enterFrame ? "enterFrame" : null;
}

const STOPS: Stop[] = ["place", "construct", "enterFrame"];

/** What happens as the root enters a frame, before its places and DoAction blocks. */
interface RootFrame {
  /** Its ExportAssets' names, which attachMovie and registerClass find characters by. */
  exports: { id: number; name: string }[];
  /** Its DoInitAction blocks, by index, with the sprite each is of. */
  inits: { sprite: number; block: number }[];
  /** Where a place in the frame whose clip actions Flash cannot read stops the SWF. */
  stop: Stop | null;
  /** The frame's last ScriptLimits: its recursion depth and script timeout, in seconds. */
  limits: [number, number] | null;
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

/** A button's condition block: the transitions it runs on, and its key (0 for none). */
interface ButtonHandler {
  conditions: number;
  key: number;
  block: number;
}

// The queue's priorities, which it runs in order: initialize clip events
// first, then the root's DoInitAction blocks, then constructions, then the
// rest, frame actions, events and methods, each in the order queued
// (Ruffle's ActionPriority; adl has a frame's initialize events before its
// DoInitAction blocks, which Ruffle runs as the SWF loads).
const INITIALIZE = 0;
const INIT = 1;
const CONSTRUCT = 2;
const NORMAL = 3;

// What a queued action is.
/** A DoAction tag's blocks, `index` the tag's body's offset. */
const FRAME = 0;
/** A block alone, a DoInitAction's or a clip event's, by its index. */
const BLOCK = 1;
/** A timeline's clip's construction: its registered class's prototype and constructor, and its construct events. */
const CONSTRUCTION = 2;
/** An AS2 event method, `name`, of the clip's object. */
const METHOD = 3;
/** The SWF stopped, at a place whose clip actions Flash cannot read. */
const HALT = 4;
/** A broadcaster's message, `name`, to its listeners: Key's and Mouse's, as the player sends them. */
const NOTIFY = 5;
/** A method, `name`, of `object`, called with `args`, as a script would call it. */
const CALL = 6;

/** An action waiting its turn in the frame. */
class Queued {
  constructor(
    readonly kind: number,
    readonly clip: DisplayObject,
    /** The SWF whose blocks `index` and `blocks` are. */
    readonly swf: Avm1Swf | null = null,
    readonly index = 0,
    /** Which of the clip's frame entries queued a FRAME: blocks of one share their constant pool. */
    readonly entry = 0,
    /** Whether it is an unload's, which runs for a clip removed since. */
    readonly unload = false,
    readonly name = "",
    readonly blocks: number[] = NO_BLOCKS,
    /** A NOTIFY's broadcaster or a CALL's object, and the arguments. */
    readonly object: avm1.Avm1Object | null = null,
    readonly args: avm1.Value[] = NO_ARGS,
  ) {}
}

const NO_BLOCKS: number[] = [];

const NO_BUTTON_HANDLERS: readonly ButtonHandler[] = [];

/**
 * One AVM1 SWF the player runs, the main one or one loadMovie loaded: its
 * blocks, its library and what its root's frames export and initialize,
 * which its own code and timelines use, not another's (Ruffle's per-movie
 * library). Every SWF shares the player's realm, `_global` among it.
 */
export class Avm1Swf {
  /** Its module's blocks, by index. */
  blocks: avm1.Blocks = [];
  /** By its root's frame, 1 the first. */
  readonly frames = new Map<number, RootFrame>();
  /** The sprites whose DoInitAction has run. */
  readonly initialized = new Set<number>();
  /** Exported characters by name in lower case, as attachMovie finds them, and each one's name. */
  readonly exports = new Map<string, number>();
  readonly exportNames = new Map<number, string>();
  /** Each button character's condition blocks, by its id, gathered from the action list once. */
  buttonHandlers: Map<number, ButtonHandler[]> | null = null;
  /** The clip that plays it as its root: level 0's, a level's or the clip it was loaded into. */
  root: MovieClip | null = null;

  constructor(
    readonly library: Library | null,
    readonly list: ActionList | null,
    readonly version: number,
    /** Its URL, which `_url` gives. */
    readonly url: string,
    /** Its length in bytes, which getBytesTotal and getBytesLoaded give for its root. */
    readonly length: number,
    /** Its size as it came, compressed, which MovieClipLoader.getProgress gives. */
    readonly size = length,
  ) {}
}

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

/** How many queued actions of a priority run before those run are dropped from its queue. */
const COMPACT_AT = 4096;

/** The ms in a frame of the SWF's rate. */
const frameMs = (rate: number) => 1000 / (rate || 24);

const defaultClock = (): (() => number) | null =>
  typeof performance !== "undefined" ? () => performance.now() : null;

/** The real clock the script timeout reads, whatever clock the timers go by. */
const timeoutClock =
  typeof performance !== "undefined" ? () => performance.now() : () => Date.now();

/** Names the scripts of AVM1 modules, as their stack frames show them. */
let modules = 0;

export class Avm1 implements Movie, InputState, FocusState, TabHost, BitmapHost, BindingHost {
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
  /** The operand stack, which every activation of a frame's actions shares. */
  private readonly st: avm1.Value[] = [];
  /** Whether the SWF stops as the next frame comes, at a clip's enterFrame. */
  private stopNext = false;
  /** The clips, in the order they were made, which play the newest first. */
  private clips: MovieClip[] = [];
  /** The queue, by priority, and how far each has run. */
  private readonly queues: Queued[][] = [[], [], [], []];
  private readonly heads = [0, 0, 0, 0];
  /** Whether the module is loaded: until it is, the first frame's actions wait in the queue. */
  private loaded = false;
  /** Whether the queue is running, which a function's return runs the earlier passes of. */
  private running = false;
  /** The pass of the action the queue runs, and the pass `next` last took from. */
  private priority = NORMAL;
  private taken = NORMAL;
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
  private readonly onUncaught: (error: unknown) => void;
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
  private readonly realTime: (() => number) | null;
  /** The frame clock, ms since the start, a frame's duration on each frame. */
  private frameClock = 0;
  /** GetTime's calls in the frame, and what they have added to a frame clock that stands still. */
  private timeCalls = 0;
  private timeOffset = 0;
  /** The real clock's reading at the start. */
  private readonly start: number;

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
  /** How deep begin() is: only the outermost begin and end start and stop the scripts' clock. */
  private beginDepth = 0;
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
    const movie = this;
    this.sounds = {
      get audio() {
        return movie.audio;
      },
      get now() {
        return movie.now();
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
    this.realTime = options.realTime === undefined ? defaultClock() : options.realTime;
    this.start = this.realTime?.() ?? 0;
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
      time: () => this.getTime(),
      duplicate: (target, name, depth) => {
        this.duplicate(target as DisplayObject, name, depth, null);
      },
      remove: (target) => this.remove(target as DisplayObject),
      startDrag: (target, lockCenter, bounds) =>
        this.startDrag(target as DisplayObject, lockCenter, bounds),
      stopDrag: () => this.stopDrag(),
      returned: () => this.returned(),
      stopSounds: () => stopTimelineSounds(this.sounds),
      loadVariables: (into, url, form) => this.loadVariables(into as DisplayObject, url, form),
      loadMovie: (into, url, form) =>
        this.loadMovie(typeof into === "number" ? into : (into as DisplayObject), url, form),
      fsCommand: options.fsCommand ?? ((command) => this.fsCommand(command)),
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
    this.readRootFrames(swf, main);

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
    }

    this.loaded = true;
    if (this.halted) {
      return;
    }

    this.frameStart();
    this.begin();
    try {
      // The main movie's root gets its load once its first frame's actions
      // have run: an onLoad they set is called (the corpus's root_onload).
      if (this.movieRoot !== null) {
        this.method(this.movieRoot, ClipEvent.load, false);
      }

      this.runQueue();
      this.afterFrame();
    } finally {
      this.end();
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

  /** A frame's actions have run: until the next frame, its time passes and the timers due fire. */
  private afterFrame(): void {
    this.frameClock += frameMs(this.rate);
    this.fireTimers();
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

    this.begin();
    try {
      this.frameStart();
      this.dropPending();
      // Sounds whose time has run are over before the clips play on, as AS3's are: a stream
      // starts again at its first block, a NoMultiple may start again.
      this.frameCount++;
      // What the network answered since the last frame, before the clips play on.
      if (this.netDelivered()) {
        this.runQueue();
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
      this.runQueue();
      // onSoundComplete runs with the frame's actions, and what it queues runs with them too.
      if (this.soundsCompleted()) {
        this.runQueue();
      }

      this.afterFrame();
    } finally {
      this.end();
    }
  }

  /** Between frames: what the network answered is delivered, and the timers due by the real clock fire. */
  idle(): void {
    this.network();
    if (this.halted || !this.loaded || this.realm.timers.size === 0) {
      return;
    }

    this.begin();
    try {
      this.fireTimers();
    } finally {
      this.end();
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
        call: (frame) => this.callFrame(clip, frame),
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

    this.begin();
    try {
      this.rt.call(cx, () => body(cx));
    } finally {
      this.end();
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
    this.timeCalls = 0;
  }

  /** The time on the player's clock: the real clock's since the start, or the frame clock. */
  private now(): number {
    return this.realTime === null ? this.frameClock : this.realTime() - this.start;
  }

  /**
   * GetTime: whole ms since the start. A frame clock stands still through
   * a frame, so, as Ruffle has it, a script that asks it again and again,
   * waiting for it to move, sees a ms pass every fifth call from the 20th.
   */
  private getTime(): number {
    if (this.realTime !== null) {
      return Math.floor(this.realTime() - this.start);
    }

    this.timeCalls++;
    if (this.timeCalls >= 20 && this.timeCalls % 5 === 0) {
      this.timeOffset++;
    }

    return Math.floor(this.realm.timers.now) + this.timeOffset;
  }

  /** Scripts start running: the script timeout counts from now. */
  private begin(): void {
    if (this.beginDepth++ > 0) {
      return;
    }

    this.realm.timers.now = this.now();
    this.rt.begin(timeoutClock(), timeoutClock);
  }

  private end(): void {
    if (--this.beginDepth > 0) {
      return;
    }

    this.rt.end();
  }

  /** The timers due by now, each running what it queues after it. */
  private fireTimers(): void {
    if (this.realm.timers.size === 0 || this.movieRoot === null) {
      return;
    }

    const root = this.movieRoot;
    this.rt.fireTimers(
      this.now(),
      this.swfVersion,
      () => this.activationOf(root),
      () => this.runQueue(),
      (object) => {
        const target = object.display?.target;
        return target instanceof MovieClip && this.removed(target);
      },
    );
  }

  /** Each root frame's exports, DoInitAction blocks, the tags Flash cannot read and its ScriptLimits. */
  private readRootFrames(swf: Swf, into: Avm1Swf): void {
    const list = into.list;
    if (list === null) {
      return;
    }

    // The root has a frame a ShowFrame tag ends; what follows the last is the last's.
    const last = Math.max(1, swf.tags.filter((t) => t.code === tags.ShowFrame).length);
    const frameOf = (frame: number) => {
      const at = Math.min(frame, last);
      let actions = into.frames.get(at);
      if (!actions) {
        actions = { exports: [], inits: [], stop: null, limits: null };
        into.frames.set(at, actions);
      }

      return actions;
    };
    for (const block of list.blocks) {
      const owner = block.owner;
      if (block.length > 0 && owner.type === "init" && owner.timeline === null) {
        frameOf(owner.frame + 1).inits.push({ sprite: owner.sprite, block: block.index });
      }
    }

    // A ScriptLimits takes effect as its frame comes, before the frame's
    // actions, the frame's last one if it has two (adl): two u16s, the
    // recursion depth and the script timeout in seconds.
    let frame = 1;
    for (const tag of swf.tags) {
      const events = list.corruptEvents.get(tag.offset);
      if (tag.code === tags.ShowFrame) {
        frame++;
      } else if (tag.code === tags.ScriptLimits && tag.length >= 4) {
        const at = tag.offset;
        const b = swf.bytes;
        frameOf(frame).limits = [b[at] | (b[at + 1] << 8), b[at + 2] | (b[at + 3] << 8)];
      } else if (tag.code === tags.ExportAssets) {
        frameOf(frame).exports.push(...readExports(swf.bytes, tag));
      } else if (events !== undefined) {
        const actions = frameOf(frame);
        const stop = stopOf(events);
        if (stop && (!actions.stop || STOPS.indexOf(stop) < STOPS.indexOf(actions.stop))) {
          actions.stop = stop;
        }
      }
    }
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
      native.handlers = this.handlersOf(place, native.swf);
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
        this.enqueue(INITIALIZE, new Queued(BLOCK, d, native.swf, h.block));
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
      this.enqueue(CONSTRUCT, new Queued(CONSTRUCTION, d, native.swf, 0, 0, false, "", constructs));
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

  /** A place's clip actions, with the events each runs for, as `swf`'s action list has them. */
  private handlersOf(place: Place, swf: Avm1Swf): Handler[] | null {
    const list = swf.list;
    if (place.actions === null || place.actions.length === 0 || list === null) {
      return null;
    }

    const handlers: Handler[] = [];
    for (const index of place.actions) {
      const owner = list.blocks[index].owner;
      if (owner.type === "clip") {
        handlers.push({ events: owner.events, key: owner.key, block: index });
      }
    }

    return handlers;
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
        this.enqueue(CONSTRUCT, new Queued(HALT, d));
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
  private classOf(d: DisplayObject): avm1.Avm1Function | null {
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

    this.begin();
    try {
      if (this.netDelivered()) {
        this.runQueue();
      }
    } finally {
      this.end();
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
        this.enqueue(NORMAL, new Queued(METHOD, into, null, 0, 0, false, "onData"));
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
        this.adopt(swf);
        this.readRootFrames(file, swf);
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
        this.enqueue(
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
    const pass = this.priority;
    this.priority = CONSTRUCT;
    try {
      // A SWF 6 sets the init object's properties before the construct events, a later one
      // after (adl).
      if (version <= 6) {
        this.initProperties(face, init, version);
      }

      for (const block of constructBlocks(native)) {
        this.runOne(new Queued(BLOCK, child, native.swf, block), []);
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
      this.priority = pass;
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
  private construct(clip: DisplayObject, face: avm1.Avm1Object, constr: avm1.Avm1Function): void {
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
  private activationOf(d: DisplayObject, pool: Value[] = []): avm1.Activation | null {
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
    this.begin();
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
      this.end();
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
        this.enqueue(INIT, new Queued(BLOCK, clip, swf, block));
      }
    }

    if (actions.stop === "construct") {
      this.enqueue(CONSTRUCT, new Queued(HALT, clip));
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
        this.enqueue(
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
      this.enqueue(NORMAL, new Queued(METHOD, clip, null, 0, 0, unload, name));
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
    this.begin();
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
        this.runQueue();
        // A movie with nothing to tab to leaves Tab to the page.
        used = this.tab(shift);
      } else if (down && !pressed && (keyCode === 13 || typed === 32)) {
        // A press it made keeps the page from acting on the key too: Space would scroll it.
        used = this.activate();
      }

      this.runQueue();
      return used;
    } finally {
      this.end();
    }
  }

  /** Text typed with no key events (avm1/keyboard.ts): a keyPress of its character, as `key` runs one. */
  keyPress(press: number): boolean {
    if (this.halted || !this.loaded || press === 0) {
      return false;
    }

    this.begin();
    try {
      const pressed = this.queueKeyPress(press) || (press === 32 && this.activate());
      this.runQueue();
      return pressed;
    } finally {
      this.end();
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
          for (const h of this.handlersOfButton(swf, id)) {
            if (h.key === press) {
              this.enqueue(NORMAL, new Queued(BLOCK, button.parent, swf, h.block));
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
            this.enqueue(NORMAL, new Queued(BLOCK, d, native.swf, h.block));
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
      this.enqueue(
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

    this.begin();
    try {
      this.notify(this.mouseFace, "onMouseWheel", [delta, target?.avm1 ?? undefined]);
      this.runQueue();
    } finally {
      this.end();
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
    this.begin();
    try {
      this.rt.call(cx, () => {
        value = avm1.get(face, name, this.swfVersion);
      });
    } finally {
      this.end();
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

    this.begin();
    try {
      for (const [d, event] of events) {
        this.buttonDispatch(d, event);
      }

      this.runQueue();
    } finally {
      this.end();
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
      for (const h of this.handlersOfButton(swf, id)) {
        if (h.conditions & condition) {
          this.enqueue(NORMAL, new Queued(BLOCK, parent, swf, h.block));
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

  /** `id`'s condition blocks: a DefineButton's one, or a DefineButton2's, one a BUTTONCONDACTION. */
  private handlersOfButton(swf: Avm1Swf, id: number): readonly ButtonHandler[] {
    if (swf.buttonHandlers === null) {
      const handlers = new Map<number, ButtonHandler[]>();
      for (const [block, { owner }] of (swf.list?.blocks ?? []).entries()) {
        if (owner.type === "button") {
          const list = handlers.get(owner.button) ?? [];
          list.push({ conditions: owner.conditions, key: owner.key, block });
          handlers.set(owner.button, list);
        }
      }

      swf.buttonHandlers = handlers;
    }

    return swf.buttonHandlers.get(id) ?? NO_BUTTON_HANDLERS;
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

    this.begin();
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

      this.runQueue();
    } finally {
      this.end();
    }
  }

  private enqueue(priority: number, q: Queued): void {
    this.queues[priority].push(q);
  }

  /** A DoAction tag a clip's frame reached: its blocks wait for the queue. */
  private queueTag(clip: MovieClip, tag: number): void {
    this.enqueue(
      NORMAL,
      new Queued(FRAME, clip, this.swfOf(clip), tag, this.entries.get(clip) ?? 0),
    );
  }

  /** The next action of priorities `from` to `to`, the most urgent first; null for none. */
  private next(from = INITIALIZE, to = NORMAL): Queued | null {
    for (let p = from; p <= to; p++) {
      const queue = this.queues[p];
      // Gotos that go back and forth queue each other's frames for as long
      // as they run, which is forever in a SWF that never stops them: what
      // has run goes, and so do the clips they removed, so that such a SWF
      // runs into the script timeout without its memory growing.
      if (this.heads[p] >= COMPACT_AT) {
        queue.splice(0, this.heads[p]);
        this.heads[p] = 0;
        this.clips = this.clips.filter((clip) => !this.removed(clip));
      }

      if (this.heads[p] < queue.length) {
        this.taken = p;
        return queue[this.heads[p]++];
      }
    }

    return null;
  }

  /**
   * Run what is queued, by priority, what it queues included: the actions
   * of a clip still on the display list but an unload's; a frame entry's
   * blocks sharing a constant pool, each starting with the one the block
   * before left.
   */
  private runQueue(): void {
    if (!this.loaded || this.running) {
      return;
    }

    this.running = true;
    let pool: avm1.Value[] = [];
    let last: Queued | null = null;
    try {
      for (let q = this.next(); q !== null; q = this.next()) {
        if (this.halted || this.rt.disabled) {
          continue;
        }

        // A goto that queues its own frame again and again loops here, as a jump back does.
        if (--this.realm.budget < 0) {
          this.timeout();
        }

        this.priority = this.taken;
        if (q.kind === FRAME) {
          if (last === null || last.clip !== q.clip || last.entry !== q.entry) {
            pool = [];
          }

          last = q;
          if (!this.gone(q.clip)) {
            pool = this.runOne(q, pool);
          }
        } else {
          this.runOne(q, []);
        }
      }
    } finally {
      this.running = false;
      for (let p = 0; p < this.queues.length; p++) {
        this.queues[p].length = 0;
        this.heads[p] = 0;
      }
    }
  }

  /** The queue's own check of the script timeout, which disables the movie's actions past it. */
  private timeout(): void {
    const cx = this.activationOf(this.root);
    if (cx !== null) {
      this.rt.call(cx, () => this.realm.timeout());
    }
  }

  /**
   * A function of the SWF's returned to code the queue runs: Flash runs
   * what was queued by then of the passes before that code's, a frame
   * action's initializations and constructions, a construction's
   * initializations (adl, and the corpus's register_and_init_order).
   */
  private returned(): void {
    if (!this.running) {
      return;
    }

    const outer = this.priority;
    try {
      for (
        let q = this.next(INITIALIZE, outer - 1);
        q !== null;
        q = this.next(INITIALIZE, outer - 1)
      ) {
        if (!this.halted && !this.rt.disabled) {
          this.priority = this.taken;
          this.runOne(q, []);
        }
      }
    } finally {
      this.priority = outer;
    }
  }

  /**
   * Whether the clip of a queued action is gone: its actions do not run
   * but an unload's. One kept a frame for an unload handler is, where it
   * has clip actions of its own; one without, kept for an onUnload or for
   * a clip in it, runs what it queued before (adl; Ruffle skips them all).
   */
  private gone(d: DisplayObject): boolean {
    if (this.removed(d)) {
      return true;
    }

    const native = nativeOf(d);
    return native?.pending === true && native.handlers !== null;
  }

  /** Run one queued action, from constant pool `pool` for a FRAME; the pool it leaves. */
  private runOne(q: Queued, pool: avm1.Value[]): avm1.Value[] {
    const clip = q.clip;
    if (q.kind !== FRAME && !q.unload && this.gone(clip)) {
      return pool;
    }

    switch (q.kind) {
      case FRAME:
        // A clip a load has filled since runs none of what it queued before.
        if (q.swf !== this.swfOf(clip)) {
          return pool;
        }

        for (const index of q.swf.list?.byTag.get(q.index) ?? NO_BLOCKS) {
          pool = this.run(q.swf, index, pool, clip);
        }

        return pool;
      case BLOCK:
        this.run(q.swf, q.index, [], clip);
        break;
      case CONSTRUCTION:
        this.construction(q);
        break;
      case METHOD: {
        const face = clip.avm1;
        const cx = this.activationOf(clip);
        if (face !== null && cx !== null && !this.removed(clip)) {
          this.rt.callMethod(cx, face, q.name, NO_ARGS, this.swfOf(clip).version);
        }
        break;
      }
      case HALT:
        this.halted = true;
        break;
      case CALL: {
        const cx = this.activationOf(clip);
        if (cx !== null && q.object !== null) {
          this.rt.callMethod(cx, q.object, q.name, q.args, this.swfVersion);
        }
        break;
      }
      case NOTIFY: {
        const cx = this.activationOf(clip);
        const object = q.object;
        if (cx !== null && object !== null) {
          this.rt.call(cx, () => {
            avm1.broadcastMessage(object, q.name, q.args, this.swfVersion, (listener) => {
              const display = listener.display;
              return display instanceof ClipNative && this.removed(display.target);
            });
          });
        }
        break;
      }
    }

    return pool;
  }

  /**
   * A timeline's clip constructed: its registered class's prototype, its
   * construct events, then the class's constructor on it.
   */
  private construction(q: Queued): void {
    const face = q.clip.avm1;
    if (face === null) {
      return;
    }

    const constr = this.classOf(q.clip);
    if (constr !== null) {
      face.define(
        "__proto__",
        avm1.get(constr, "prototype", this.swfOf(q.clip).version),
        avm1.DONT_ENUM | avm1.DONT_DELETE,
      );
    }

    for (const block of q.blocks) {
      this.run(q.swf, block, [], q.clip);
    }

    if (constr !== null) {
      this.construct(q.clip, face, constr);
    }
  }

  /** CallFrame: the actions of `clip`'s frame `frame`, run now in order, each with a pool of its own. */
  private callFrame(clip: MovieClip, frame: number): void {
    const swf = this.swfOf(clip);
    for (const command of clip.timeline.frames[frame - 1] ?? []) {
      if (command.type === "actions") {
        for (const index of swf.list?.byTag.get(command.tag) ?? []) {
          this.run(swf, index, [], clip);
        }
      }
    }
  }

  /**
   * Run `swf`'s block `index` with `clip` as its target, starting from
   * constant pool `pool`; the pool it leaves.
   */
  private run(
    swf: Avm1Swf | null,
    index: number,
    pool: avm1.Value[],
    clip: DisplayObject,
  ): avm1.Value[] {
    const regions = swf?.blocks[index];
    const cx = regions ? this.activationOf(clip, pool) : null;
    if (!regions || cx === null) {
      return pool;
    }

    try {
      this.rt.run(regions, cx);
    } catch (error) {
      if (!(error instanceof avm1.Halt)) {
        this.onUncaught(error);
      }
    }

    return cx.pool;
  }
}

/** A load of loadMovie's or MovieClipLoader's, from when it is asked until it is done with. */
interface MovieLoad {
  /** The clip it fills: the target's, or a level's. */
  target: MovieClip;
  /** The MovieClipLoader whose listeners hear of it; null for loadMovie's. */
  loader: avm1.Avm1Object | null;
  /** Its URL against the SWF's: what it loaded's `_url`. */
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

/** A clip action: the block, the events it runs for, and keyPress's key code. */
export interface Handler {
  events: number;
  key: number;
  block: number;
}

const NO_HANDLERS: Handler[] = [];
const NO_ARGS: Value[] = [];

/** The highest timeline depth scripts place at, 2^31 - 16777220, as Ruffle has it. */
const MAX_DEPTH = 2130706428;
/** The depth from which removeMovieClip removes nothing. */
const MAX_REMOVE_DEPTH = 2130706416;

/** `d`'s AVM1 side, null for one without. */
function nativeOf(d: DisplayObject): ClipNative | null {
  const native = d.avm1?.display;
  return native instanceof ClipNative ? native : null;
}

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
