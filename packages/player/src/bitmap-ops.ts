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
  const [pixels, pw, ox, oy] = readFrom(source, store, sx, sy, d.width, d.height);
  for (let row = 0; row < d.height; row++) {
    for (let i = 0; i < d.width; i++) {
      const to = (d.y + row) * store.width + d.x + i;
      const p = unmultiply(pixels[(sy - oy + row) * pw + sx - ox + i]);
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
  // Its own keys only: "constructor" and the rest of Object's are not operations.
  return Object.hasOwn(OPERATIONS, op);
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
  const [pixels, pw, ox, oy] = readFrom(source, store, sx, sy, d.width, d.height);
  const fill = store.premultiplied(color >>> 0);
  for (let row = 0; row < d.height; row++) {
    for (let i = 0; i < d.width; i++) {
      const to = (d.y + row) * store.width + d.x + i;
      const raw = pixels[(sy - oy + row) * pw + sx - ox + i];
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
 * Flash's pixelDissolve taps, by the state's width in bits: a Galois LFSR,
 * s >> 1, xor the tap where s was odd, read off adl for every width a
 * BitmapData can have (2 to 26 bits).
 */
const DISSOLVE_TAPS = [
  0, 0, 3, 6, 12, 20, 48, 96, 184, 272, 576, 1280, 3232, 6912, 13568, 24576, 46080, 73728, 132096,
  466944, 589824, 1310720, 3145728, 4325376, 14155776, 18874368, 59244544,
];

/** Bits to number 0..n - 1: ceil(log2(n)). */
function bitsFor(n: number): number {
  return n <= 1 ? 0 : 32 - Math.clz32(n - 1);
}

/**
 * pixelDissolve as Flash does it, fitted under adl: a state of
 * ceil(log2 w) + ceil(log2 h) bits stands for the pixel (s & (2^bw - 1),
 * s >> bw) of the rect, a state outside it skipped; each call writes
 * numPixels pixels, from the seed on, and returns the state after the
 * last, raw, so the next call goes on from there. Every call writes the
 * pixel at the origin too, which no state stands for, and so n calls of
 * 1 write n + 1 (Ruffle's bitmapdata_pixeldissolve); a seed past the
 * generator's states is taken modulo 2^bits - 1, and 0 starts at the tap. A
 * pixel takes the fill colour where the source is the destination, else
 * the source's; a rect a pixel high or wide dissolves nothing.
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
  // Over the rect clipped to the source and then to the destination, as the copies are.
  const sc = source.clip(rect);
  if (!sc) {
    return 0;
  }

  const ox = dx + (sc.x - rect.x);
  const oy = dy + (sc.y - rect.y);
  const dc = store.clip({ x: ox, y: oy, width: sc.width, height: sc.height });
  if (!dc) {
    return 0;
  }

  const rx = sc.x + (dc.x - ox);
  const ry = sc.y + (dc.y - oy);
  dx = dc.x;
  dy = dc.y;
  const { width: w, height: h } = dc;
  if (w <= 1 || h <= 1) {
    return 0;
  }

  const bw = bitsFor(w);
  const bits = bw + bitsFor(h);
  const tap = DISSOLVE_TAPS[bits] ?? 0;
  const mask = 2 ** bits - 1;
  const xMask = (1 << bw) - 1;
  const color = store.premultiplied(fill >>> 0);
  const next = (s: number) => (s & 1 ? Math.floor(s / 2) ^ tap : Math.floor(s / 2));

  // A position of the rect, written where it lies in both bitmaps.
  const write = (state: number) => {
    const px = state & xMask;
    const py = Math.floor(state / 2 ** bw);
    const sx = rx + px;
    const sy = ry + py;
    const tx = dx + px;
    const ty = dy + py;
    if (
      sx < 0 ||
      sy < 0 ||
      sx >= source.width ||
      sy >= source.height ||
      tx < 0 ||
      ty < 0 ||
      tx >= store.width ||
      ty >= store.height
    ) {
      return;
    }

    store.pixels[ty * store.width + tx] =
      source === store ? color : source.pixels[sy * source.width + sx];
  };
  const inside = (state: number) => (state & xMask) < w && Math.floor(state / 2 ** bw) < h;

  // The origin is written on every call; the seed is reduced to the
  // generator's period, and 0, which it never reaches, starts at the tap.
  write(0);
  const start = Math.abs(Math.trunc(seed));
  let s = start > mask ? start % mask : start;
  if (s === 0) {
    s = tap;
  }

  // The states inside the rect come round every w * h - 1 writes (state 0
  // is the origin's, reached from seed 0 alone), so a count past that is
  // one full round, which writes every pixel, and the remainder: the same
  // pixels and the seed Flash returns, without its seconds-long loop.
  const round = w * h - 1;
  const steps = count > round ? round + (count % round) : count;
  for (let k = 0; k < steps; k++) {
    // Every state but 0 comes round within 2^bits steps, so this ends.
    while (!inside(s)) {
      s = next(s);
    }

    write(s);
    s = next(s);
  }

  store.changed();
  return s;
}

/**
 * The pixels a copy reads, with their row width and origin: the source's
 * own, or where the source is the destination, a copy of the rect alone,
 * so a one-pixel operation does not copy the whole store.
 */
function readFrom(
  source: BitmapStore,
  store: BitmapStore,
  x: number,
  y: number,
  w: number,
  h: number,
): [Uint32Array, number, number, number] {
  if (source !== store) {
    return [source.pixels, source.width, 0, 0];
  }

  const copy = new Uint32Array(w * h);
  for (let row = 0; row < h; row++) {
    const from = (y + row) * source.width + x;
    copy.set(source.pixels.subarray(from, from + w), row * w);
  }

  return [copy, w, x, y];
}
