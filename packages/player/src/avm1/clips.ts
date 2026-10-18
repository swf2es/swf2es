// The display objects an AVM1 movie's scripts make and take away:
// attachMovie's, createEmptyMovieClip's, createTextField's and
// duplicateMovieClip's, each placed and made at once, constructed as its
// registered class with its init object's properties, and removeMovieClip's
// removal of what is at a depth scripts place at.
// The depths and the order of construction follow Ruffle's
// (https://github.com/ruffle-rs/ruffle) construct_as_avm1_object: MIT OR
// Apache-2.0, Copyright (c) 2018-2022 Ruffle LLC and Ruffle contributors.
import { ClipEvent } from "@swf2es/format";
import { avm1 } from "@swf2es/runtime";
import {
  Container,
  construct,
  type DisplayObject,
  displayFor,
  EMPTY_TIMELINE,
  MovieClip,
  TextObject,
} from "../display/display.js";
import type { DisplayCharacter } from "../display/timeline.js";
import type { Avm1 } from "./avm1.js";
import { ClipNative, DEPTH_BIAS, nativeOf } from "./globals/MovieClip.js";
import { asciiLower } from "./paths.js";
import { BLOCK, CONSTRUCT, NO_ARGS, Queued } from "./queue.js";
import { NO_HANDLERS } from "./swf.js";

/** The highest timeline depth scripts place at, 2^31 - 16777220, as Ruffle has it. */
const MAX_DEPTH = 2130706428;
/** The depth from which removeMovieClip removes nothing. */
const MAX_REMOVE_DEPTH = 2130706416;

/** The blocks of a clip's construct events. */
export function constructBlocks(native: ClipNative): number[] {
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

/** What the movie's scripts place on and take off the display list. */
export class ScriptClips {
  /** The display object a script is making, which it constructs itself; its children are the timeline's. */
  scripted: DisplayObject | null = null;

  constructor(private readonly movie: Avm1) {}

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

    const swf = this.movie.swfOf(parent);
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
    const parent = this.movie.levelOf(d) !== null ? null : d.parent;
    if (!(parent instanceof MovieClip) || this.movie.removed(d) || depth < 0 || depth > MAX_DEPTH) {
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
  readonly handed = new WeakMap<DisplayObject, ClipNative>();

  /**
   * removeMovieClip and RemoveSprite: `d` removed, where it is at a depth
   * scripts place at (a timeline's clip swapped there too), as Flash
   * removes only those.
   */
  remove(d: DisplayObject): void {
    const parent = this.movie.levelOf(d) !== null ? null : d.parent;
    const depth = d.depth;
    if (
      !(parent instanceof Container) ||
      depth === null ||
      depth < DEPTH_BIAS ||
      depth >= MAX_REMOVE_DEPTH ||
      this.movie.removed(d)
    ) {
      return;
    }

    parent.removeAtDepth(depth);
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
        this.movie.made(child);
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

    const version = this.movie.swfOf(child).version;
    const constr = this.movie.classes.classOf(child);
    if (constr !== null) {
      face.define(
        "__proto__",
        avm1.get(constr, "prototype", version),
        avm1.DONT_ENUM | avm1.DONT_DELETE,
      );
    }

    // It is constructed as the queue's constructions are: a function returning in it
    // runs only initializations queued (the corpus's register_and_init_order).
    const pass = this.movie.queue.priority;
    this.movie.queue.priority = CONSTRUCT;
    try {
      // A SWF 6 sets the init object's properties before the construct events, a later one
      // after (adl).
      if (version <= 6) {
        this.initProperties(face, init, version);
      }

      for (const block of constructBlocks(native)) {
        this.movie.queue.runOne(new Queued(BLOCK, child, native.swf, block), []);
      }

      if (version > 6) {
        this.initProperties(face, init, version);
      }

      if (constr !== null) {
        this.construct(child, face, constr);
      }

      // Then its onConstruct, from MovieClip's prototype or its class's, what it
      // throws caught there (adl, and the corpus's movieclip_onconstruct).
      const cx = this.movie.activationOf(child);
      if (cx !== null) {
        this.movie.rt.callMethod(cx, face, "onConstruct", NO_ARGS, version);
      }
    } finally {
      this.movie.queue.priority = pass;
    }

    return child;
  }

  /** An init object's properties set on `face`, in the reverse of for..in's order, as Flash sets them. */
  private initProperties(
    face: avm1.Avm1Object,
    init: avm1.Avm1Object | null,
    version: number,
  ): void {
    const cx = init === null ? null : this.movie.activationOf(this.movie.root);
    if (init === null || cx === null) {
      return;
    }

    this.movie.rt.call(cx, () => {
      const names = avm1.keys(init, version);
      for (let i = names.length - 1; i >= 0; i--) {
        avm1.set(face, names[i], avm1.get(init, names[i], version), version);
      }
    });
  }

  /** `constr` run on the clip's object as its constructor, as `new` runs one. */
  construct(clip: DisplayObject, face: avm1.Avm1Object, constr: avm1.Avm1Function): void {
    const cx = this.movie.activationOf(clip);
    if (cx === null) {
      return;
    }

    const version = this.movie.swfOf(clip).version;
    face.define("__constructor__", constr, avm1.DONT_ENUM);
    if (version < 7) {
      face.define("constructor", constr, avm1.DONT_ENUM);
    }

    this.movie.rt.call(cx, () => {
      constr.callConstructor(face, NO_ARGS, version, 1);
    });
  }
}
