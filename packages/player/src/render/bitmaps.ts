// Bitmaps on the GPU: each renderer's textures of the bitmap stores it
// shows or draws into, and of the gradients its fills paint with.
import {
  BufferImageSource,
  Matrix,
  Container as PixiContainer,
  type Renderer,
  RenderTexture,
  Sprite,
  Texture,
} from "pixi.js";
import { BitmapStore, type GpuCopy } from "../bitmap/bitmap.js";
import { type Region as Area, RADIAL_MAX, radialPixels, ramp } from "../display/gradients.js";
import type { GradientFill } from "../display/shapes.js";
import type { BitmapCharacter } from "../display/timeline.js";
import { rgbaOf } from "./filters.js";

/**
 * Make a texture source report "clamp" for addressMode: Pixi turns a
 * fill's texture that says clamp-to-edge to repeating, while WebGL reads
 * each axis's mode, which stays clamped.
 */
function keepClamped(source: { style: object }): void {
  Object.defineProperty(source.style, "addressMode", { get: () => "clamp", set: () => {} });
}

/**
 * Destroy a texture a fill may have drawn with. Pixi keeps the bind group
 * of each unbatched Graphics' textures in a cache it never clears, and each
 * group that holds a texture warns as it is destroyed; nothing else listens
 * for the change. That cache keeps the source too, and a destroyed source
 * still keeps the options it was made with, the bytes it was uploaded from
 * among them: they go, so the cache holds a source's shell, not its pixels.
 */
function destroyTexture(texture: Texture): void {
  const source = texture.source;
  source.removeAllListeners("change");
  source.style.removeAllListeners("change");
  texture.destroy(true);
  (source as unknown as { options: { resource?: unknown } }).options.resource = undefined;
}

/** The store a SWF bitmap's fills draw from, one for all its shapes; null until its image is decoded. */
export function characterStore(character: BitmapCharacter): BitmapStore | null {
  if (!character.pixels) {
    return null;
  }

  character.store ??= BitmapStore.of(character.pixels);
  return character.store;
}

/** RGBA bytes read from a texture as premultiplied ARGB. */
export function argbOf(bytes: Uint8Array | Uint8ClampedArray): Uint32Array {
  const out = new Uint32Array(bytes.length / 4);
  for (let i = 0; i < out.length; i++) {
    const j = i * 4;
    out[i] = ((bytes[j + 3] << 24) | (bytes[j] << 16) | (bytes[j + 1] << 8) | bytes[j + 2]) >>> 0;
  }

  return out;
}

/**
 * A store's texture: its premultiplied ARGB exactly, uploaded as it is and
 * rendered into by draws. Pixi's collector never unloads it, as content a
 * draw left there could not be uploaded again.
 */
class StoreTexture implements GpuCopy {
  readonly source: BufferImageSource;
  readonly texture: Texture;
  /** The store's version the texture holds. */
  version = -1;
  /**
   * The same pixels sampled otherwise, copied on the GPU as the texture
   * changes: linearly for a smoothed Bitmap, and repeating or clamped,
   * either way, for bitmap fills; by "linear repeat".
   */
  private readonly variants = new Map<string, { texture: RenderTexture; version: number }>();

  constructor(
    private readonly renderer: Renderer,
    private readonly bitmaps: GpuBitmaps,
    width: number,
    height: number,
  ) {
    this.source = new BufferImageSource({
      // Bytes decide the format, 8 bits a channel; none allocate a float buffer.
      resource: new Uint8Array(0),
      width,
      height,
      alphaMode: "premultiplied-alpha",
      scaleMode: "nearest",
      autoGarbageCollect: false,
    });
    // No bytes until the CPU's are uploaded: the first use allocates the
    // texture without an upload, and a store of one colour is cleared to it.
    this.source.resource = null as unknown as Uint8Array;
    this.texture = new Texture({ source: this.source });
  }

  read(): Uint32Array {
    return argbOf(this.renderer.extract.pixels(this.texture).pixels);
  }

  /** The store's pixels on the GPU: cleared to their colour where they are all one, as a new bitmap's are, else uploaded. */
  upload(pixels: Uint32Array): void {
    const first = pixels[0];
    let uniform = true;
    for (let i = 1; i < pixels.length; i++) {
      if (pixels[i] !== first) {
        uniform = false;
        break;
      }
    }

    if (!uniform) {
      this.source.resource = rgbaOf(pixels);
      this.source.update();
      return;
    }

    // Already premultiplied, as the texture holds them; a byte divided by 255 comes back exactly.
    this.renderer.render({
      container: EMPTY,
      target: this.texture,
      clear: true,
      clearColor: [
        ((first >>> 16) & 0xff) / 255,
        ((first >>> 8) & 0xff) / 255,
        (first & 0xff) / 255,
        (first >>> 24) / 255,
      ],
    });
  }

  /**
   * The texture sampled linearly or not, repeating or clamped: a
   * texture's sampling is its source's in Pixi, so each way is a copy.
   */
  sampled(linear: boolean, repeat: boolean): Texture {
    const key = `${linear} ${repeat}`;
    let variant = this.variants.get(key);
    if (!variant) {
      const texture = RenderTexture.create({
        width: this.source.width,
        height: this.source.height,
        scaleMode: linear ? "linear" : "nearest",
        addressMode: repeat ? "repeat" : "clamp-to-edge",
        autoGarbageCollect: false,
      });
      if (!repeat) {
        keepClamped(texture.source);
      }

      variant = { texture, version: -1 };
      this.variants.set(key, variant);
    }

    if (variant.version !== this.version) {
      const sprite = new Sprite(this.texture);
      this.renderer.render({ container: sprite, target: variant.texture, clear: true });
      sprite.destroy();
      variant.version = this.version;
    }

    return variant.texture;
  }

  destroy(): void {
    this.bitmaps.forget(this);
    destroyTexture(this.texture);
    for (const { texture } of this.variants.values()) {
      destroyTexture(texture);
    }
  }
}

/**
 * The textures of a renderer's stores, one a store, made as a Bitmap shows
 * one or a draw renders into it. Each renderer keeps its own: a store
 * shown by two has a copy in each, and one a draw wrote is read back
 * through the renderer that drew it before another uploads it.
 */
class GpuBitmaps {
  private readonly limit: number;
  private readonly copies = new WeakMap<BitmapStore, StoreTexture>();
  private readonly collected = new FinalizationRegistry<StoreTexture>((copy) => copy.destroy());

  constructor(private readonly renderer: Renderer) {
    const gl = (renderer as unknown as { gl?: WebGL2RenderingContext }).gl;
    this.limit = gl ? gl.getParameter(gl.MAX_TEXTURE_SIZE) : 8192;
  }

  /**
   * The store's texture, made if it has none and uploaded if the CPU
   * changed the store since; null for one disposed, of 0 by 0, or larger
   * than a texture may be. Smoothed, it is a linearly sampled copy.
   */
  texture(store: BitmapStore, smoothing?: boolean): Texture | null {
    if (
      store.disposed ||
      store.width === 0 ||
      store.width > this.limit ||
      store.height > this.limit
    ) {
      return null;
    }

    let copy = this.copies.get(store);
    if (!copy) {
      copy = new StoreTexture(this.renderer, this, store.width, store.height);
      this.copies.set(store, copy);
      store.copies.add(copy);
      // Unregistered by the copy itself, on dispose.
      this.collected.register(store, copy, copy);
    }

    // Behind the store: its pixels, read back first if another renderer's draw wrote them.
    if (copy.version !== store.version) {
      copy.upload(store.pixels);
      copy.version = store.version;
    }

    return smoothing ? copy.sampled(true, false) : copy.texture;
  }

  /** The store's texture for a bitmap fill: repeating or clamped, smoothed or not, up to date. */
  fillTexture(store: BitmapStore, repeat: boolean, smooth: boolean): Texture | null {
    if (!this.texture(store)) {
      return null;
    }

    return (this.copies.get(store) as StoreTexture).sampled(smooth, repeat);
  }

  /** A draw rendered into this renderer's copy of the store, which now holds the store as it is. */
  drawn(store: BitmapStore): void {
    const copy = this.copies.get(store);
    if (copy) {
      store.drawnOnGpu(copy);
      copy.version = store.version;
    }
  }

  forget(copy: StoreTexture): void {
    this.collected.unregister(copy);
  }

  /**
   * Each gradient's textures by region: one for a linear gradient, one for
   * each region a radial one fills, which `drawPath` and `copyFrom` can make
   * several of, each held by the contexts that draw with it.
   */
  private readonly gradients = new WeakMap<GradientFill, Map<string, GradientTexture>>();

  /**
   * A gradient's texture and the matrix from its texels to the shape, made
   * once for each region and held: given back with `release` by each
   * context that took it, and freed when the last does: not when the fill
   * is collected, as a drawing cleared may drop it while a view still draws
   * the texture (`graphics.clear()` empties the layers the view holds too).
   * A linear one is its ramp of 256 colours, sampled nearest and
   * spread as the texture wraps, moved half a pixel so that a pixel's
   * centre reads what Flash reads at its corner. A radial one is computed
   * over the region it fills, a texel a pixel (up to RADIAL_MAX a side),
   * sampled linearly.
   */
  gradientTexture(fill: GradientFill, area: Area | null): GradientTexture {
    const region = area ?? { x: 0, y: 0, width: 1, height: 1 };
    const key = area ? `${area.x} ${area.y} ${area.width} ${area.height}` : "";
    let made = this.gradients.get(fill);
    if (!made) {
      made = new Map();
      this.gradients.set(fill, made);
    }

    const known = made.get(key);
    if (known) {
      known.uses++;
      return known;
    }

    const colors = ramp(fill.stops, fill.linearRgb);
    const m = fill.matrix;
    const columns = Math.min(RADIAL_MAX, region.width);
    const rows = Math.min(RADIAL_MAX, region.height);
    const clamped = fill.radial || fill.spread === 0;
    const source = new BufferImageSource({
      resource: rgbaOf(
        fill.radial
          ? radialPixels(colors, m, fill.focal, fill.spread, region, columns, rows)
          : colors,
      ),
      width: fill.radial ? columns : 256,
      height: fill.radial ? rows : 1,
      alphaMode: "premultiplied-alpha",
      scaleMode: fill.radial ? "linear" : "nearest",
      addressMode: clamped ? "clamp-to-edge" : fill.spread === 1 ? "mirror-repeat" : "repeat",
      autoGarbageCollect: false,
    });
    if (clamped) {
      keepClamped(source);
    }

    const texture = new Texture({ source });
    const matrix = fill.radial
      ? new Matrix(region.width / columns, 0, 0, region.height / rows, region.x, region.y)
      : new Matrix(1, 0, 0, 1, 0.5, 0.5)
          .append(new Matrix(m.a, m.b, m.c, m.d, m.tx, m.ty))
          // Texels to the gradient square, -819.2 to 819.2 a side.
          .append(new Matrix(1638.4 / 256, 0, 0, 1638.4, -819.2, -819.2));
    const byRegion = made;
    const entry: GradientTexture = {
      texture,
      matrix,
      uses: 1,
      release: () => {
        if (--entry.uses === 0) {
          byRegion.delete(key);
          destroyTexture(texture);
        }
      },
    };
    made.set(key, entry);
    return entry;
  }
}

/** A gradient's texture for a region, and how many contexts hold it. */
interface GradientTexture {
  texture: Texture;
  matrix: Matrix;
  uses: number;
  release: () => void;
}

const gpuBitmapsOf = new WeakMap<Renderer, GpuBitmaps>();
/** Nothing, rendered to clear a texture. */
const EMPTY = new PixiContainer();

export function gpuBitmaps(renderer: Renderer): GpuBitmaps {
  let bitmaps = gpuBitmapsOf.get(renderer);
  if (!bitmaps) {
    bitmaps = new GpuBitmaps(renderer);
    gpuBitmapsOf.set(renderer, bitmaps);
  }

  return bitmaps;
}
