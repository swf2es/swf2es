// A player's AVM1: a main AVM1 SWF's action blocks compiled to one module
// by codegen, and run as its timelines reach them (docs/avm1.md, "The
// frame"). Each clip, button and text field gets an AS2 face as it is made
// (globals/MovieClip.ts). The clips play in Flash's order, the newest
// first, each queueing the DoAction blocks of the frame it enters in tag
// order, a child placed before them running its first frame first; then
// the queue runs, and a goto in it queues the frames it enters, as Ruffle's
// (https://github.com/ruffle-rs/ruffle) Avm1::run_frame and ActionQueue
// have it (MIT OR Apache-2.0, Copyright (c) 2018-2022 Ruffle LLC and Ruffle
// contributors). A root frame's DoInitAction blocks run before its
// DoAction blocks, each sprite's once. Clip events, buttons and the
// queue's passes for them come with the later steps.
import type { Codegen } from "@swf2es/codegen";
import { type ActionList, ClipEvent, isAs3, readActions, type Swf, tags } from "@swf2es/format";
import { avm1 } from "@swf2es/runtime";
import {
  ButtonObject,
  type DisplayObject,
  MovieClip,
  TextObject,
  VideoObject,
} from "../display/display.js";
import type { Library } from "../display/timeline.js";
import { evaluate } from "../scripting/evaluate.js";
import { ClipNative, type Movie, movieClipClass } from "./globals/MovieClip.js";
import { asciiLower, atPath, childByName, pathOf, under } from "./paths.js";

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
}

/**
 * Where in a frame Flash stops the SWF at a place whose clip actions it
 * cannot read: it reads them as the first of the place's events comes, so
 * as it places the clip for load and initialize, before any of the
 * frame's actions; after the frame's DoInitActions for construct; at the
 * next frame for enterFrame, the frame's actions run. A place of other
 * events stops it as one comes, which the later steps' events do.
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

/** What happens as the root enters a frame, before its DoAction blocks. */
interface RootFrame {
  /** Its DoInitAction blocks, by index, with the sprite each is of. */
  inits: { sprite: number; block: number }[];
  /** Where a place in the frame whose clip actions Flash cannot read stops the SWF. */
  stop: Stop | null;
  /** The frame's last ScriptLimits: its recursion depth and script timeout, in seconds. */
  limits: [number, number] | null;
}

/** Actions waiting their turn in the frame: a DoAction tag's blocks, a DoInitAction's, or the SWF's stop. */
interface Queued {
  clip: MovieClip;
  /** The DoAction tag's body's offset, or for an init the block's index; -1 to stop the SWF. */
  tag: number;
  init: boolean;
  /** Which of the clip's frame entries queued it: blocks of one share their constant pool. */
  entry: number;
}

/** How many queued actions run before those run are dropped from the queue. */
const COMPACT_AT = 4096;

/** Names the scripts of AVM1 modules, as their stack frames show them. */
let modules = 0;

export class Avm1 implements Movie {
  readonly rt = new avm1.Runtime();
  /** Whether the SWF has stopped for good at what Flash cannot read: nothing plays or runs after. */
  halted = false;
  private blocks: avm1.Blocks = [];
  private list: ActionList | null = null;
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
  private readonly queue: Queued[] = [];
  /** How far the queue has run. */
  private next = 0;
  /** Whether the module is loaded: until it is, the first frame's actions wait in the queue. */
  private loaded = false;
  /** Each clip's latest frame entry, which its queued blocks are of. */
  private readonly entries = new WeakMap<MovieClip, number>();
  private entryCount = 0;
  /** What names the next object without a name of its own: instance1, instance2... */
  private instances = 0;
  private movieRoot: MovieClip | null = null;
  private swfVersion = 0;
  private swfLength = 0;
  private readonly host: avm1.Host;
  private readonly onUncaught: (error: unknown) => void;
  private readonly timelines = new WeakMap<MovieClip, avm1.Timeline>();
  private clipProto: avm1.Avm1Object | null = null;

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
    if (isAs3(swf)) {
      return;
    }

    root.avm1Root = true;
    this.list = readActions(swf);
    this.readRootFrames(swf, this.list);

    const clip = movieClipClass(this);
    this.clipProto = clip.proto;
    this.rt.realm.global.define("MovieClip", clip.constr, avm1.DONT_ENUM);
    library.avm1 = {
      made: (display) => this.made(display),
      entered: (clip, frame) => this.entered(clip, frame),
      actions: (clip, tag) => this.queueTag(clip, tag),
      occupied: (depth) => this.host.trace(`Warning: Failed to place object at depth ${depth}.`),
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
    this.frameStart();
    this.runQueue();
  }

  /**
   * The next frame: the clips play, the newest first, those a clip before
   * them took off the display list left out, each queueing the actions of
   * the frame it enters; then the queue runs.
   */
  tick(): void {
    // A clip's enterFrame comes whether the root moved or not.
    if (this.stopNext) {
      this.halted = true;
    }

    if (this.halted) {
      return;
    }

    this.frameStart();
    const clips = this.clips;
    const root = this.root;
    for (let i = clips.length - 1; i >= 0; i--) {
      const clip = clips[i];
      if (clip !== root && !under(clip, root)) {
        continue;
      }

      clip.advance();
      if (this.halted) {
        return;
      }
    }

    this.clips = clips.filter((clip) => clip === root || under(clip, root));
    this.runQueue();
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

  /** The frame's stack empty and its registers undefined, as each frame starts in Flash. */
  private frameStart(): void {
    this.st.length = 0;
    this.rt.realm.registers.fill(undefined);
  }

  /** Each root frame's DoInitAction blocks, the tags Flash cannot read and its ScriptLimits. */
  private readRootFrames(swf: Swf, list: ActionList): void {
    // The root has a frame a ShowFrame tag ends; what follows the last is the last's.
    const last = Math.max(1, swf.tags.filter((t) => t.code === tags.ShowFrame).length);
    const frameOf = (frame: number) => {
      const at = Math.min(frame, last);
      let actions = this.frames.get(at);
      if (!actions) {
        actions = { inits: [], stop: null, limits: null };
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
      } else if (events !== undefined) {
        const actions = frameOf(frame);
        const stop = stopOf(events);
        if (stop && (!actions.stop || STOPS.indexOf(stop) < STOPS.indexOf(actions.stop))) {
          actions.stop = stop;
        }
      }
    }
  }

  /** A display object made alive: its AS2 face, and a clip among those that play. */
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

    // Flash names each clip, button and video without a name of its own as it is made.
    if (d.name === "" && d !== this.movieRoot && !(d instanceof TextObject)) {
      d.name = `instance${++this.instances}`;
    }

    const face = new avm1.Avm1Object(clip ? this.clipProto : this.rt.realm.objectProto);
    face.display = new ClipNative(this, d);
    d.avm1 = face;
    if (clip) {
      this.clips.push(d);
    }
  }

  /** A display object about to leave the display list: where it and what is in it are, the paths their references keep. */
  private removing(d: DisplayObject): void {
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

  /** A clip entered a frame: the root's frames have their inits, limits and stops. */
  private entered(clip: MovieClip, frame: number): void {
    this.entries.set(clip, ++this.entryCount);
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

    for (const { sprite, block } of actions.inits) {
      if (!this.initialized.has(sprite)) {
        this.initialized.add(sprite);
        this.queue.push({ clip, tag: block, init: true, entry: 0 });
      }
    }

    if (actions.stop === "construct") {
      this.queue.push({ clip, tag: -1, init: true, entry: 0 });
    }

    this.stopNext ||= actions.stop === "enterFrame";
  }

  /** A DoAction tag a clip's frame reached: its blocks wait for the queue. */
  private queueTag(clip: MovieClip, tag: number): void {
    this.queue.push({ clip, tag, init: false, entry: this.entries.get(clip) ?? 0 });
  }

  /**
   * Run what is queued, in order, what it queues included: the blocks of a
   * clip still on the display list, those of one frame entry sharing a
   * constant pool, each starting with the one the block before left; an
   * init's pool is its own.
   */
  private runQueue(): void {
    if (!this.loaded) {
      return;
    }

    const queue = this.queue;
    let pool: avm1.Value[] = [];
    let last: Queued | null = null;
    while (this.next < queue.length) {
      // Gotos that go back and forth queue each other's frames for as long
      // as they run, which is forever in a SWF that never stops them: what
      // has run goes, and so do the clips they removed, so that such a
      // SWF hangs as Flash's would, without its memory growing.
      if (this.next >= COMPACT_AT) {
        queue.splice(0, this.next);
        this.next = 0;
        this.clips = this.clips.filter((clip) => !this.removed(clip));
      }

      const q = queue[this.next++];
      if (this.halted || this.rt.disabled) {
        continue;
      }

      if (q.tag < 0) {
        this.halted = true;
        continue;
      }

      if (this.removed(q.clip)) {
        continue;
      }

      if (q.init) {
        this.run(q.tag, [], q.clip);
        continue;
      }

      if (last === null || last.clip !== q.clip || last.entry !== q.entry) {
        pool = [];
      }

      last = q;
      for (const index of this.list?.byTag.get(q.tag) ?? []) {
        pool = this.run(index, pool, q.clip);
      }
    }

    queue.length = 0;
    this.next = 0;
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
  private run(index: number, pool: avm1.Value[], clip: MovieClip): avm1.Value[] {
    const regions = this.blocks[index];
    const face = clip.avm1;
    if (!regions || face === null) {
      return pool;
    }

    const cx = this.rt.activation(this.st, pool, clip, face, this.host);
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
