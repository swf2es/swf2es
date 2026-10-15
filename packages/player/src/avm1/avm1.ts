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
  ClipEvent,
  isAs3,
  type Place,
  readExports,
  type Swf,
  tags,
} from "@swf2es/format";
import { avm1 } from "@swf2es/runtime";
import {
  ButtonObject,
  Container,
  construct,
  type DisplayObject,
  displayFor,
  EMPTY_TIMELINE,
  MovieClip,
  TextObject,
  VideoObject,
} from "../display/display.js";
import type { DisplayCharacter, Library } from "../display/timeline.js";
import { evaluate } from "../scripting/evaluate.js";
import { buttonClass } from "./globals/Button.js";
import { ClipNative, DEPTH_BIAS, type Movie, movieClipClass } from "./globals/MovieClip.js";
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

/** An action waiting its turn in the frame. */
class Queued {
  constructor(
    readonly kind: number,
    readonly clip: DisplayObject,
    readonly index = 0,
    /** Which of the clip's frame entries queued a FRAME: blocks of one share their constant pool. */
    readonly entry = 0,
    /** Whether it is an unload's, which runs for a clip removed since. */
    readonly unload = false,
    readonly name = "",
    readonly blocks: number[] = NO_BLOCKS,
  ) {}
}

const NO_BLOCKS: number[] = [];

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

export class Avm1 implements Movie {
  readonly rt = new avm1.Runtime();
  /** Whether the SWF has stopped for good at what Flash cannot read: nothing plays or runs after. */
  halted = false;
  private blocks: avm1.Blocks = [];
  private list: ActionList | null = null;
  private library: Library | null = null;
  /** By the root's frame, 1 the first. */
  private readonly frames = new Map<number, RootFrame>();
  /** The sprites whose DoInitAction has run. */
  private readonly initialized = new Set<number>();
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
  /** The places of display objects being placed, until they are made. */
  private readonly places = new WeakMap<DisplayObject, Place>();
  /** The clips removed with an unload handler, kept until the next frame. */
  private pending: DisplayObject[] = [];
  /** Exported characters by name in lower case, as attachMovie finds them, and each one's name. */
  private readonly exports = new Map<string, number>();
  private readonly exportNames = new Map<number, string>();
  /** Object.registerClass's classes, by symbol name in the SWF's case. */
  private readonly registered = new Map<string, avm1.Avm1Function>();
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
  readonly mouseX = 0;
  readonly mouseY = 0;
  readonly url: string;

  constructor(
    readonly codegen: Codegen,
    options: Avm1Options = {},
  ) {
    const print = options.print ?? ((line: string) => console.log(line));
    this.onUncaught = options.onUncaught ?? ((error) => console.error(error));
    this.url = options.url ?? "";
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
      root: () => face(this.movieRoot),
      level: (level) => (level === 0 ? face(this.movieRoot) : undefined),
      parent: (object) => {
        const d = display(object);
        return d === undefined || d === this.movieRoot ? undefined : face(d.parent);
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
      returned: () => this.returned(),
    };
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
  attach(swf: Swf, library: Library, root: MovieClip): void {
    this.movieRoot = root;
    this.swfVersion = swf.header.version;
    this.swfLength = swf.header.fileLength;
    this.rate = swf.frameRate;
    if (isAs3(swf) || !library.actions) {
      return;
    }

    root.avm1Root = true;
    this.library = library;
    this.list = library.actions;
    this.readRootFrames(swf, this.list);

    const clip = movieClipClass(this);
    this.clipProto = clip.proto;
    const realm = this.rt.realm;
    realm.global.define("MovieClip", clip.constr, avm1.DONT_ENUM);
    const button = buttonClass(this);
    this.buttonProto = button.proto;
    realm.global.define("Button", button.constr, avm1.DONT_ENUM);
    realm.Object.define(
      "registerClass",
      realm.method((_, args, version) => this.registerClass(args, version)),
      avm1.DONT_ENUM | avm1.DONT_DELETE | avm1.READ_ONLY,
    );
    library.avm1 = {
      placing: (display, place) => this.places.set(display, place),
      made: (display) => this.made(display),
      entered: (clip, frame) => this.entered(clip, frame),
      actions: (clip, tag) => this.queueTag(clip, tag),
      occupied: (depth) => this.host.trace(`Warning: Failed to place object at depth ${depth}.`),
      keeps: (display) => this.keeps(display),
    };
    library.removing = (display) => this.removing(display);
    this.made(root);
  }

  /**
   * Compile the SWF's blocks and load their module, then run what the
   * first frame queued. An ActionScript 3 SWF's blocks are left, as Flash
   * runs none of them.
   */
  async load(swf: Swf): Promise<void> {
    const list = this.list;
    if (list !== null && list.blocks.length > 0) {
      const module = this.codegen.compileActionsModule(swf.bytes, list);
      const { factory } = await evaluate(module, `swf2es-avm1-${++modules}.js`);
      this.blocks = (factory as unknown as avm1.Factory)(this.rt);
    }

    this.loaded = true;
    if (this.halted) {
      return;
    }

    this.frameStart();
    this.begin();

    // The main movie's root gets its load once its first frame's actions
    // have run: an onLoad they set is called (the corpus's root_onload).
    if (this.movieRoot !== null) {
      this.method(this.movieRoot, ClipEvent.load, false);
    }

    this.runQueue();
    this.afterFrame();
    this.end();
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
      return;
    }

    this.begin();
    this.frameStart();
    this.dropPending();
    const clips = this.clips;
    const root = this.root;
    for (let i = clips.length - 1; i >= 0; i--) {
      const clip = clips[i];
      if (clip !== root && !under(clip, root)) {
        continue;
      }

      this.dispatch(clip, ClipEvent.enterFrame);
      clip.advance();
      if (this.halted) {
        this.end();
        return;
      }
    }

    this.clips = clips.filter((clip) => clip === root || under(clip, root));
    this.runQueue();
    this.afterFrame();
    this.end();
  }

  /** Between frames: the timers due by the real clock fire. */
  idle(): void {
    if (this.halted || !this.loaded || this.realm.timers.size === 0) {
      return;
    }

    this.begin();
    this.fireTimers();
    this.end();
  }

  /** Whether `d` is off the display list, no longer a clip scripts reach but by its path. */
  removed(d: DisplayObject): boolean {
    return d !== this.movieRoot && !under(d, this.root);
  }

  faceOf(d: DisplayObject): avm1.Avm1Object | null {
    return d.avm1;
  }

  atPath(path: string): DisplayObject | null {
    return atPath(path, this.root, this.swfVersion > 6);
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

    const id = this.exports.get(asciiLower(name));
    const character = id === undefined ? undefined : this.library?.characters.get(id);
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
    const parent = d === this.movieRoot ? null : d.parent;
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
    const parent = d === this.movieRoot ? null : d.parent;
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
    this.realm.timers.now = this.now();
    this.rt.begin(timeoutClock(), timeoutClock);
  }

  private end(): void {
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
  private readRootFrames(swf: Swf, list: ActionList): void {
    // The root has a frame a ShowFrame tag ends; what follows the last is the last's.
    const last = Math.max(1, swf.tags.filter((t) => t.code === tags.ShowFrame).length);
    const frameOf = (frame: number) => {
      const at = Math.min(frame, last);
      let actions = this.frames.get(at);
      if (!actions) {
        actions = { exports: [], inits: [], stop: null, limits: null };
        this.frames.set(at, actions);
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
    if (d.name === "" && d !== this.movieRoot) {
      d.name = `instance${++this.instances}`;
    }

    // A registered class's prototype comes as it is constructed: its initialize
    // events see MovieClip's (adl; Ruffle gives the class's at once).
    const face = new avm1.Avm1Object(
      clip
        ? this.clipProto
        : d instanceof ButtonObject
          ? this.buttonProto
          : this.rt.realm.objectProto,
    );
    const native = new ClipNative(this, d);
    face.display = native;
    d.avm1 = face;
    if (!clip) {
      return;
    }

    this.clips.push(d);
    const place = this.places.get(d);
    const source = this.handed.get(d);
    if (place !== undefined) {
      this.places.delete(d);
      native.corrupt = place.corrupt;
      native.handlers = this.handlersOf(place);
      this.corruptPlace(d, place.corrupt);
    } else if (source !== undefined) {
      this.handed.delete(d);
      native.corrupt = source.corrupt;
      native.handlers = source.handlers;
    }

    // Its initialize events wait for the queue's first pass, before its children's.
    for (const h of native.handlers ?? NO_HANDLERS) {
      if (h.events & ClipEvent.initialize) {
        this.enqueue(INITIALIZE, new Queued(BLOCK, d, h.block));
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
      this.enqueue(CONSTRUCT, new Queued(CONSTRUCTION, d, 0, 0, false, "", constructs));
    }
  }

  /** Whether `d`'s character has an export name, which a class may be registered by. */
  private exported(d: DisplayObject): boolean {
    const id = d.character?.id;
    return id !== undefined && this.exportNames.has(id);
  }

  /** A place's clip actions, with the events each runs for, as the action list has them. */
  private handlersOf(place: Place): Handler[] | null {
    const list = this.list;
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

  /** The class Object.registerClass bound to `d`'s character's export name, null for none. */
  private classOf(d: DisplayObject): avm1.Avm1Function | null {
    // A sprite's only: a button's symbol stays a Button (the corpus's register_class).
    const id = d instanceof MovieClip ? d.character?.id : undefined;
    const name = id === undefined ? undefined : this.exportNames.get(id);
    return name === undefined ? null : (this.registered.get(this.classKey(name)) ?? null);
  }

  private classKey(name: string): string {
    return this.swfVersion > 6 ? name : avm1.fold(name);
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

    const key = this.classKey(avm1.stringOf(args[0], version));
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

    const version = this.swfVersion;
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
        this.runOne(new Queued(BLOCK, child, block), []);
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

    const version = this.swfVersion;
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
    this.markPaths(d);
    this.unload(d);
  }

  /** Where `d` and what is in it are, the paths their references keep. */
  private markPaths(d: DisplayObject): void {
    const mark = (o: DisplayObject) => {
      const native = o.avm1?.display;
      if (native instanceof ClipNative && native.removedAt === null) {
        native.removedAt = pathOf(o, this.root);
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
    if (this.swfVersion < 5 || nativeOf(d)?.pending || !this.delays(d)) {
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
      if (face !== null && avm1.find(face, "onUnload", this.swfVersion) !== undefined) {
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
        this.library?.sounds?.removed(d);
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

    if (clip !== this.movieRoot) {
      return;
    }

    const actions = this.frames.get(frame);
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
      this.exports.set(asciiLower(name), id);
      this.exportNames.set(id, name);
    }

    for (const { sprite, block } of actions.inits) {
      if (!this.initialized.has(sprite)) {
        this.initialized.add(sprite);
        this.enqueue(INIT, new Queued(BLOCK, clip, block));
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
  private dispatch(clip: MovieClip, event: number): void {
    const native = nativeOf(clip);
    if (this.swfVersion < 5 || native === null) {
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
          new Queued(BLOCK, clip, h.block, 0, unload),
        );
      }
    }

    this.method(clip, event, unload);
  }

  /** From SWF 6, the AS2 method of `event` on `clip`'s object, queued. */
  private method(clip: MovieClip, event: number, unload: boolean): void {
    const name = METHODS.get(event);
    if (this.swfVersion >= 6 && name !== undefined) {
      this.enqueue(NORMAL, new Queued(METHOD, clip, 0, 0, unload, name));
    }
  }

  /**
   * Broadcast a pointer or keyboard event, as the pointer and the keyboard
   * bring them (step 12): every clip's clip actions for it, the newest
   * first, then the queue runs.
   */
  clipEvent(event: number): void {
    if (this.halted || !this.loaded) {
      return;
    }

    this.begin();
    for (let i = this.clips.length - 1; i >= 0; i--) {
      const clip = this.clips[i];
      if (!this.removed(clip)) {
        this.dispatch(clip, event);
      }
    }

    this.runQueue();
    this.end();
  }

  private enqueue(priority: number, q: Queued): void {
    this.queues[priority].push(q);
  }

  /** A DoAction tag a clip's frame reached: its blocks wait for the queue. */
  private queueTag(clip: MovieClip, tag: number): void {
    this.enqueue(NORMAL, new Queued(FRAME, clip, tag, this.entries.get(clip) ?? 0));
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
        for (const index of this.list?.byTag.get(q.index) ?? NO_BLOCKS) {
          pool = this.run(index, pool, clip);
        }

        return pool;
      case BLOCK:
        this.run(q.index, [], clip);
        break;
      case CONSTRUCTION:
        this.construction(q);
        break;
      case METHOD: {
        const face = clip.avm1;
        const cx = this.activationOf(clip);
        if (face !== null && cx !== null && !this.removed(clip)) {
          this.rt.callMethod(cx, face, q.name, NO_ARGS, this.swfVersion);
        }
        break;
      }
      case HALT:
        this.halted = true;
        break;
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
        avm1.get(constr, "prototype", this.swfVersion),
        avm1.DONT_ENUM | avm1.DONT_DELETE,
      );
    }

    for (const block of q.blocks) {
      this.run(block, [], q.clip);
    }

    if (constr !== null) {
      this.construct(q.clip, face, constr);
    }
  }

  /** CallFrame: the actions of `clip`'s frame `frame`, run now in order, each with a pool of its own. */
  private callFrame(clip: MovieClip, frame: number): void {
    for (const command of clip.timeline.frames[frame - 1] ?? []) {
      if (command.type === "actions") {
        for (const index of this.list?.byTag.get(command.tag) ?? []) {
          this.run(index, [], clip);
        }
      }
    }
  }

  /** Run block `index` with `clip` as its target, starting from constant pool `pool`; the pool it leaves. */
  private run(index: number, pool: avm1.Value[], clip: DisplayObject): avm1.Value[] {
    const regions = this.blocks[index];
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
