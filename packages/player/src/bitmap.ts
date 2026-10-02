// A BitmapData's pixels, as Flash keeps them: ARGB, premultiplied by alpha,
// so that setPixel32 premultiplies and getPixel32 divides back, with the
// arithmetic Flash's does (Ruffle's bitmapdata_accuracy tabulates every
// alpha and value): premultiplied c' = (c * a + 127) / 255, and back
// c = min(255, (c' * floor(0xFF00 / a) + 127) >> 8), 0 for alpha 0. An
// opaque bitmap keeps every alpha at 255.

export interface PixelRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The reciprocals Flash divides alpha out with, 8.8 fixed point. */
const RECIPROCAL = new Uint32Array(256);
for (let a = 1; a < 256; a++) {
  RECIPROCAL[a] = Math.floor(0xff00 / a);
}

/** `argb` with its colour channels premultiplied by its alpha. */
export function premultiply(argb: number): number {
  const a = argb >>> 24;
  if (a === 255) {
    return argb >>> 0;
  }

  if (a === 0) {
    return 0;
  }

  const r = ((((argb >>> 16) & 0xff) * a + 127) / 255) | 0;
  const g = ((((argb >>> 8) & 0xff) * a + 127) / 255) | 0;
  const b = (((argb & 0xff) * a + 127) / 255) | 0;
  return ((a << 24) | (r << 16) | (g << 8) | b) >>> 0;
}

/** A premultiplied pixel with its alpha divided back out. */
export function unmultiply(pixel: number): number {
  const a = pixel >>> 24;
  if (a === 255) {
    return pixel >>> 0;
  }

  if (a === 0) {
    return 0;
  }

  const k = RECIPROCAL[a];
  const r = Math.min(255, ((((pixel >>> 16) & 0xff) * k + 127) >> 8) >>> 0);
  const g = Math.min(255, ((((pixel >>> 8) & 0xff) * k + 127) >> 8) >>> 0);
  const b = Math.min(255, (((pixel & 0xff) * k + 127) >> 8) >>> 0);
  return ((a << 24) | (r << 16) | (g << 8) | b) >>> 0;
}

/**
 * A store's copy on the GPU, where a renderer keeps one: a texture holding
 * the same premultiplied ARGB, which a draw may render into.
 */
export interface GpuCopy {
  /** The texture's pixels, read back: premultiplied ARGB, row by row. */
  read(): Uint32Array;
  /** Free the texture. */
  destroy(): void;
}

export class BitmapStore {
  private cpu: Uint32Array;
  /** The renderers' copies of the store, one each, for `dispose` to free. */
  readonly copies = new Set<GpuCopy>();
  /** The copy a draw wrote last, which reading `pixels` brings back while it is newer; null for none. */
  gpu: GpuCopy | null = null;
  /** Whether the GPU's copy was written last, so the CPU's is behind until read. */
  private gpuNewer = false;
  /** Counts each change, so a texture of the store knows to upload again. */
  version = 0;
  disposed = false;
  /**
   * The Bitmaps showing the store, told of each change so the renderer
   * looks at them; held weakly, so a Bitmap taken off the display list
   * and dropped is collected though the BitmapData lives on.
   */
  readonly views = new Set<WeakRef<{ pixelsChanged(disposed: boolean): void }>>();

  constructor(
    readonly width: number,
    readonly height: number,
    readonly transparent: boolean,
    fill: number,
  ) {
    this.cpu = new Uint32Array(width * height);
    this.cpu.fill(this.premultiplied(fill));
  }

  /**
   * Premultiplied ARGB, row by row. Reading them brings the GPU's copy
   * back first if a draw wrote it last, once: every CPU operation reads
   * them, so each sees the store as the GPU left it.
   */
  get pixels(): Uint32Array {
    if (this.gpuNewer && this.gpu) {
      this.cpu = this.gpu.read();
    }

    this.gpuNewer = false;
    return this.cpu;
  }

  set pixels(pixels: Uint32Array) {
    this.cpu = pixels;
    this.gpuNewer = false;
  }

  /** Whether the GPU's copy is newer than the CPU's, which a read of `pixels` would bring back. */
  get newerOnGpu(): boolean {
    return this.gpuNewer;
  }

  /** A draw wrote `copy`: the store changed, and the CPU's pixels and every other copy are behind it until read. */
  drawnOnGpu(copy: GpuCopy): void {
    this.gpu = copy;
    this.gpuNewer = true;
    this.changed();
  }

  /** A store of its own holding `pixels`, premultiplied already. */
  static of(pixels: {
    width: number;
    height: number;
    transparent: boolean;
    pixels: Uint32Array;
  }): BitmapStore {
    const store = new BitmapStore(pixels.width, pixels.height, pixels.transparent, 0);
    store.pixels.set(pixels.pixels);
    return store;
  }

  /** `argb` as this store keeps it: premultiplied, and opaque where the store is. */
  premultiplied(argb: number): number {
    return premultiply(this.transparent ? argb : argb | 0xff000000);
  }

  /** The rect clipped to the store: null where nothing of it lies within. */
  clip(r: PixelRect): PixelRect | null {
    const x0 = Math.max(0, r.x);
    const y0 = Math.max(0, r.y);
    const x1 = Math.min(this.width, r.x + r.width);
    const y1 = Math.min(this.height, r.y + r.height);
    if (x1 <= x0 || y1 <= y0) {
      return null;
    }

    return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
  }

  getPixel32(x: number, y: number): number {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) {
      return 0;
    }

    return unmultiply(this.pixels[y * this.width + x]);
  }

  getPixel(x: number, y: number): number {
    return this.getPixel32(x, y) & 0xffffff;
  }

  setPixel32(x: number, y: number, argb: number): void {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) {
      return;
    }

    this.pixels[y * this.width + x] = this.premultiplied(argb);
    this.changed();
  }

  /** The colour set, the alpha kept as it was. */
  setPixel(x: number, y: number, rgb: number): void {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) {
      return;
    }

    const alpha = unmultiply(this.pixels[y * this.width + x]) & 0xff000000;
    this.pixels[y * this.width + x] = this.premultiplied((alpha | (rgb & 0xffffff)) >>> 0);
    this.changed();
  }

  fillRect(r: PixelRect, argb: number): void {
    const c = this.clip(r);
    if (!c) {
      return;
    }

    const pixel = this.premultiplied(argb);
    for (let y = c.y; y < c.y + c.height; y++) {
      this.pixels.fill(pixel, y * this.width + c.x, y * this.width + c.x + c.width);
    }

    this.changed();
  }

  /**
   * Flash's copyPixels: the source rect's pixels at the destination point,
   * both clipped to their stores. With an alpha bitmap each premultiplied
   * channel is scaled by its alpha at the matching point, k = a, or 256
   * for 255, then shifted down 8, and where the alpha bitmap does not
   * reach, the destination is left as it was; Ruffle's
   * bitmapdata_copypixels_alpha_combine records Flash's 65,536 cases.
   * Without `mergeAlpha` the pixels replace the destination's; with it,
   * and always into an opaque destination, they go source over
   * destination, s + ((d * (256 - sa)) >> 8) a channel (the 160 cases of
   * bitmapdata_copypixels_alpha_merge).
   */
  copyPixels(
    source: BitmapStore,
    rect: PixelRect,
    dx: number,
    dy: number,
    mergeAlpha: boolean,
    alpha: BitmapStore | null = null,
    ax = 0,
    ay = 0,
  ): void {
    const s = source.clip(rect);
    if (!s) {
      return;
    }

    dx += s.x - rect.x;
    dy += s.y - rect.y;
    ax += s.x - rect.x;
    ay += s.y - rect.y;
    const d = this.clip({ x: dx, y: dy, width: s.width, height: s.height });
    if (!d) {
      return;
    }

    const sx = s.x + (d.x - dx);
    const sy = s.y + (d.y - dy);
    ax += d.x - dx;
    ay += d.y - dy;
    // In place, in Flash's order, which reads what it already wrote in one
    // direction (Ruffle's bitmapdata_copypixels_self): rows bottom-up when
    // the copy moves down without moving left, columns right to left when
    // it moves right.
    const up = source === this && d.y > sy && d.x >= sx;
    const left = source === this && d.x > sx;
    for (let r = 0; r < d.height; r++) {
      const row = up ? d.height - 1 - r : r;
      const to = (d.y + row) * this.width + d.x;
      const from = (sy + row) * source.width + sx;
      for (let c = 0; c < d.width; c++) {
        const i = left ? d.width - 1 - c : c;
        let p = source.pixels[from + i];
        if (alpha) {
          const mx = ax + i;
          const my = ay + row;
          if (mx < 0 || my < 0 || mx >= alpha.width || my >= alpha.height) {
            continue;
          }

          p = scale(p, alpha.pixels[my * alpha.width + mx] >>> 24);
        }

        if (!this.transparent) {
          this.pixels[to + i] = (over(p, this.pixels[to + i]) | 0xff000000) >>> 0;
        } else if (mergeAlpha) {
          this.pixels[to + i] = over(p, this.pixels[to + i]);
        } else {
          this.pixels[to + i] = p;
        }
      }
    }

    this.changed();
  }

  /** The rect's pixels, unmultiplied ARGB, row by row; the rect clipped to the store. */
  getVector(r: PixelRect): number[] {
    const c = this.clip(r);
    const out: number[] = [];
    if (!c) {
      return out;
    }

    for (let y = c.y; y < c.y + c.height; y++) {
      for (let x = c.x; x < c.x + c.width; x++) {
        out.push(unmultiply(this.pixels[y * this.width + x]));
      }
    }

    return out;
  }

  /** The rect's pixels as getPixels gives them: unmultiplied ARGB, big-endian, row by row; the rect clipped to the store. */
  argbBytes(rect: PixelRect): Uint8Array {
    const c = this.clip(rect);
    if (!c) {
      return new Uint8Array(0);
    }

    const pixels = this.pixels;
    const out = new Uint8Array(c.width * c.height * 4);
    let j = 0;
    for (let y = c.y; y < c.y + c.height; y++) {
      for (let i = y * this.width + c.x, end = i + c.width; i < end; i++, j += 4) {
        const p = unmultiply(pixels[i]);
        out[j] = p >>> 24;
        out[j + 1] = (p >>> 16) & 0xff;
        out[j + 2] = (p >>> 8) & 0xff;
        out[j + 3] = p & 0xff;
      }
    }

    return out;
  }

  /** The rect's pixels set from `values`, unmultiplied ARGB, row by row, as far as they go; how many it took. */
  setVector(r: PixelRect, values: ArrayLike<number>): number {
    const c = this.clip(r);
    if (!c) {
      return 0;
    }

    // As many as there are values, row by row; the rest stay.
    let k = 0;
    for (let y = c.y; y < c.y + c.height && k < values.length; y++) {
      for (let x = c.x; x < c.x + c.width && k < values.length; x++) {
        this.pixels[y * this.width + x] = this.premultiplied(values[k++] >>> 0);
      }
    }

    this.changed();
    return k;
  }

  clone(): BitmapStore {
    const copy = new BitmapStore(this.width, this.height, this.transparent, 0);
    copy.pixels.set(this.pixels);
    return copy;
  }

  dispose(): void {
    this.pixels = new Uint32Array(0);
    for (const copy of this.copies) {
      copy.destroy();
    }

    this.copies.clear();
    this.gpu = null;
    this.disposed = true;
    this.changed();
  }

  /** A change: counted, and told to each Bitmap showing the store. */
  changed(): void {
    this.version++;
    for (const ref of this.views) {
      const view = ref.deref();
      if (view) {
        view.pixelsChanged(this.disposed);
      } else {
        this.views.delete(ref);
      }
    }
  }
}

/** Source over destination, both premultiplied, as Flash does: s + ((d * (256 - sa)) >> 8) a channel. */
function over(s: number, d: number): number {
  const sa = s >>> 24;
  if (sa === 255) {
    return s >>> 0;
  }

  if (sa === 0) {
    return d >>> 0;
  }

  const k = 256 - sa;
  const channel = (shift: number) =>
    Math.min(255, ((s >>> shift) & 0xff) + ((((d >>> shift) & 0xff) * k) >> 8));
  return ((channel(24) << 24) | (channel(16) << 16) | (channel(8) << 8) | channel(0)) >>> 0;
}

/** A premultiplied pixel's channels scaled by an alpha, as Flash's alpha bitmap scales them. */
function scale(p: number, a: number): number {
  if (a === 255) {
    return p >>> 0;
  }

  const channel = (shift: number) => ((((p >>> shift) & 0xff) * a) >> 8) << shift;
  return (channel(24) | channel(16) | channel(8) | channel(0)) >>> 0;
}
