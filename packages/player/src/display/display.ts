// The display list the player owns: display objects, containers and
// movie clips, as Flash has them. A renderer mirrors it (see render/view.ts) and
// never decides its order. A container keeps its children in render order,
// which is their index in AS3, and apart from it the children the timeline
// placed, by depth, which is how SWF tags address them; a child the
// timeline places goes before the first child of a greater depth.
import {
  BUTTON_DOWN,
  BUTTON_HIT_TEST,
  BUTTON_OVER,
  BUTTON_UP,
  type ButtonRecord,
  type ColorTransform,
  IDENTITY,
  type Matrix,
  type Place,
  readFilters,
} from "@swf2es/format";
import type { avm2 } from "@swf2es/runtime";
import { BitmapStore } from "../bitmap/bitmap.js";
import type { FontSet } from "../text/fonts.js";
import { GUTTER, layoutText, type TextLayout } from "../text/layout.js";
import { type PlacedGlyph, placeGlyphs } from "../text/static.js";
import { TextModel } from "../text/text.js";
import type { Drawing } from "./drawing.js";
import { type Filter, filterOfSwf } from "./filters.js";
import { type Rect, shifted } from "./geometry.js";
import { compose3D, decompose3D } from "./matrix3d.js";
import { morphAt } from "./morph.js";
import {
  type BitmapCharacter,
  type ButtonCharacter,
  type Character,
  type DisplayCharacter,
  INVALID_PIXELS,
  type Library,
  type MorphCharacter,
  type ShapeCharacter,
  type StaticTextCharacter,
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

/**
 * A count that moves whenever something changes that a round of frame
 * scripts (Scripting.runFrameScripts) reads to find a script to run: a
 * clip's frame, frame scripts, makingChildren or timelineChild, a children
 * list, a button's states, and, as Scripting and Lifecycle move it, an
 * object made alive, a button's first scripts, the scripts' phase, the
 * orphans and what scripts made. While it stands still, a round finds
 * nothing the one before it left. One for every player: another's moving
 * it costs a round, never a script.
 */
export const scriptWork = { changes: 0 };

/** DisplayObject.kind's. */
export const OTHER = 0;
export const CLIP = 1;
export const BUTTON = 2;

const NO_FILTERS: readonly Filter[] = Object.freeze([]);
/** What a leaf has to walk: one for all, as the frame's walks visit every object once or more a frame. */
const NO_CHILDREN: readonly DisplayObject[] = Object.freeze([]);
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

/**
 * A display object's 3D transform: the properties a script sets, the
 * rotations in degrees as set, and the matrix3D they make, or that a
 * script set whole, column-major float32.
 */
export interface Space {
  x: number;
  y: number;
  z: number;
  scaleX: number;
  scaleY: number;
  scaleZ: number;
  rotationX: number;
  rotationY: number;
  rotationZ: number;
  raw: Float32Array;
}

export type SpaceProperty = Exclude<keyof Space, "raw">;

/** A perspective projection a script gave a display object: the field of view in radians, as Flash keeps it, and the centre. */
export interface Projection {
  fieldOfView: number;
  centerX: number;
  centerY: number;
}

export class DisplayObject {
  readonly serial = made++;
  parent: Container | null = null;
  /** The timeline depth it was placed at, or null for one a script added. */
  depth: number | null = null;
  /** The frame of its parent's timeline that placed it, 1 the first; 0 for one a script added. */
  placeFrame = 0;
  /**
   * The ratio its placements gave, 0 for none: a rewind keeps the child
   * only where the frames replayed give it the same (gotoFrame).
   */
  ratio = 0;
  name = "";
  /** Whether its name is one the timeline gave it, which its parent has a property of; not a default instanceN. */
  timelineNamed = false;
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
  /**
   * Where it has the keyboard's focus, how to drop it: Flash takes focus
   * from an object taken off its parent or hidden (input/keyboard.ts).
   */
  focusDrop: ((d: DisplayObject) => void) | null = null;
  /** The character it was made from, or null. */
  character: Character | null = null;
  /** Whether a script set a property of it; from then on the timeline swaps no shape under it, as Flash's does not. */
  scripted = false;
  /**
   * Whether a script set its transform or another property a place gives:
   * from then on the timeline's places, moves and a rewind's alike, leave
   * its matrix, colour, ratio, visibility, blend mode and filters as they
   * are, all of them whichever was set, as Flash's do (`scripted-moves`).
   * Setting visible, mask or cacheAsBitmap is no such touch.
   */
  transformed = false;
  /** Its other face, the AS3 object a script sees; null in an AVM1 movie. */
  object: avm2.AsObject | null = null;
  /** The root of an AVM1 movie an AS3 Loader loaded: its other face, an AVM1Movie, is no InteractiveObject. */
  avm1Root = false;
  /** The LoaderInfo of the SWF this is the root of: set on the main root and on each loaded SWF's; null below. */
  loaderInfo: avm2.AsObject | null = null;
  /** What its Graphics drew, for a Shape or Sprite a script draws in; null until one does. */
  drawing: Drawing | null = null;
  /** What changed since the renderer last synced it: TRANSFORM, CHILDREN, CONTENT. */
  dirty = TRANSFORM | CONTENT;
  /**
   * The display objects whose frames its frames run: a container's own
   * children array, a button's states (ButtonObject), none for the rest.
   * A field every object has, so that the walks each frame, which visit
   * every object, read it without asking its class.
   */
  frameChildren: readonly DisplayObject[] = NO_CHILDREN;
  /** Whether it is a MovieClip (CLIP) or a ButtonObject (BUTTON), for those walks likewise: OTHER for the rest. */
  kind = OTHER;

  private weakRef: WeakRef<this> | null = null;

  /**
   * This object, weakly, as a store it shows or fills with holds it: the
   * same each time, made as it is first asked for, which most never are,
   * though timelines make thousands of objects a second.
   */
  get ref(): WeakRef<this> {
    this.weakRef ??= new WeakRef(this);
    return this.weakRef;
  }
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
  /**
   * Its 9-slice grid, in its own space, in pixels (display/scale9.ts): its
   * symbol's DefineScalingGrid's, or what a script set; null for none.
   */
  scale9Grid: Rect | null = null;
  /** Its blend mode, as BlendMode names it. */
  blendMode = "normal";
  /** Its filters' values, which its `filters` reads copies of. */
  filters: readonly Filter[] = NO_FILTERS;
  /**
   * Its 3D transform, from when a script first sets a 3D property, its
   * matrix3D, or its 2D matrix to null, until it sets matrix3D to null: in
   * place of the 2D matrix to a script, and drawn as the matrix3D's x and
   * y rows, without perspective, which the player does not draw.
   */
  space: Space | null = null;
  /** The perspective projection a script set on its transform, or null. */
  projection: Projection | null = null;

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

  /** A script set a property a place gives (`transformed`), which is also a touch (`scripted`). */
  touch(): void {
    this.scripted = true;
    this.transformed = true;
  }

  /**
   * The matrix set whole, and taken apart: the scales are its columns'
   * lengths, the rotation the first column's angle, the skew the second's
   * beyond that. A negative scale set as such is not recovered: a half
   * turn is what the matrix says. It leaves 3D.
   */
  setMatrix(m: Matrix): void {
    this.adoptMatrix({ ...m });
  }

  /** As setMatrix, with a matrix made for it, which it keeps: a place's, on each move of each frame. */
  private adoptMatrix(m: Matrix): void {
    this.space = null;
    this.matrix = m;
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
    if (this.space) {
      this.set3D("scaleX", v);
      return;
    }

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
    if (this.space) {
      this.set3D("scaleY", v);
      return;
    }

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
    if (this.space) {
      this.set3D("rotationZ", degrees);
      return;
    }

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

  /** Its 3D transform, made from the 2D matrix the first time. */
  enter3D(): Space {
    if (!this.space) {
      const m = this.matrix;
      this.setMatrix3D(
        Float32Array.of(m.a, m.b, 0, 0, m.c, m.d, 0, 0, 0, 0, 1, 0, m.tx, m.ty, 0, 1),
      );
    }

    return this.space as Space;
  }

  /**
   * One 3D property set, as Flash's: a position moves the matrix3D, as set
   * whole or not; a scale or rotation makes it again from all of them, a
   * rotation as set, not brought within ±180. A NaN position or rotation
   * is 0.
   */
  set3D(key: SpaceProperty, v: number): void {
    const space = this.enter3D();
    space[key] = Number.isNaN(v) && !key.startsWith("scale") ? 0 : v;
    const at = ["x", "y", "z"].indexOf(key);
    if (at >= 0) {
      space.raw[12 + at] = space[key];
      this.flatten();
      return;
    }

    const radians = [space.rotationX, space.rotationY, space.rotationZ].map(
      (r) => (r * Math.PI) / 180,
    );
    space.raw = compose3D(
      [space.x, space.y, space.z],
      radians,
      [space.scaleX, space.scaleY, space.scaleZ],
      "eulerAngles",
    );
    this.flatten();
  }

  /** The matrix3D set whole, and taken apart into the properties as Matrix3D.decompose would; null back to 2D, at the identity. */
  setMatrix3D(raw: Float32Array | null): void {
    if (!raw) {
      this.space = null;
      this.setMatrix(IDENTITY);
      return;
    }

    const [[x, y, z], rotation, [scaleX, scaleY, scaleZ]] = decompose3D(raw, "eulerAngles");
    const [rotationX, rotationY, rotationZ] = rotation.map((r) => r * DEGREES);
    this.space = {
      x,
      y,
      z,
      scaleX,
      scaleY,
      scaleZ,
      rotationX,
      rotationY,
      rotationZ,
      raw: Float32Array.from(raw),
    };
    this.flatten();
  }

  /** The 2D fields from the 3D transform: the matrix its x and y rows, which is how it draws and hits. */
  private flatten(): void {
    const space = this.space as Space;
    const m = space.raw;
    this.matrix = { a: m[0], b: m[1], c: m[4], d: m[5], tx: m[12], ty: m[13] };
    this.scaleX = space.scaleX;
    this.scaleY = space.scaleY;
    this.rotation = space.rotationZ;
    this.skew = 0;
    this.invalidate(TRANSFORM);
  }

  /** Apply a place's transform, colour, name and visibility; to one a script transformed, its name and clip depth only. */
  applyPlace(place: Place): void {
    if (place.name !== null) {
      this.name = place.name;
      this.timelineNamed = true;
    }

    if (this.transformed) {
      if (place.clipDepth !== null) {
        this.applyRare({ ...place, blendMode: null, filters: null });
      }

      return;
    }

    if (place.matrix) {
      const m = place.matrix;
      this.adoptMatrix({ a: m.a, b: m.b, c: m.c, d: m.d, tx: m.tx / 20, ty: m.ty / 20 });
    }

    if (place.colorTransform) {
      this.colorTransform = place.colorTransform;
      this.invalidate(TRANSFORM);
    }

    if (place.ratio !== null) {
      this.ratio = place.ratio;
    }

    if (place.visible !== null) {
      this.visible = place.visible;
      this.invalidate(TRANSFORM);
      if (!place.visible) {
        this.focusDrop?.(this);
      }
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
  /** The shape it draws, or last drew; null for a Shape a script made, which draws nothing yet. */
  shape: ShapeCharacter | null;
  /** A MorphShape's morph, which `shape` is a blend of. */
  morph: MorphCharacter | null = null;
  /**
   * The blend drawn() last made, and its morph and ratio: it stands while
   * `shape` is still it, which a swap to a shape is not.
   */
  private blended: { morph: MorphCharacter; ratio: number; shape: ShapeCharacter } | null = null;

  constructor(shape: ShapeCharacter | null) {
    super();
    this.shape = shape;
    this.character = shape;
  }

  /** A MorphShape, its morph's start until it is drawn at another ratio. */
  static ofMorph(morph: MorphCharacter): ShapeObject {
    const shape = morphAt(morph, 0);
    const object = new ShapeObject(shape);
    object.morph = morph;
    object.blended = { morph, ratio: 0, shape };
    object.character = morph;
    return object;
  }

  /**
   * A MorphShape takes on a new ratio when it is next drawn (drawn): until
   * then its bounds and hit tests are the last drawn blend's, as Flash's
   * are (the corpus's hittest_morph).
   */
  override applyPlace(place: Place): void {
    const ratio = this.ratio;
    super.applyPlace(place);

    if (this.morph && this.ratio !== ratio) {
      this.invalidate(CONTENT);
    }
  }

  /** The shape to draw now: a MorphShape's blend at its ratio, which it keeps from here. */
  drawn(): ShapeCharacter | null {
    // The blend it has is kept while its morph and ratio are: asking the
    // morph again would turn over its few latest blends for nothing.
    const b = this.blended;
    if (
      this.morph &&
      (b?.morph !== this.morph || b.ratio !== this.ratio || b.shape !== this.shape)
    ) {
      this.shape = morphAt(this.morph, this.ratio);
      this.blended = { morph: this.morph, ratio: this.ratio, shape: this.shape };
    }

    return this.shape;
  }
}

/** A StaticText: DefineText's glyphs, which only a timeline places; its bounds the tag's. */
export class StaticTextObject extends DisplayObject {
  private laidGlyphs: { glyphs: PlacedGlyph[]; text: string | null } | null = null;

  constructor(
    readonly definition: StaticTextCharacter,
    private readonly characters: Map<number, Character>,
  ) {
    super();
    this.character = definition;
  }

  /**
   * Its glyphs as placed, and its text, found the first time they are
   * asked for: by then its SWF's fonts are all read, those defined after it
   * too.
   */
  get glyphs(): { glyphs: PlacedGlyph[]; text: string | null } {
    this.laidGlyphs ??= placeGlyphs(this.definition, this.characters);
    return this.laidGlyphs;
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
  /** The selection, from the end it was started at to the caret, as text indices; empty, a caret alone. */
  private anchorAt = 0;
  private caretAt = 0;
  /** Whether it has the keyboard's focus, an input field then showing its caret. */
  focused = false;
  /** The StyleSheet its HTML is styled by, or null. */
  styleSheet: avm2.AsObject | null = null;
  /** Under a sheet, the HTML a script last set, which htmlText gives back as it was set. */
  htmlSource: string | null = null;
  /** Under a sheet, its HTML styled again, as a change to the sheet asks. */
  restyle: (() => void) | null = null;

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
    const key = `${this.model.revision}|${this.width}|${this.wordWrap}|${this.embedFonts}|${this.displayAsPassword}|${this.type}`;
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
          input: this.type === "input",
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

  /** The end the selection was started at, within the text as it is now, which a script may have shortened. */
  get anchor(): number {
    return Math.min(this.anchorAt, this.model.text.length);
  }

  /** The caret, within the text as it is now. */
  get caret(): number {
    return Math.min(this.caretAt, this.model.text.length);
  }

  /** The selection's first and last index, in order. */
  get selection(): [number, number] {
    const [anchor, caret] = [this.anchor, this.caret];
    return anchor <= caret ? [anchor, caret] : [caret, anchor];
  }

  /** Select from `anchor` to `caret`, each kept within the text; a focused field shows its caret there. */
  select(anchor: number, caret: number): void {
    const length = this.model.text.length;
    const [a, c] = [Math.max(0, Math.min(length, anchor)), Math.max(0, Math.min(length, caret))];
    // A drag selects on every move, mostly what it had: redraw only for a change.
    if (a === this.anchor && c === this.caret) {
      return;
    }

    this.anchorAt = a;
    this.caretAt = c;
    this.invalidate(CONTENT);
  }
}

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
 * a rewind keeps the child: Flash makes no new object, and only a Shape or
 * MorphShape no script has touched takes the new shape's or morph's
 * graphic; a clip, a Shape a script set a property of, and a Shape a
 * sprite is placed over all stay as they are (`replaces`).
 */
function swap(existing: DisplayObject, character: Character): void {
  if (!(existing instanceof ShapeObject) || existing.scripted || existing.character === character) {
    return;
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

/** A Video: a box of the size it was made at, its bounds; the player plays no video in it, so it draws nothing. */
export class VideoObject extends DisplayObject {
  boxWidth = 320;
  boxHeight = 240;
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

  constructor() {
    super();
    this.frameChildren = this.children;
  }

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
    scriptWork.changes++;
  }

  removeAtDepth(depth: number): DisplayObject | null {
    const child = this.depths.get(depth);
    if (!child) {
      return null;
    }

    // The timeline's removal: a script's goes through the natives, which tell of it themselves.
    this.library?.removing?.(child, true);
    this.library?.sounds?.removed(child);
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
    child.focusDrop?.(child);
    this.invalidate(CHILDREN);
    scriptWork.changes++;
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
    scriptWork.changes++;
  }

  swapChildren(a: DisplayObject, b: DisplayObject): void {
    const i = this.children.indexOf(a);
    const j = this.children.indexOf(b);
    this.children[i] = b;
    this.children[j] = a;
    this.invalidate(CHILDREN);
    scriptWork.changes++;
  }
}

/** The state a button shows, as the pointer has it. */
export type ButtonState = "up" | "over" | "down";

/**
 * Which of DefineButtonSound's sounds a change of state plays, by the
 * state before and after, as Ruffle's button events pick them: a drag off
 * while pressed, down to up here, and back over, up to down, none (-1); a
 * release outside plays over to up's (ButtonObject.releasedOutside).
 */
const BUTTON_SOUNDS: Record<ButtonState, Record<ButtonState, number>> = {
  up: { up: -1, over: 1, down: -1 },
  over: { up: 0, over: -1, down: 2 },
  down: { up: -1, over: 3, down: -1 },
};

/**
 * A button (SimpleButton): four states, each a display object, of which it
 * shows the up, over or down one, as the pointer has it, and hit tests with
 * the fourth. The state it shows is its one child, which it is drawn and
 * bounded by; the others are its own, off the display list, but each has
 * its frames as Flash's do (`frameChildren`). Not a container to a script.
 */
export class ButtonObject extends Container {
  private up: DisplayObject | null = null;
  private over: DisplayObject | null = null;
  private down: DisplayObject | null = null;
  private hitTest: DisplayObject | null = null;
  state: ButtonState = "up";
  private firstOrder = false;
  enabled = true;
  useHandCursor = true;
  trackAsMenu = false;

  constructor() {
    super();
    this.kind = BUTTON;
    this.frameChildren = NO_CHILDREN;
  }

  get upState(): DisplayObject | null {
    return this.up;
  }

  set upState(d: DisplayObject | null) {
    this.up = d;
    this.statesChanged();
  }

  get overState(): DisplayObject | null {
    return this.over;
  }

  set overState(d: DisplayObject | null) {
    this.over = d;
    this.statesChanged();
  }

  get downState(): DisplayObject | null {
    return this.down;
  }

  set downState(d: DisplayObject | null) {
    this.down = d;
    this.statesChanged();
  }

  get hitTestState(): DisplayObject | null {
    return this.hitTest;
  }

  set hitTestState(d: DisplayObject | null) {
    this.hitTest = d;
    this.statesChanged();
  }

  /**
   * Its frame children made again from the states it has now, each once,
   * as Ruffle orders them, the hit test state first, whichever it shows: a
   * new list, so that none it let go of stays held.
   */
  private statesChanged(): void {
    const states = [this.hitTest, this.up, this.down, this.over].filter(
      (o, i, all): o is DisplayObject => o !== null && all.indexOf(o) === i,
    );
    this.frameChildren = states.length > 0 ? states : NO_CHILDREN;
    scriptWork.changes++;
  }

  /** Its states' next frame scripts run up, over, down, hit: the first, in a SWF after 9 (Scripting.construct). */
  get firstScripts(): boolean {
    return this.firstOrder;
  }

  set firstScripts(first: boolean) {
    if (first !== this.firstOrder) {
      this.firstOrder = first;
      scriptWork.changes++;
    }
  }

  /** The display object of state `state`. */
  stateObject(state: ButtonState): DisplayObject | null {
    return state === "up" ? this.upState : state === "over" ? this.overState : this.downState;
  }

  /** Show state `state`, with the sound DefineButtonSound gives the change. */
  setState(state: ButtonState): void {
    this.playSound(BUTTON_SOUNDS[this.state][state]);
    this.state = state;
    this.show();
  }

  /** A press on it released elsewhere: over to up's sound, as Ruffle's ReleaseOutside plays. */
  releasedOutside(): void {
    this.playSound(0);
  }

  /** DefineButtonSound's sound `index`, if it has one. */
  private playSound(index: number): void {
    const sounds = this.character?.type === "button" ? this.character.sounds : null;
    const sound = sounds?.[index];
    const library = this.library;
    if (sound && library) {
      library.sounds?.start(this, library, sound.id, sound.info);
    }
  }

  /**
   * Have the state it is in be its one child, as it is now. The states it
   * does not show are parented to nothing, as Flash has them once made.
   */
  show(): void {
    const current = this.stateObject(this.state);
    for (const child of [...this.children]) {
      if (child !== current) {
        this.removeChild(child);
      }
    }

    for (const state of [this.upState, this.overState, this.downState, this.hitTestState]) {
      if (state && state !== current && state.parent === this && !this.children.includes(state)) {
        state.parent = null;
      }
    }

    if (current && !this.children.includes(current)) {
      if (current.parent !== this) {
        current.parent?.removeChild(current);
      }

      this.children.splice(0, 0, current);
      current.parent = this;
      this.invalidate(CHILDREN);
      scriptWork.changes++;
    }
  }
}

/**
 * Make a button's states from its records, as Flash does when the button
 * is made, up, over, down, then hit test: each state the one character it
 * shows, else a container of its characters by depth, one for none too. A
 * character in several states is made once for each. `made` brings a
 * character to life once placed, and `holderMade` each container, once all
 * four states' characters are, as Flash names them after those; the hit
 * test state takes only the records' transforms.
 */
export function buttonStates(
  button: ButtonObject,
  character: ButtonCharacter,
  library: Library,
  made: (display: DisplayObject, character: DisplayCharacter) => void,
  holderMade: (holder: Container) => void,
): void {
  const holders: Container[] = [];
  const state = (flag: number): DisplayObject => {
    const parts: { display: DisplayObject; character: DisplayCharacter; record: ButtonRecord }[] =
      [];
    for (const record of character.records) {
      const c = record.states & flag ? library.characters.get(record.character) : undefined;
      if (
        c &&
        c.type !== "binary" &&
        c.type !== "font" &&
        c.type !== "fontCff" &&
        c.type !== "sound"
      ) {
        const display = displayFor(c, library);
        display.applyPlace(recordPlace(record, flag !== BUTTON_HIT_TEST));
        parts.push({ display, character: c, record });
      }
    }

    // Made as the button's, under it, though in no container's list: a
    // script sees the stage from them, and no parent above them.
    if (parts.length === 1) {
      parts[0].display.parent = button;
      made(parts[0].display, parts[0].character);
      return parts[0].display;
    }

    const holder = new Container();
    holder.parent = button;
    for (const part of parts) {
      holder.placeAtDepth(part.display, part.record.depth);
      made(part.display, part.character);
    }

    holders.push(holder);
    return holder;
  };

  button.upState = state(BUTTON_UP);
  button.overState = state(BUTTON_OVER);
  button.downState = state(BUTTON_DOWN);
  button.hitTestState = state(BUTTON_HIT_TEST);
  for (const holder of holders) {
    holderMade(holder);
  }

  button.show();
}

/** A button record as a place of its character: its transform, and, but in the hit test state, its look. */
function recordPlace(record: ButtonRecord, look: boolean): Place {
  return {
    depth: record.depth,
    move: false,
    character: record.character,
    matrix: record.matrix,
    colorTransform: look ? record.colorTransform : null,
    ratio: null,
    name: null,
    clipDepth: null,
    className: null,
    hasImage: false,
    blendMode: look ? record.blendMode : null,
    cacheAsBitmap: null,
    visible: null,
    opaqueBackground: null,
    filters: look ? record.filters : null,
    clipActions: null,
  };
}

/**
 * The display objects whose frame scripts a display object's run: those
 * whose frames its frames run, but a button's first, in a SWF after 9, up,
 * over, down, then hit test, as Flash runs them while the button is made.
 */
export function scriptChildren(d: DisplayObject): readonly DisplayObject[] {
  if (d.kind === BUTTON && (d as ButtonObject).firstScripts) {
    const b = d as ButtonObject;
    b.firstScripts = false;
    return [b.upState, b.overState, b.downState, b.hitTestState].filter(
      (o, i, all): o is DisplayObject => o !== null && all.indexOf(o) === i,
    );
  }

  return d.frameChildren;
}

/** The root `d` is under, or is: the nearest display object up from it that carries a LoaderInfo; null under none, as for one a script made and did not add. */
export function rootOf(d: DisplayObject): DisplayObject | null {
  for (let o: DisplayObject | null = d; o; o = o.parent) {
    if (o.loaderInfo) {
      return o;
    }
  }

  return null;
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

  constructor(
    readonly timeline: Timeline,
    library: Library,
  ) {
    super();
    this.kind = CLIP;
    this.library = library;
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
    for (const command of this.timeline.frames[frame - 1] ?? []) {
      if (command.type === "remove") {
        this.removeAtDepth(command.depth);
        continue;
      }

      const place = command.place;
      const existing = this.depths.get(place.depth);
      if (!place.move && existing) {
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
    // A goto stops the stream, and the frame it lands on starts it again
    // if the clip plays, as Ruffle's run_goto has it; one to the frame it is
    // on is nothing to it, as Ruffle's goto_frame_now has it.
    if (this.stream && target !== from) {
      this.library.sounds?.stopStream(this);
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
      for (const child of [...this.children]) {
        const depth = child.depth;
        if (depth === null || child.placeFrame <= 0) {
          continue;
        }

        const jump = jumps.get(depth);
        const id = jump?.place?.character ?? null;
        if (!jump || (jump.place && jump.place.ratio !== child.ratio)) {
          this.removeAtDepth(depth);
        } else if (
          child.placeFrame > target &&
          jump.placed &&
          madeAs(child, id === null ? undefined : this.library.characters.get(id))
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
      this.placeAtDepth(child, depth);
      if (looping && this.library.constructLater) {
        this.library.constructLater(child, character);
      } else {
        placed.push({ display: child, character });
      }
    }

    if (this.library.constructPlaced) {
      this.library.constructPlaced(placed);
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

    if (!this.playing || this.totalFrames <= 1) {
      // A clip of one frame plays its stream for that frame only, as Ruffle stops it.
      if (this.stream) {
        this.library.sounds?.stopStream(this);
      }

      return;
    }

    if (this.currentFrame >= this.totalFrames) {
      this.gotoFrame(1, true);
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

  if (character.type === "morph") {
    return ShapeObject.ofMorph(character);
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

  if (character.type === "static") {
    return new StaticTextObject(character, library.characters);
  }

  if (character.type === "text") {
    const text = new TextObject(character);
    text.fonts = library.fonts;
    return text;
  }

  // Its states are made where it is constructed (Scripting.construct).
  if (character.type === "button") {
    const button = new ButtonObject();
    button.character = character;
    button.library = library;
    button.trackAsMenu = character.trackAsMenu;
    button.scale9Grid = character.grid;
    return button;
  }

  const clip = new MovieClip(character.timeline, library);
  clip.character = character;
  clip.scale9Grid = character.grid;
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
  } else if (display instanceof ButtonObject && character.type === "button") {
    buttonStates(
      display,
      character,
      library,
      (d, c) => construct(d, c, library),
      () => {},
    );
  }
}

/** A display object for a character as the timeline would place it, alive, but in no container. */
export function instantiate(character: DisplayCharacter, library: Library): DisplayObject {
  const display = displayFor(character, library);
  construct(display, character, library);
  return display;
}

/** A timeline of one empty frame: a clip a script makes. */
export const EMPTY_TIMELINE: Timeline = {
  frames: [[]],
  labels: [],
  gotoLabels: [],
  frameLabels: new Map(),
  scenes: [{ name: "", frame: 1 }],
  sounds: new Map(),
  stream: null,
};
