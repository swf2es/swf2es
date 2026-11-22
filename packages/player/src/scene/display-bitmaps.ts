// BitmapData shown at the display's resolution (RenderViewOptions'
// `bitmapResolution`): vector art a SWF draws into a bitmap the stage's
// size and shows scaled up is stretched, as Flash stretches it, a few
// pixels made many on a large or dense screen.
//
// The store itself goes on as it does with the option off: every draw, fill
// and read takes its own way, and scripts read the pixels Flash's would
// have. Beside it the renderer keeps a record of a store made of one colour
// and since only drawn into with display objects and filled. Once a Bitmap on
// the stage shows the store larger than a pixel a stage pixel, the record is
// drawn into a texture of the renderer's own at the screen's pixels a pixel,
// each draw as the stage would draw the art at that scale, and that texture
// is what the Bitmap shows, texel for pixel, while the store stays as the
// record left it: draws and fills after go into it too, and anything else
// that changes the store leaves it behind and the Bitmap shows the store.
// The record draws again only while nothing it drew has changed since
// (DisplayObject's `changedAt`), at a new scale when the one the store is
// shown at changes and holds for a few frames.

import type { TextureHandle, Textures } from "@swf2es/render";
import { BitmapStore } from "../bitmap/bitmap.js";
import type { PixelRect } from "../bitmap/pixel-rect.js";
import {
  BitmapObject,
  Container,
  type DisplayObject,
  pickWork,
  VideoObject,
} from "../display/display.js";
import type { Paint } from "../display/shapes.js";

type Affine = { a: number; b: number; c: number; d: number; tx: number; ty: number };

/** The most texels a side of a pixel a store is shown at. */
const MOST_ZOOM = 4;
/** The fewest worth a texture of its own: below, the Bitmap shows the store. */
const LEAST_ZOOM = 1.1;
/** The most texels one store's texture holds: 64 MB. */
const STORE_TEXELS = 1 << 24;
/** The most texels a draw's samples take at once: a tile's side is this's root over the samples. */
const TILE_TEXELS = 1 << 24;
/** The most an object with filters takes drawn whole, its samples fewer where it is large. */
const WHOLE_TEXELS = 1 << 25;
/**
 * How far the scale a store is shown at may stray from its texture's before it is drawn again at
 * it: little, as a texel that lands on a pixel of the screen is read as it is, else resampled.
 */
const RESCALE = 0.002;
/** The most draws and fills a store's record keeps. */
const MOST_STEPS = 256;
/** Rendered frames a new scale must hold before a store is drawn again at it: a resize's drag passes. */
const STEADY_FRAMES = 8;
/** Rendered frames a store may go unshown before its texture is let go of, to be made again when shown. */
const UNSHOWN_FRAMES = 300;

/** What a view lends the textures it shows stores at the display's resolution in. */
export interface DisplayHost {
  textureLimit(): number;
  /**
   * `o` drawn as BitmapData.draw draws it through `m`, in the store's
   * pixels, at `zoom` texels a pixel, into `width` by `height` texels of
   * texture `id` at (x, y), composited source over, with `samples` a side;
   * whether it was.
   */
  draw(
    o: DisplayObject,
    m: Affine,
    x: number,
    y: number,
    width: number,
    height: number,
    samples: number,
    zoom: number,
    id: number,
    opaque: boolean,
  ): boolean;
  /** `rect` of texture `id` cleared to `pixel`, premultiplied ARGB; whether it was. */
  fill(id: number, rect: PixelRect, pixel: number): boolean;
}

/** A draw a store went through: as drawInto took it, in the store's pixels. */
interface DrawStep {
  object: DisplayObject;
  matrix: Affine;
  x: number;
  y: number;
  width: number;
  height: number;
  samples: number;
  /** pickWork.changes once drawn: the object draws so again while nothing in it changed since. */
  epoch: number;
  /** The stores its fills sample, and their versions then, which no Bitmap is told of. */
  sampled: [BitmapStore, number][];
  /** Whether it is drawn whole, not in tiles: filters near a tile's edge would read past it. */
  whole: boolean;
}

interface FillStep {
  rect: PixelRect;
  pixel: number;
}

/** A store's texture at the display's resolution. */
export interface Shown {
  handle: TextureHandle;
  zoom: number;
  bytes: number;
}

/**
 * A store followed while its record stands for it, kept by the store alone
 * (DisplayBitmaps' `records`): what it draws holds what it drew, and with that
 * perhaps the store itself, which a strong reference from elsewhere would keep.
 */
interface Record {
  /** The colour it was all of, and its draws and fills since, in order; null once that cannot be told. */
  solid: number;
  steps: (DrawStep | FillStep)[] | null;
  /** The store's version the record stands for: anything else changed it since. */
  version: number;
  /** Its entry among those shown, while it is. */
  entry: Entry | null;
  /** Texels a pixel a Bitmap on the stage last showed it at, and the frame it did. */
  shownZoom: number;
  shownAt: number;
  /** A scale it is to be drawn again at, and for how many frames that has held. */
  wanted: number;
  steady: number;
}

/** A store a Bitmap on the stage showed: its texture, by a reference that does not keep the store. */
interface Entry {
  store: WeakRef<BitmapStore>;
  shown: Shown | null;
}

/** The views following stores' fills (BitmapStore's `fillWatch`), each told of every fill. */
const followers = new Set<DisplayBitmaps>();

function followFills(store: BitmapStore, rect: PixelRect, pixel: number, before: number): void {
  for (const follower of followers) {
    follower.filled(store, rect, pixel, before);
  }
}

export class DisplayBitmaps {
  private readonly records = new WeakMap<BitmapStore, Record>();
  private readonly entries: Entry[] = [];
  /** The bytes the textures take. */
  private bytes = 0;
  private frames = 0;

  constructor(
    private readonly textures: Textures,
    private readonly host: DisplayHost,
    readonly budget: number,
  ) {
    followers.add(this);
    BitmapStore.fillWatch = followFills;
  }

  /** The bytes of texture the stores shown at display resolution hold now. */
  get heldBytes(): number {
    return this.bytes;
  }

  /** How many stores are shown at display resolution now. */
  get heldCount(): number {
    let n = 0;
    for (const entry of this.entries) {
      n += entry.shown ? 1 : 0;
    }

    return n;
  }

  /** Its textures let go of, and stores' fills no longer followed, as the view goes. */
  destroy(): void {
    followers.delete(this);
    if (followers.size === 0) {
      BitmapStore.fillWatch = null;
    }

    for (const entry of this.entries) {
      this.free(entry);
    }

    this.entries.length = 0;
  }

  /**
   * A draw into `store` done (Drawer's `drawn`): kept in its record, and
   * drawn into its texture too where it has one; a draw that cannot be,
   * or one into a store the record no longer stands for, ends the record.
   */
  drawn(
    store: BitmapStore,
    o: DisplayObject,
    m: Affine,
    x: number,
    y: number,
    width: number,
    height: number,
    samples: number,
    plain: boolean,
    before: number,
    solid: number | null,
  ): void {
    let record = this.records.get(store);
    if (!record || record.version !== before) {
      // Something it did not see changed the store: what it knows starts again where the store
      // was of one colour before the draw, and ends otherwise.
      if (solid === null) {
        if (record) {
          this.end(record);
          record.version = store.version;
        }

        return;
      }

      if (record) {
        this.restart(record, solid);
      } else {
        record = newRecord(solid, before);
        this.records.set(store, record);
      }
    }

    record.version = store.version;
    const steps = record.steps;
    if (!steps) {
      return;
    }

    // One that shows the store itself, or that would not draw the same again, cannot be followed.
    const sampled: [BitmapStore, number][] = [];
    if (
      !plain ||
      steps.length >= MOST_STEPS ||
      !drawsAgain(o, Number.POSITIVE_INFINITY, sampled, store)
    ) {
      this.end(record);
      return;
    }

    const step: DrawStep = {
      object: o,
      matrix: m,
      x,
      y,
      width,
      height,
      samples,
      epoch: pickWork.changes,
      sampled,
      whole: filtered(o),
    };
    steps.push(step);
    const shown = record.entry?.shown;
    if (shown) {
      if (
        !this.textures.alive(shown.handle) ||
        !this.render(store, step, shown.zoom, shown.handle.id)
      ) {
        this.end(record);
        return;
      }

      // What drawing it again changed of the object drew as it did.
      step.epoch = pickWork.changes;
    }
  }

  /** A fillRect of `store` done (BitmapStore's `fillWatch`), followed as a draw is. */
  filled(store: BitmapStore, rect: PixelRect, pixel: number, before: number): void {
    const whole =
      !store.holdsAlpha &&
      rect.x === 0 &&
      rect.y === 0 &&
      rect.width === store.width &&
      rect.height === store.height;
    const record = this.records.get(store);
    if (!record) {
      // A store filled whole is of one colour: followed from there.
      if (whole) {
        this.records.set(store, newRecord(pixel, store.version));
      }

      return;
    }

    const known = record.version === before;
    record.version = store.version;
    if (whole) {
      this.restart(record, pixel);
      const shown = record.entry?.shown;
      if (shown && !this.fillTexels(store, shown, rect, pixel)) {
        this.end(record);
      }

      return;
    }

    if (!known || !record.steps || record.steps.length >= MOST_STEPS) {
      this.end(record);
      return;
    }

    record.steps.push({ rect: { ...rect }, pixel });
    const shown = record.entry?.shown;
    if (shown && !this.fillTexels(store, shown, rect, pixel)) {
      this.end(record);
    }
  }

  /** `rect` of `store`'s pixels filled in its texture `shown`, its edges rounded to texels. */
  private fillTexels(store: BitmapStore, shown: Shown, rect: PixelRect, pixel: number): boolean {
    return (
      this.textures.alive(shown.handle) &&
      this.host.fill(shown.handle.id, texelRect(store, rect, shown.zoom), pixel)
    );
  }

  /** `record` started again from `solid`: what was drawn before is gone. */
  private restart(record: Record, solid: number): void {
    record.solid = solid;
    record.steps = [];
  }

  /** `record` no longer able to tell the store: its texture let go of, and none made till it starts again. */
  private end(record: Record): void {
    record.steps = null;
    if (record.entry) {
      this.free(record.entry);
    }
  }

  /**
   * The texture a Bitmap on the stage shows `store` through, and its texels
   * a pixel, where it has one that is the store as it is; else null, and
   * the Bitmap shows the store.
   */
  texture(store: BitmapStore): Shown | null {
    const record = this.records.get(store);
    const entry = record?.entry;
    const shown = entry?.shown;
    if (!record || !entry || !shown) {
      return null;
    }

    // Left behind by a change it did not follow: in the walk, whose Bitmap shows the store now.
    const lost = !this.textures.alive(shown.handle);
    if (record.version !== store.version || lost) {
      // A lost context took what the store's own held of the draws too: not made again from them.
      if (lost) {
        record.steps = null;
      }

      this.free(entry, false);
      return null;
    }

    return shown;
  }

  /**
   * A Bitmap on the stage showed `store` at `zoom` screen pixels a pixel:
   * the scale a texture of it is made at, and made again at, so that its
   * texels land on the screen's pixels.
   */
  shown(store: BitmapStore, zoom: number): void {
    const record = this.records.get(store);
    if (!record?.steps || !Number.isFinite(zoom) || zoom <= 0) {
      return;
    }

    record.shownZoom = zoom;
    record.shownAt = this.frames;
    if (!record.entry) {
      record.entry = { store: new WeakRef(store), shown: null };
      this.entries.push(record.entry);
    }
  }

  /**
   * At the start of a frame: textures that no longer stand for their stores
   * let go of, a texture made for a store shown larger than a pixel a stage
   * pixel, and one drawn again at a scale it has been shown at since a few
   * frames.
   */
  frame(): void {
    this.frames++;
    let kept = 0;
    for (const entry of this.entries) {
      const store = entry.store.deref();
      const record = store ? this.records.get(store) : undefined;
      if (!store || !record || record.entry !== entry || this.gone(store, record, entry)) {
        this.free(entry);
        if (record?.entry === entry) {
          record.entry = null;
        }

        continue;
      }

      this.entries[kept++] = entry;
    }

    this.entries.length = kept;
  }

  /** `store`'s texture made, made again or let go of as it is shown now; whether its entry is to go. */
  private gone(store: BitmapStore, record: Record, entry: Entry): boolean {
    if (
      store.disposed ||
      !record.steps ||
      record.version !== store.version ||
      this.frames - record.shownAt > UNSHOWN_FRAMES
    ) {
      return true;
    }

    // Its texture gone with a lost context, and with it what the store's own held of the draws:
    // the Bitmap shows the store, as with the option off, till a whole fill starts it again.
    if (entry.shown && !this.textures.alive(entry.shown.handle)) {
      this.end(record);
      return true;
    }

    const wanted = this.fit(store, record.shownZoom);
    if (wanted === null) {
      // Shown at about a pixel a stage pixel: the Bitmap shows the store, as smoothed as it asks.
      this.free(entry);
      return false;
    }

    if (!entry.shown) {
      this.make(store, record, entry, wanted);
      return false;
    }

    if (Math.abs(wanted / entry.shown.zoom - 1) <= RESCALE) {
      record.steady = 0;
      return false;
    }

    if (record.wanted !== wanted) {
      record.wanted = wanted;
      record.steady = 0;
    }

    if (++record.steady >= STEADY_FRAMES) {
      record.steady = 0;
      this.make(store, record, entry, wanted);
    }

    return false;
  }

  /** The scale `shown` as a store may take it: within a texture and the cap; null below the least. */
  private fit(store: BitmapStore, shown: number): number | null {
    const zoom = Math.min(
      shown,
      MOST_ZOOM,
      this.host.textureLimit() / Math.max(store.width, store.height),
      Math.sqrt(STORE_TEXELS / (store.width * store.height)),
    );
    return zoom >= LEAST_ZOOM ? zoom : null;
  }

  /**
   * `store`'s texture made at `zoom` from its record, into a texture of its
   * own that takes the old one's place once all of it drew; where nothing
   * the record drew changed since and the budget holds it.
   */
  private make(store: BitmapStore, record: Record, entry: Entry, zoom: number): void {
    const steps = record.steps;
    if (!steps) {
      return;
    }

    if (!stillDraws(steps)) {
      this.end(record);
      return;
    }

    const across = texelsOf(store.width, zoom);
    const down = texelsOf(store.height, zoom);
    const bytes = 4 * across * down;
    if (this.bytes - (entry.shown?.bytes ?? 0) + bytes > this.budget) {
      return;
    }

    const handle = this.textures.addFilled(across, down, record.solid, Number.POSITIVE_INFINITY);
    const shown = { handle, zoom, bytes };
    for (const step of steps) {
      const done =
        "object" in step
          ? this.render(store, step, zoom, handle.id)
          : this.fillTexels(store, shown, step.rect, step.pixel);
      if (!done) {
        this.textures.remove(handle.id);
        this.end(record);
        return;
      }
    }

    // What drawing them again changed of the objects drew as it did.
    for (const step of steps) {
      if ("object" in step) {
        step.epoch = pickWork.changes;
      }
    }

    this.free(entry);
    entry.shown = shown;
    this.bytes += bytes;
    repaint(store);
  }

  /** `step` drawn into texture `id` of `store` at `zoom`: in tiles the samples hold, or whole. */
  private render(store: BitmapStore, step: DrawStep, zoom: number, id: number): boolean {
    const across = texelsOf(store.width, zoom);
    const down = texelsOf(store.height, zoom);
    const x0 = Math.round(step.x * zoom);
    const y0 = Math.round(step.y * zoom);
    const x1 =
      step.x + step.width >= store.width ? across : Math.round((step.x + step.width) * zoom);
    const y1 =
      step.y + step.height >= store.height ? down : Math.round((step.y + step.height) * zoom);
    const limit = this.host.textureLimit();
    let samples = Math.max(1, step.samples);
    let side = Math.max(64, Math.floor(Math.min(limit, Math.sqrt(TILE_TEXELS)) / samples));
    if (step.whole) {
      // Filters read past a tile's edge: drawn whole, at fewer samples where it is large.
      while (
        samples > 1 &&
        (Math.max(x1 - x0, y1 - y0) * samples > limit ||
          (x1 - x0) * (y1 - y0) * samples * samples > WHOLE_TEXELS)
      ) {
        samples /= 2;
      }

      side = Math.max(x1 - x0, y1 - y0);
    }

    // The matrix places the object in the store's pixels from (x, y): each tile from its own corner.
    const m = step.matrix;

    for (let ty = y0; ty < y1; ty += side) {
      for (let tx = x0; tx < x1; tx += side) {
        const placed = {
          ...m,
          tx: m.tx + step.x - tx / zoom,
          ty: m.ty + step.y - ty / zoom,
        };
        const w = Math.min(side, x1 - tx);
        const h = Math.min(side, y1 - ty);
        if (
          !this.host.draw(step.object, placed, tx, ty, w, h, samples, zoom, id, !store.transparent)
        ) {
          return false;
        }
      }
    }

    return true;
  }

  /** `entry`'s texture let go of, its Bitmaps walked again to show the store where `repainted`. */
  private free(entry: Entry, repainted = true): void {
    const shown = entry.shown;
    if (!shown) {
      return;
    }

    entry.shown = null;
    this.bytes -= shown.bytes;
    if (this.textures.alive(shown.handle)) {
      this.textures.remove(shown.handle.id);
    }

    const store = repainted ? entry.store.deref() : undefined;
    if (store) {
      repaint(store);
    }
  }
}

function newRecord(solid: number, version: number): Record {
  return {
    solid,
    steps: [],
    version,
    entry: null,
    shownZoom: 0,
    shownAt: 0,
    wanted: 0,
    steady: 0,
  };
}

/** The Bitmaps showing `store` walked again, as what they show changed though the store did not. */
function repaint(store: BitmapStore): void {
  for (const ref of store.views) {
    ref.deref()?.pixelsChanged(false);
  }
}

/** Texels `n` pixels take at `zoom`: the last partly covered counts. */
export function texelsOf(n: number, zoom: number): number {
  return Math.max(1, Math.ceil(n * zoom - 1e-6));
}

/** `rect` of `store`'s pixels as texels at `zoom`: its edges rounded, the store's own edges its texture's. */
function texelRect(store: BitmapStore, rect: PixelRect, zoom: number): PixelRect {
  const x0 = Math.round(rect.x * zoom);
  const y0 = Math.round(rect.y * zoom);
  const x1 =
    rect.x + rect.width >= store.width
      ? texelsOf(store.width, zoom)
      : Math.round((rect.x + rect.width) * zoom);
  const y1 =
    rect.y + rect.height >= store.height
      ? texelsOf(store.height, zoom)
      : Math.round((rect.y + rect.height) * zoom);
  return { x: x0, y: y0, width: Math.max(0, x1 - x0), height: Math.max(0, y1 - y0) };
}

/** Whether every draw of `steps` would draw as it did. */
function stillDraws(steps: readonly (DrawStep | FillStep)[]): boolean {
  for (const step of steps) {
    if (!("object" in step)) {
      continue;
    }

    if (!drawsAgain(step.object, step.epoch, null, null)) {
      return false;
    }

    for (const [store, version] of step.sampled) {
      if (store.version !== version || store.disposed) {
        return false;
      }
    }
  }

  return true;
}

/**
 * Whether `o` would draw as it did when pickWork.changes was `epoch`:
 * nothing in it changed since, nothing it draws hangs on what lies outside
 * it or changes unseen (a mask, 3D, a shader, a displacement map, a video),
 * and it shows nothing of `self`, the store drawn into. `sampled`, where
 * given, gathers the stores its fills sample, which no change of theirs
 * marks it.
 */
function drawsAgain(
  o: DisplayObject,
  epoch: number,
  sampled: [BitmapStore, number][] | null,
  self: BitmapStore | null,
): boolean {
  if (
    o.changedAt > epoch ||
    o.mask !== null ||
    o.maskOf !== null ||
    o.space !== null ||
    o.projection !== null ||
    o.blendShader !== null ||
    o instanceof VideoObject ||
    (self !== null && o instanceof BitmapObject && o.store === self)
  ) {
    return false;
  }

  for (const filter of o.filters) {
    if (filter.kind === "shader" || filter.kind === "displacementMap") {
      return false;
    }
  }

  const layers = o.drawing?.layers;
  if (layers) {
    for (const layer of layers) {
      for (const fill of layer.fills) {
        if (!paintDrawsAgain(fill.fill, sampled, self)) {
          return false;
        }
      }

      for (const stroke of layer.strokes) {
        if (stroke.paint && !paintDrawsAgain(stroke.paint, sampled, self)) {
          return false;
        }
      }

      if (layer.meshes?.length || layer.mirrored) {
        return false;
      }
    }
  }

  if (o instanceof Container) {
    for (const child of o.children) {
      if (!drawsAgain(child, epoch, sampled, self)) {
        return false;
      }
    }
  }

  return true;
}

function paintDrawsAgain(
  paint: Paint,
  sampled: [BitmapStore, number][] | null,
  self: BitmapStore | null,
): boolean {
  if (paint.type === "shader") {
    return false;
  }

  if (paint.type === "image" && paint.image instanceof BitmapStore) {
    if (paint.image === self) {
      return false;
    }

    sampled?.push([paint.image, paint.image.version]);
  }

  return true;
}

/** Whether anything in `o` has filters, which read past a tile's edge. */
function filtered(o: DisplayObject): boolean {
  if (o.filters.length > 0) {
    return true;
  }

  if (o instanceof Container) {
    for (const child of o.children) {
      if (filtered(child)) {
        return true;
      }
    }
  }

  return false;
}
