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

export class BitmapStore {
  /** Premultiplied ARGB, row by row. */
  pixels: Uint32Array;
  /** Counts each change, so a sprite drawn from the store knows to upload again. */
  version = 0;
  disposed = false;

  constructor(
    readonly width: number,
    readonly height: number,
    readonly transparent: boolean,
    fill: number,
  ) {
    this.pixels = new Uint32Array(width * height);
    this.pixels.fill(this.premultiplied(fill));
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
    this.version++;
  }

  /** The colour set, the alpha kept as it was. */
  setPixel(x: number, y: number, rgb: number): void {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) {
      return;
    }

    const alpha = unmultiply(this.pixels[y * this.width + x]) & 0xff000000;
    this.pixels[y * this.width + x] = this.premultiplied((alpha | (rgb & 0xffffff)) >>> 0);
    this.version++;
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

    this.version++;
  }

  /**
   * Flash's copyPixels: the source rect's pixels at the destination point,
   * both clipped to their stores. Without `mergeAlpha` the pixels replace
   * the destination's; with it they are composited over, source over
   * destination, as they always are into an opaque destination.
   */
  copyPixels(
    source: BitmapStore,
    rect: PixelRect,
    dx: number,
    dy: number,
    mergeAlpha: boolean,
  ): void {
    const s = source.clip(rect);
    if (!s) {
      return;
    }

    dx += s.x - rect.x;
    dy += s.y - rect.y;
    const d = this.clip({ x: dx, y: dy, width: s.width, height: s.height });
    if (!d) {
      return;
    }

    const sx = s.x + (d.x - dx);
    const sy = s.y + (d.y - dy);
    for (let row = 0; row < d.height; row++) {
      const from = (sy + row) * source.width + sx;
      const to = (d.y + row) * this.width + d.x;
      for (let i = 0; i < d.width; i++) {
        const p = source.pixels[from + i];
        if (!this.transparent) {
          // An opaque destination composites whatever it is given, as Flash does without mergeAlpha too.
          this.pixels[to + i] = (over(p, this.pixels[to + i]) | 0xff000000) >>> 0;
        } else if (mergeAlpha) {
          this.pixels[to + i] = over(p, this.pixels[to + i]);
        } else {
          this.pixels[to + i] = p;
        }
      }
    }

    this.version++;
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

  /** The rect's pixels set from `values`, unmultiplied ARGB, row by row; how many it took. */
  setVector(r: PixelRect, values: ArrayLike<number>): number {
    const c = this.clip(r);
    if (!c) {
      return 0;
    }

    let k = 0;
    for (let y = c.y; y < c.y + c.height; y++) {
      for (let x = c.x; x < c.x + c.width; x++) {
        this.pixels[y * this.width + x] = this.premultiplied(values[k++] >>> 0);
      }
    }

    this.version++;
    return k;
  }

  clone(): BitmapStore {
    const copy = new BitmapStore(this.width, this.height, this.transparent, 0);
    copy.pixels.set(this.pixels);
    return copy;
  }

  dispose(): void {
    this.pixels = new Uint32Array(0);
    this.disposed = true;
    this.version++;
  }
}

/** Source over destination, both premultiplied: s + d * (1 - sa), each channel rounded. */
function over(s: number, d: number): number {
  const sa = s >>> 24;
  if (sa === 255) {
    return s >>> 0;
  }

  if (sa === 0) {
    return d >>> 0;
  }

  const k = 255 - sa;
  const channel = (shift: number) =>
    Math.min(255, (((s >>> shift) & 0xff) + (((d >>> shift) & 0xff) * k + 127) / 255) | 0);
  return ((channel(24) << 24) | (channel(16) << 16) | (channel(8) << 8) | channel(0)) >>> 0;
}
