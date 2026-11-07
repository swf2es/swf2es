// Nellymoser Asao, the speech codec of DefineSound's and a stream's
// formats 4, 5 and 6: translated from FFmpeg's libavcodec/nellymoser.c and
// nellymoserdec.c, which carry this notice:
//
// Copyright (c) 2007 a840bda5870ba11f19698ff6eb9581dfb0f95fa5,
//                    539459aeb7d425140b62a3ec7dbf6dc8e408a306, and
//                    520e17cd55896441042b14df2566a6eb610ed444
// Copyright (c) 2007 Loic Minier <lool at dooz.org>
//                    Benjamin Larsson
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the "Software"),
// to deal in the Software without restriction, including without limitation
// the rights to use, copy, modify, merge, publish, distribute, sublicense,
// and/or sell copies of the Software, and to permit persons to whom the
// Software is furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL
// THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
// FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
// DEALINGS IN THE SOFTWARE.
//
// (The three alphanumeric notices are the MD5 sums of the original
// implementers' names, of nelly2pcm.)
//
// Each 64-byte block is 256 mono samples: band energies, then two halves
// of 124 coefficients whose bit widths the energies decide, each through
// an inverse MDCT and overlapped with the half before it. Bands given no
// bits are noise of the band's energy, its signs from a generator of this
// file's own rather than FFmpeg's, as the ear cannot tell.

const BANDS = 23;
const BLOCK_LEN = 64;
const HEADER_BITS = 116;
const DETAIL_BITS = 198;
const BUF_LEN = 128;
const FILL_LEN = 124;
const BIT_CAP = 6;
const BASE_OFF = 4228;
const BASE_SHIFT = 19;
/** The samples a block decodes to. */
export const NELLY_SAMPLES = 2 * BUF_LEN;

const DEQUANTIZATION = Float32Array.of(
  0.0,
  -0.8472560048,
  0.7224709988,
  -1.5247479677,
  -0.4531480074,
  0.3753609955,
  1.4717899561,
  -1.9822579622,
  -1.1929379702,
  -0.5829370022,
  -0.0693780035,
  0.3909569979,
  0.9069200158,
  1.486274004,
  2.2215409279,
  -2.3887870312,
  -1.806753993,
  -1.4105420113,
  -1.0773609877,
  -0.7995010018,
  -0.5558109879,
  -0.3334020078,
  -0.1324490011,
  0.0568020009,
  0.254877001,
  0.4773550034,
  0.7386850119,
  1.0443060398,
  1.3954459429,
  1.8098750114,
  2.3918759823,
  -2.3893830776,
  -1.988468051,
  -1.751404047,
  -1.5643119812,
  -1.3922129869,
  -1.2164649963,
  -1.0469499826,
  -0.8905100226,
  -0.7645580173,
  -0.645457983,
  -0.5259280205,
  -0.4059549868,
  -0.3029719889,
  -0.2096900046,
  -0.1239869967,
  -0.0479229987,
  0.025773,
  0.1001340002,
  0.1737180054,
  0.2585540116,
  0.3522900045,
  0.4569880068,
  0.5767750144,
  0.7003160119,
  0.8425520062,
  1.00938797,
  1.1821349859,
  1.3534560204,
  1.5320819616,
  1.7332619429,
  1.9722349644,
  2.3978140354,
  -2.5756309032,
  -2.0573320389,
  -1.8984919786,
  -1.7727810144,
  -1.666260004,
  -1.5742180347,
  -1.4993319511,
  -1.43166399,
  -1.3652280569,
  -1.3000990152,
  -1.2280930281,
  -1.1588579416,
  -1.0921250582,
  -1.0135740042,
  -0.9202849865,
  -0.8287050128,
  -0.7374889851,
  -0.6447759867,
  -0.5590940118,
  -0.4857139885,
  -0.4110319912,
  -0.3459700048,
  -0.2851159871,
  -0.2341620028,
  -0.1870580018,
  -0.1442500055,
  -0.1107169986,
  -0.0739680007,
  -0.0365610011,
  -0.0073290002,
  0.0203610007,
  0.0479039997,
  0.0751969963,
  0.0980999991,
  0.1220389977,
  0.1458999962,
  0.1694349945,
  0.1970459968,
  0.2252430022,
  0.2556869984,
  0.2870100141,
  0.3197099864,
  0.3525829911,
  0.3889069855,
  0.4334920049,
  0.4769459963,
  0.5204820037,
  0.5644530058,
  0.6122040153,
  0.6685929894,
  0.7341650128,
  0.8032159805,
  0.8784040213,
  0.9566209912,
  1.0397069454,
  1.1293770075,
  1.2211159468,
  1.3080279827,
  1.4024800062,
  1.5056819916,
  1.6227730513,
  1.772495985,
  1.9430880547,
  2.2903931141,
);

const BAND_SIZES = Uint8Array.of(
  2,
  2,
  2,
  2,
  2,
  2,
  2,
  2,
  2,
  3,
  3,
  4,
  4,
  5,
  6,
  6,
  7,
  8,
  9,
  10,
  12,
  14,
  15,
);

const INIT = Uint16Array.of(
  3134,
  5342,
  6870,
  7792,
  8569,
  9185,
  9744,
  10191,
  10631,
  11061,
  11434,
  11770,
  12116,
  12513,
  12925,
  13300,
  13674,
  14027,
  14352,
  14716,
  15117,
  15477,
  15824,
  16157,
  16513,
  16804,
  17090,
  17401,
  17679,
  17948,
  18238,
  18520,
  18764,
  19078,
  19381,
  19640,
  19921,
  20205,
  20500,
  20813,
  21162,
  21465,
  21794,
  22137,
  22453,
  22756,
  23067,
  23350,
  23636,
  23926,
  24227,
  24521,
  24819,
  25107,
  25414,
  25730,
  26120,
  26497,
  26895,
  27344,
  27877,
  28463,
  29426,
  31355,
);

const DELTA = Int16Array.of(
  -11725,
  -9420,
  -7910,
  -6801,
  -5948,
  -5233,
  -4599,
  -4039,
  -3507,
  -3030,
  -2596,
  -2170,
  -1774,
  -1383,
  -1016,
  -660,
  -329,
  -1,
  337,
  696,
  1085,
  1512,
  1962,
  2433,
  2968,
  3569,
  4314,
  5279,
  6622,
  8154,
  10076,
  12975,
);

/** The window halves overlap by: FFmpeg's ff_sine_128. */
const SINE = Float32Array.from({ length: BUF_LEN }, (_, i) =>
  Math.sin((i + 0.5) * (Math.PI / (2 * BUF_LEN))),
);

/** The inverse MDCT's twiddles, FFmpeg's ff_mdct_init's for 256 points at a scale of 1. */
const N4 = BUF_LEN / 2;
const TCOS = Float64Array.from(
  { length: N4 },
  (_, i) => -Math.cos((2 * Math.PI * (i + 1 / 8)) / 256),
);
const TSIN = Float64Array.from(
  { length: N4 },
  (_, i) => -Math.sin((2 * Math.PI * (i + 1 / 8)) / 256),
);
/** Where each of the FFT's 64 points goes in its bit-reversed order. */
const REVERSED = Uint8Array.from({ length: N4 }, (_, i) => {
  let r = 0;
  for (let b = 0; b < 6; b++) {
    r |= ((i >> b) & 1) << (5 - b);
  }

  return r;
});
/** The FFT's roots: e^(2 pi i k / 64), an inverse transform's. */
const ROOT_RE = Float64Array.from({ length: N4 / 2 }, (_, k) => Math.cos((2 * Math.PI * k) / N4));
const ROOT_IM = Float64Array.from({ length: N4 / 2 }, (_, k) => Math.sin((2 * Math.PI * k) / N4));

/** A short, as C's stores wrap it. */
const short = (v: number) => (v << 16) >> 16;

/** C's floor(log2(v)) for a positive v, av_log2. */
const log2 = (v: number) => 31 - Math.clz32(v);

/** The bits each coefficient takes, from the bands' energies: ff_nelly_get_sample_bits. */
function sampleBits(buf: Float32Array, bits: Int32Array): void {
  const sbuf = new Int16Array(FILL_LEN);
  // headroom(&v): how far v may be shifted up, and v shifted.
  const headroom = (v: number): [number, number] => {
    if (v === 0) {
      return [31, 0];
    }

    const l = 30 - log2(Math.abs(v));
    return [l, Math.imul(v, 1 << l)];
  };
  const sumBits = (shift: number, offset: number): number => {
    const off = short(offset);
    let sum = 0;
    for (let i = 0; i < FILL_LEN; i++) {
      const b = (((sbuf[i] - off) >> (shift - 1)) + 1) >> 1;
      sum += b < 0 ? 0 : b > BIT_CAP ? BIT_CAP : b;
    }

    return sum;
  };
  const signedShift = (v: number, shift: number) => (shift > 0 ? v << shift : v >> -shift);

  let max = 0;
  for (let i = 0; i < FILL_LEN; i++) {
    max = Math.max(max, Math.trunc(buf[i]));
  }

  let shift = -16;
  let room: number;
  [room, max] = headroom(max);
  shift = short(shift + room);
  let sum = 0;
  for (let i = 0; i < FILL_LEN; i++) {
    sbuf[i] = signedShift(Math.trunc(buf[i]), shift);
    sbuf[i] = (3 * sbuf[i]) >> 2;
    sum += sbuf[i];
  }

  shift = short(shift + 11);
  const saved = shift;
  sum = (sum - (DETAIL_BITS << shift)) | 0;
  [room, sum] = headroom(sum);
  shift = short(shift + room);
  let small = Math.imul(BASE_OFF, sum >> 16) >> 15;
  shift = short(saved - (BASE_SHIFT + shift - 31));
  small = signedShift(small, shift);
  let bitsum = sumBits(saved, small);
  if (bitsum !== DETAIL_BITS) {
    let off = bitsum - DETAIL_BITS;
    for (shift = 0; Math.abs(off) <= 16383; shift++) {
      off *= 2;
    }

    off = Math.imul(off, BASE_OFF) >> 15;
    shift = short(saved - (BASE_SHIFT + shift - 15));
    off = signedShift(off, shift);
    let last = small;
    let lastBitsum = bitsum;
    let j = 1;
    for (; j < 20; j++) {
      last = small;
      small = (small + off) | 0;
      lastBitsum = bitsum;
      bitsum = sumBits(saved, small);
      if ((bitsum - DETAIL_BITS) * (lastBitsum - DETAIL_BITS) <= 0) {
        break;
      }
    }

    let big: number;
    let bigBitsum: number;
    let smallBitsum: number;
    if (bitsum > DETAIL_BITS) {
      big = small;
      small = last;
      bigBitsum = bitsum;
      smallBitsum = lastBitsum;
    } else {
      big = last;
      bigBitsum = lastBitsum;
      smallBitsum = bitsum;
    }

    while (bitsum !== DETAIL_BITS && j <= 19) {
      off = (big + small) >> 1;
      bitsum = sumBits(saved, off);
      if (bitsum > DETAIL_BITS) {
        big = off;
        bigBitsum = bitsum;
      } else {
        small = off;
        smallBitsum = bitsum;
      }

      j++;
    }

    if (Math.abs(bigBitsum - DETAIL_BITS) >= Math.abs(smallBitsum - DETAIL_BITS)) {
      bitsum = smallBitsum;
    } else {
      small = big;
      bitsum = bigBitsum;
    }
  }

  for (let i = 0; i < FILL_LEN; i++) {
    const b = (((sbuf[i] - small) >> (saved - 1)) + 1) >> 1;
    bits[i] = b < 0 ? 0 : b > BIT_CAP ? BIT_CAP : b;
  }

  if (bitsum > DETAIL_BITS) {
    let total = 0;
    let i = 0;
    while (total < DETAIL_BITS) {
      total += bits[i];
      i++;
    }

    bits[i - 1] -= total - DETAIL_BITS;
    for (; i < FILL_LEN; i++) {
      bits[i] = 0;
    }
  }
}

/** Nellymoser's blocks into samples, the overlap carried from one call to the next, as a stream's blocks need. */
export class NellymoserDecoder {
  readonly #buf = new Float32Array(FILL_LEN);
  readonly #pows = new Float32Array(FILL_LEN);
  readonly #bits = new Int32Array(BUF_LEN);
  readonly #coefficients = new Float32Array(BUF_LEN);
  #out = new Float32Array(BUF_LEN);
  #prev = new Float32Array(BUF_LEN);
  #random = 1;
  /** The FFT's points. */
  readonly #re = new Float64Array(N4);
  readonly #im = new Float64Array(N4);

  /** `data`'s whole 64-byte blocks as samples from -1 to 1, 256 a block. */
  decode(data: Uint8Array): Float32Array {
    const blocks = Math.floor(data.length / BLOCK_LEN);
    const audio = new Float32Array(blocks * NELLY_SAMPLES);
    for (let b = 0; b < blocks; b++) {
      this.#block(data.subarray(b * BLOCK_LEN, (b + 1) * BLOCK_LEN), audio, b * NELLY_SAMPLES);
    }

    return audio;
  }

  #block(block: Uint8Array, audio: Float32Array, at: number): void {
    let bit = 0;
    // FFmpeg's little-endian bit reader: the first bit read is the value's lowest.
    const read = (n: number): number => {
      let v = 0;
      for (let i = 0; i < n; i++, bit++) {
        v |= ((block[bit >> 3] >> (bit & 7)) & 1) << i;
      }

      return v;
    };

    const buf = this.#buf;
    const pows = this.#pows;
    let val = INIT[read(6)];
    for (let i = 0, p = 0; i < BANDS; i++) {
      if (i > 0) {
        val += DELTA[read(5)];
      }

      const pval = -(2 ** (val / 2048)) / (32768 * 8);
      for (let j = 0; j < BAND_SIZES[i]; j++, p++) {
        buf[p] = val;
        pows[p] = pval;
      }
    }

    const bits = this.#bits;
    sampleBits(buf, bits);
    const a = this.#coefficients;
    for (let half = 0; half < 2; half++) {
      bit = HEADER_BITS + half * DETAIL_BITS;
      for (let j = 0; j < FILL_LEN; j++) {
        if (bits[j] <= 0) {
          a[j] = Math.SQRT1_2 * pows[j];
          // A xorshift's low bit for the noise's sign.
          this.#random ^= this.#random << 13;
          this.#random ^= this.#random >>> 17;
          this.#random ^= this.#random << 5;
          if (this.#random & 1) {
            a[j] = -a[j];
          }
        } else {
          const v = read(bits[j]);
          a[j] = DEQUANTIZATION[(1 << bits[j]) - 1 + v] * pows[j];
        }
      }

      a.fill(0, FILL_LEN);
      this.#imdct(a);
      // FFmpeg's vector_fmul_window over the last half's second half and this one's first.
      const out = audio.subarray(at + half * BUF_LEN, at + (half + 1) * BUF_LEN);
      const len = BUF_LEN / 2;
      for (let i = 0; i < len; i++) {
        const j = len - 1 - i;
        const s0 = this.#prev[len + i];
        const s1 = this.#out[j];
        const wi = SINE[i];
        const wj = SINE[len + j];
        out[i] = s0 * wj - s1 * wi;
        out[len + j] = s0 * wi + s1 * wj;
      }

      [this.#out, this.#prev] = [this.#prev, this.#out];
    }
  }

  /**
   * The middle half of the 256-point inverse MDCT of `a`'s 128
   * coefficients into the current half's output, as FFmpeg's imdct_half:
   * rotated into 64 complex points, an inverse FFT, rotated back.
   */
  #imdct(a: Float32Array): void {
    const re = this.#re;
    const im = this.#im;
    for (let k = 0; k < N4; k++) {
      const x = a[BUF_LEN - 1 - 2 * k];
      const y = a[2 * k];
      const j = REVERSED[k];
      re[j] = x * TCOS[k] - y * TSIN[k];
      im[j] = x * TSIN[k] + y * TCOS[k];
    }

    for (let size = 2; size <= N4; size *= 2) {
      const half = size / 2;
      const step = N4 / size;
      for (let start = 0; start < N4; start += size) {
        for (let k = 0; k < half; k++) {
          const wr = ROOT_RE[k * step];
          const wi = ROOT_IM[k * step];
          const p = start + k;
          const q = p + half;
          const tr = re[q] * wr - im[q] * wi;
          const ti = re[q] * wi + im[q] * wr;
          re[q] = re[p] - tr;
          im[q] = im[p] - ti;
          re[p] += tr;
          im[p] += ti;
        }
      }
    }

    const out = this.#out;
    const n8 = N4 / 2;
    for (let k = 0; k < n8; k++) {
      const lo = n8 - k - 1;
      const hi = n8 + k;
      const r0 = im[lo] * TSIN[lo] - re[lo] * TCOS[lo];
      const i1 = im[lo] * TCOS[lo] + re[lo] * TSIN[lo];
      const r1 = im[hi] * TSIN[hi] - re[hi] * TCOS[hi];
      const i0 = im[hi] * TCOS[hi] + re[hi] * TSIN[hi];
      out[2 * lo] = r0;
      out[2 * lo + 1] = i0;
      out[2 * hi] = r1;
      out[2 * hi + 1] = i1;
    }
  }
}
