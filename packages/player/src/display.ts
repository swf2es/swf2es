// The display list the player owns: display objects, containers and
// movie clips, as Flash has them. A renderer mirrors it (see pixi.ts) and
// never decides its order. A container keeps its children in render order,
// which is their index in AS3, and apart from it the children the timeline
// placed, by depth, which is how SWF tags address them; a child the
// timeline places goes before the first child of a greater depth.
import { type ColorTransform, IDENTITY, type Matrix, type Place } from "@swf2es/format";
import type { Character, Library, ShapeCharacter, Timeline } from "./timeline.js";

/** Nothing changed since the renderer last looked, or what did. */
export const CLEAN = 0;
export const TRANSFORM = 1;
export const CHILDREN = 2;
export const CONTENT = 4;

export class DisplayObject {
  parent: Container | null = null;
  /** The timeline depth it was placed at, or null for one a script added. */
  depth: number | null = null;
  name = "";
  /** Its transform in its parent, translation in pixels. */
  matrix: Matrix = { ...IDENTITY };
  colorTransform: ColorTransform | null = null;
  visible = true;
  /** The character it was made from, or null. */
  character: Character | null = null;
  /** What changed since the renderer last synced it: TRANSFORM, CHILDREN, CONTENT. */
  dirty = TRANSFORM | CONTENT;

  /** Mark a change, and that its ancestors have a changed descendant. */
  invalidate(what: number): void {
    this.dirty |= what;
    for (let p = this.parent; p && !p.descendantsDirty; p = p.parent) {
      p.descendantsDirty = true;
    }
  }

  /** Apply a place's transform, colour, name and visibility. */
  applyPlace(place: Place): void {
    if (place.matrix) {
      const m = place.matrix;
      this.matrix = { a: m.a, b: m.b, c: m.c, d: m.d, tx: m.tx / 20, ty: m.ty / 20 };
      this.invalidate(TRANSFORM);
    }

    if (place.colorTransform) {
      this.colorTransform = place.colorTransform;
      this.invalidate(TRANSFORM);
    }

    if (place.name !== null) {
      this.name = place.name;
    }

    if (place.visible !== null) {
      this.visible = place.visible;
      this.invalidate(TRANSFORM);
    }
  }
}

export class ShapeObject extends DisplayObject {
  constructor(readonly shape: ShapeCharacter) {
    super();
    this.character = shape;
  }
}

export class Container extends DisplayObject {
  /** Its children in render order: index 0 is drawn first, below the rest. */
  readonly children: DisplayObject[] = [];
  /** The children the timeline placed, by depth. */
  readonly depths = new Map<number, DisplayObject>();
  /** Whether a descendant changed since the renderer last synced. */
  descendantsDirty = true;

  /** Place `child` at timeline depth `depth`: before the first child of a greater depth. */
  placeAtDepth(child: DisplayObject, depth: number): void {
    this.removeAtDepth(depth);
    let index = this.children.length;
    for (let i = 0; i < this.children.length; i++) {
      const d = this.children[i].depth;
      if (d !== null && d > depth) {
        index = i;
        break;
      }
    }

    child.depth = depth;
    child.parent = this;
    this.children.splice(index, 0, child);
    this.depths.set(depth, child);
    this.invalidate(CHILDREN);
  }

  removeAtDepth(depth: number): DisplayObject | null {
    const child = this.depths.get(depth);
    if (!child) {
      return null;
    }

    this.depths.delete(depth);
    this.children.splice(this.children.indexOf(child), 1);
    child.parent = null;
    this.invalidate(CHILDREN);
    return child;
  }
}

export class MovieClip extends Container {
  /** The frame it shows, 1 the first. */
  currentFrame = 0;
  playing = true;

  constructor(
    readonly timeline: Timeline,
    readonly library: Library,
  ) {
    super();
  }

  get totalFrames(): number {
    return this.timeline.frames.length;
  }

  /** Run frame `frame`'s commands: place, move and remove the timeline's children. */
  private runFrame(frame: number): void {
    for (const command of this.timeline.frames[frame - 1] ?? []) {
      if (command.type === "remove") {
        this.removeAtDepth(command.depth);
        continue;
      }

      const place = command.place;
      const existing = this.depths.get(place.depth);
      if (place.move && existing && place.character === null) {
        existing.applyPlace(place);
        continue;
      }

      // A new character, or one that replaces what is at the depth.
      const character =
        place.character === null ? null : this.library.characters.get(place.character);
      if (!character) {
        existing?.applyPlace(place);
        continue;
      }

      if (place.move && existing?.character === character) {
        existing.applyPlace(place);
        continue;
      }

      const child = instantiate(character, this.library);
      // A replaced character keeps what the place does not set.
      if (place.move && existing) {
        child.matrix = existing.matrix;
        child.colorTransform = existing.colorTransform;
        child.name = existing.name;
      }

      child.applyPlace(place);
      this.placeAtDepth(child, place.depth);
    }
  }

  /** The first frame, as a clip runs it when it is made. */
  enterFirstFrame(): void {
    this.currentFrame = 1;
    this.runFrame(1);
  }

  /**
   * On to the next frame, if it plays and has one. From the last back to the
   * first, the timeline's children are made again from the first frame's
   * commands, as a rewind in Flash puts back the first frame's state.
   */
  advance(): void {
    if (!this.playing || this.totalFrames <= 1) {
      return;
    }

    if (this.currentFrame >= this.totalFrames) {
      for (const depth of [...this.depths.keys()]) {
        this.removeAtDepth(depth);
      }

      this.currentFrame = 1;
      this.runFrame(1);
      return;
    }

    this.currentFrame++;
    this.runFrame(this.currentFrame);
  }
}

/** A display object for a character: a shape, or a clip on its first frame. */
export function instantiate(character: Character, library: Library): DisplayObject {
  if (character.type === "shape") {
    return new ShapeObject(character);
  }

  const clip = new MovieClip(character.timeline, library);
  clip.character = character;
  clip.enterFirstFrame();
  return clip;
}
