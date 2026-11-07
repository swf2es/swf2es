// The textures a shape's paints sample (RenderView): a bitmap store's
// pixels, uploaded again as they change, and a gradient's ramp or radial
// texture, kept by the region it covers. A store's texture is also its GPU
// copy (GpuCopy), which BitmapData.draw draws into on the GPU (RenderView's
// drawInto): it then holds the store's pixels alone, is shown as it is and
// never let go of for being idle, till a script reads the pixels back.
import {
  CLAMP,
  IDLE_FRAMES,
  MESH,
  MIRROR,
  REPEAT,
  SMOOTH,
  type TextureHandle,
  type Textures,
} from "@swf2es/render";
import {
  argbOf,
  BitmapStore,
  characterStore,
  type GpuCopy,
  type PixelRect,
  rgbaInto,
} from "../bitmap/bitmap.js";
import { type Region as Area, radialPixels, ramp } from "../display/gradients.js";
import type { GradientFill } from "../display/shapes.js";
import { makeRoom, moveLast, same } from "../display/value-lists.js";
import { type BitmapSampling, type Part, radialTexels } from "./shapes.js";

/**
 * How many frames a gradient's texture may go undrawn: a morph tweening a
 * gradient makes a new one for each ratio, up to a megabyte each, which
 * the usual idle frames would hold hundreds of.
 */
export const GRADIENT_IDLE_FRAMES = 30;

/** Regions a gradient's textures are kept for, as a shape that changes draws it over them. */
const GRADIENT_REGIONS = 8;

/** A texture made of pixels that change: a store's, kept as of its version. */
interface Kept {
  handle: TextureHandle;
  version: number;
  /** The texture as the store's GPU copy, once drawn into on the GPU. */
  copy: StoreCopy | null;
  /** Whether it is kept however long it goes undrawn, as it holds what was drawn alone. */
  pinned: boolean;
}

/** What a store's GPU copy asks of the renderer, on textures by id; each null or false where it cannot. */
export interface StoreGpu {
  /** Texture `id`'s `width` by `height` texels read back, premultiplied RGBA. */
  read(id: number, width: number, height: number): Uint8Array | null;
  /** A rectangle of texture `id` cleared to `pixel`, premultiplied ARGB. */
  fill(id: number, rect: PixelRect, pixel: number): boolean;
  /** A rectangle of texture `from` copied to (dx, dy) of `to`, as a memmove where they are one. */
  copy(from: number, rect: PixelRect, to: number, dx: number, dy: number): boolean;
}

/** A store's texture as its GPU copy: what a draw left there, read back as a script reads the store. */
class StoreCopy implements GpuCopy {
  version = -1;

  constructor(
    private readonly paints: Paints,
    private readonly store: BitmapStore,
    readonly handle: TextureHandle,
  ) {}

  read(): Uint32Array {
    const bytes = this.paints.readStore(this.handle, this.store.width, this.store.height);
    // Gone with a lost context: what the CPU held before the draws.
    return bytes ? argbOf(bytes) : this.store.lostOnGpu(this);
  }

  copy(source: BitmapStore, rect: PixelRect, dx: number, dy: number): boolean {
    return this.paints.copyStore(source, rect, this.handle, dx, dy);
  }

  fill(rect: PixelRect, pixel: number): boolean {
    return this.paints.fillStore(this.handle, rect, pixel);
  }

  destroy(): void {
    this.paints.release(this.store, this.handle);
  }
}

/** Bitmaps' and gradients' textures, made as first drawn and kept while they are. */
export class Paints {
  private readonly stores = new WeakMap<BitmapStore, Kept>();
  /** Each gradient's textures, by the region a radial one covers (null for a linear one), the latest used last. */
  private readonly gradients = new WeakMap<
    GradientFill,
    { region: Area | null; handle: TextureHandle }[]
  >();

  /** A store's texture held for draws alone let go of if the store is collected undisposed. */
  private readonly collected = new FinalizationRegistry<TextureHandle>((handle) => {
    if (this.textures.alive(handle)) {
      this.textures.remove(handle.id);
    }
  });

  constructor(
    private readonly textures: Textures,
    private readonly gpu: StoreGpu | null = null,
  ) {}

  /**
   * The texture a part's paint or mesh samples: its bitmap's, else null till
   * it is decoded, or its gradient's.
   */
  paintTexture(part: Part): TextureHandle | null {
    if (part.mesh) {
      const store = part.mesh.image;
      return store.disposed ? null : this.storeTexture(store);
    }

    const paint = part.paint as BitmapSampling | GradientFill;
    if (paint.type === "image") {
      const store = paint.image instanceof BitmapStore ? paint.image : characterStore(paint.image);
      return store && !store.disposed ? this.storeTexture(store) : null;
    }

    return this.gradientTexture(paint, part.region);
  }

  /**
   * `store`'s texture, its pixels as drawn (`drawable`) uploaded again if
   * they changed since, converted into the bytes the texture keeps (Textures'
   * `bytes`), so that a store drawn into every frame allocates none.
   */
  storeTexture(store: BitmapStore, idle?: number): TextureHandle {
    const kept = this.stores.get(store);
    if (kept && this.textures.alive(kept.handle)) {
      const id = kept.handle.id;
      // What was drawn into the texture is newest there: shown as it is.
      if (kept.copy !== null && store.gpu === kept.copy && store.newerOnGpu) {
        return kept.handle;
      }

      // Read back since: idle again as any other.
      if (kept.pinned) {
        kept.pinned = false;
        this.collected.unregister(kept);
        this.textures.idleFor(id, idle ?? IDLE_FRAMES);
      }

      if (kept.version !== store.version) {
        kept.version = store.version;
        this.textures.set(id, store.width, store.height, this.bytesOf(store, id), idle);
      } else if (idle !== undefined) {
        this.textures.idleWithin(id, idle);
      }

      return kept.handle;
    }

    // A texture a draw alone wrote, gone with a lost context: the CPU's pixels are the store's again.
    if (kept?.copy && store.gpu === kept.copy) {
      store.lostOnGpu(kept.copy);
    }

    if (kept) {
      store.copies.delete(kept.copy as GpuCopy);
      this.collected.unregister(kept);
    }

    const bytes = this.bytesOf(store, -1);
    const handle = this.textures.add(store.width, store.height, bytes, idle);
    this.stores.set(store, { handle, version: store.version, copy: null, pinned: false });
    return handle;
  }

  /**
   * `store` drawn into on the GPU, its texture (`storeTexture`) the newest
   * of its pixels now: kept however long it goes undrawn, till they are
   * read back, the store disposed or collected.
   */
  drawn(store: BitmapStore): void {
    const kept = this.stores.get(store);
    if (!kept) {
      return;
    }

    if (!kept.copy) {
      kept.copy = new StoreCopy(this, store, kept.handle);
      store.copies.add(kept.copy);
    }

    store.drawnOnGpu(kept.copy);
    kept.version = store.version;
    if (!kept.pinned) {
      kept.pinned = true;
      this.textures.idleFor(kept.handle.id, Number.POSITIVE_INFINITY);
      this.collected.register(store, kept.handle, kept);
    }
  }

  /** Texture `handle`'s pixels read back for a store `width` by `height`; null once it is gone. */
  readStore(handle: TextureHandle, width: number, height: number): Uint8Array | null {
    return this.gpu && this.textures.alive(handle) ? this.gpu.read(handle.id, width, height) : null;
  }

  /** `rect` of texture `handle` cleared to `pixel`: a store's fill on the GPU. */
  fillStore(handle: TextureHandle, rect: PixelRect, pixel: number): boolean {
    return !!this.gpu && this.textures.alive(handle) && this.gpu.fill(handle.id, rect, pixel);
  }

  /**
   * `rect` of `source` copied to (dx, dy) of texture `handle`, a store's
   * copy on the GPU: the source's texture first made of its pixels where
   * they are newer, as when it is drawn. Not from an opaque store holding
   * alpha, whose texture holds its pixels as drawn, not as they are.
   */
  copyStore(
    source: BitmapStore,
    rect: PixelRect,
    handle: TextureHandle,
    dx: number,
    dy: number,
  ): boolean {
    if (!this.gpu || !this.textures.alive(handle) || source.disposed || source.holdsAlpha) {
      return false;
    }

    const from = this.storeTexture(source);
    return this.textures.alive(handle) && this.gpu.copy(from.id, rect, handle.id, dx, dy);
  }

  /** `store`'s texture let go of, as the store is disposed. */
  release(store: BitmapStore, handle: TextureHandle): void {
    const kept = this.stores.get(store);
    if (kept?.handle === handle) {
      this.stores.delete(store);
      this.collected.unregister(kept);
    }

    if (this.textures.alive(handle)) {
      this.textures.remove(handle.id);
    }
  }

  /**
   * `store`'s pixels as drawn, in bytes Textures lends for texture `id`: an
   * opaque store holding alpha made opaque as they are converted, rather
   * than through a copy of its own.
   */
  private bytesOf(store: BitmapStore, id: number): Uint8Array {
    const pixels = store.readable;
    const bytes = this.textures.bytes(pixels.length * 4, id);
    rgbaInto(pixels, bytes, store.holdsAlpha);
    return bytes;
  }

  /** Premultiplied ARGB in bytes Textures lends. */
  private rgba(pixels: Uint32Array): Uint8Array {
    const bytes = this.textures.bytes(pixels.length * 4);
    rgbaInto(pixels, bytes);
    return bytes;
  }

  /**
   * A gradient's texture: a linear one's ramp of 256 colours, a radial one
   * computed over its region, a texel a pixel up to 512 a side
   * (display/gradients.ts).
   */
  private gradientTexture(fill: GradientFill, region: Area | null): TextureHandle {
    let made = this.gradients.get(fill);
    if (!made) {
      made = [];
      this.gradients.set(fill, made);
    }

    // By its region's numbers, the latest used first: a fill is drawn over one region, or a few
    // as its shape changes.
    let known: { region: Area | null; handle: TextureHandle } | null = null;
    for (let i = made.length - 1; i >= 0; i--) {
      const r = made[i].region;
      if (
        r === region ||
        (r &&
          region &&
          same(r.x, region.x) &&
          same(r.y, region.y) &&
          same(r.width, region.width) &&
          same(r.height, region.height))
      ) {
        known = i === made.length - 1 ? made[i] : moveLast(made, i);
        break;
      }
    }

    if (known && this.textures.alive(known.handle)) {
      return known.handle;
    }

    const colors = ramp(fill.stops, fill.linearRgb);
    let handle: TextureHandle;
    if (fill.radial && region) {
      const columns = radialTexels(region.width);
      const rows = radialTexels(region.height);
      const pixels = radialPixels(
        colors,
        fill.matrix,
        fill.focal,
        fill.spread,
        region,
        columns,
        rows,
      );
      handle = this.textures.add(columns, rows, this.rgba(pixels), GRADIENT_IDLE_FRAMES);
    } else {
      handle = this.textures.add(colors.length, 1, this.rgba(colors), GRADIENT_IDLE_FRAMES);
    }

    // Its region's texture made again, or a new region's kept: those let go of forgotten, and the
    // least lately used past GRADIENT_REGIONS.
    if (known) {
      known.handle = handle;
    } else {
      const list = made;
      makeRoom(
        list,
        GRADIENT_REGIONS,
        (e) => !this.textures.alive(e.handle),
        (e) => {
          if (this.textures.alive(e.handle)) {
            this.textures.remove(e.handle.id);
          }
        },
      );
      list.push({ region: region && { ...region }, handle });
    }

    return handle;
  }
}

/**
 * How a part's paint is sampled. A bitmap fill, or a mesh's bitmap:
 * smoothed if it asks and `smoothing` (RenderView.smoothing), repeated or
 * clamped. A linear gradient's ramp: texel by texel, spread as it wraps; a
 * radial one's, smoothed.
 */
export function paintSampler(part: Part, smoothing: boolean): number {
  const mesh = part.mesh;
  if (mesh) {
    return MESH | (mesh.smooth && smoothing ? SMOOTH : 0) | (mesh.repeat ? REPEAT : CLAMP);
  }

  const paint = part.paint as BitmapSampling | GradientFill;
  if (paint.type === "image") {
    return (paint.smooth && smoothing ? SMOOTH : 0) | (paint.repeat ? REPEAT : CLAMP);
  }

  if (paint.radial) {
    return SMOOTH | CLAMP;
  }

  return paint.spread === 1 ? MIRROR : paint.spread === 2 ? REPEAT : CLAMP;
}
