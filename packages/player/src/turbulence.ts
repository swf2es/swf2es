// Perlin noise as BitmapData.perlinNoise makes it: the reference
// implementation of SVG's feTurbulence, which Flash's matches, with an
// offset for each octave, as Ruffle ports it (turbulence.rs).
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

export class Turbulence {
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

      // The reference's slip, which Ruffle keeps: the y frequency's floor from the x one.
      if (fy !== 0) {
        const lo = Math.floor(height * fx) / height;
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
