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
 * perlinNoise's set-up of `seed`: the lattice, and four channels'
 * gradients, x and y interleaved, one after another; the frequencies,
 * adjusted where stitching to tile a `width` by `height` image, and the
 * tile in lattice cells at the first octave. The render module draws the
 * noise of them (pixels.zig).
 */
export function perlinSetup(
  seed: number,
  base: [number, number],
  stitching: boolean,
  width: number,
  height: number,
): {
  lattice: Int32Array;
  gradients: Float64Array;
  fx: number;
  fy: number;
  stitch: boolean;
  stitchWidth: number;
  stitchHeight: number;
} {
  const lattice = new Int32Array(B_SIZE + B_SIZE + 2);
  const cells = (B_SIZE + B_SIZE + 2) * 2;
  const gradients = new Float64Array(cells * 4);
  let s = setupSeed(seed);
  for (let c = 0; c < 4; c++) {
    const g = gradients.subarray(c * cells, (c + 1) * cells);
    for (let i = 0; i < B_SIZE; i++) {
      lattice[i] = i;
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
    const k = lattice[i];
    s = random(s);
    const j = s % B_SIZE;
    lattice[i] = lattice[j];
    lattice[j] = k;
  }

  for (let i = 0; i < B_SIZE + 2; i++) {
    lattice[B_SIZE + i] = lattice[i];
    for (let c = 0; c < 4; c++) {
      gradients[c * cells + (B_SIZE + i) * 2] = gradients[c * cells + i * 2];
      gradients[c * cells + (B_SIZE + i) * 2 + 1] = gradients[c * cells + i * 2 + 1];
    }
  }

  let [fx, fy] = base;
  let stitchWidth = 0;
  let stitchHeight = 0;
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

    stitchWidth = Math.trunc(width * fx + 0.5);
    stitchHeight = Math.trunc(height * fy + 0.5);
  }

  return { lattice, gradients, fx, fy, stitch: stitching, stitchWidth, stitchHeight };
}
