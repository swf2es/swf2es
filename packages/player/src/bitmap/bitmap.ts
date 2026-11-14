// A BitmapData's pixels, as Flash keeps them: ARGB, premultiplied by alpha,
// so that setPixel32 premultiplies and getPixel32 divides back, with the
// arithmetic Flash's does (Ruffle's bitmapdata_accuracy tabulates every
// alpha and value): premultiplied c' = (c * a + 127) / 255, and back
// c = min(255, (c' * floor(0xFF00 / a) + 127) >> 8), 0 for alpha 0. An
// opaque bitmap keeps every alpha at 255.
import {
  WORDS_PLAIN,
  WORDS_PREMULTIPLY,
  WORDS_SOLID,
  WORDS_UNMULTIPLY,
} from "@swf2es/native/render";
import type { BitmapCharacter, BitmapPixels } from "../display/timeline.js";
import { bitmapKernel } from "./kernel.js";
import type { PixelRect } from "./pixel-rect.js";

/** No gaps, shared by every copy that leaves none. */
const NO_GAPS: readonly PixelRect[] = [];
/** The fewest pixels copyPixels blends in the native module rather than here. */
const NATIVE_OVER = 2048;
const OVER = { op: "over" } as const;

/** The reciprocals Flash divides alpha out with, 8.8 fixed point. */
const RECIPROCAL = new Uint32Array(256);
for (let a = 1; a < 256; a++) {
  RECIPROCAL[a] = Math.floor(0xff00 / a);
}

/**
 * `argb` with its colour channels premultiplied by its alpha: each the
 * nearest whole number to c * a / 255, which (t + (t >> 8)) >> 8 of
 * t = c * a + 128 is with no division, red and blue at once in the two
 * halves of a word. No test but the solid pixel's, which most are: a run
 * of every alpha takes the one way through.
 */
export function premultiply(argb: number): number {
  const a = argb >>> 24;
  if (a === 255) {
    return argb >>> 0;
  }

  const rb = (Math.imul(argb & 0xff00ff, a) + 0x800080) | 0;
  const g = ((argb >>> 8) & 0xff) * a + 0x80;
  return (
    ((a << 24) |
      (((rb + ((rb >>> 8) & 0xff00ff)) >>> 8) & 0xff00ff) |
      ((g + (g >>> 8)) & 0xff00)) >>>
    0
  );
}

/** A premultiplied pixel with its alpha divided back out; a clear one's reciprocal is 0, and so is it. */
export function unmultiply(pixel: number): number {
  const a = pixel >>> 24;
  if (a === 255) {
    return pixel >>> 0;
  }

  const k = RECIPROCAL[a];
  const r = Math.min(255, (((pixel >>> 16) & 0xff) * k + 127) >> 8);
  const g = Math.min(255, (((pixel >>> 8) & 0xff) * k + 127) >> 8);
  const b = Math.min(255, ((pixel & 0xff) * k + 127) >> 8);
  return ((a << 24) | (r << 16) | (g << 8) | b) >>> 0;
}

/**
 * Whether a typed array's words are little-endian here: a store's pixels
 * are ARGB words in the host's order, so a ByteArray's bytes in the same
 * order are its words as they are, and in the other each reversed.
 */
const HOST_LITTLE = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;

/** `w` with its four bytes in the other order. */
function reversed(w: number): number {
  return (w << 24) | ((w & 0xff00) << 8) | ((w >>> 8) & 0xff00) | (w >>> 24);
}

// A run of pixels set from or read into words, each kind by a loop of its
// own with nothing to decide inside: the byte order, whether the store is
// opaque and what holds the words are settled once a call, not once a
// pixel, and each loop sees one kind of array.

/** `n` of `pixels` from `to` set from unmultiplied ARGB `words` from `from`, reversed first where `swap`. */
function setRun(
  pixels: Uint32Array,
  to: number,
  words: Uint32Array,
  from: number,
  n: number,
  swap: boolean,
  transparent: boolean,
): void {
  if (!transparent) {
    // Alpha 255 premultiplies to itself.
    if (swap) {
      for (let i = 0; i < n; i++) {
        pixels[to + i] = reversed(words[from + i]) | 0xff000000;
      }
    } else {
      for (let i = 0; i < n; i++) {
        pixels[to + i] = words[from + i] | 0xff000000;
      }
    }
  } else if (swap) {
    for (let i = 0; i < n; i++) {
      pixels[to + i] = premultiply(reversed(words[from + i]));
    }
  } else {
    for (let i = 0; i < n; i++) {
      pixels[to + i] = premultiply(words[from + i]);
    }
  }
}

/** `setRun` from a Vector's elements, an array of numbers. */
function setRunOf(
  pixels: Uint32Array,
  to: number,
  values: ArrayLike<number>,
  from: number,
  n: number,
  transparent: boolean,
): void {
  if (transparent) {
    for (let i = 0; i < n; i++) {
      pixels[to + i] = premultiply(values[from + i] | 0);
    }
  } else {
    for (let i = 0; i < n; i++) {
      pixels[to + i] = values[from + i] | 0xff000000;
    }
  }
}

/** `n` of `words` from `from` into `values` from `to`, as they are. */
function valuesOf(values: number[], to: number, words: Uint32Array, from: number, n: number): void {
  for (let i = 0; i < n; i++) {
    values[to + i] = words[from + i];
  }
}

/**
 * The fewest pixels of a run that the native module makes rather than the
 * loops here: four at a time there, but copied in and out.
 */
const NATIVE_WORDS = 1024;

/**
 * A Vector's elements on their way from the native module, which writes
 * no array of numbers: so many at a time, as words that stay in the
 * processor's cache between the two.
 */
const SCRATCH = new Uint32Array(1 << 14);

/** The bytes of `n` of `words` from `at`. */
function bytesOf(words: Uint32Array, at: number, n: number): Uint8Array {
  return new Uint8Array(words.buffer, words.byteOffset + at * 4, n * 4);
}

/**
 * The native module for runs of `run` pixels, or null: where they are too
 * few, where the realm refused it, and where the host's words are not in
 * its order, little-endian, in which it reads the store's.
 */
function wordsKernel(run: number) {
  return run >= NATIVE_WORDS && HOST_LITTLE ? bitmapKernel() : null;
}

/** `n` of `pixels` from `from` read into `words` from `to` as their values, reversed where `swap`. */
function getRun(
  words: Uint32Array,
  to: number,
  pixels: Uint32Array,
  from: number,
  n: number,
  swap: boolean,
  transparent: boolean,
): void {
  if (!transparent) {
    // An opaque store's pixels are their values.
    if (swap) {
      for (let i = 0; i < n; i++) {
        words[to + i] = reversed(pixels[from + i]);
      }
    } else {
      words.set(pixels.subarray(from, from + n), to);
    }
  } else if (swap) {
    for (let i = 0; i < n; i++) {
      words[to + i] = reversed(unmultiply(pixels[from + i]));
    }
  } else {
    for (let i = 0; i < n; i++) {
      words[to + i] = unmultiply(pixels[from + i]);
    }
  }
}

/** `getRun` into a Vector's elements, an array of numbers. */
function getRunOf(
  values: number[],
  to: number,
  pixels: Uint32Array,
  from: number,
  n: number,
  transparent: boolean,
): void {
  if (transparent) {
    for (let i = 0; i < n; i++) {
      values[to + i] = unmultiply(pixels[from + i]);
    }
  } else {
    for (let i = 0; i < n; i++) {
      values[to + i] = pixels[from + i];
    }
  }
}

/** As many zeros as `packedDoubles` copies at once. */
const ZEROS_LENGTH = 1 << 15;
const ZEROS: number[] = [0.5];
ZEROS.pop();
while (ZEROS.length < ZEROS_LENGTH) {
  ZEROS.push(0);
}

/**
 * An array of `length` zeros as a Vector.<uint> keeps its elements, packed
 * doubles (vector-elements.ts), made at once: pushed one by one it grows
 * over and over, each time copied, which cost more than reading a bitmap's
 * pixels into it; `new Array(length)` is made at once but has holes, and
 * a site that stores into one such array takes every Vector's elements
 * for holey from then on. A slice or a concat of packed doubles is packed
 * doubles, allocated once at its length.
 */
function packedDoubles(length: number): number[] {
  if (length <= ZEROS_LENGTH) {
    return ZEROS.slice(0, length);
  }

  const parts: number[][] = [];
  for (let left = length - ZEROS_LENGTH; left >= ZEROS_LENGTH; left -= ZEROS_LENGTH) {
    parts.push(ZEROS);
  }

  parts.push(ZEROS.slice(0, length % ZEROS_LENGTH));
  return ZEROS.concat(...parts);
}

/**
 * A store's copy on the GPU, where a renderer keeps one: a texture holding
 * the same premultiplied ARGB, which a draw may render into.
 */
export interface GpuCopy {
  /** The store's version the texture holds. */
  version: number;
  /** The texture's pixels, read back: premultiplied ARGB, row by row. */
  read(): Uint32Array;
  /**
   * `rect` of `source`, within it, put at (dx, dy) in the texture, which it
   * fits, replacing what was there: as a memmove where `source` is this
   * store. False, having done nothing, where `source` can have no texture.
   */
  copy(source: BitmapStore, rect: PixelRect, dx: number, dy: number): boolean;
  /** `rect`, within the store, set to `pixel`, premultiplied ARGB. */
  fill(rect: PixelRect, pixel: number): boolean;
  /** Free the texture. */
  destroy(): void;
}

export class BitmapStore {
  private cpu: Uint32Array;
  /**
   * Whether `cpu` is a library bitmap's pixels, which every store made of it
   * shares: copied before it is first written, so an atlas a SWF only reads
   * from is one array, not one for the library and one for each BitmapData.
   */
  private shared = false;
  /** The renderers' copies of the store, one each, for `dispose` to free. */
  readonly copies = new Set<GpuCopy>();
  /** The copy a draw wrote last, which reading `pixels` brings back while it is newer; null for none. */
  gpu: GpuCopy | null = null;
  /** Whether the GPU's copy was written last, so the CPU's is behind until read. */
  private gpuNewer = false;
  /** Counts each change, so a texture of the store knows to upload again. */
  version = 0;
  /**
   * Whether the store is opaque but holds pixels below alpha 255, which
   * erase and alpha leave in one (drawBitmap), as Flash's memory does.
   * Its pixels then read two ways (adl): as they are, by what reads their
   * values (getPixel32, getPixels, getVector, clone, compare, floodFill,
   * Context3D's upload, a ShaderJob's input, unmultiplied), and opaque,
   * alpha 255 over the premultiplied colour, by what draws or copies them
   * (draw, copyPixels, encode, the screen, hitTest's alpha): `drawable`.
   */
  holdsAlpha = false;
  /** `drawable`'s pixels and the version they are of, while the store holds alpha. */
  private opaqueCopy: Uint32Array | null = null;
  private opaqueVersion = -1;
  disposed = false;
  /**
   * The Bitmaps showing the store, told of each change so the renderer
   * looks at them; held weakly, so a Bitmap taken off the display list
   * and dropped is collected though the BitmapData lives on.
   */
  readonly views = new Set<WeakRef<{ pixelsChanged(disposed: boolean): void }>>();

  /** `shared`, where given, is the pixels it holds, its own until written: see `of`. */
  constructor(
    readonly width: number,
    readonly height: number,
    readonly transparent: boolean,
    fill: number,
    shared?: Uint32Array,
  ) {
    if (shared) {
      this.cpu = shared;
      this.shared = true;
      return;
    }

    this.cpu = new Uint32Array(width * height);
    this.cpu.fill(this.premultiplied(fill));
  }

  /**
   * Premultiplied ARGB, row by row, to read and write. Reading them brings
   * the GPU's copy back first if a draw wrote it last, once: every CPU
   * operation reads them, so each sees the store as the GPU left it. Shared
   * pixels are copied first, as they may be written.
   */
  get pixels(): Uint32Array {
    const pixels = this.readable;
    if (this.shared) {
      this.cpu = pixels.slice();
      this.shared = false;
    }

    return this.cpu;
  }

  set pixels(pixels: Uint32Array) {
    this.cpu = pixels;
    this.shared = false;
    this.gpuNewer = false;
  }

  /**
   * The pixels as `pixels` gives them, to read only, never to write: shared
   * pixels stay shared. An operation that writes a store and reads another,
   * which may be the same, takes the one it writes first, so both are one array.
   */
  get readable(): Uint32Array {
    if (this.gpuNewer && this.gpu) {
      this.cpu = this.gpu.read();
      this.shared = false;
    }

    this.gpuNewer = false;
    return this.cpu;
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
    copy.version = this.version;
  }

  /**
   * The pixels for `copy` to upload once its context was lost and given
   * back: the CPU's, a draw only the copy held lost with it, not read back
   * from the texture, which is empty now.
   */
  lostOnGpu(copy: GpuCopy): Uint32Array {
    if (this.gpu === copy) {
      this.gpu = null;
      this.gpuNewer = false;
    }

    return this.readable;
  }

  /**
   * `op` done on the GPU's copy where that is newer, so the pixels stay
   * there: an operation after a draw would otherwise wait for the GPU and
   * bring the whole store back, on every frame of a SWF that draws and then
   * scrolls, fills or copies. Only an operation the GPU does exactly takes
   * this way: moves of whole pixels and fills, never arithmetic. Whether
   * it was done.
   */
  onGpu(op: (copy: GpuCopy) => boolean): boolean {
    const copy = this.gpu;
    if (!this.gpuNewer || !copy || !op(copy)) {
      return false;
    }

    // The op may have read the pixels back, for a texture of this store that
    // was behind: the CPU then holds them as they were before it.
    this.gpuNewer = true;
    this.changed();
    copy.version = this.version;
    return true;
  }

  /**
   * A store of its own holding `pixels`, premultiplied already, which are
   * never written: the store shares them until it is.
   */
  static of(pixels: {
    width: number;
    height: number;
    transparent: boolean;
    pixels: Uint32Array;
  }): BitmapStore {
    return new BitmapStore(pixels.width, pixels.height, pixels.transparent, 0, pixels.pixels);
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

    return this.unmultiplied(this.readable[y * this.width + x]);
  }

  /**
   * A stored pixel as its value reads back: unmultiplied, but an opaque
   * bitmap's as it is, which is the same but where it holds alpha.
   */
  unmultiplied(p: number): number {
    return this.transparent ? unmultiply(p) : p;
  }

  /**
   * The pixels as a draw, a copy or the screen reads them, to read only:
   * `readable`, but where an opaque store holds alpha, a copy at alpha 255.
   */
  get drawable(): Uint32Array {
    const pixels = this.readable;
    if (!this.holdsAlpha) {
      return pixels;
    }

    if (this.opaqueCopy === null || this.opaqueVersion !== this.version) {
      const copy =
        this.opaqueCopy?.length === pixels.length
          ? this.opaqueCopy
          : new Uint32Array(pixels.length);
      for (let i = 0; i < pixels.length; i++) {
        copy[i] = (pixels[i] | 0xff000000) >>> 0;
      }

      this.opaqueCopy = copy;
      this.opaqueVersion = this.version;
    }

    return this.opaqueCopy;
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
    if (this.onGpu((copy) => copy.fill(c, pixel))) {
      return;
    }

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
   * bitmapdata_copypixels_alpha_merge). In place, a rect reaching past
   * the bitmap's left or top edge may leave a gap (copyGaps).
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
    const gaps = source === this ? this.copyGaps(rect, dx, dy) : NO_GAPS;
    // The point and alpha point as given, which the gaps are written from.
    const gx = dx;
    const gy = dy;
    const gax = ax;
    const gay = ay;
    const s = source.clip(rect);
    const d =
      s &&
      this.clip({ x: dx + s.x - rect.x, y: dy + s.y - rect.y, width: s.width, height: s.height });
    if (!s || !d) {
      if (gaps.length) {
        this.fillGaps(gaps, source, gx, gy, mergeAlpha, alpha, gax, gay);
        this.changed();
      }

      return;
    }

    dx += s.x - rect.x;
    dy += s.y - rect.y;
    ax += s.x - rect.x;
    ay += s.y - rect.y;
    const sx = s.x + (d.x - dx);
    const sy = s.y + (d.y - dy);
    ax += d.x - dx;
    ay += d.y - dy;
    // A plain replacement, where the pixels land as they are: an opaque
    // source's go over anything unchanged, and a gap is empty. In place,
    // all but a move down and left, which Flash's order smears, are a
    // memmove.
    const replaces =
      !alpha && !source.holdsAlpha && (!source.transparent || (this.transparent && !mergeAlpha));
    const smears = source === this && d.y > sy && d.x < sx;
    if (
      replaces &&
      !smears &&
      this.onGpu(
        (copy) =>
          copy.copy(source, { x: sx, y: sy, width: d.width, height: d.height }, d.x, d.y) &&
          gaps.every((gap) => copy.fill(gap, source.transparent ? 0 : 0xff000000)),
      )
    ) {
      return;
    }

    // In place, in Flash's order, which reads what it already wrote in one
    // direction (Ruffle's bitmapdata_copypixels_self): rows bottom-up when
    // the copy moves down without moving left, columns right to left when
    // it moves right.
    const up = source === this && d.y > sy && d.x >= sx;
    const left = source === this && d.x > sx;
    // The arrays taken once, the written one first: a source or alpha that is this store reads
    // it too, and so what the copy already wrote. A source that holds alpha is copied opaque, as
    // a draw reads it; within itself, as it is.
    const into = this.pixels;
    const pixels = source !== this && source.holdsAlpha ? source.drawable : source.readable;
    const mask = alpha?.readable ?? null;
    const maskWidth = alpha?.width ?? 0;
    const maskHeight = alpha?.height ?? 0;

    if (replaces && !smears) {
      // Each row moved whole: in place a memmove, which Flash's order is but for a smear.
      for (let r = 0; r < d.height; r++) {
        const row = up ? d.height - 1 - r : r;
        const to = (d.y + row) * this.width + d.x;
        const from = (sy + row) * source.width + sx;
        if (into === pixels) {
          into.copyWithin(to, from, from + d.width);
        } else {
          into.set(pixels.subarray(from, from + d.width), to);
        }
      }

      this.fillGaps(gaps, source, gx, gy, mergeAlpha, alpha, gax, gay);
      this.changed();
      return;
    }

    if (!mask && source !== this && (mergeAlpha || !this.transparent)) {
      // Source over destination, as composite does: a blit of sprites, the commonest copy a
      // game makes each frame. Four pixels at a time in the native module where there are
      // enough to pay for copying them in and out; else written out here, which skips what
      // is clear and takes what is solid.
      const kernel = d.width * d.height >= NATIVE_OVER ? bitmapKernel() : null;
      if (kernel) {
        kernel.copy(into, this.width, pixels, source.width, d, sx, sy, this.transparent, OVER);
        this.changed();
        return;
      }

      const solid = this.transparent ? 0 : 0xff000000;
      for (let r = 0; r < d.height; r++) {
        const to = (d.y + r) * this.width + d.x;
        const from = (sy + r) * source.width + sx;
        for (let c = 0; c < d.width; c++) {
          const p = pixels[from + c];
          const sa = p >>> 24;
          if (sa === 255) {
            into[to + c] = p;
          } else if (sa === 0) {
            if (solid !== 0) {
              into[to + c] = (into[to + c] | solid) >>> 0;
            }
          } else {
            into[to + c] = (over(p, into[to + c]) | solid) >>> 0;
          }
        }
      }

      this.changed();
      return;
    }

    for (let r = 0; r < d.height; r++) {
      const row = up ? d.height - 1 - r : r;
      const to = (d.y + row) * this.width + d.x;
      const from = (sy + row) * source.width + sx;
      for (let c = 0; c < d.width; c++) {
        const i = left ? d.width - 1 - c : c;
        let p = pixels[from + i];
        if (mask) {
          const mx = ax + i;
          const my = ay + row;
          if (mx < 0 || my < 0 || mx >= maskWidth || my >= maskHeight) {
            continue;
          }

          p = scale(p, mask[my * maskWidth + mx] >>> 24);
        }

        into[to + i] = this.composite(p, into[to + i], mergeAlpha);
      }
    }

    this.fillGaps(gaps, source, gx, gy, mergeAlpha, alpha, gax, gay);
    this.changed();
  }

  /**
   * The parts of an in-place copy Flash leaves empty: moved right and down
   * by no more than its size, the rect is written whole from (dx, dy), and
   * what of it lies left of or above the bitmap reads as nothing, where any
   * other move (or another source) clips it and moves the point with it.
   * Within the store, and apart; none for any other copy.
   */
  copyGaps(rect: PixelRect, dx: number, dy: number): readonly PixelRect[] {
    // Where the source's (0, 0) lands.
    const kx = dx - rect.x;
    const ky = dy - rect.y;
    if (
      (rect.x >= 0 && rect.y >= 0) ||
      rect.width <= 0 ||
      rect.height <= 0 ||
      kx < 0 ||
      ky < 0 ||
      kx > rect.width ||
      ky > rect.height
    ) {
      return NO_GAPS;
    }

    const right = dx + rect.width;
    const bottom = dy + rect.height;
    const left = this.clip({ x: dx, y: dy, width: Math.min(kx, right) - dx, height: rect.height });
    const x0 = Math.max(dx, kx);
    const top = this.clip({ x: x0, y: dy, width: right - x0, height: Math.min(ky, bottom) - dy });
    return [left, top].filter((r): r is PixelRect => r !== null);
  }

  /**
   * The gaps of an in-place copy written, as an empty pixel copied: a
   * transparent bitmap's are what Flash's memory held there, taken as
   * transparent; an opaque one's Flash reads back as 0, alpha and all, and
   * draws black, which this keeps them, as opaque black.
   */
  private fillGaps(
    gaps: readonly PixelRect[],
    source: BitmapStore,
    dx: number,
    dy: number,
    mergeAlpha: boolean,
    alpha: BitmapStore | null,
    ax: number,
    ay: number,
  ): void {
    const empty = source.transparent ? 0 : 0xff000000;
    for (const gap of gaps) {
      for (let y = gap.y; y < gap.y + gap.height; y++) {
        for (let x = gap.x; x < gap.x + gap.width; x++) {
          let p = empty;
          if (alpha) {
            const mx = ax + x - dx;
            const my = ay + y - dy;
            if (mx < 0 || my < 0 || mx >= alpha.width || my >= alpha.height) {
              continue;
            }

            p = scale(p, alpha.readable[my * alpha.width + mx] >>> 24);
          }

          const i = y * this.width + x;
          this.pixels[i] = this.composite(p, this.pixels[i], mergeAlpha);
        }
      }
    }
  }

  /** A copied pixel `p` on `d`: over it into an opaque store or merging, else in its place. */
  private composite(p: number, d: number, mergeAlpha: boolean): number {
    if (!this.transparent) {
      return (over(p, d) | 0xff000000) >>> 0;
    }

    return mergeAlpha ? over(p, d) : p;
  }

  /**
   * The rect's pixels, unmultiplied ARGB, row by row, as a Vector.<uint>'s
   * elements; the rect clipped to the store.
   */
  getVector(r: PixelRect): number[] {
    const c = this.clip(r);
    if (!c) {
      return packedDoubles(0);
    }

    const pixels = this.readable;
    const count = c.width * c.height;
    const out = packedDoubles(count);
    // Rows as wide as the store follow one another in it: one run.
    const run = c.width === this.width ? count : c.width;
    // Only a transparent store's pixels are worked on: divided in the module, then taken as numbers.
    const kernel = this.transparent ? wordsKernel(run) : null;
    for (let k = 0, row = c.y * this.width + c.x; k < count; k += run, row += this.width) {
      let done = 0;
      while (kernel && done < run) {
        const n = Math.min(SCRATCH.length, run - done);
        const from = bytesOf(pixels, row + done, n);
        const made = kernel.words(bytesOf(SCRATCH, 0, n), from, WORDS_UNMULTIPLY, false) >> 2;
        valuesOf(out, k + done, SCRATCH, 0, made);
        done += made;
        if (made < n) {
          break;
        }
      }

      getRunOf(out, k + done, pixels, row + done, run - done, this.transparent);
    }

    return out;
  }

  /**
   * The rect's pixels, within the store, as unmultiplied ARGB words in the
   * byte order given, row by row, into `bytes` from `at`, which has room
   * for them: getPixels' and copyPixelsToByteArray's write of a ByteArray.
   */
  getWords(r: PixelRect, bytes: Uint8Array, at: number, littleEndian: boolean): void {
    const pixels = this.readable;
    const count = r.width * r.height;
    const run = r.width === this.width ? count : r.width;
    // An opaque store's pixels in the host's order are copied as they are, which the module would not hasten.
    const kernel = this.transparent || !littleEndian ? wordsKernel(run) : null;
    const kind = this.transparent ? WORDS_UNMULTIPLY : WORDS_PLAIN;
    // What is left to the loops here writes words, which a typed array holds at a multiple of four alone.
    const aligned = ((bytes.byteOffset + at) & 3) === 0;
    const swap = littleEndian !== HOST_LITTLE;
    for (let k = 0, row = r.y * this.width + r.x; k < count; k += run, row += this.width) {
      const to = at + k * 4;
      const into = bytes.subarray(to, to + run * 4);
      const done = kernel
        ? kernel.words(into, bytesOf(pixels, row, run), kind, !littleEndian) >> 2
        : 0;
      if (done === run) {
        continue;
      }

      const left = run - done;
      const words = aligned
        ? new Uint32Array(bytes.buffer, bytes.byteOffset + to + done * 4, left)
        : new Uint32Array(left);
      getRun(words, 0, pixels, row + done, left, swap, this.transparent);
      if (!aligned) {
        into.set(bytesOf(words, 0, left), done * 4);
      }
    }
  }

  /** The rect's pixels set from `values`, unmultiplied ARGB, row by row, as far as they go; how many it took. */
  setVector(r: PixelRect, values: ArrayLike<number>): number {
    const c = this.clip(r);
    if (!c) {
      return 0;
    }

    // As many as there are values, row by row; the rest stay.
    const pixels = this.pixels;
    const count = Math.min(values.length, c.width * c.height);
    const run = c.width === this.width ? count : c.width;
    // Here alone: taking an array's numbers as words costs what premultiplying them does, and
    // the native module would then save little.
    for (let k = 0, row = c.y * this.width + c.x; k < count; k += run, row += this.width) {
      setRunOf(pixels, row, values, k, Math.min(run, count - k), this.transparent);
    }

    this.changed();
    return count;
  }

  /**
   * The rect's first `count` pixels, row by row, set from unmultiplied ARGB
   * words in `bytes` from `at`, in the byte order given: setPixels' read of
   * a ByteArray, with no array of the values between.
   */
  setWords(
    r: PixelRect,
    bytes: Uint8Array,
    at: number,
    count: number,
    littleEndian: boolean,
  ): void {
    const c = this.clip(r);
    if (!c || count === 0) {
      return;
    }

    const pixels = this.pixels;
    const run = c.width === this.width ? count : c.width;
    const kernel = wordsKernel(run);
    const kind = this.transparent ? WORDS_PREMULTIPLY : WORDS_SOLID;
    const swap = littleEndian !== HOST_LITTLE;
    // What is left to the loops here reads words, which a typed array holds at a multiple
    // of four alone: from elsewhere the bytes are copied to one first.
    let words: Uint32Array | null = null;
    for (let k = 0, row = c.y * this.width + c.x; k < count; k += run, row += this.width) {
      const n = Math.min(run, count - k);
      const from = at + k * 4;
      const done = kernel
        ? kernel.words(
            bytesOf(pixels, row, n),
            bytes.subarray(from, from + n * 4),
            kind,
            !littleEndian,
          ) >> 2
        : 0;
      if (done === n) {
        continue;
      }

      if (!words) {
        const offset = bytes.byteOffset + at;
        words =
          (offset & 3) === 0
            ? new Uint32Array(bytes.buffer, offset, count)
            : new Uint32Array(bytes.slice(at, at + count * 4).buffer);
      }

      setRun(pixels, row + done, words, k + done, n - done, swap, this.transparent);
    }

    this.changed();
  }

  clone(): BitmapStore {
    const copy = new BitmapStore(this.width, this.height, this.transparent, 0);
    copy.pixels.set(this.readable);
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
export function over(s: number, d: number): number {
  const sa = s >>> 24;
  if (sa === 255) {
    return s >>> 0;
  }

  if (sa === 0) {
    return d >>> 0;
  }

  // Each channel written out: a closure over s and d would take a context each pixel.
  const k = 256 - sa;
  return (
    ((Math.min(255, sa + (((d >>> 24) * k) >> 8)) << 24) |
      (Math.min(255, ((s >>> 16) & 0xff) + ((((d >>> 16) & 0xff) * k) >> 8)) << 16) |
      (Math.min(255, ((s >>> 8) & 0xff) + ((((d >>> 8) & 0xff) * k) >> 8)) << 8) |
      Math.min(255, (s & 0xff) + (((d & 0xff) * k) >> 8))) >>>
    0
  );
}

/** A premultiplied pixel's channels scaled by an alpha, as Flash's alpha bitmap scales them. */
function scale(p: number, a: number): number {
  if (a === 255) {
    return p >>> 0;
  }

  return (
    (((((p >>> 24) * a) >> 8) << 24) |
      (((((p >>> 16) & 0xff) * a) >> 8) << 16) |
      (((((p >>> 8) & 0xff) * a) >> 8) << 8) |
      (((p & 0xff) * a) >> 8)) >>>
    0
  );
}

/** Each bitmap's fill store, by its pixels, which the SWFs that define the bitmap alike share. */
const fillStores = new WeakMap<BitmapPixels, BitmapStore>();

/**
 * The store a SWF bitmap's fills draw from, one for all its shapes and for
 * every SWF that defines it alike, so one texture; null until its image is
 * decoded. Nothing writes it.
 */
export function characterStore(character: BitmapCharacter): BitmapStore | null {
  const pixels = character.pixels;
  if (!pixels) {
    return null;
  }

  if (!character.store) {
    let store = fillStores.get(pixels);
    if (!store) {
      store = BitmapStore.of(pixels);
      fillStores.set(pixels, store);
    }

    character.store = store;
  }

  return character.store;
}

/** Whether a word's low byte comes first in memory, as on every machine a browser runs on. */
const LITTLE_ENDIAN = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;

/** Premultiplied ARGB as the RGBA bytes a texture holds, still premultiplied. */
export function rgbaOf(pixels: Uint32Array): Uint8Array {
  const out = new Uint8Array(pixels.length * 4);
  rgbaInto(pixels, out);
  return out;
}

/**
 * rgbaOf into `out`, `pixels.length * 4` bytes or more, as a texture
 * uploaded again and again takes it; `opaque`, every alpha 255, as an
 * opaque store holding alpha draws (BitmapStore's drawable). Little-endian,
 * a pixel is a word whose red and blue swap, written whole rather than a
 * byte at a time.
 */
export function rgbaInto(pixels: Uint32Array, out: Uint8Array, opaque = false): void {
  if (out.length < pixels.length * 4) {
    throw new RangeError(`${out.length} bytes hold no ${pixels.length} pixels`);
  }

  const alpha = opaque ? 0xff000000 : 0;
  if (LITTLE_ENDIAN && out.byteOffset % 4 === 0) {
    const words = new Uint32Array(out.buffer, out.byteOffset, pixels.length);
    for (let i = 0; i < pixels.length; i++) {
      const p = pixels[i] | alpha;
      words[i] = (p & 0xff00ff00) | ((p >>> 16) & 0xff) | ((p & 0xff) << 16);
    }

    return;
  }

  for (let i = 0; i < pixels.length; i++) {
    const p = pixels[i] | alpha;
    const j = i * 4;
    out[j] = (p >>> 16) & 0xff;
    out[j + 1] = (p >>> 8) & 0xff;
    out[j + 2] = p & 0xff;
    out[j + 3] = p >>> 24;
  }
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
