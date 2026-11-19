// Flash's random numbers: avmplus' generator, a 31-bit LFSR whose state is
// hashed by a third-order polynomial, so that each value is an int from 0
// to 2^31 - 1 and Math.random() one of those over 2^31. Content can rely
// on that value set, which JavaScript's Math.random, of 52 bits, leaves.
//
// Translated from avmplus' core/MathUtils.cpp (RandomFastInit,
// RandomFastNext, RandomPureHasher, GenerateRandomNumber, Random and
// random), this file is subject to the Mozilla Public License, v. 2.0:
// http://mozilla.org/MPL/2.0/.

// Random_Xor_Masks[n - 2] for n = 31, the mask of a sequence of 2^31 - 1.
const XOR_MASK = 0x48000000;
const PURE_MAX = 0x7fffffff;

const clock = (globalThis as { performance?: { now(): number; timeOrigin?: number } }).performance;
let made = 0;

/**
 * Flash's seed, the performance counter's low 32 bits: microseconds here.
 * A browser coarsens its clock to as much as 100 µs, so a count of the
 * seeds taken sets apart generators made within one tick of it.
 */
function counterSeed(): number {
  const ms = clock !== undefined ? (clock.timeOrigin ?? 0) + clock.now() : Date.now();
  made = (made + 1) >>> 0;
  return Math.floor(ms * 1000) ^ Math.imul(made, 0x9e3779b9);
}

/** RandomPureHasher, in the 32-bit wrapping arithmetic of avmplus' C++. */
function pureHash(seed: number): number {
  let s = (((seed << 13) ^ seed) - (seed >> 21)) | 0;
  // The C++ multiplies in a long, whose low 31 bits, all it keeps, are these.
  let r = (Math.imul(s, (Math.imul(Math.imul(s, s), 15731) + 789221) | 0) + 1376312589) & PURE_MAX;
  r = (r + s) | 0;
  s = (((r << 13) ^ r) - (r >> 21)) | 0;

  return s;
}

/** A TRandomFast: each runtime has its own, as each avmplus toplevel's Math has. */
export class FlashRandom {
  /** uValue, the LFSR's state: a uint32's bits, kept as an int32 as V8 keeps it best. */
  private value = 0;

  /** Seeded from the clock, as Flash's is, unless given a seed. */
  constructor(seed: number = counterSeed()) {
    this.seed(seed);
  }

  /** RandomFastInit with a seed: the sequence from there. */
  seed(seed: number): void {
    this.value = seed | 0;
  }

  /** GenerateRandomNumber: an int from 0 to 2^31 - 1. */
  next(): number {
    let v = this.value;
    if (v === 0) {
      v = counterSeed();
    }

    // RandomFastNext, without a branch: its low bit is a coin flip, which
    // a branch mispredicts half the time, doubling the call's cost.
    v = (v >>> 1) ^ (-(v & 1) & XOR_MASK);
    this.value = v;

    return pureHash(Math.imul(v, 71)) & PURE_MAX;
  }

  /** random(): a multiple of 2^-31 from 0 below 1. */
  random(): number {
    return this.next() / 2147483648;
  }

  /** Random(range): an int from 0 below `range`, 0 for a range below 1. */
  range(range: number): number {
    return range > 0 ? this.next() % range : 0;
  }
}
