// The textures a shape's paints sample (RenderView): a bitmap store's
// pixels, uploaded again as they change, and a gradient's ramp or radial
// texture, kept by the region it covers.
import {
  CLAMP,
  MESH,
  MIRROR,
  REPEAT,
  SMOOTH,
  type TextureHandle,
  type Textures,
} from "@swf2es/render";
import { BitmapStore, characterStore, rgbaOf } from "../bitmap/bitmap.js";
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
}

/** Bitmaps' and gradients' textures, made as first drawn and kept while they are. */
export class Paints {
  private readonly stores = new WeakMap<BitmapStore, Kept>();
  /** Each gradient's textures, by the region a radial one covers (null for a linear one), the latest used last. */
  private readonly gradients = new WeakMap<
    GradientFill,
    { region: Area | null; handle: TextureHandle }[]
  >();

  constructor(private readonly textures: Textures) {}

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

  /** `store`'s texture, its pixels uploaded again if they changed since. */
  storeTexture(store: BitmapStore, idle?: number): TextureHandle {
    const kept = this.stores.get(store);
    if (kept && this.textures.alive(kept.handle)) {
      if (kept.version !== store.version) {
        kept.version = store.version;
        this.textures.set(kept.handle.id, store.width, store.height, rgbaOf(store.readable));
      }

      return kept.handle;
    }

    const handle = this.textures.add(store.width, store.height, rgbaOf(store.readable), idle);
    this.stores.set(store, { handle, version: store.version });
    return handle;
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
      handle = this.textures.add(columns, rows, rgbaOf(pixels), GRADIENT_IDLE_FRAMES);
    } else {
      handle = this.textures.add(colors.length, 1, rgbaOf(colors), GRADIENT_IDLE_FRAMES);
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
