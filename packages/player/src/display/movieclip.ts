// A MovieClip: a container its timeline's frames place, move and remove
// children in as its playhead plays or jumps.
import { IDENTITY, type Place } from "@swf2es/format";
import type { avm2 } from "@swf2es/runtime";
import { BitmapObject } from "./bitmapobject.js";
import { ButtonObject } from "./buttonobject.js";
import { IDENTITY_COLOR } from "./color.js";
import { Container } from "./container.js";
import { CLIP, CONTENT, type DisplayObject, scriptWork } from "./displayobject.js";
import { construct, displayFor } from "./instantiate.js";
import { cached, ShapeObject, StaleCache } from "./shapeobject.js";
import { StaticTextObject, TextObject } from "./textobjects.js";
import type { Character, DisplayCharacter, Library, ShapeCharacter, Timeline } from "./timeline.js";

const NO_FILTER_BYTES = new Uint8Array([0]);

/**
 * Whether `display` is the kind of object `character` makes, so that a
 * rewind's place may keep it in that place's stead: a shape for a shape or
 * a morph, a clip for a clip, and so on. Not for a character that makes
 * none (data, a font, a sound), which the place leaves as it is.
 */
function madeAs(display: DisplayObject, character: Character | undefined): boolean {
  switch (character?.type) {
    case "shape":
    case "morph":
      return display instanceof ShapeObject;
    case "sprite":
      return display instanceof MovieClip;
    case "button":
      return display instanceof ButtonObject;
    case "bitmap":
      return display instanceof BitmapObject;
    case "text":
      return display instanceof TextObject;
    case "static":
      return display instanceof StaticTextObject;
    default:
      return true;
  }
}

/**
 * Another character placed in a child's stead, with the move flag or where
 * a rewind keeps the child: Flash makes no new object, and only a Shape,
 * MorphShape or StaticText no script has touched takes the new shape's,
 * morph's or text's graphic; a clip, a Shape a script set a property of,
 * and a Shape a sprite is placed over all stay as they are (`replaces`,
 * `static-text-replace`). Flash also gives a Shape a text's glyphs and a
 * StaticText a shape's fills, which the player does not: they stay as
 * they are.
 */
function swap(existing: DisplayObject, character: Character): void {
  if (existing.scripted || existing.character === character) {
    return;
  }

  if (existing instanceof StaticTextObject) {
    if (character.type === "static") {
      existing.show(character);
    }

    return;
  }

  if (!(existing instanceof ShapeObject)) {
    return;
  }

  // Cached as a bitmap, a Shape takes the new shape but Flash goes on
  // showing the bitmap it drew of the old while their bounds are the same
  // (`replaces`, `cache-replace`); other bounds draw it again
  // (`scripted-touch`). A text draws its new glyphs whatever its bounds.
  const old = existing.drawn();
  if (cached(existing) && character.type === "shape" && old && sameBounds(old, character)) {
    existing.stale ??= new StaleCache(old, existing);
  } else {
    existing.stale = null;
  }

  // A morph is blended when it is next drawn, at the ratio the place gives.
  if (character.type === "morph") {
    existing.morph = character;
  } else if (character.type === "shape") {
    existing.morph = null;
    existing.shape = character;
  } else {
    return;
  }

  existing.character = character;
  existing.invalidate(CONTENT);
}

function sameBounds(a: ShapeCharacter, b: ShapeCharacter): boolean {
  const x = a.shape.bounds;
  const y = b.shape.bounds;
  return x.xMin === y.xMin && x.xMax === y.xMax && x.yMin === y.yMin && x.yMax === y.yMax;
}

/** What the frames of a jump do at one depth, folded together. */
interface Jump {
  /** Changes from before any place put a character: they apply to a child that is there, and to nothing else. */
  before: Place | null;
  /** The place that put a character, with what followed folded in; move false for one placed anew. */
  place: Place | null;
  /** The frame of the place that makes the child, if one is made. */
  frame: number;
  /**
   * Whether a place without the move flag put the character: on a rewind,
   * a child the timeline placed after the target at the depth stays then,
   * whatever character it is, if the place gives its ratio, and takes this
   * place (`rewind-first`, `rewind-ratio`).
   */
  placed: boolean;
}

export class MovieClip extends Container {
  /** A clip always has its library: the one its timeline came from. */
  declare library: Library;
  private frame = 0;
  private scripts = new Map<number, avm2.Value>();
  private making = false;
  private placedByTimeline = false;
  private running = true;
  /** Its timeline's stream as it plays, for what plays it (TimelineSounds); null while none does. */
  stream: object | null = null;
  /**
   * Made by a script with `new`, or placed on the first frame of one that
   * was as it was made: Flash has such a clip sit out the next frame's
   * advance, wherever it is by then (`fresh-clips`).
   */
  fresh = false;
  /**
   * The frame whose script last ran, so that entering a frame runs its
   * script once: set to currentFrame alone, as a round's skipping
   * (scriptWork) has it.
   */
  scriptedFrame = 0;
  /** A goto a frame script asked for, taken when the script returns, as Flash defers it; null for none. */
  queuedGoto: number | null = null;
  /** Whether that goto plays or stops the clip, as it happens, not as it is asked for. */
  queuedPlay = false;
  /**
   * The frame count (Scripting.frames) at a script's goto in a SWF of
   * version 9 or earlier, a goto to the frame it is on among them: the next
   * frame it sits out, with all in it, as Flash has such a clip
   * (`goto-children`). A stamp, not a flag: one a skipped parent took along,
   * or a clip no frame reached, is past by the frame after and never skips.
   * From version 10 a goto leaves its frames as they were.
   */
  skipsAfter = -1;
  /** Whether an AVM1 clip ran the actions after its last ShowFrame, which it does once. */
  private tailed = false;

  /** Its frames: its character's, or, once an AVM1 load has filled it, the SWF's root's. */
  timeline: Timeline;

  constructor(timeline: Timeline, library: Library) {
    super();
    this.kind = CLIP;
    this.timeline = timeline;
    this.library = library;
  }

  /**
   * What an AVM1 load puts in it, as Flash keeps the clip and replaces
   * what it shows: `timeline` of `library` in place of its own, its
   * children gone, before its first frame and playing. Telling of what it
   * showed going, its unload, is the caller's.
   */
  replaceTimeline(timeline: Timeline, library: Library): void {
    this.library.sounds?.stopStream(this);
    for (const child of [...this.children]) {
      this.removeChild(child);
    }

    this.depths.clear();
    this.held = [];
    this.timeline = timeline;
    this.library = library;
    this.drawing = null;
    this.currentFrame = 0;
    this.running = true;
    this.tailed = false;
    this.queuedGoto = null;
    this.invalidate(CONTENT);
  }

  /** The frame it shows, 1 the first; 0 before its first frame is entered. */
  get currentFrame(): number {
    return this.frame;
  }

  set currentFrame(frame: number) {
    if (frame !== this.frame) {
      this.frame = frame;
      scriptWork.changes++;
    }
  }

  /** The scripts addFrameScript registered, by frame, 1 the first. */
  get frameScripts(): ReadonlyMap<number, avm2.Value> {
    return this.scripts;
  }

  /** Register `script` for frame `frame`, or, null, take the frame's away. */
  setFrameScript(frame: number, script: avm2.Value | null): void {
    if (script === null || script === undefined) {
      this.scripts.delete(frame);
    } else {
      this.scripts.set(frame, script);
    }

    scriptWork.changes++;
  }

  /** Whether its constructor's super() is making its first frame's children. */
  get makingChildren(): boolean {
    return this.making;
  }

  set makingChildren(making: boolean) {
    if (making !== this.making) {
      this.making = making;
      scriptWork.changes++;
    }
  }

  /** Placed by a timeline, not made by a script with `new`. */
  get timelineChild(): boolean {
    return this.placedByTimeline;
  }

  set timelineChild(placed: boolean) {
    if (placed !== this.placedByTimeline) {
      this.placedByTimeline = placed;
      scriptWork.changes++;
    }
  }

  /** Whether its playhead moves on; stopped, its stream stops, as in Flash and Ruffle. */
  get playing(): boolean {
    return this.running;
  }

  set playing(play: boolean) {
    this.running = play;
    if (!play && this.stream) {
      this.library.sounds?.stopStream(this);
    }
  }

  get totalFrames(): number {
    return this.timeline.frames.length;
  }

  /** The frame's sounds, where it has any and something plays them. */
  private frameSounds(frame: number): void {
    const timeline = this.timeline;
    if ((timeline.stream || timeline.sounds.size > 0) && this.library.sounds) {
      this.library.sounds.frame(this, frame);
    }
  }

  /**
   * First-frame children placed but not yet made alive: placed before the
   * clip's class constructor runs, made by Sprite's constructChildren in its
   * super(), as Flash has a constructor find them (`instantiation_on_enter_frame`).
   */
  private held: { display: DisplayObject; character: DisplayCharacter }[] = [];

  /**
   * Run frame `frame`'s commands as the playhead reaches it: place, move and
   * remove the timeline's children. A place without the move flag at a depth
   * already taken is let be, as Flash lets it (`same-depth`).
   * A new child is made alive at once, or `later`: by the frame's construct
   * phase, after ENTER_FRAME, for a frame played on; by constructChildren,
   * held, for a clip's first frame.
   */
  private runFrame(frame: number, later: "frame" | "held" | null = null): void {
    this.library.avm1?.entered(this, frame);
    for (const command of this.timeline.frames[frame - 1] ?? []) {
      if (command.type === "remove") {
        this.removeAtDepth(command.depth);
        continue;
      }

      if (command.type === "actions") {
        this.library.avm1?.actions(this, command.tag);
        continue;
      }

      const place = command.place;
      const existing = this.depths.get(place.depth);
      if (!place.move && existing) {
        this.library.avm1?.occupied(place.depth);
        continue;
      }

      if (place.move && existing && place.character === null) {
        existing.applyPlace(place);
        continue;
      }

      // A new character, or one that replaces what is at the depth.
      // Data is no display object: Flash places nothing for it.
      const character =
        place.character === null ? null : this.library.characters.get(place.character);
      if (
        !character ||
        character.type === "binary" ||
        character.type === "font" ||
        character.type === "fontCff" ||
        character.type === "sound"
      ) {
        existing?.applyPlace(place);
        continue;
      }

      // With the move flag the child stays, another character or not; and
      // where there is none, the move places nothing (`rewind-first`).
      if (place.move) {
        if (existing) {
          swap(existing, character);
          existing.applyPlace(place);
        }

        continue;
      }

      const child = displayFor(character, this.library, place.hasImage);
      child.applyPlace(place);
      child.placeFrame = frame;
      this.library.avm1?.placing(child, place);
      this.placeAtDepth(child, place.depth);
      if (later === "held" && this.library.construct) {
        this.held.push({ display: child, character });
      } else if (later === "frame" && this.library.constructLater) {
        this.library.constructLater(child, character);
      } else {
        construct(child, character, this.library);
      }
    }

    this.frameSounds(frame);
  }

  /**
   * Jump to frame `frame`, as Flash does rather than by running the frames
   * between: the frames up to it (from the first, for a rewind) are
   * replayed into one jump per depth. On a rewind the children the timeline
   * placed after it go, but one at a depth the frames up to it end on a
   * place without the move flag at, which stays and takes the place; and
   * any child whose ratio is not the one the replayed frames give goes,
   * whenever it was placed. Each jump then changes the child still at its
   * depth, or makes one where the frames placed one anew, or where a
   * rewind ends on another character or ratio. The result is what playing
   * the frames would leave, except that a child placed before the frame and
   * untouched since keeps playing, and its identity; on a rewind a place
   * puts back what it leaves unsaid too, so it looks as it did when first
   * placed. A clip's own loop (`looping`) makes the children it places
   * alive in the frame's construct phase, as playing on does (`loop-ratio`);
   * a script's goto, at once.
   */
  gotoFrame(frame: number, looping = false): void {
    const target = Math.max(1, Math.min(frame, this.totalFrames));
    const from = this.currentFrame;
    const rewind = target < from;

    // A goto past the last frame reads its definitions without queueing its frame actions (adl).
    if (target !== from) {
      this.library.avm1?.skipped(this, rewind ? 1 : from + 1, target - (target === frame ? 1 : 0));
    }

    // A goto stops the stream, and the frame it lands on starts it again
    // if the clip plays, as Ruffle's run_goto has it; one to the frame it is
    // on is nothing to it, as Ruffle's goto_frame_now has it.
    if (this.stream && target !== from) {
      this.library.sounds?.stopStream(this);
    }

    const jumps = new Map<number, Jump>();
    for (let f = (rewind ? 0 : this.currentFrame) + 1; f <= target; f++) {
      for (const command of this.timeline.frames[f - 1] ?? []) {
        if (command.type === "actions") {
          continue;
        }

        if (command.type === "remove") {
          jumps.delete(command.depth);
          // Going forward, a removal between the frames takes effect.
          if (!rewind) {
            this.removeAtDepth(command.depth);
          }

          continue;
        }

        const place = command.place;
        const jump = jumps.get(place.depth) ?? {
          before: null,
          place: null,
          frame: f,
          placed: false,
        };

        // A rewind replays from an empty display list, so what the frames do
        // at a depth nothing has placed yet is known: a change does nothing,
        // and a place in a child's stead places anew.
        if (place.character === null) {
          if (jump.place) {
            jump.place = mergePlace(jump.place, place);
          } else if (!rewind) {
            jump.before = jump.before ? mergePlace(jump.before, place) : place;
          }
        } else if (!place.move && (jump.place || (!rewind && this.depths.has(place.depth)))) {
          // At a depth taken by then, as frame by frame: let be.
          continue;
        } else if (!place.move) {
          // Anew: the child starts from nothing, and from here.
          jump.before = null;
          jump.place = rewind ? asFirstPlaced(place) : place;
          jump.frame = f;
          jump.placed = true;
        } else if (jump.place) {
          jump.place = mergePlace(jump.place, place);
        } else if (!rewind && this.depths.has(place.depth)) {
          jump.place = place;
          jump.frame = f;
        } else {
          // Another character with the move flag where nothing is: as frame
          // by frame, nothing is placed (`rewind-first`).
          continue;
        }

        jumps.set(place.depth, jump);
      }
    }

    // On a rewind, what the timeline placed after the target goes, but where
    // the frames replayed end on a place without the move flag: that child
    // stays and takes the place, as Flash keeps it (`same-depth` at the
    // loop, `rewind-first`), a clip its character and a shape the place's
    // (swap, `morph-shapes`), if it is the kind of object the place makes:
    // a shape where the place makes a clip, or a clip where it makes a
    // shape, goes, and the place makes it anew (`rewind-shape-clip`).
    // Replayed from the first frame, a depth the
    // frames left empty is empty. Whenever it was placed, a child whose
    // ratio is not the one the frames replayed give goes too, to be made
    // anew: authoring tools give each placement a ratio of its own, and
    // Flash takes another ratio for another object, of every kind
    // (`rewind-ratio`, `rewind-kinds`), where Ruffle compares it only for
    // children placed after the target, and for morphs. In render order, as
    // Ruffle removes.
    const kept = new Set<number>();
    if (rewind) {
      const avm1 = this.library.avm1;
      for (const child of [...this.children]) {
        const depth = child.depth;
        if (depth === null) {
          continue;
        }

        // In AVM1, what is at a script's depths stays, a timeline's clip swapped there
        // too, and a script's clip at the timeline's goes (Ruffle's survives_rewind).
        if (avm1) {
          if (depth < 0 || depth >= AVM1_DEPTH_BIAS) {
            continue;
          }

          if (child.placeFrame <= 0) {
            this.removeAtDepth(depth);
            continue;
          }
        } else if (child.placeFrame <= 0) {
          continue;
        }

        const jump = jumps.get(depth);
        const id = jump?.place?.character ?? null;
        if (!jump || (jump.place && jump.place.ratio !== child.ratio)) {
          this.removeAtDepth(depth);
        } else if (
          child.placeFrame > target &&
          jump.placed &&
          madeAs(child, id === null ? undefined : this.library.characters.get(id)) &&
          // An AVM1 clip of another character goes, to be made anew (Ruffle's survives_rewind).
          !(this.library.avm1 && child instanceof MovieClip && child.character?.id !== id)
        ) {
          kept.add(depth);
        } else if (child.placeFrame > target) {
          this.removeAtDepth(depth);
        }
      }
    }

    // On the frame before its children are made: one constructed now sees it there, as in Flash.
    this.currentFrame = target;
    // Every child the jump places is placed before any is made alive, as
    // Flash places a goto's: a constructor finds the others placed, and a
    // button's early frame makes those after it alive before its
    // FRAME_CONSTRUCTED, which a parent's listener reads them in
    // (`goto-place-first`).
    const placed: { display: DisplayObject; character: DisplayCharacter }[] = [];
    for (const [depth, jump] of jumps) {
      const existing = this.depths.get(depth);
      if (existing && kept.has(depth) && jump.place) {
        const id = jump.place.character;
        const character = id === null ? undefined : this.library.characters.get(id);
        if (character) {
          swap(existing, character);
        }

        existing.applyPlace(jump.place);
        continue;
      }

      if (existing && jump.before) {
        existing.applyPlace(jump.before);
      }

      if (!jump.place) {
        continue;
      }

      const character =
        jump.place.character === null ? null : this.library.characters.get(jump.place.character);
      if (
        !character ||
        character.type === "binary" ||
        character.type === "font" ||
        character.type === "fontCff" ||
        character.type === "sound"
      ) {
        existing?.applyPlace(jump.place);
        continue;
      }

      // Forward, the child stays for a place with the move flag, whatever
      // character it names, as frame by frame; on a rewind it stays only
      // for its own character, and another, however the frames between went,
      // makes a new child (the corpus's `place_object_replace_2`). Placed
      // anew it is a new child.
      const same = existing?.character === character;
      if (existing && (rewind ? same : jump.place.move)) {
        swap(existing, character);
        existing.applyPlace(jump.place);
        continue;
      }

      const child = displayFor(character, this.library, jump.place.hasImage);
      child.applyPlace(jump.place);
      child.placeFrame = jump.frame;
      this.library.avm1?.placing(child, jump.place);
      this.placeAtDepth(child, depth);
      if (looping && this.library.constructLater) {
        this.library.constructLater(child, character);
      } else {
        placed.push({ display: child, character });
      }
    }

    if (this.library.constructPlaced) {
      this.library.constructPlaced(placed);
    } else if (this.library.avm1 && target !== from) {
      // As playing would order them: the children placed before the frame
      // run their first frames, then the frame's places and actions in tag
      // order, a place's child its first frame, the actions queued (adl); a
      // frame past the last queues none (Ruffle's run_goto).
      const avm1 = this.library.avm1;
      const made = new Set<DisplayObject>();
      const make = (display: DisplayObject, character: DisplayCharacter) => {
        made.add(display);
        construct(display, character, this.library);
      };
      for (const { display, character } of placed) {
        if (display.placeFrame < target) {
          make(display, character);
        }
      }

      if (target === frame) {
        avm1.entered(this, target);
        for (const command of this.timeline.frames[target - 1] ?? []) {
          if (command.type === "actions") {
            avm1.actions(this, command.tag);
          } else if (command.type === "place") {
            const child = this.depths.get(command.place.depth);
            const at = placed.find((p) => p.display === child);
            if (at && !made.has(at.display)) {
              make(at.display, at.character);
            }
          }
        }
      }

      for (const { display, character } of placed) {
        if (!made.has(display)) {
          make(display, character);
        }
      }
    } else {
      for (const { display, character } of placed) {
        construct(display, character, this.library);
      }
    }

    // The frame it lands on plays its sounds, unless it is the one it was on.
    if (target !== from) {
      this.frameSounds(target);
    }
  }

  /** The first frame, as a clip runs it when it is made, its children placed and made alive; once. */
  enterFirstFrame(): void {
    this.placeFirstFrame();
    // One at a time: a constructor that throws stops here, as its error stops the frame.
    const outer = this.makingChildren;
    this.makingChildren = true;
    try {
      for (let next = this.held.shift(); next; next = this.held.shift()) {
        if (!next.display.object && next.display.parent === this) {
          construct(next.display, next.character, this.library);
        }
      }
    } finally {
      this.makingChildren = outer;
    }
  }

  /** The first frame's children placed, to be made alive by enterFirstFrame; once. */
  placeFirstFrame(): void {
    if (this.currentFrame !== 0) {
      return;
    }

    this.currentFrame = 1;
    this.runFrame(1, "held");
    // What a goto places later, or a script adds, plays on at once: only these sit out with it.
    if (this.fresh) {
      for (const { display } of this.held) {
        if (display instanceof MovieClip) {
          display.fresh = true;
        }
      }
    }
  }

  /**
   * On to the next frame, if it plays and has one. From the last frame it
   * loops to the first as a goto, so what the first frame placed stays.
   */
  advance(): void {
    if (this.fresh) {
      this.fresh = false;
      return;
    }

    // An AVM1 clip on its last frame that does not loop, one of a single
    // frame or without an End tag, stops there, and the DoAction tags
    // after its last ShowFrame run, once (Ruffle's determine_next_frame).
    const avm1 = this.library.avm1;
    if (
      avm1 &&
      this.playing &&
      this.currentFrame >= this.totalFrames &&
      !(this.timeline.loops && this.totalFrames > 1)
    ) {
      this.playing = false;
      for (const command of this.tailed ? [] : (this.timeline.tail ?? [])) {
        if (command.type === "actions") {
          avm1.actions(this, command.tag);
        }
      }

      this.tailed = true;
      return;
    }

    if (!this.playing || this.totalFrames <= 1) {
      // A clip of one frame plays its stream for that frame only, as Ruffle stops it.
      if (this.stream) {
        this.library.sounds?.stopStream(this);
      }

      return;
    }

    if (this.currentFrame >= this.totalFrames) {
      if (this.timeline.loops) {
        this.gotoFrame(1, true);
      }

      return;
    }

    this.currentFrame++;
    this.runFrame(this.currentFrame, "frame");
  }
}

/**
 * A rewind's place with what it leaves unsaid said: the transform, colour,
 * ratio and the rest as a character first placed has them, as Ruffle's
 * goto fills them in. The name and visibility are not among them: they
 * stay as they were.
 */
function asFirstPlaced(place: Place): Place {
  return {
    ...place,
    matrix: place.matrix ?? IDENTITY,
    colorTransform: place.colorTransform ?? IDENTITY_COLOR,
    ratio: place.ratio ?? 0,
    blendMode: place.blendMode ?? 0,
    // An empty FILTERLIST: a rewind clears what the frames after set.
    filters: place.filters ?? NO_FILTER_BYTES,
    cacheAsBitmap: place.cacheAsBitmap ?? false,
  };
}

/** `next` over `previous`: what the later place sets, and the rest as it was. */
function mergePlace(previous: Place, next: Place): Place {
  return {
    ...previous,
    character: next.character ?? previous.character,
    matrix: next.matrix ?? previous.matrix,
    colorTransform: next.colorTransform ?? previous.colorTransform,
    ratio: next.ratio ?? previous.ratio,
    name: next.name ?? previous.name,
    clipDepth: next.clipDepth ?? previous.clipDepth,
    className: next.className ?? previous.className,
    blendMode: next.blendMode ?? previous.blendMode,
    cacheAsBitmap: next.cacheAsBitmap ?? previous.cacheAsBitmap,
    visible: next.visible ?? previous.visible,
    opaqueBackground: next.opaqueBackground ?? previous.opaqueBackground,
    filters: next.filters ?? previous.filters,
    actions: next.actions ?? previous.actions,
  };
}

/** The timeline depth AVM1's depths count from: a script's depths are from it, the timeline's below it. */
const AVM1_DEPTH_BIAS = 16384;

/** A timeline of one empty frame: a clip a script makes. */
export const EMPTY_TIMELINE: Timeline = {
  frames: [[]],
  labels: [],
  gotoLabels: [],
  frameLabels: new Map(),
  scenes: [{ name: "", frame: 1 }],
  sounds: new Map(),
  stream: null,
  loops: true,
};
