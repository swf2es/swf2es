// The pixel operations the player computed in JS before the render module's
// (pixels.zig) took them over, kept as the kernels' reference: what adl
// computes, quirks and all, which native-pixels.test.ts holds them to.
import {
  type BitmapStore,
  type PixelRect,
  unmultiply,
} from "../../../../packages/player/dist/bitmap/bitmap.js";

const M = 2147483647;

/**
 * Flash's noise generator: Park-Miller's minimal standard, x * 16807 mod
 * 2^31 - 1, a seed of 0 taken as 1 and one under 0 as -seed + 1 (all 25
 * pixels Ruffle's bitmapdata_getvector records of noise(0) match).
 */
class ParkMiller {
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
export function noiseReference(
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
export function copyChannelReference(
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
export function colorTransformReference(
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

  for (let y = c.y; y < c.y + c.height; y++) {
    for (let x = c.x; x < c.x + c.width; x++) {
      const i = y * store.width + x;
      const p = store.pixels[i];
      const a0 = p >>> 24;
      // A pixel of alpha 0 is left as it is, offsets and all.
      if (a0 === 0) {
        continue;
      }

      // An opaque bitmap's alpha is transformed too: down to 0, the pixel reads 0.
      const a = colorChannel(a0, am, ao);
      const r = colorChannel(straightChannel(p, a0, 16), rm, ro);
      const g = colorChannel(straightChannel(p, a0, 8), gm, go);
      const b = colorChannel(straightChannel(p, a0, 0), bm, bo);
      store.pixels[i] =
        ((a << 24) |
          (premultipliedChannel(r, a) << 16) |
          (premultipliedChannel(g, a) << 8) |
          premultipliedChannel(b, a)) >>>
        0;
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
export function mergeReference(
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
 * of the pair. In place, rows down and pixels along, each read as the
 * ones before it left it, as Flash does: a move down or right repeats what
 * it wrote.
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
  // The store written first: if it is the source, both are then its own array.
  const into = store.pixels;
  const pixels = source.readable;
  for (let row = 0; row < d.height; row++) {
    for (let i = 0; i < d.width; i++) {
      const to = (d.y + row) * store.width + d.x + i;
      const p = unmultiply(pixels[(sy + row) * source.width + sx + i]);
      into[to] = store.premultiplied(f(p, unmultiply(into[to])));
    }
  }

  store.changed();
}

/**
 * paletteMap: each copied pixel the sum of its channels' entries in the
 * four tables, red, green, blue and alpha, wrapping at 32 bits, as Flash
 * makes it (Ruffle's operations.rs); a table not given maps its channel
 * to itself.
 */
export function paletteMapReference(
  store: BitmapStore,
  source: BitmapStore,
  rect: PixelRect,
  dx: number,
  dy: number,
  tables: readonly [Uint32Array, Uint32Array, Uint32Array, Uint32Array],
): void {
  const [r, g, b, a] = tables;
  forEachCopied(
    store,
    source,
    rect,
    dx,
    dy,
    (p) => (r[(p >>> 16) & 0xff] + g[(p >>> 8) & 0xff] + b[p & 0xff] + a[p >>> 24]) >>> 0,
  );
}

/**
 * perlinNoise: each pixel's channels from turbulence.ts, a channel left
 * out its least, alpha left out opaque, written as they come, not
 * premultiplied, as Flash writes them (Ruffle's operations.rs, whose
 * conversion to a byte is Flash's). A channel's noise is drawn from the
 * next of the generator's four only for the channels asked for.
 */
export function perlinNoiseReference(
  store: BitmapStore,
  base: [number, number],
  offsets: readonly [number, number][],
  seed: number,
  stitch: boolean,
  fractal: boolean,
  channels: number,
  gray: boolean,
): void {
  const turbulence = new Turbulence(seed);
  const { width, height } = store;
  // A base's sign is dropped (adl).
  const frequency: [number, number] = [
    base[0] === 0 ? 0 : 1 / Math.abs(base[0]),
    base[1] === 0 ? 0 : 1 / Math.abs(base[1]),
  ];
  const at = (channel: number, x: number, y: number) =>
    turbulence.turbulence(channel, x, y, frequency, offsets, fractal, stitch, width, height);
  // A byte as Flash makes it of a noise, saturating, the half added before the halving; past an
  // int, as wild noise goes, x86's conversion gives -2^31 and the byte 0.
  const byte = (n: number) => {
    const v = fractal ? (n * 255 + 255 + 0.5) / 2 : n * 255 + 0.5;
    return !(v < 2147483648) ? 0 : v >= 255 ? 255 : v > 0 ? Math.trunc(v) : 0;
  };
  const noise = [0, 0, 0, 0];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (gray) {
        noise[0] = noise[1] = noise[2] = at(0, x, y);
        noise[3] = channels & 8 ? at(1, x, y) : 1;
      } else {
        let channel = 0;
        for (let c = 0; c < 4; c++) {
          noise[c] = c === 3 ? 1 : -1;
          if (channels & (1 << c)) {
            noise[c] = at(channel++, x, y);
          }
        }
      }

      const a = store.transparent ? byte(noise[3]) : 255;
      store.pixels[y * width + x] =
        ((a << 24) | (byte(noise[0]) << 16) | (byte(noise[1]) << 8) | byte(noise[2])) >>> 0;
    }
  }

  store.changed();
}

// These stay outside the pixel loops so a transform creates no per-pixel closures.
function colorChannel(v: number, mul: number, add: number): number {
  return Math.max(0, Math.min(255, Math.floor((v * mul) / 256) + add));
}

function straightChannel(p: number, alpha: number, shift: number): number {
  return alpha === 0 ? 0 : Math.min(255, Math.floor((((p >>> shift) & 0xff) * 255) / alpha));
}

function premultipliedChannel(v: number, alpha: number): number {
  return alpha === 255 ? v : (v * (alpha + 1)) >> 8;
}

function intersect(p: PixelRect, q: PixelRect): PixelRect | null {
  const x0 = Math.max(p.x, q.x);
  const y0 = Math.max(p.y, q.y);
  const x1 = Math.min(p.x + p.width, q.x + q.width);
  const y1 = Math.min(p.y + p.height, q.y + q.height);
  return x1 > x0 && y1 > y0 ? { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } : null;
}

/** The bounds of the pixels of `rect` of the source that are not transparent: null for none. */
function contentOf(source: BitmapStore, rect: PixelRect): PixelRect | null {
  const area = intersect(rect, { x: 0, y: 0, width: source.width, height: source.height });
  if (!area) {
    return null;
  }

  const pixels = source.pixels;
  let x0 = Number.POSITIVE_INFINITY;
  let y0 = Number.POSITIVE_INFINITY;
  let x1 = -1;
  let y1 = -1;
  for (let y = area.y; y < area.y + area.height; y++) {
    for (let x = area.x; x < area.x + area.width; x++) {
      if (pixels[y * source.width + x] >>> 24) {
        x0 = Math.min(x0, x);
        y0 = Math.min(y0, y);
        x1 = Math.max(x1, x);
        y1 = Math.max(y1, y);
      }
    }
  }

  return x1 < 0 ? null : { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 };
}

/**
 * A colour matrix of each pixel's straight colour, rounded, into `dest`.
 * adl maps the pixels about what the source has, its bounds and one more
 * each way, one by one, their colour premultiplied by the new alpha and
 * truncated; the rest of the rect it fills with the map of a transparent
 * pixel, written as the store premultiplies it. Of the rect, only what
 * lies within the source is written, the point moved with the clip, as a
 * copy's is.
 */
export function colorMatrixReference(
  dest: BitmapStore,
  source: BitmapStore,
  rect: PixelRect,
  dx: number,
  dy: number,
  m: number[],
): void {
  const area = intersect(rect, { x: 0, y: 0, width: source.width, height: source.height });
  const mx = dx - rect.x;
  const my = dy - rect.y;
  const shown = area && intersect(area, { x: -mx, y: -my, width: dest.width, height: dest.height });
  if (!shown) {
    return;
  }

  // The map of straight (r, g, b, a) into `mapped`, each clamped and rounded.
  const mapped = [0, 0, 0, 0];
  const map = (cr: number, cg: number, cb: number, ca: number) => {
    for (let row = 0; row < 4; row++) {
      const v =
        m[row * 5] * cr +
        m[row * 5 + 1] * cg +
        m[row * 5 + 2] * cb +
        m[row * 5 + 3] * ca +
        m[row * 5 + 4];
      mapped[row] = Math.max(0, Math.min(255, Math.round(Number.isNaN(v) ? 0 : v)));
    }

    return mapped;
  };
  const [er, eg, eb, ea] = map(0, 0, 0, 0);
  const empty = dest.premultiplied(((ea << 24) | (er << 16) | (eg << 8) | eb) >>> 0);

  // What the source has, and one more each way.
  const content = contentOf(source, area);
  const near = content && {
    x: content.x - 1,
    y: content.y - 1,
    width: content.width + 2,
    height: content.height + 2,
  };
  const from = source.pixels;
  const into = dest.pixels;
  const opaque = dest.transparent ? 0 : 0xff000000;
  const pixel = (x: number, y: number): number => {
    if (
      !near ||
      x < near.x ||
      y < near.y ||
      x >= near.x + near.width ||
      y >= near.y + near.height
    ) {
      return empty;
    }

    const p = from[y * source.width + x];
    const a = p >>> 24;
    const s = a > 0 ? 255 / a : 0;
    const [nr, ng, nb, na] = map(
      ((p >>> 16) & 0xff) * s,
      ((p >>> 8) & 0xff) * s,
      (p & 0xff) * s,
      a,
    );
    return (
      ((na << 24) |
        (Math.floor((nr * na) / 255) << 16) |
        (Math.floor((ng * na) / 255) << 8) |
        Math.floor((nb * na) / 255)) >>>
      0
    );
  };

  // Rows down, each in fours from its start, a four read whole before it is
  // written, the rest one by one: in place, a move right repeats what the
  // fours before wrote, as 480 rows under adl show.
  const four = [0, 0, 0, 0];
  const end = shown.x + shown.width;
  for (let y = shown.y; y < shown.y + shown.height; y++) {
    const row = (y + my) * dest.width + mx;
    for (let x = shown.x; x < end; ) {
      const n = end - x >= 4 ? 4 : 1;
      for (let k = 0; k < n; k++) {
        four[k] = pixel(x + k, y);
      }

      for (let k = 0; k < n; k++, x++) {
        into[row + x] = (four[k] | opaque) >>> 0;
      }
    }
  }

  dest.changed();
}

// Perlin noise as BitmapData.perlinNoise made it in turbulence.ts: the
// reference implementation of SVG's feTurbulence, which Flash's matches,
// with an offset for each octave, as Ruffle ports it (turbulence.rs).
//
// Derived from https://www.w3.org/TR/SVG11/filters.html#feTurbulenceElement,
// Copyright © 2015 W3C® (MIT, ERCIM, Keio, Beihang), under the W3C software
// license.

const RAND_M = 2147483647;
const RAND_A = 16807;
const RAND_Q = 127773;
const RAND_R = 2836;
const B_SIZE = 0x100;
const BM = 0xff;
const PERLIN_N = 0x1000;

/** Park and Miller's minimal standard seed: in [1, 2^31 - 2]. */
function setupSeed(seed: number): number {
  let s = seed;
  if (s <= 0) {
    s = -(s % (RAND_M - 1)) + 1;
  }

  if (s > RAND_M - 1) {
    s = RAND_M - 1;
  }

  return s;
}

function random(seed: number): number {
  let result = RAND_A * (seed % RAND_Q) - RAND_R * Math.trunc(seed / RAND_Q);
  if (result <= 0) {
    result += RAND_M;
  }

  return result;
}

/**
 * A double to int as x86's conversion makes it: out of range, or NaN, is
 * -2^31. Where many octaves take a point's lattice past it, Flash's noise
 * goes wild, and so does this (the `perlin-noise` case).
 */
function int32(v: number): number {
  return v > -2147483649 && v < 2147483648 ? Math.trunc(v) : -2147483648;
}

const sCurve = (t: number) => t * t * (3 - 2 * t);
const lerp = (t: number, a: number, b: number) => a + t * (b - a);

interface Stitch {
  width: number;
  height: number;
  wrapX: number;
  wrapY: number;
}

class Turbulence {
  private readonly lattice = new Int32Array(B_SIZE + B_SIZE + 2);
  /** The stitching state, made again for each point, kept to not allocate per pixel. */
  private readonly stitch: Stitch = { width: 0, height: 0, wrapX: 0, wrapY: 0 };
  /** Each channel's gradients, x and y interleaved. */
  private readonly gradient = [0, 1, 2, 3].map(() => new Float64Array((B_SIZE + B_SIZE + 2) * 2));

  constructor(seed: number) {
    let s = setupSeed(seed);
    for (const g of this.gradient) {
      for (let i = 0; i < B_SIZE; i++) {
        this.lattice[i] = i;
        for (let j = 0; j < 2; j++) {
          s = random(s);
          g[i * 2 + j] = ((s % (B_SIZE + B_SIZE)) - B_SIZE) / B_SIZE;
        }

        const length = Math.sqrt(g[i * 2] * g[i * 2] + g[i * 2 + 1] * g[i * 2 + 1]);
        g[i * 2] /= length;
        g[i * 2 + 1] /= length;
      }
    }

    for (let i = B_SIZE - 1; i > 0; i--) {
      const k = this.lattice[i];
      s = random(s);
      const j = s % B_SIZE;
      this.lattice[i] = this.lattice[j];
      this.lattice[j] = k;
    }

    for (let i = 0; i < B_SIZE + 2; i++) {
      this.lattice[B_SIZE + i] = this.lattice[i];
      for (const g of this.gradient) {
        g[(B_SIZE + i) * 2] = g[i * 2];
        g[(B_SIZE + i) * 2 + 1] = g[i * 2 + 1];
      }
    }
  }

  private noise2(channel: number, x: number, y: number, stitch: Stitch | null): number {
    const tx = x + PERLIN_N;
    let bx0 = int32(tx);
    let bx1 = bx0 + 1;
    const rx0 = tx - int32(tx);
    const rx1 = rx0 - 1;
    const ty = y + PERLIN_N;
    let by0 = int32(ty);
    let by1 = by0 + 1;
    const ry0 = ty - int32(ty);
    const ry1 = ry0 - 1;
    if (stitch) {
      bx0 -= bx0 >= stitch.wrapX ? stitch.width : 0;
      bx1 -= bx1 >= stitch.wrapX ? stitch.width : 0;
      by0 -= by0 >= stitch.wrapY ? stitch.height : 0;
      by1 -= by1 >= stitch.wrapY ? stitch.height : 0;
    }

    bx0 &= BM;
    bx1 &= BM;
    by0 &= BM;
    by1 &= BM;
    const i = this.lattice[bx0];
    const j = this.lattice[bx1];
    const b00 = this.lattice[i + by0];
    const b10 = this.lattice[j + by0];
    const b01 = this.lattice[i + by1];
    const b11 = this.lattice[j + by1];
    const sx = sCurve(rx0);
    const sy = sCurve(ry0);
    const g = this.gradient[channel];
    const a = lerp(
      sx,
      rx0 * g[b00 * 2] + ry0 * g[b00 * 2 + 1],
      rx1 * g[b10 * 2] + ry0 * g[b10 * 2 + 1],
    );
    const b = lerp(
      sx,
      rx0 * g[b01 * 2] + ry1 * g[b01 * 2 + 1],
      rx1 * g[b11 * 2] + ry1 * g[b11 * 2 + 1],
    );
    return lerp(sy, a, b);
  }

  /**
   * The turbulence (sum of absolute noise) or fractal sum at a point, over
   * `offsets.length` octaves, each moved by its offset; stitched to tile
   * a `width` by `height` image if asked.
   */
  turbulence(
    channel: number,
    x: number,
    y: number,
    base: [number, number],
    offsets: readonly [number, number][],
    fractalSum: boolean,
    stitching: boolean,
    width: number,
    height: number,
  ): number {
    let [fx, fy] = base;
    let stitch: Stitch | null = null;
    if (stitching) {
      if (fx !== 0) {
        const lo = Math.floor(width * fx) / width;
        const hi = Math.ceil(width * fx) / width;
        fx = fx / lo < hi / fx ? lo : hi;
      }

      // Not the reference's slip, which Ruffle keeps, the y frequency's floor from the x one (adl).
      if (fy !== 0) {
        const lo = Math.floor(height * fy) / height;
        const hi = Math.ceil(height * fy) / height;
        fy = fy / lo < hi / fy ? lo : hi;
      }

      const w = Math.trunc(width * fx + 0.5);
      const h = Math.trunc(height * fy + 0.5);
      stitch = this.stitch;
      stitch.width = w;
      stitch.height = h;
      stitch.wrapX = PERLIN_N + w;
      stitch.wrapY = PERLIN_N + h;
    }

    let sum = 0;
    let ratio = 1;
    for (const [ox, oy] of offsets) {
      const noise = this.noise2(channel, (x + ox) * fx * ratio, (y + oy) * fy * ratio, stitch);
      sum += (fractalSum ? noise : Math.abs(noise)) / ratio;
      ratio *= 2;
      if (stitch) {
        stitch.width *= 2;
        stitch.wrapX = 2 * stitch.wrapX - PERLIN_N;
        stitch.height *= 2;
        stitch.wrapY = 2 * stitch.wrapY - PERLIN_N;
      }
    }

    return sum;
  }
}
