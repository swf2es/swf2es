// The pixel operations of BitmapData that read and write its store alone
// (bitmap.ts): each on unmultiplied ARGB as Flash's results show it works,
// the store premultiplying again as it writes. The rules are the ones
// Flash traces under adl and records in Ruffle's corpus.
import { type BitmapStore, type PixelRect, unmultiply } from "./bitmap.js";

const M = 2147483647;

/**
 * Flash's noise generator: Park-Miller's minimal standard, x * 16807 mod
 * 2^31 - 1, a seed of 0 taken as 1 and one under 0 as -seed + 1 (all 25
 * pixels Ruffle's bitmapdata_getvector records of noise(0) match).
 */
export class ParkMiller {
  private x: number;

  constructor(seed: number) {
    let s = seed | 0;
    if (s <= 0) {
      s = -s + 1;
    }

    this.x = s % M || 1;
  }

  next(): number {
    // 16807 * x stays below 2^46: exact in a double.
    this.x = (this.x * 16807) % M;
    return this.x;
  }
}

/**
 * noise: each pixel's channels drawn in R, G, B order, then alpha, which
 * only a transparent bitmap draws; a grayscale draw is one for all three
 * colours, then alpha. A value is low + r % (high - low + 1), high capped
 * at 255 and a range upside down giving low. A colour left out is 0, an
 * alpha left out 255.
 */
export function noise(
  store: BitmapStore,
  seed: number,
  low: number,
  high: number,
  channels: number,
  gray: boolean,
): void {
  const rng = new ParkMiller(seed);
  const lo = Math.max(0, Math.min(255, low));
  const hi = Math.max(0, Math.min(255, high));
  const span = hi - lo + 1;
  const draw = () => (span <= 0 ? lo : lo + (rng.next() % span));
  const alpha = (channels & 8) !== 0 && store.transparent;
  for (let i = 0; i < store.pixels.length; i++) {
    let r = 0;
    let g = 0;
    let b = 0;
    if (gray) {
      r = g = b = draw();
    } else {
      if (channels & 1) {
        r = draw();
      }

      if (channels & 2) {
        g = draw();
      }

      if (channels & 4) {
        b = draw();
      }
    }

    const a = alpha ? draw() : 255;
    store.pixels[i] = store.premultiplied(((a << 24) | (r << 16) | (g << 8) | b) >>> 0);
  }

  store.changed();
}

/** The channel's shift in ARGB: 1 red, 2 green, 4 blue, 8 alpha; -1 for another value. */
function shiftOf(channel: number): number {
  switch (channel) {
    case 1:
      return 16;
    case 2:
      return 8;
    case 4:
      return 0;
    case 8:
      return 24;
    default:
      return -1;
  }
}

/** Each destination pixel's channel set from the source pixel's channel, both unmultiplied. */
export function copyChannel(
  store: BitmapStore,
  source: BitmapStore,
  rect: PixelRect,
  dx: number,
  dy: number,
  from: number,
  to: number,
): void {
  const fromShift = shiftOf(from);
  const toShift = shiftOf(to);
  if (toShift < 0 || (toShift === 24 && !store.transparent)) {
    return;
  }

  // A source of more than one channel, or none, copies 0, as Flash does.
  forEachCopied(store, source, rect, dx, dy, (s, d) => {
    const v = fromShift < 0 ? 0 : (s >>> fromShift) & 0xff;
    return ((d & ~(0xff << toShift)) | (v << toShift)) >>> 0;
  });
}

/**
 * colorTransform as Flash computes it, fitted under adl: each channel read
 * back as p * 255 / a, floored; then (c * floor(mul * 256) >> 8) +
 * trunc(offset), clamped to 0..255, the alpha alike; and written
 * premultiplied as c * (a + 1) >> 8, not as setPixel32 rounds. A pixel
 * of alpha 0 is left as it is; an opaque bitmap's alpha is transformed
 * like a transparent one's.
 */
export function colorTransform(
  store: BitmapStore,
  rect: PixelRect,
  ct: {
    rMul: number;
    gMul: number;
    bMul: number;
    aMul: number;
    rAdd: number;
    gAdd: number;
    bAdd: number;
    aAdd: number;
  },
): void {
  const c = store.clip(rect);
  if (!c) {
    return;
  }

  const fixed = (m: number) => Math.trunc(m * 256);
  const [rm, gm, bm, am] = [ct.rMul, ct.gMul, ct.bMul, ct.aMul].map(fixed);
  const [ro, go, bo, ao] = [ct.rAdd, ct.gAdd, ct.bAdd, ct.aAdd].map(Math.trunc);
  const ch = (v: number, m: number, o: number) =>
    Math.max(0, Math.min(255, Math.floor((v * m) / 256) + o));
  for (let y = c.y; y < c.y + c.height; y++) {
    for (let x = c.x; x < c.x + c.width; x++) {
      const i = y * store.width + x;
      const p = store.pixels[i];
      const a0 = p >>> 24;
      // A pixel of alpha 0 is left as it is, offsets and all.
      if (a0 === 0) {
        continue;
      }

      const straight = (shift: number) =>
        a0 === 0 ? 0 : Math.min(255, Math.floor((((p >>> shift) & 0xff) * 255) / a0));
      // An opaque bitmap's alpha is transformed too: down to 0, the pixel reads 0.
      const a = ch(a0, am, ao);
      const r = ch(straight(16), rm, ro);
      const g = ch(straight(8), gm, go);
      const b = ch(straight(0), bm, bo);
      const out = (v: number) => (a === 255 ? v : (v * (a + 1)) >> 8);
      store.pixels[i] = ((a << 24) | (out(r) << 16) | (out(g) << 8) | out(b)) >>> 0;
    }
  }

  store.changed();
}

/**
 * merge: each channel ((s * m + d * (256 - m)) >> 8) & 0xFF, unmultiplied,
 * the multiplier a uint and nothing clamped, as 18 multipliers from -257
 * to 2^32 - 1 show Flash computing it under adl; a double holds the
 * product, so the shift is a division.
 */
export function merge(
  store: BitmapStore,
  source: BitmapStore,
  rect: PixelRect,
  dx: number,
  dy: number,
  muls: [number, number, number, number],
): void {
  const [rm, gm, bm, am] = muls;
  const mix = (s: number, d: number, shift: number, m: number) =>
    Math.floor((((s >>> shift) & 0xff) * m + ((d >>> shift) & 0xff) * (256 - m)) / 256) & 0xff;
  forEachCopied(
    store,
    source,
    rect,
    dx,
    dy,
    (s, d) =>
      ((mix(s, d, 24, am) << 24) |
        (mix(s, d, 16, rm) << 16) |
        (mix(s, d, 8, gm) << 8) |
        mix(s, d, 0, bm)) >>>
      0,
  );
}

/**
 * The source rect's pixels against the destination's at the point, both
 * clipped and unmultiplied, each destination pixel set to what `f` makes
 * of the pair; from a copy where the source is the destination.
 */
function forEachCopied(
  store: BitmapStore,
  source: BitmapStore,
  rect: PixelRect,
  dx: number,
  dy: number,
  f: (s: number, d: number) => number,
): void {
  const s = source.clip(rect);
  if (!s) {
    return;
  }

  dx += s.x - rect.x;
  dy += s.y - rect.y;
  const d = store.clip({ x: dx, y: dy, width: s.width, height: s.height });
  if (!d) {
    return;
  }

  const sx = s.x + (d.x - dx);
  const sy = s.y + (d.y - dy);
  const pixels = source === store ? store.pixels.slice() : source.pixels;
  for (let row = 0; row < d.height; row++) {
    for (let i = 0; i < d.width; i++) {
      const to = (d.y + row) * store.width + d.x + i;
      const p = unmultiply(pixels[(sy + row) * source.width + sx + i]);
      store.pixels[to] = store.premultiplied(f(p, unmultiply(store.pixels[to])));
    }
  }

  store.changed();
}

/** scroll: the pixels moved by (x, y); what nothing moved onto keeps its old pixels. */
export function scroll(store: BitmapStore, x: number, y: number): void {
  const { width, height } = store;
  const old = store.pixels.slice();
  for (let row = 0; row < height; row++) {
    const sy = row - y;
    if (sy < 0 || sy >= height) {
      continue;
    }

    for (let col = 0; col < width; col++) {
      const sx = col - x;
      if (sx >= 0 && sx < width) {
        store.pixels[row * width + col] = old[sy * width + sx];
      }
    }
  }

  store.changed();
}

const OPERATIONS: Record<string, (a: number, b: number) => boolean> = {
  "<": (a, b) => a < b,
  "<=": (a, b) => a <= b,
  ">": (a, b) => a > b,
  ">=": (a, b) => a >= b,
  "==": (a, b) => a === b,
  "!=": (a, b) => a !== b,
};

/** Whether `op` is one threshold takes. */
export function isThresholdOperation(op: string): boolean {
  return op in OPERATIONS;
}

/**
 * threshold: each source pixel, unmultiplied and masked, compared with the
 * masked threshold as unsigned numbers; where the test holds the
 * destination pixel becomes `color`, elsewhere the source pixel if
 * `copySource`; how many held.
 */
export function threshold(
  store: BitmapStore,
  source: BitmapStore,
  rect: PixelRect,
  dx: number,
  dy: number,
  op: string,
  value: number,
  color: number,
  mask: number,
  copySource: boolean,
): number {
  const test = OPERATIONS[op];
  const target = (value & mask) >>> 0;
  let count = 0;
  const s = source.clip(rect);
  if (!s) {
    return 0;
  }

  dx += s.x - rect.x;
  dy += s.y - rect.y;
  const d = store.clip({ x: dx, y: dy, width: s.width, height: s.height });
  if (!d) {
    return 0;
  }

  const sx = s.x + (d.x - dx);
  const sy = s.y + (d.y - dy);
  const pixels = source === store ? store.pixels.slice() : source.pixels;
  const fill = store.premultiplied(color >>> 0);
  for (let row = 0; row < d.height; row++) {
    for (let i = 0; i < d.width; i++) {
      const to = (d.y + row) * store.width + d.x + i;
      const raw = pixels[(sy + row) * source.width + sx + i];
      if (test((unmultiply(raw) & mask) >>> 0, target)) {
        store.pixels[to] = fill;
        count++;
      } else if (copySource) {
        store.pixels[to] = store.transparent ? raw : (raw | 0xff000000) >>> 0;
      }
    }
  }

  store.changed();
  return count;
}

/**
 * getColorBoundsRect: the smallest rect holding every pixel whose
 * unmultiplied value, masked, is `color` (or is not, without findColor);
 * empty where none is, and where the one found is the pixel at the
 * origin alone, as Flash has it (Ruffle's bitmap_data).
 */
export function colorBounds(
  store: BitmapStore,
  mask: number,
  color: number,
  find: boolean,
): PixelRect {
  let x0 = store.width;
  let y0 = store.height;
  let x1 = -1;
  let y1 = -1;
  const target = (color & mask) >>> 0;
  for (let y = 0; y < store.height; y++) {
    for (let x = 0; x < store.width; x++) {
      const hit = (unmultiply(store.pixels[y * store.width + x]) & mask) >>> 0 === target;
      if (hit === find) {
        x0 = Math.min(x0, x);
        y0 = Math.min(y0, y);
        x1 = Math.max(x1, x);
        y1 = Math.max(y1, y);
      }
    }
  }

  // Flash takes extents that end at the origin for none found: a lone hit at (0, 0) gives an empty rect.
  return x1 <= 0 && y1 <= 0
    ? { x: 0, y: 0, width: 0, height: 0 }
    : { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 };
}

/** floodFill: the 4-connected region of the start pixel's exact value set to `color`. */
export function floodFill(store: BitmapStore, x: number, y: number, color: number): void {
  const { width, height } = store;
  if (x < 0 || y < 0 || x >= width || y >= height) {
    return;
  }

  const from = store.pixels[y * width + x];
  const to = store.premultiplied(color >>> 0);
  if (from === to) {
    return;
  }

  const stack = [y * width + x];
  while (stack.length) {
    const i = stack.pop() as number;
    if (store.pixels[i] !== from) {
      continue;
    }

    store.pixels[i] = to;
    const px = i % width;
    if (px > 0) {
      stack.push(i - 1);
    }

    if (px < width - 1) {
      stack.push(i + 1);
    }

    if (i >= width) {
      stack.push(i - width);
    }

    if (i + width < width * height) {
      stack.push(i + width);
    }
  }

  store.changed();
}

/** histogram: four arrays of 256 counts, red, green, blue and alpha, of the rect's unmultiplied pixels. */
export function histogram(store: BitmapStore, rect: PixelRect): number[][] {
  const counts = [0, 1, 2, 3].map(() => new Array<number>(256).fill(0));
  const c = store.clip(rect);
  if (!c) {
    return counts;
  }

  for (let y = c.y; y < c.y + c.height; y++) {
    for (let x = c.x; x < c.x + c.width; x++) {
      const p = unmultiply(store.pixels[y * store.width + x]);
      counts[0][(p >>> 16) & 0xff]++;
      counts[1][(p >>> 8) & 0xff]++;
      counts[2][p & 0xff]++;
      counts[3][p >>> 24]++;
    }
  }

  return counts;
}

/** The unmultiplied alpha at (x, y), or -1 outside. */
export function alphaAt(store: BitmapStore, x: number, y: number): number {
  if (x < 0 || y < 0 || x >= store.width || y >= store.height) {
    return -1;
  }

  return store.pixels[y * store.width + x] >>> 24;
}

/**
 * pixelDissolve: numPixels + 1 pixels of the source rect, clipped to both
 * bitmaps, written to the destination, the fill colour where the source
 * is the destination, starting at the seed's position and going on; the
 * position reached is the next seed, so a call starts where the last
 * stopped and rewrites that pixel, as Flash's counts in Ruffle's
 * bitmapdata_pixeldissolve show (numPixels * calls + 1). Flash's order of
 * positions is its own pseudo-random one, which no trace records; this
 * walks the rect row by row.
 */
export function pixelDissolve(
  store: BitmapStore,
  source: BitmapStore,
  rect: PixelRect,
  dx: number,
  dy: number,
  seed: number,
  count: number,
  fill: number,
): number {
  const s = source.clip(rect);
  if (!s) {
    return 0;
  }

  dx += s.x - rect.x;
  dy += s.y - rect.y;
  const d = store.clip({ x: dx, y: dy, width: s.width, height: s.height });
  if (!d) {
    return 0;
  }

  const sx = s.x + (d.x - dx);
  const sy = s.y + (d.y - dy);
  const total = d.width * d.height;
  const color = store.premultiplied(fill >>> 0);
  let at = Math.abs(Math.trunc(seed)) % total;
  for (let k = 0; k <= Math.min(count, total); k++) {
    if (k > 0) {
      at = (at + 1) % total;
    }

    const col = at % d.width;
    const row = (at - col) / d.width;
    const to = (d.y + row) * store.width + d.x + col;
    store.pixels[to] =
      source === store ? color : source.pixels[(sy + row) * source.width + sx + col];
  }

  store.changed();
  return at;
}
