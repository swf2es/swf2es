// The display object every kind extends: its place in its parent, its
// transform, 2D and 3D, its look, and the flags and counts by which the
// renderer, the pointer's pick and the frame's walks learn of its changes.
import {
  type ColorTransform,
  IDENTITY,
  type Matrix,
  type Place,
  readFilters,
} from "@swf2es/format";
import type { avm1, avm2 } from "@swf2es/runtime";
import type { Container } from "./container.js";
import type { Drawing } from "./drawing.js";
import { type Filter, filterOfSwf } from "./filters.js";
import { type Rect, shifted } from "./geometry.js";
import { compose3D, decompose3D, identity3D } from "./matrix3d.js";
import { placedInPerspective } from "./perspective.js";
import type { Character } from "./timeline.js";

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

/**
 * A count that moves whenever something changes that may change what is
 * under a pointer that stands still: any change a renderer would sync
 * (DisplayObject.invalidate), and the pick's own fields, mouseEnabled,
 * mouseChildren, a hitArea, a button's enabled. While it stands still,
 * the pointer has no need to pick again at a frame's end. One for every
 * player: another's moving it costs a pick, never an event. `picks`
 * counts the pointer's picks, which an object's pickChangedAt is told in.
 */
export const pickWork = { changes: 0, picks: 0 };

/**
 * How many times a SWF's content was let go of, a Loader's unloaded or
 * replaced or a player destroyed: a renderer lets go then of what it kept
 * of objects off the list for others to take, which holds their SWF's
 * characters (render/view.ts).
 */
export const unloads = { count: 0 };

/** DisplayObject.kind's. */
export const OTHER = 0;
export const CLIP = 1;
export const BUTTON = 2;

const NO_FILTERS: readonly Filter[] = Object.freeze([]);

/** What a leaf has to walk: one for all, as the frame's walks visit every object once or more a frame. */
export const NO_CHILDREN: readonly DisplayObject[] = Object.freeze([]);

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
  /**
   * The matrix it is drawn, bounded and hit by: `raw` as the object last
   * made or took it. A Matrix3D a script holds of it (transform.matrix3D)
   * shares `raw`, and its copyColumnFrom, copyRowFrom and copyToMatrix3D
   * change that alone, as Flash's do: the object stays where it was until
   * a property set writes all of `shown` back into `raw` (`three-d-matrix`).
   */
  shown: Float32Array;
  /**
   * Whether its matrix could not be taken apart, a column of it of no
   * length: Flash then reads the properties as the identity's, at the
   * position, until a scale or rotation set makes it the identity.
   */
  singular: boolean;
  /**
   * Whether a scale or rotation set has made the matrix since it was set
   * whole: Flash keeps the first scale set after that as a float32.
   */
  composed: boolean;
  /** The 2D scales, rotation and skew from before it went 3D, which matrix3D set to null gives back. */
  flat: readonly number[];
  /** Its planes in perspective (`planes`), and the changes (pickWork) they were made at. */
  planes?: { placed: Matrix; own: Matrix; back: Matrix | null } | null;
  planeAt?: number;
}

export type SpaceProperty = Exclude<
  keyof Space,
  "raw" | "shown" | "singular" | "composed" | "flat" | "planes" | "planeAt"
>;

/**
 * The least a 3D scale goes to, as Flash's: a smaller one, 0 or NaN is
 * this, so the matrix stays invertible and the scale can come back.
 */
export const LEAST_SCALE_3D = 1.175494351e-36;

/**
 * The records of a place's filters, read once for each list of them: an
 * animated character's timeline places the same glowing children again on
 * each frame, and each read the list anew. Shared by every object placed
 * with the list, as nothing changes a record in place: a script reads
 * copies and sets new ones.
 */
const placedLists = new WeakMap<Uint8Array, readonly Filter[]>();
function placedFilters(bytes: Uint8Array): readonly Filter[] {
  let filters = placedLists.get(bytes);
  if (!filters) {
    filters = readFilters(bytes).map(filterOfSwf);
    placedLists.set(bytes, filters);
  }

  return filters;
}

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
  /**
   * Whether the matrix is not the one the scales, rotation and skew make:
   * the identity matrix3D set to null leaves, which a scale set then makes
   * again from all of them, as Flash's does, not in proportion.
   */
  private unmade = false;
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
  /** Whether a script or a place set its cacheAsBitmap: Flash then draws it from a bitmap it keeps (`swap`). */
  cachedAsBitmap = false;
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
  /** In an AVM1 movie, its AS2 face, a clip's, a button's or a text field's (avm1/avm1.ts); null otherwise. */
  avm1: avm1.Avm1Object | null = null;
  /** The root of an AVM1 movie an AS3 Loader loaded: its other face, an AVM1Movie, is no InteractiveObject. */
  avm1Root = false;
  /** The LoaderInfo of the SWF this is the root of: set on the main root and on each loaded SWF's; null below. */
  loaderInfo: avm2.AsObject | null = null;
  /** What its Graphics drew, for a Shape or Sprite a script draws in; null until one does. */
  drawing: Drawing | null = null;
  /** What changed since the renderer last synced it: TRANSFORM, CHILDREN, CONTENT. */
  dirty = TRANSFORM | CONTENT;
  /**
   * Where anything under it may take the pointer, in its own space, as the
   * pointer's pick last worked it out (input/pointer.ts), and whether a
   * change under it since has made that stale: the renderer's flags are
   * cleared as it syncs, these as the pick reads them. A move alone marks
   * its ancestors, not it: its bounds in its own space stand.
   */
  pickBounds: Rect | null = null;
  pickStale = true;
  /** The scroll its pick bounds were worked out for: a scroll's change marks it only moved. */
  pickScroll: Rect | null = null;
  /**
   * The pick (pickWork.picks) before which it or something under it last
   * changed, or it was made: one that changes between every two picks is
   * not worth its bounds, and the pick goes through it instead.
   */
  pickChangedAt = pickWork.picks;
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
  private scrollTaken: Rect | null = null;

  /** The scroll a 3D object has none of: Flash draws, bounds and hits all of it whatever its scrollRect. */
  get scroll(): Rect | null {
    return this.space ? null : this.scrollTaken;
  }

  set scroll(r: Rect | null) {
    this.scrollTaken = r;
  }
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
   * place of the 2D matrix to a script, and drawn, bounded and hit in
   * perspective (`placed`).
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
    pickWork.changes++;
    for (let p = this.parent; p && !p.descendantsDirty; p = p.parent) {
      p.descendantsDirty = true;
    }

    // Its own pick bounds stand when it only moves; its ancestors' do not.
    this.pickChanged(what !== TRANSFORM);
  }

  /**
   * Mark the pick bounds above it stale, and its own unless `own` is false
   * (input/pointer.ts): an ancestor of one changed since the last pick is
   * marked already.
   */
  pickChanged(own: boolean): void {
    const picks = pickWork.picks;
    if (own) {
      this.pickStale = true;
      this.pickChangedAt = picks;
    }

    for (let p = this.parent; p && p.pickChangedAt !== picks; p = p.parent) {
      p.pickStale = true;
      p.pickChangedAt = picks;
    }
  }

  /**
   * Its matrix after its scroll's shift: from what it draws to its parent's
   * space. A 3D object's is its plane in perspective (display/perspective.ts),
   * kept until anything is invalidated, as an ancestor's move changes it.
   */
  get placed(): Matrix {
    if (this.space) {
      return this.perspective();
    }

    return this.scroll ? shifted(this.matrix, this.scroll) : this.matrix;
  }

  private perspective(): Matrix {
    return this.planes().placed;
  }

  /**
   * A 3D object's planes (display/perspective.ts): in its parent's space,
   * in its projector's, and the way back from the projector's to its
   * parent's, kept as `placed` is.
   */
  planes(): { placed: Matrix; own: Matrix; back: Matrix | null } {
    const space = this.space as Space;
    if (space.planeAt !== pickWork.changes || !space.planes) {
      space.planes = placedInPerspective(this);
      space.planeAt = pickWork.changes;
    }

    return space.planes;
  }

  /** Its 2D matrix after its scroll's shift, a 3D object's its matrix3D's x and y rows: what a mask draws by. */
  get flatPlaced(): Matrix {
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

  setCachedAsBitmap(cached: boolean): void {
    this.cachedAsBitmap = cached;
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
    this.unmade = false;
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

    if (this.unmade) {
      this.scaleX = v;
      this.remake();
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

    if (this.unmade) {
      this.scaleY = v;
      this.remake();
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
    this.unmade = false;
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

  /** Its 3D transform, made from the 2D matrix the first time, a -0 in it taken as 0. */
  enter3D(): Space {
    if (!this.space) {
      const m = this.matrix;
      this.setMatrix3D(
        Float32Array.of(m.a, m.b, 0, 0, m.c, m.d, 0, 0, 0, 0, 1, 0, m.tx, m.ty, 0, 1).map(
          (v) => v + 0,
        ),
        true,
      );
    }

    return this.space as Space;
  }

  /**
   * One 3D property set, as Flash's: a position moves the matrix3D, as set
   * whole or not; a scale or rotation makes it again from all of them, a
   * rotation as set, not brought within ±180, a scale no nearer 0 than
   * LEAST_SCALE_3D, and a float32 if the matrix was set whole since the
   * last such set. A NaN position or rotation is 0. A scale or rotation
   * set where the 2D matrix could not be taken apart makes it the
   * identity, at the origin, and is lost, as in Flash.
   */
  set3D(key: SpaceProperty, v: number): void {
    const space = this.enter3D();
    const at = ["x", "y", "z"].indexOf(key);
    if (at >= 0) {
      space[key] = Number.isNaN(v) ? 0 : v;
      space.shown[12 + at] = space[key];
      space.raw.set(space.shown);
      this.flatten();
      return;
    }

    if (space.singular) {
      this.setMatrix3D(identity3D());
      return;
    }

    if (!key.startsWith("scale")) {
      space[key] = Number.isNaN(v) ? 0 : v;
    } else {
      const kept = Math.abs(v) >= LEAST_SCALE_3D ? v : LEAST_SCALE_3D;
      space[key] = space.composed ? kept : Math.fround(kept);
    }

    // In float32 radians, as adl's sines and cosines of them are, to the last bit.
    const radians = [space.rotationX, space.rotationY, space.rotationZ].map((r) =>
      Math.fround((r * Math.PI) / 180),
    );
    space.shown.set(
      compose3D(
        [space.x, space.y, space.z],
        radians,
        [space.scaleX, space.scaleY, space.scaleZ],
        "eulerAngles",
      ),
    );
    // In place: a Matrix3D a script holds of it shows the change (transform.matrix3D).
    space.raw.set(space.shown);
    space.composed = true;
    this.flatten();
  }

  /**
   * The matrix3D set whole, and taken apart into the properties as
   * Matrix3D.decompose would; null back to 2D, at the identity, with the
   * scales and rotation it had before it went 3D. Null in 2D changes
   * nothing. One made from the 2D matrix (`flat`) with a column of no
   * length reads as the identity at its position, as in Flash, where a
   * matrix3D set so reads as NaN. The values go into the matrix it has,
   * which a script's Matrix3D may share (transform.matrix3D), unless it
   * `adopt`s `raw` itself, a Matrix3D's that a script set.
   */
  setMatrix3D(raw: Float32Array | null, flat = false, adopt = false): void {
    const before = this.space?.flat ?? [this.scaleX, this.scaleY, this.rotation, this.skew];
    if (!raw) {
      if (this.space) {
        this.setMatrix(IDENTITY);
        [this.scaleX, this.scaleY, this.rotation, this.skew] = before;
        this.unmade = true;
      }

      return;
    }

    const kept = this.space?.raw;
    const [[x, y, z], rotation, [scaleX, scaleY, scaleZ]] = decompose3D(raw, "eulerAngles");
    const singular = flat && (scaleX === 0 || scaleY === 0);
    const [rotationX, rotationY, rotationZ] = singular
      ? [0, 0, 0]
      : rotation.map((r) => r * DEGREES);
    let held = raw;
    if (!adopt && kept) {
      kept.set(raw);
      held = kept;
    } else if (!adopt) {
      held = new Float32Array(raw);
    }

    this.space = {
      x,
      y,
      z,
      scaleX: singular ? 1 : scaleX,
      scaleY: singular ? 1 : scaleY,
      scaleZ: singular ? 1 : scaleZ,
      rotationX,
      rotationY,
      rotationZ,
      raw: held,
      shown: new Float32Array(held),
      singular,
      composed: false,
      flat: before,
    };
    this.flatten();
  }

  /**
   * Its matrix, `raw`, changed in place through a Matrix3D a script holds of
   * it, which Flash's getter hands out live: taken apart again, as adl reads
   * the properties after; nothing if it is no longer its matrix.
   */
  matrix3DChanged(raw: Float32Array): void {
    if (this.space?.raw === raw) {
      this.touch();
      this.setMatrix3D(raw);
    }
  }

  /** The 2D fields from the 3D transform: the matrix its x and y rows, which a mask draws by (`flatPlaced`). */
  private flatten(): void {
    const space = this.space as Space;
    const m = space.shown;
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
    if (
      place.clipDepth !== null ||
      place.blendMode !== null ||
      place.filters !== null ||
      place.cacheAsBitmap !== null
    ) {
      this.applyRare(place);
    }
  }

  /** What a place sets that few do: a clip depth, a blend mode, filters, cacheAsBitmap. */
  private applyRare(place: Place): void {
    if (place.cacheAsBitmap !== null) {
      this.setCachedAsBitmap(place.cacheAsBitmap);
    }

    if (place.filters !== null) {
      this.filters = placedFilters(place.filters);
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

/** The root `d` is under, or is: the nearest display object up from it that carries a LoaderInfo; null under none, as for one a script made and did not add. */
export function rootOf(d: DisplayObject): DisplayObject | null {
  for (let o: DisplayObject | null = d; o; o = o.parent) {
    if (o.loaderInfo) {
      return o;
    }
  }

  return null;
}
