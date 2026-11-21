// A SWF's timelines packed: each place record a row of a few integers, its
// matrix and colour transform in arrays of their own that rows index, and
// what few places set (names, filters, clip actions) in side tables; each
// frame a run of commands. A SWF with long tweened timelines holds hundreds
// of thousands of places, and an object for each, with a matrix and a colour
// transform object of its own, held tens of megabytes. The matrices keep
// SWF's own fixed point, 16.16 scales and twips, so they are exact as read.
import type { ColorTransform, Matrix, Place } from "@swf2es/format";
import { IDENTITY_COLOR } from "./color.js";
import type { Timeline } from "./timeline.js";

/** A frame command's kinds: a place (its record), a removal (its depth) and AVM1's DoAction (its tag's offset). */
export const PLACE = 0;
export const REMOVE = 1;
export const ACTIONS = 2;

// A row: the depth and flags; the character and ratio; the clip depth and
// blend mode; the matrix's index; the colour transform's; the side tables'.
const STRIDE = 6;
const MATRIX = 3;
const COLOR = 4;
const RARE = 5;

const MOVE = 1 << 0;
const HAS_IMAGE = 1 << 1;
const HAS_CHARACTER = 1 << 2;
const HAS_RATIO = 1 << 3;
const HAS_CLIP = 1 << 4;
const HAS_BLEND = 1 << 5;
const CACHE_SET = 1 << 6;
const CACHE = 1 << 7;
const VISIBLE_SET = 1 << 8;
const VISIBLE = 1 << 9;
const HAS_FILTERS = 1 << 10;
/** What applyPlace hands to its rare half. */
const RARE_FLAGS = HAS_CLIP | HAS_BLEND | CACHE_SET | HAS_FILTERS;

/** An empty FILTERLIST, which a rewind's place puts back where it set none. */
const NO_FILTER_BYTES = new Uint8Array([0]);

function grown<T extends Int32Array | Int16Array | Uint32Array | Uint8Array>(
  array: T,
  length: number,
): T {
  if (length <= array.length) {
    return array;
  }

  const next = new (array.constructor as new (n: number) => T)(
    Math.max(length, array.length * 2, 16),
  );
  next.set(array);
  return next;
}

/** `s`, or the string equal to it that `strings` already has. */
function interned(s: string | null, strings: Map<string, string> | undefined): string | null {
  if (s === null || !strings) {
    return s;
  }

  const known = strings.get(s);
  if (known !== undefined) {
    return known;
  }

  strings.set(s, s);
  return s;
}

function hash(values: ArrayLike<number>, at: number, count: number): number {
  let h = 0x811c9dc5;
  for (let k = 0; k < count; k++) {
    h = Math.imul(h ^ values[at + k], 0x01000193);
  }

  return h ^ (h >>> 15);
}

/**
 * The distinct entries of an array of entries of `size` numbers, as an
 * open-addressed table of their indices + 1, so that an entry equal to one
 * already there is kept once.
 */
class Distinct {
  private slots = new Int32Array(256);
  private used = 0;
  private readonly size: number;

  constructor(size: number) {
    this.size = size;
  }

  /** Entry `next` of `values`, or an earlier one equal to it: the index to use; `next` itself if new. */
  find(values: Int32Array | Int16Array, next: number): number {
    const size = this.size;
    const o = next * size;
    const mask = this.slots.length - 1;
    for (let slot = hash(values, o, size) & mask; ; slot = (slot + 1) & mask) {
      const known = this.slots[slot] - 1;
      if (known < 0) {
        this.slots[slot] = next + 1;
        if (++this.used * 2 > this.slots.length) {
          this.rehash(values);
        }

        return next;
      }

      let k = 0;
      while (k < size && values[known * size + k] === values[o + k]) {
        k++;
      }

      if (k === size) {
        return known;
      }
    }
  }

  private rehash(values: Int32Array | Int16Array): void {
    const old = this.slots;
    this.slots = new Int32Array(old.length * 2);
    const mask = this.slots.length - 1;
    for (let s = 0; s < old.length; s++) {
      const index = old[s] - 1;
      if (index >= 0) {
        let slot = hash(values, index * this.size, this.size) & mask;
        while (this.slots[slot] !== 0) {
          slot = (slot + 1) & mask;
        }

        this.slots[slot] = index + 1;
      }
    }
  }
}

/**
 * Place records. A timeline store's are read from its SWF; a goto's scratch
 * records are copies it folds later places into, sharing the store's
 * matrices and colour transforms. Matrix 0 and colour transform 0 are the
 * identity, which a rewind's place falls back to.
 */
export class Places {
  rows = new Int32Array(0);
  count = 0;
  /** a, b, c, d in 16.16, tx, ty in twips, by matrix. */
  matrices: Int32Array;
  matrixCount = 1;
  /** Multipliers in 256ths, offsets, by colour transform: r, g, b, a of each. */
  colors: Int16Array;
  colorCount = 1;
  /** Each colour transform's object, made as a display object first takes it, and shared. */
  colorObjects: (ColorTransform | undefined)[] = [IDENTITY_COLOR];

  // The side tables, by a row's RARE index.
  private rareCount = 0;
  private names: (string | null)[] = [];
  private classNames: (string | null)[] = [];
  private filterLists: (Uint8Array | null)[] = [];
  private metaDatas: (Uint8Array | null)[] = [];
  private actionLists: (number[] | null)[] = [];
  private corrupts: number[] = [];
  private opaques: (number | null)[] = [];

  // While read: identical matrices and colour transforms shared, by hash; dropped once sealed.
  private distinctMatrices: Distinct | null = new Distinct(6);
  private distinctColors: Distinct | null = new Distinct(8);

  constructor() {
    this.matrices = new Int32Array(6 * 16);
    this.matrices[0] = 0x10000;
    this.matrices[3] = 0x10000;
    this.colors = new Int16Array(8 * 16);
    this.colors.fill(256, 0, 4);
    this.distinctMatrices?.find(this.matrices, 0);
    this.distinctColors?.find(this.colors, 0);
  }

  /** `place` as a new record, its strings shared through `strings`; its index. */
  add(place: Place, strings?: Map<string, string>): number {
    let flags = 0;
    if (place.move) {
      flags |= MOVE;
    }

    if (place.hasImage) {
      flags |= HAS_IMAGE;
    }

    if (place.character !== null) {
      flags |= HAS_CHARACTER;
    }

    if (place.ratio !== null) {
      flags |= HAS_RATIO;
    }

    if (place.clipDepth !== null) {
      flags |= HAS_CLIP;
    }

    if (place.blendMode !== null) {
      flags |= HAS_BLEND;
    }

    if (place.cacheAsBitmap !== null) {
      flags |= CACHE_SET | (place.cacheAsBitmap ? CACHE : 0);
    }

    if (place.visible !== null) {
      flags |= VISIBLE_SET | (place.visible ? VISIBLE : 0);
    }

    if (place.filters !== null) {
      flags |= HAS_FILTERS;
    }

    const i = this.count++;
    this.rows = grown(this.rows, this.count * STRIDE);
    const r = this.rows;
    const o = i * STRIDE;
    r[o] = (place.depth & 0xffff) | (flags << 16);
    r[o + 1] = ((place.character ?? 0) & 0xffff) | (((place.ratio ?? 0) & 0xffff) << 16);
    r[o + 2] = ((place.clipDepth ?? 0) & 0xffff) | (((place.blendMode ?? 0) & 0xff) << 16);
    r[o + MATRIX] = place.matrix ? this.addMatrix(place.matrix) : -1;
    r[o + COLOR] = place.colorTransform ? this.addColor(place.colorTransform) : -1;
    const rare =
      place.name !== null ||
      place.className !== null ||
      place.filters !== null ||
      place.metaData !== null ||
      place.actions !== null ||
      place.corrupt !== 0 ||
      place.opaqueBackground !== null;
    r[o + RARE] = rare
      ? this.addRare(
          interned(place.name, strings),
          interned(place.className, strings),
          place.filters,
          place.metaData,
          place.actions,
          place.corrupt,
          place.opaqueBackground,
        )
      : -1;
    return i;
  }

  private addRare(
    name: string | null,
    className: string | null,
    filters: Uint8Array | null,
    metaData: Uint8Array | null,
    actions: number[] | null,
    corrupt: number,
    opaque: number | null,
  ): number {
    const k = this.rareCount++;
    this.names[k] = name;
    this.classNames[k] = className;
    this.filterLists[k] = filters;
    this.metaDatas[k] = metaData;
    this.actionLists[k] = actions;
    this.corrupts[k] = corrupt;
    this.opaques[k] = opaque;
    return k;
  }

  private addMatrix(m: Matrix): number {
    const next = this.matrixCount;
    this.matrices = grown(this.matrices, (next + 1) * 6);
    const v = this.matrices;
    const o = next * 6;
    v[o] = Math.round(m.a * 0x10000);
    v[o + 1] = Math.round(m.b * 0x10000);
    v[o + 2] = Math.round(m.c * 0x10000);
    v[o + 3] = Math.round(m.d * 0x10000);
    v[o + 4] = m.tx;
    v[o + 5] = m.ty;
    const index = this.distinctMatrices?.find(v, next) ?? next;
    if (index === next) {
      this.matrixCount++;
    }

    return index;
  }

  private addColor(c: ColorTransform): number {
    const next = this.colorCount;
    this.colors = grown(this.colors, (next + 1) * 8);
    const v = this.colors;
    const o = next * 8;
    v[o] = Math.round(c.rMul * 256);
    v[o + 1] = Math.round(c.gMul * 256);
    v[o + 2] = Math.round(c.bMul * 256);
    v[o + 3] = Math.round(c.aMul * 256);
    v[o + 4] = c.rAdd;
    v[o + 5] = c.gAdd;
    v[o + 6] = c.bAdd;
    v[o + 7] = c.aAdd;
    const index = this.distinctColors?.find(v, next) ?? next;
    if (index === next) {
      this.colorCount++;
    }

    return index;
  }

  /** Done reading: the arrays cut to what they hold, and what only reading needed dropped. */
  seal(): void {
    this.rows = this.rows.slice(0, this.count * STRIDE);
    this.matrices = this.matrices.slice(0, this.matrixCount * 6);
    this.colors = this.colors.slice(0, this.colorCount * 8);
    this.distinctMatrices = null;
    this.distinctColors = null;
  }

  depth(i: number): number {
    return this.rows[i * STRIDE] & 0xffff;
  }

  private flags(i: number): number {
    return this.rows[i * STRIDE] >>> 16;
  }

  /** Whether it changes the character already at the depth, rather than placing one. */
  move(i: number): boolean {
    return (this.flags(i) & MOVE) !== 0;
  }

  /** PlaceObject3's HasImage. */
  hasImage(i: number): boolean {
    return (this.flags(i) & HAS_IMAGE) !== 0;
  }

  /** Its character's id, -1 without one. */
  character(i: number): number {
    return this.flags(i) & HAS_CHARACTER ? this.rows[i * STRIDE + 1] & 0xffff : -1;
  }

  /** Its ratio, -1 without one. */
  ratio(i: number): number {
    return this.flags(i) & HAS_RATIO ? this.rows[i * STRIDE + 1] >>> 16 : -1;
  }

  /** Its clip depth, -1 without one. */
  clipDepth(i: number): number {
    return this.flags(i) & HAS_CLIP ? this.rows[i * STRIDE + 2] & 0xffff : -1;
  }

  /** Its blend mode, -1 without one. */
  blendMode(i: number): number {
    return this.flags(i) & HAS_BLEND ? this.rows[i * STRIDE + 2] >>> 16 : -1;
  }

  cacheAsBitmap(i: number): boolean | null {
    const flags = this.flags(i);
    return flags & CACHE_SET ? (flags & CACHE) !== 0 : null;
  }

  visible(i: number): boolean | null {
    const flags = this.flags(i);
    return flags & VISIBLE_SET ? (flags & VISIBLE) !== 0 : null;
  }

  /** Whether it sets any of a clip depth, a blend mode, filters or cacheAsBitmap. */
  setsRare(i: number): boolean {
    return (this.flags(i) & RARE_FLAGS) !== 0;
  }

  /** Its matrix's index, -1 without one. */
  matrix(i: number): number {
    return this.rows[i * STRIDE + MATRIX];
  }

  /** Matrix `k`, its translation in pixels, as a new object for a display object to keep. */
  pixelMatrix(k: number): Matrix {
    const m = this.matrices;
    const o = k * 6;
    return {
      a: m[o] / 0x10000,
      b: m[o + 1] / 0x10000,
      c: m[o + 2] / 0x10000,
      d: m[o + 3] / 0x10000,
      tx: m[o + 4] / 20,
      ty: m[o + 5] / 20,
    };
  }

  /** Its colour transform's index, -1 without one. */
  colorTransform(i: number): number {
    return this.rows[i * STRIDE + COLOR];
  }

  /** Colour transform `k`'s object, shared by every display object given it. */
  colorObject(k: number): ColorTransform {
    let c = this.colorObjects[k];
    if (c === undefined) {
      const v = this.colors;
      const o = k * 8;
      c = {
        rMul: v[o] / 256,
        gMul: v[o + 1] / 256,
        bMul: v[o + 2] / 256,
        aMul: v[o + 3] / 256,
        rAdd: v[o + 4],
        gAdd: v[o + 5],
        bAdd: v[o + 6],
        aAdd: v[o + 7],
      };
      this.colorObjects[k] = c;
    }

    return c;
  }

  name(i: number): string | null {
    const k = this.rows[i * STRIDE + RARE];
    return k < 0 ? null : this.names[k];
  }

  className(i: number): string | null {
    const k = this.rows[i * STRIDE + RARE];
    return k < 0 ? null : this.classNames[k];
  }

  filters(i: number): Uint8Array | null {
    const k = this.rows[i * STRIDE + RARE];
    return k < 0 ? null : this.filterLists[k];
  }

  metaData(i: number): Uint8Array | null {
    const k = this.rows[i * STRIDE + RARE];
    return k < 0 ? null : this.metaDatas[k];
  }

  /** The indices of its AVM1 clip actions in the SWF's ActionList; null without them. */
  actions(i: number): number[] | null {
    const k = this.rows[i * STRIDE + RARE];
    return k < 0 ? null : this.actionLists[k];
  }

  /** Place.corrupt. */
  corrupt(i: number): number {
    const k = this.rows[i * STRIDE + RARE];
    return k < 0 ? 0 : this.corrupts[k];
  }

  opaqueBackground(i: number): number | null {
    const k = this.rows[i * STRIDE + RARE];
    return k < 0 ? null : this.opaques[k];
  }

  /** Record `i` as a Place, for tools and tests. */
  place(i: number): Place {
    const m = this.matrix(i);
    const c = this.colorTransform(i);
    const matrix = m < 0 ? null : this.pixelMatrix(m);
    if (matrix) {
      matrix.tx = this.matrices[m * 6 + 4];
      matrix.ty = this.matrices[m * 6 + 5];
    }

    const ratio = this.ratio(i);
    const clipDepth = this.clipDepth(i);
    const blendMode = this.blendMode(i);
    const character = this.character(i);
    return {
      depth: this.depth(i),
      move: this.move(i),
      character: character < 0 ? null : character,
      matrix,
      colorTransform: c < 0 ? null : { ...this.colorObject(c) },
      ratio: ratio < 0 ? null : ratio,
      name: this.name(i),
      clipDepth: clipDepth < 0 ? null : clipDepth,
      className: this.className(i),
      hasImage: this.hasImage(i),
      blendMode: blendMode < 0 ? null : blendMode,
      cacheAsBitmap: this.cacheAsBitmap(i),
      visible: this.visible(i),
      opaqueBackground: this.opaqueBackground(i),
      filters: this.filters(i),
      metaData: this.metaData(i),
      actions: this.actions(i),
      corrupt: this.corrupt(i),
    };
  }

  // A goto's scratch records, each with side tables of its own at its own index.

  /** Emptied for a goto in `store`'s timeline, whose matrices and colour transforms it reads. */
  reset(store: Places): void {
    this.release();
    this.matrices = store.matrices;
    this.matrixCount = store.matrixCount;
    this.colors = store.colors;
    this.colorCount = store.colorCount;
    this.colorObjects = store.colorObjects;
  }

  /** Emptied, holding nothing of a store. */
  release(): void {
    for (let k = 0; k < this.rareCount; k++) {
      this.names[k] = null;
      this.classNames[k] = null;
      this.filterLists[k] = null;
      this.metaDatas[k] = null;
      this.actionLists[k] = null;
      this.opaques[k] = null;
    }

    this.count = 0;
    this.rareCount = 0;
    this.matrices = IDENTITY_STORE.matrices;
    this.matrixCount = 1;
    this.colors = IDENTITY_STORE.colors;
    this.colorCount = 1;
    this.colorObjects = IDENTITY_STORE.colorObjects;
    this.distinctMatrices = null;
    this.distinctColors = null;
  }

  /** A copy of `from`'s record `i`, which reset gave this its matrices; its index. */
  copy(from: Places, i: number): number {
    const j = this.count++;
    this.rows = grown(this.rows, this.count * STRIDE);
    const o = j * STRIDE;
    for (let k = 0; k < RARE; k++) {
      this.rows[o + k] = from.rows[i * STRIDE + k];
    }

    this.rows[o + RARE] = this.addRare(
      from.name(i),
      from.className(i),
      from.filters(i),
      from.metaData(i),
      from.actions(i),
      from.corrupt(i),
      from.opaqueBackground(i),
    );
    return j;
  }

  /**
   * `from`'s record `i` folded into record `j`: what it sets, and the rest
   * as it was; the depth, move, hasImage, metadata and corrupt stay `j`'s.
   */
  merge(j: number, from: Places, i: number): void {
    const r = this.rows;
    const s = from.rows;
    const o = j * STRIDE;
    const p = i * STRIDE;
    const next = s[p] >>> 16;
    let flags = r[o] >>> 16;
    let w1 = r[o + 1];
    let w2 = r[o + 2];
    if (next & HAS_CHARACTER) {
      w1 = (w1 & ~0xffff) | (s[p + 1] & 0xffff);
    }

    if (next & HAS_RATIO) {
      w1 = (w1 & 0xffff) | (s[p + 1] & ~0xffff);
    }

    if (next & HAS_CLIP) {
      w2 = (w2 & ~0xffff) | (s[p + 2] & 0xffff);
    }

    if (next & HAS_BLEND) {
      w2 = (w2 & 0xffff) | (s[p + 2] & ~0xffff);
    }

    if (next & CACHE_SET) {
      flags = (flags & ~CACHE) | (next & (CACHE_SET | CACHE));
    }

    if (next & VISIBLE_SET) {
      flags = (flags & ~VISIBLE) | (next & (VISIBLE_SET | VISIBLE));
    }

    flags |= next & (HAS_CHARACTER | HAS_RATIO | HAS_CLIP | HAS_BLEND | HAS_FILTERS);
    r[o] = (r[o] & 0xffff) | (flags << 16);
    r[o + 1] = w1;
    r[o + 2] = w2;
    if (s[p + MATRIX] >= 0) {
      r[o + MATRIX] = s[p + MATRIX];
    }

    if (s[p + COLOR] >= 0) {
      r[o + COLOR] = s[p + COLOR];
    }

    const k = r[o + RARE];
    this.names[k] = from.name(i) ?? this.names[k];
    this.classNames[k] = from.className(i) ?? this.classNames[k];
    this.filterLists[k] = from.filters(i) ?? this.filterLists[k];
    this.actionLists[k] = from.actions(i) ?? this.actionLists[k];
    this.opaques[k] = from.opaqueBackground(i) ?? this.opaques[k];
  }

  /**
   * Record `j` as a rewind places it: the transform, colour, ratio and the
   * rest as a character first placed has them, as Ruffle's goto fills them
   * in. The name and visibility are not among them: they stay as they were.
   */
  firstPlaced(j: number): void {
    const r = this.rows;
    const o = j * STRIDE;
    let flags = r[o] >>> 16;
    if (!(flags & HAS_RATIO)) {
      r[o + 1] &= 0xffff;
    }

    if (!(flags & HAS_BLEND)) {
      r[o + 2] &= 0xffff;
    }

    flags |= HAS_RATIO | HAS_BLEND | HAS_FILTERS | CACHE_SET;
    r[o] = (r[o] & 0xffff) | (flags << 16);
    if (r[o + MATRIX] < 0) {
      r[o + MATRIX] = 0;
    }

    if (r[o + COLOR] < 0) {
      r[o + COLOR] = 0;
    }

    const k = r[o + RARE];
    this.filterLists[k] ??= NO_FILTER_BYTES;
  }

  /** Record `j` without its name. */
  unnamed(j: number): void {
    this.names[this.rows[j * STRIDE + RARE]] = null;
  }
}

/** Records of none: the identity matrix and colour transform alone. */
const IDENTITY_STORE = new Places();
IDENTITY_STORE.seal();

const scratches: Places[] = [];

/** Scratch records for a goto in a timeline of `store`; given back when it is done. */
export function takeScratch(store: Places): Places {
  const scratch = scratches.pop() ?? new Places();
  scratch.reset(store);
  return scratch;
}

export function giveScratch(scratch: Places): void {
  scratch.release();
  scratches.push(scratch);
}

/**
 * A SWF's timelines: their place records, and each frame's commands, one
 * timeline's frames after another's. A timeline's frame k runs commands
 * `starts[first + k - 1]` to `starts[first + k]`.
 */
export class TimelineStore {
  readonly places = new Places();
  starts = new Uint32Array(1);
  frameCount = 0;
  kinds = new Uint8Array(0);
  args = new Uint32Array(0);
  commandCount = 0;

  /** A timeline's frames, each its commands as kind and argument in turn; the frame index of its first. */
  addFrames(frames: number[][]): number {
    const first = this.frameCount;
    this.frameCount += frames.length;
    this.starts = grown(this.starts, this.frameCount + 1);
    for (let f = 0; f < frames.length; f++) {
      const commands = frames[f];
      const at = this.commandCount;
      this.commandCount += commands.length / 2;
      this.kinds = grown(this.kinds, this.commandCount);
      this.args = grown(this.args, this.commandCount);
      for (let c = 0; c < commands.length; c += 2) {
        this.kinds[at + c / 2] = commands[c];
        this.args[at + c / 2] = commands[c + 1];
      }

      this.starts[first + f + 1] = this.commandCount;
    }

    return first;
  }

  /** Done reading: the arrays cut to what they hold. */
  seal(): void {
    this.places.seal();
    this.starts = this.starts.slice(0, this.frameCount + 1);
    this.kinds = this.kinds.slice(0, this.commandCount);
    this.args = this.args.slice(0, this.commandCount);
  }

  /** Where `timeline`'s frame `frame`'s commands start; at end(), for a frame it does not have. */
  start(timeline: Timeline, frame: number): number {
    return frame >= 1 && frame <= timeline.frameCount ? this.starts[timeline.first + frame - 1] : 0;
  }

  /** Where they end. */
  end(timeline: Timeline, frame: number): number {
    return frame >= 1 && frame <= timeline.frameCount ? this.starts[timeline.first + frame] : 0;
  }
}

/** The store of timelines with no commands, as a clip a script makes has. */
export const EMPTY_STORE = new TimelineStore();
EMPTY_STORE.addFrames([[]]);
EMPTY_STORE.seal();
