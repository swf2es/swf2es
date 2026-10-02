// The display list the player owns: display objects, containers and
// movie clips, as Flash has them. A renderer mirrors it (see pixi.ts) and
// never decides its order. A container keeps its children in render order,
// which is their index in AS3, and apart from it the children the timeline
// placed, by depth, which is how SWF tags address them; a child the
// timeline places goes before the first child of a greater depth.
import {
  type ColorTransform,
  IDENTITY,
  type Matrix,
  type Place,
  readFilters,
} from "@swf2es/format";
import type { avm2 } from "@swf2es/runtime";
import { BitmapStore } from "./bitmap.js";
import type { Drawing } from "./drawing.js";
import { type Filter, filterOfSwf } from "./filters.js";
import type { FontSet } from "./fonts.js";
import { type Rect, shifted } from "./geometry.js";
import { TextModel } from "./text.js";
import { GUTTER, layoutText, type TextLayout } from "./text-layout.js";
import {
  type BitmapCharacter,
  type Character,
  type DisplayCharacter,
  INVALID_PIXELS,
  type Library,
  type ShapeCharacter,
  type TextCharacter,
  type Timeline,
} from "./timeline.js";

/** Nothing changed since the renderer last looked, or what did. */
export const CLEAN = 0;
export const TRANSFORM = 1;
export const CHILDREN = 2;
export const CONTENT = 4;
/** A Bitmap's pixels changed in place: the texture uploads again, nothing is rebuilt. */
export const PIXELS = 8;

const NO_FILTERS: readonly Filter[] = Object.freeze([]);
const NO_FILTER_BYTES = new Uint8Array([0]);

/** The blend modes by the number PlaceObject3 gives them: 0 and 1 are normal. */
export const BLEND_MODES = [
  "normal",
  "normal",
  "layer",
  "multiply",
  "screen",
  "lighten",
  "darken",
  "difference",
  "add",
  "subtract",
  "invert",
  "alpha",
  "erase",
  "overlay",
  "hardlight",
];

/** Display objects are numbered as they are made: Flash runs orphans' scripts newest first. */
let made = 0;

const DEGREES = 180 / Math.PI;

/** A matrix column of scale `from` stretched to scale `to`; zeroed for a NaN, and null where there is no proportion to keep. */
function scaled(to: number, from: number, x: number, y: number): [number, number] | null {
  if (Number.isNaN(to)) {
    return [0, 0];
  }

  const f = to / from;
  return Number.isFinite(f) ? [x * f, y * f] : null;
}

/** The sine and cosine of `degrees`, exact at the quarter turns, where Flash's matrix has 0s and 1s and not the doubles' rounding (`replaces`). */
function sinCos(degrees: number): [number, number] {
  const quarters = degrees / 90;
  if (Number.isInteger(quarters)) {
    const k = ((quarters % 4) + 4) % 4;
    return [[0, 1, 0, -1][k], [1, 0, -1, 0][k]];
  }

  const r = degrees / DEGREES;
  return [Math.sin(r), Math.cos(r)];
}

/** Degrees into Flash's range, -180 to 180 with both ends kept as given; a NaN stays NaN. */
export function normalizeDegrees(degrees: number): number {
  let d = degrees % 360;
  if (d > 180) {
    d -= 360;
  } else if (d < -180) {
    d += 360;
  }

  return d;
}

export class DisplayObject {
  readonly serial = made++;
  parent: Container | null = null;
  /** The timeline depth it was placed at, or null for one a script added. */
  depth: number | null = null;
  /** The frame of its parent's timeline that placed it, 1 the first; 0 for one a script added. */
  placeFrame = 0;
  name = "";
  /**
   * Its transform in its parent, translation in pixels: made from the
   * scales, rotation and skew below, which are the object's own, as Flash
   * keeps them apart from the matrix; set whole, it is taken apart into them.
   */
  matrix: Matrix = { ...IDENTITY };
  scaleX = 1;
  scaleY = 1;
  /** In degrees, -180 to 180, as Flash reports it. */
  rotation = 0;
  /** The second column's turn beyond the first's, in degrees: 0 but for a matrix that skews. */
  skew = 0;
  colorTransform: ColorTransform | null = null;
  visible = true;
  /** The character it was made from, or null. */
  character: Character | null = null;
  /** Whether a script set a property of it; from then on the timeline swaps no shape under it, as Flash's does not. */
  scripted = false;
  /** Its other face, the AS3 object a script sees; null in an AVM1 movie. */
  object: avm2.AsObject | null = null;
  /** The LoaderInfo of the SWF this is the root of: set on the main root and on each loaded SWF's; null below. */
  loaderInfo: avm2.AsObject | null = null;
  /** What its Graphics drew, for a Shape or Sprite a script draws in; null until one does. */
  drawing: Drawing | null = null;
  /** What changed since the renderer last synced it: TRANSFORM, CHILDREN, CONTENT. */
  dirty = TRANSFORM | CONTENT;

  /** This object, weakly, as a store it shows or fills with holds it. */
  readonly ref = new WeakRef(this);
  /**
   * The last depth this clips, as a timeline's mask, or 0: a mask is not
   * drawn, and clips the children after it until one placed deeper.
   */
  clipDepth = 0;
  /** The object `mask` set clips this one to; and the one it clips, for such a mask. */
  mask: DisplayObject | null = null;
  maskOf: DisplayObject | null = null;
  /**
   * scrollRect as set, its edges whole pixels, and as the last render took
   * it, which the drawing, bounds and points go by: Flash's takes effect
   * when it next draws.
   */
  scrollRect: Rect | null = null;
  scroll: Rect | null = null;
  /** Its blend mode, as BlendMode names it. */
  blendMode = "normal";
  /** Its filters' values, which its `filters` reads copies of. */
  filters: readonly Filter[] = NO_FILTERS;

  /** A store it shows or fills with changed its pixels, or was disposed. */
  pixelsChanged(disposed: boolean): void {
    this.invalidate(disposed ? CONTENT : PIXELS);
  }

  /** Mark a change, and that its ancestors have a changed descendant. */
  invalidate(what: number): void {
    this.dirty |= what;
    for (let p = this.parent; p && !p.descendantsDirty; p = p.parent) {
      p.descendantsDirty = true;
    }
  }

  /** Its matrix after its scroll's shift: from what it draws to its parent's space. */
  get placed(): Matrix {
    return this.scroll ? shifted(this.matrix, this.scroll) : this.matrix;
  }

  /** Whether `o` is this or under it. */
  encloses(o: DisplayObject): boolean {
    for (let p: DisplayObject | null = o; p; p = p.parent) {
      if (p === this) {
        return true;
      }
    }

    return false;
  }

  /**
   * Clip this to `mask`'s fills, or to nothing for null. A mask clips one
   * object: set on another it leaves the one before, as Flash's does.
   */
  setMask(mask: DisplayObject | null): void {
    if (this.mask === mask) {
      return;
    }

    if (this.mask) {
      this.mask.maskOf = null;
      this.mask.invalidate(TRANSFORM);
    }

    if (mask?.maskOf) {
      mask.maskOf.mask = null;
      mask.maskOf.invalidate(TRANSFORM);
    }

    this.mask = mask;
    if (mask) {
      mask.maskOf = this;
      mask.invalidate(TRANSFORM);
    }

    this.invalidate(TRANSFORM);
  }

  /**
   * The matrix set whole, and taken apart: the scales are its columns'
   * lengths, the rotation the first column's angle, the skew the second's
   * beyond that. A negative scale set as such is not recovered: a half
   * turn is what the matrix says.
   */
  setMatrix(m: Matrix): void {
    this.matrix = { ...m };
    this.scaleX = Math.hypot(m.a, m.b);
    this.scaleY = Math.hypot(m.c, m.d);
    this.rotation = Math.atan2(m.b, m.a) * DEGREES;
    this.skew = normalizeDegrees(Math.atan2(-m.c, m.d) * DEGREES - this.rotation);
    this.invalidate(TRANSFORM);
  }

  /**
   * A scale set stretches its column of the matrix in proportion, so the
   * other column stays exactly as it was, as Flash's does (the corpus's
   * `displayobject_invalid_floats`); from a scale of 0 or NaN, where there
   * is no proportion, the column is made anew from the angles. A NaN is
   * reported back as set, as Flash reports it: a NaN scale zeroes its
   * column, a NaN rotation leaves the matrix as it was and counts as none
   * from then on.
   */
  setScaleX(v: number): void {
    const column = scaled(v, this.scaleX, this.matrix.a, this.matrix.b);
    this.scaleX = v;
    if (column) {
      this.matrix = { ...this.matrix, a: column[0], b: column[1] };
      this.invalidate(TRANSFORM);
    } else {
      this.remake();
    }
  }

  setScaleY(v: number): void {
    const column = scaled(v, this.scaleY, this.matrix.c, this.matrix.d);
    this.scaleY = v;
    if (column) {
      this.matrix = { ...this.matrix, c: column[0], d: column[1] };
      this.invalidate(TRANSFORM);
    } else {
      this.remake();
    }
  }

  setRotation(degrees: number): void {
    this.rotation = normalizeDegrees(degrees);
    if (!Number.isNaN(degrees)) {
      this.remake();
    }
  }

  private remake(): void {
    const [sinR, cosR] = sinCos(this.rotation || 0);
    const [sinQ, cosQ] = sinCos((this.rotation || 0) + this.skew);
    this.matrix = {
      a: (this.scaleX || 0) * cosR,
      b: (this.scaleX || 0) * sinR,
      c: -(this.scaleY || 0) * sinQ,
      d: (this.scaleY || 0) * cosQ,
      tx: this.matrix.tx,
      ty: this.matrix.ty,
    };
    this.invalidate(TRANSFORM);
  }

  /** Apply a place's transform, colour, name and visibility. */
  applyPlace(place: Place): void {
    if (place.matrix) {
      const m = place.matrix;
      this.setMatrix({ a: m.a, b: m.b, c: m.c, d: m.d, tx: m.tx / 20, ty: m.ty / 20 });
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

    // Apart, and once tested: applyPlace runs for each move of each frame, and grown it is no longer inlined.
    if (place.clipDepth !== null || place.blendMode !== null || place.filters !== null) {
      this.applyRare(place);
    }
  }

  /** What a place sets that few do: a clip depth, a blend mode, filters. */
  private applyRare(place: Place): void {
    if (place.filters !== null) {
      this.filters = readFilters(place.filters).map(filterOfSwf);
      this.invalidate(TRANSFORM);
    }

    if (place.clipDepth !== null && place.clipDepth !== this.clipDepth) {
      this.clipDepth = place.clipDepth;
      this.invalidate(TRANSFORM);
      this.parent?.invalidate(CHILDREN);
    }

    if (place.blendMode !== null) {
      this.setBlendMode(BLEND_MODES[place.blendMode] ?? "normal");
    }
  }

  /** How it is composited with what is below it (BLEND_MODES). */
  setBlendMode(mode: string): void {
    if (mode !== this.blendMode) {
      this.blendMode = mode;
      this.invalidate(TRANSFORM);
    }
  }
}

export class ShapeObject extends DisplayObject {
  /** The shape it draws; null for a Shape a script made, which draws nothing yet. */
  shape: ShapeCharacter | null;

  constructor(shape: ShapeCharacter | null) {
    super();
    this.shape = shape;
    this.character = shape;
  }
}

/**
 * A TextField: placed by DefineEditText, or made by a script. Its text and
 * formats are a TextModel; a timeline's starts with its tag's text, read
 * as HTML if the tag says so, in the format the tag gives.
 */
export class TextObject extends DisplayObject {
  readonly model = new TextModel();
  /** The embedded fonts its text may be in: its SWF's. */
  fonts: FontSet | null = null;
  private laid: { key: string; layout: TextLayout } | null = null;
  /** The field's rectangle, in its own pixels: from (left, top), width by height. */
  left = 0;
  top = 0;
  width = 100;
  height = 100;
  border = false;
  borderColor = 0;
  background = false;
  backgroundColor = 0xffffff;
  multiline = false;
  wordWrap = false;
  type = "dynamic";
  embedFonts = false;
  autoSize = "none";
  selectable = true;
  maxChars = 0;
  displayAsPassword = false;
  condenseWhite = false;
  antiAliasType = "normal";
  gridFitType = "pixel";
  sharpness = 0;
  thickness = 0;
  restrict: string | null = null;
  mouseWheelEnabled = true;
  alwaysShowSelection = false;
  useRichTextClipboard = false;
  scrollH = 0;
  scrollV = 1;

  constructor(
    readonly definition: TextCharacter | null,
    initialText = true,
  ) {
    super();
    this.character = definition;
    const edit = definition?.definition;
    if (!edit) {
      return;
    }

    this.left = edit.bounds.xMin / 20;
    this.top = edit.bounds.yMin / 20;
    this.width = (edit.bounds.xMax - edit.bounds.xMin) / 20;
    this.height = (edit.bounds.yMax - edit.bounds.yMin) / 20;
    this.multiline = edit.multiline;
    this.wordWrap = edit.wordWrap;
    this.type = edit.readOnly ? "dynamic" : "input";
    this.displayAsPassword = edit.password;
    this.autoSize = edit.autoSize ? "left" : "none";
    this.selectable = edit.selectable;
    // A border in the tag is Flash's border and white background together.
    this.border = edit.border;
    this.background = edit.border;
    this.maxChars = edit.maxLength ?? 0;
    this.embedFonts = edit.useOutlines;
    const font = definition?.font;
    const color = edit.color;
    this.model.defaultFormat = {
      ...this.model.defaultFormat,
      font: font?.name ?? edit.fontClass ?? this.model.defaultFormat.font,
      bold: font?.bold ?? false,
      italic: font?.italic ?? false,
      size: edit.fontHeight === null ? 12 : edit.fontHeight / 20,
      // RGBA as the tag stores it.
      color:
        color === null ? 0 : ((color & 0xff) << 16) | (color & 0xff00) | ((color >>> 16) & 0xff),
      align: ["left", "right", "center", "justify"][edit.align] ?? "left",
      leftMargin: edit.leftMargin / 20,
      rightMargin: edit.rightMargin / 20,
      indent: edit.indent / 20,
      leading: edit.leading / 20,
    };
    if (!initialText) {
      this.model.setText("");
    } else if (edit.html) {
      this.model.setHtml(edit.text, edit.multiline);
    } else {
      this.model.setText(edit.text);
    }
  }

  /** Its text laid out, as of now: made again only when the text, its formats or the field changed. */
  get layout(): TextLayout {
    const key = `${this.model.revision}|${this.width}|${this.wordWrap}|${this.embedFonts}|${this.displayAsPassword}`;
    if (this.laid?.key !== key) {
      const text = this.model.text;
      this.laid = {
        key,
        layout: layoutText({
          // A password's characters are laid out, and drawn, as asterisks; its lines stay.
          text: this.displayAsPassword ? text.replace(/[^\r]/g, "*") : text,
          formats: this.model.formats,
          defaultFormat: this.model.defaultFormat,
          width: this.width,
          wordWrap: this.wordWrap,
          embedFonts: this.embedFonts,
          fonts: this.fonts,
        }),
      };
    }

    return this.laid.layout;
  }

  /**
   * Fit the field to its text, as autoSize does: its height to the text's
   * and the gutters, and its width too unless it wraps, keeping its left,
   * centre or right edge where it was.
   */
  fit(): void {
    if (this.autoSize === "none") {
      return;
    }

    const layout = this.layout;
    const height = (layout.height + 2 * GUTTER) / 20;
    if (!this.wordWrap) {
      const width = (layout.width + 2 * GUTTER) / 20;
      const moved =
        this.autoSize === "center"
          ? (this.width - width) / 2
          : this.autoSize === "right"
            ? this.width - width
            : 0;
      if (moved !== 0) {
        this.matrix = { ...this.matrix, tx: Math.round((this.matrix.tx + moved) * 20) / 20 };
        this.invalidate(TRANSFORM);
      }

      this.width = width;
    }

    this.height = height;
    this.invalidate(CONTENT);
  }

  /** The text, \r between its lines. */
  get text(): string {
    return this.model.text;
  }

  /** The alignment of its first paragraph. */
  get align(): string {
    return (this.model.formats[0] ?? this.model.defaultFormat).align;
  }
}

/**
 * Another character placed in a child's stead, with the move flag: Flash
 * makes no new object, and only a Shape no script has touched takes the
 * new shape's graphic; a clip, a Shape a script set a property of, and a
 * Shape a sprite is placed over all stay as they are (`replaces`).
 */
function swap(existing: DisplayObject, character: Character): void {
  if (
    existing instanceof ShapeObject &&
    character.type === "shape" &&
    !existing.scripted &&
    existing.shape !== character
  ) {
    existing.shape = character;
    existing.character = character;
    existing.invalidate(CONTENT);
  }
}

/** A Bitmap: a display object that shows a BitmapData's pixels, its bounds the data's size. */
export class BitmapObject extends DisplayObject {
  private shown: BitmapStore | null = null;
  smoothing = false;
  pixelSnapping = "auto";
  /** The SWF's bitmap it shows a copy of, placed by a timeline or made by its class; null for one a script made. */
  character: BitmapCharacter | null = null;
  /** PlaceObject3's HasImage where a timeline placed it: Flash then takes a bound class for its data's. */
  hasImage = false;

  constructor(store: BitmapStore | null) {
    super();
    this.store = store;
  }

  /** The store shown; the object watches it, so a pixel set marks the object for the renderer. */
  get store(): BitmapStore | null {
    return this.shown;
  }

  set store(store: BitmapStore | null) {
    this.shown?.views.delete(this.ref);
    this.shown = store;
    store?.views.add(this.ref);
    this.invalidate(CONTENT);
  }
}

export class Container extends DisplayObject {
  /** The library whose timeline this is, for what it tells of children going; a script's container has none. */
  library: Library | null = null;
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

    // The timeline's removal: a script's goes through the natives, which tell of it themselves.
    this.library?.removing?.(child, true);
    this.removeChild(child);
    return child;
  }

  /** Take `child` out, wherever it is in the list, and off the timeline's depths. */
  removeChild(child: DisplayObject): void {
    if (child.depth !== null) {
      this.depths.delete(child.depth);
      child.depth = null;
    }

    this.children.splice(this.children.indexOf(child), 1);
    child.parent = null;
    this.invalidate(CHILDREN);
  }

  /**
   * Put `child` at `index` in render order, as a script's addChildAt does:
   * out of its parent first, and off the timeline's depths, which no
   * longer place it.
   */
  addChildAt(child: DisplayObject, index: number): void {
    const same = child.parent === this;
    child.parent?.removeChild(child);
    child.parent = this;
    this.children.splice(same ? Math.min(index, this.children.length) : index, 0, child);
    this.invalidate(CHILDREN);
  }

  swapChildren(a: DisplayObject, b: DisplayObject): void {
    const i = this.children.indexOf(a);
    const j = this.children.indexOf(b);
    this.children[i] = b;
    this.children[j] = a;
    this.invalidate(CHILDREN);
  }
}

/**
 * A walk of a container's children in render order, for the timeline
 * masks that clip each: a mask clips the children after it until one
 * placed deeper than its clip depth; one a script put among them has no
 * depth and ends nothing. A class, not a generator: the renderer walks
 * every child each time a container's children change.
 */
export class Clips {
  /** The masks open, outermost first. */
  readonly masks: DisplayObject[] = [];

  /** The next child: how many of `masks`, from the first, clip it; it clips those after it, if a mask. */
  enter(child: DisplayObject): number {
    const depth = child.depth;
    const masks = this.masks;
    while (depth !== null && masks.length > 0 && masks[masks.length - 1].clipDepth < depth) {
      masks.pop();
    }

    const n = masks.length;
    if (child.clipDepth > 0) {
      masks.push(child);
    }

    return n;
  }
}

/** What the frames of a jump do at one depth, folded together. */
interface Jump {
  /** Changes from before any place put a character: they apply to a child that is there, and to nothing else. */
  before: Place | null;
  /** The place that put a character, with what followed folded in; move false for one placed anew. */
  place: Place | null;
  /** The frame of the place that makes the child, if one is made. */
  frame: number;
}

export class MovieClip extends Container {
  /** A clip always has its library: the one its timeline came from. */
  declare library: Library;
  /** The frame it shows, 1 the first; 0 before its first frame is entered. */
  currentFrame = 0;
  playing = true;
  /** Made by a script with `new`: Flash has such a clip sit out the next frame's advance. */
  fresh = false;
  /** The scripts addFrameScript registered, by frame, 1 the first. */
  readonly frameScripts = new Map<number, avm2.Value>();
  /** The frame whose script last ran, so that entering a frame runs its script once. */
  scriptedFrame = 0;
  /** A goto a frame script asked for, taken when the script returns, as Flash defers it; null for none. */
  queuedGoto: number | null = null;

  constructor(
    readonly timeline: Timeline,
    library: Library,
  ) {
    super();
    this.library = library;
  }

  get totalFrames(): number {
    return this.timeline.frames.length;
  }

  /**
   * Run frame `frame`'s commands as the playhead reaches it: place, move and
   * remove the timeline's children. A place without the move flag makes a
   * new child even where the same character is at the depth; a goto does not.
   */
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
      // Data is no display object: Flash places nothing for it.
      const character =
        place.character === null ? null : this.library.characters.get(place.character);
      if (!character || character.type === "binary" || character.type === "font") {
        existing?.applyPlace(place);
        continue;
      }

      // With the move flag the child stays, another character or not.
      if (place.move && existing) {
        swap(existing, character);
        existing.applyPlace(place);
        continue;
      }

      const child = displayFor(character, this.library, place.hasImage);
      child.applyPlace(place);
      child.placeFrame = frame;
      this.placeAtDepth(child, place.depth);
      construct(child, character, this.library);
    }
  }

  /**
   * Jump to frame `frame`, as Flash does rather than by running the frames
   * between: the children the timeline placed after it go, the frames up to
   * it (from the first, for a rewind) are replayed into one jump per depth,
   * and each jump changes the child still at its depth, or makes one where
   * the frames placed one anew, or where a rewind ends on another
   * character. The result is what playing the frames would
   * leave, except that a child placed before the frame and untouched since
   * keeps playing, and its identity; on a rewind a place puts back what it
   * leaves unsaid too, so it looks as it did when first placed.
   */
  gotoFrame(frame: number): void {
    const target = Math.max(1, Math.min(frame, this.totalFrames));
    const rewind = target < this.currentFrame;
    if (rewind) {
      for (const child of [...this.depths.values()]) {
        if (child.placeFrame > target && child.depth !== null) {
          this.removeAtDepth(child.depth);
        }
      }
    }

    const jumps = new Map<number, Jump>();
    for (let f = (rewind ? 0 : this.currentFrame) + 1; f <= target; f++) {
      for (const command of this.timeline.frames[f - 1] ?? []) {
        if (command.type === "remove") {
          jumps.delete(command.depth);
          // Going forward, a removal between the frames takes effect.
          if (!rewind) {
            this.removeAtDepth(command.depth);
          }

          continue;
        }

        const place = command.place;
        const jump = jumps.get(place.depth) ?? { before: null, place: null, frame: f };
        // A rewind replays from an empty display list, so what the frames do
        // at a depth nothing has placed yet is known: a change does nothing,
        // and a place in a child's stead places anew.
        if (place.character === null) {
          if (jump.place) {
            jump.place = mergePlace(jump.place, place);
          } else if (!rewind) {
            jump.before = jump.before ? mergePlace(jump.before, place) : place;
          }
        } else if (!place.move || (rewind && !jump.place)) {
          // Anew: the child starts from nothing, and from here.
          jump.before = null;
          jump.place = rewind ? asFirstPlaced({ ...place, move: false }) : place;
          jump.frame = f;
        } else if (jump.place) {
          jump.place = mergePlace(jump.place, place);
        } else {
          jump.place = place;
          jump.frame = f;
        }

        jumps.set(place.depth, jump);
      }
    }

    // Replayed from the first frame, a depth the frames left empty is empty.
    if (rewind) {
      for (const child of [...this.depths.values()]) {
        if (child.placeFrame > 0 && child.depth !== null && !jumps.has(child.depth)) {
          this.removeAtDepth(child.depth);
        }
      }
    }

    // On the frame before its children are made: one constructed now sees it there, as in Flash.
    this.currentFrame = target;
    for (const [depth, jump] of jumps) {
      const existing = this.depths.get(depth);
      if (existing && jump.before) {
        existing.applyPlace(jump.before);
      }

      if (!jump.place) {
        continue;
      }

      const character =
        jump.place.character === null ? null : this.library.characters.get(jump.place.character);
      if (!character || character.type === "binary" || character.type === "font") {
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
      this.placeAtDepth(child, depth);
      construct(child, character, this.library);
    }
  }

  /** The first frame, as a clip runs it when it is made; once. */
  enterFirstFrame(): void {
    if (this.currentFrame !== 0) {
      return;
    }

    this.currentFrame = 1;
    this.runFrame(1);
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

    if (!this.playing || this.totalFrames <= 1) {
      return;
    }

    if (this.currentFrame >= this.totalFrames) {
      this.gotoFrame(1);
      return;
    }

    this.currentFrame++;
    this.runFrame(this.currentFrame);
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

const IDENTITY_COLOR: ColorTransform = {
  rMul: 1,
  gMul: 1,
  bMul: 1,
  aMul: 1,
  rAdd: 0,
  gAdd: 0,
  bAdd: 0,
  aAdd: 0,
};

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
    clipActions: next.clipActions ?? previous.clipActions,
  };
}

/** A display object for a character, before its first frame: a shape, or a clip. */
/** `hasImage` is PlaceObject3's flag where a timeline places it, which a bitmap's construction reads. */
export function displayFor(
  character: DisplayCharacter,
  library: Library,
  hasImage = false,
): DisplayObject {
  if (character.type === "shape") {
    return new ShapeObject(character);
  }

  if (character.type === "bitmap") {
    // With scripts, its Bitmap's constructor gives it its data; without, a copy of the pixels.
    const bitmap = new BitmapObject(
      library.construct ? null : BitmapStore.of(character.pixels ?? INVALID_PIXELS),
    );
    bitmap.character = character;
    bitmap.hasImage = hasImage;
    return bitmap;
  }

  if (character.type === "text") {
    const text = new TextObject(character);
    text.fonts = library.fonts;
    return text;
  }

  const clip = new MovieClip(character.timeline, library);
  clip.character = character;
  return clip;
}

/**
 * Bring a display object the timeline placed to life: its AS3 object
 * constructed where the SWF has scripts, which enters a clip's first frame
 * and names it on its parent, else a clip's first frame entered. After the
 * placement, as Flash has it, so that the parent and the name are there.
 */
function construct(display: DisplayObject, character: DisplayCharacter, library: Library): void {
  if (library.construct) {
    library.construct(display, character);
  } else if (display instanceof MovieClip) {
    display.enterFirstFrame();
  }
}

/** A display object for a character as the timeline would place it, alive, but in no container. */
export function instantiate(character: DisplayCharacter, library: Library): DisplayObject {
  const display = displayFor(character, library);
  construct(display, character, library);
  return display;
}

/** A timeline of one empty frame: a clip a script makes. */
export const EMPTY_TIMELINE: Timeline = { frames: [[]], labels: new Map() };
