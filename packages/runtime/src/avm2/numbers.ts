// Numbers as avmplus writes them: MathUtils::convertDoubleToString and its
// digit generator, D2A (Burger and Dybvig's), translated as they are, since
// their output is AS3's and differs from JavaScript's: Number.MAX_VALUE is
// 1.79769313486231e+308, a denormal gets 17 digits, and toFixed rounds its
// own way. Also convertDoubleToStringRadix, which writes only the integer
// part.
//
// Translated from avmplus' core/MathUtils.cpp and core/d2a.cpp, this file is
// subject to the Mozilla Public License, v. 2.0: http://mozilla.org/MPL/2.0/.

export const DTOSTR_NORMAL = 0;
export const DTOSTR_FIXED = 1;
export const DTOSTR_PRECISION = 2;
export const DTOSTR_EXPONENTIAL = 3;

// avmplus' kLog2_10, 0.30102999566398119521373889472449, as the double it is.
const kLog2_10 = 0.3010299956639812;
const maxBase2Precision = 53;
const two_pow_52 = 2 ** 52;

const kPowersOfTen = [
  1, 1e1, 1e2, 1e3, 1e4, 1e5, 1e6, 1e7, 1e8, 1e9, 1e10, 1e11, 1e12, 1e13, 1e14, 1e15, 1e16, 1e17,
  1e18, 1e19, 1e20, 1e21, 1e22,
];

function quickPowTen(exp: number): number {
  return exp >= 0 && exp < 23 ? kPowersOfTen[exp] : 10 ** exp;
}

/** 10^exp exactly, as quickBigPowTen computes it for exp >= 0. */
function bigPowTen(exp: number): bigint {
  return 10n ** BigInt(exp);
}

const bits = new DataView(new ArrayBuffer(8));

/**
 * As MathUtils::frexp on Unix: value = mantissa * 2^e, the mantissa an
 * integer of 53 bits, normalized as C's frexp normalizes, denormals too.
 */
function frexp(value: number): [number, number] {
  if (value === 0 || !Number.isFinite(value)) {
    return [0, value === 0 ? -53 : 0];
  }

  bits.setFloat64(0, Math.abs(value));
  const hi = bits.getUint32(0);
  const lo = bits.getUint32(4);
  const exponent = (hi >>> 20) & 0x7ff;
  let mantissa = (hi & 0xfffff) * 2 ** 32 + lo;
  if (exponent !== 0) {
    return [mantissa + two_pow_52, exponent - 1075];
  }

  // A denormal: frexp's fraction is still in [0.5, 1).
  let e = -1074;
  while (mantissa < two_pow_52) {
    mantissa *= 2;
    e--;
  }

  return [mantissa, e];
}

/** As avmplus' int32_t(value): a truncated int, or 0x80000000 when out of range. */
function toInt32Truncated(value: number): number {
  const t = Math.trunc(value);
  return t >= -2147483648 && t <= 2147483647 ? t : -2147483648;
}

/** D2A: the digits of a positive double, one at a time. */
class D2A {
  finished = false;
  readonly bFastEstimateOk: boolean;
  readonly base10Exp: number;
  private readonly e: number;
  private readonly mantissaPrec: number;
  private readonly lowOk: boolean;
  private readonly highOk: boolean;
  private dr = 0;
  private ds = 0;
  private dMPlus = 0;
  private dMMinus = 0;
  private r = 0n;
  private s = 0n;
  private mPlus = 0n;
  private mMinus = 0n;

  constructor(value: number, fixedPrecision: boolean, minPrecision: number) {
    const [mantissa, e] = frexp(value);
    this.e = e;
    if (fixedPrecision) {
      this.lowOk = this.highOk = true;
    } else {
      const round = mantissa % 2 === 0;
      this.lowOk = this.highOk = round;
    }

    let prec = maxBase2Precision;
    while (prec !== 0 && Math.floor(mantissa / 2 ** --prec) % 2 === 0) {
      // the leading zeroes
    }

    this.mantissaPrec = prec + 1;
    const absE = e > 0 ? e : -e;
    this.bFastEstimateOk = absE + this.mantissaPrec - 1 < 50;

    if (this.bFastEstimateOk) {
      if (e >= 0) {
        const be = 2 ** e;
        if (mantissa !== two_pow_52) {
          this.dr = mantissa * be * 2;
          this.ds = 2;
          this.dMPlus = be;
          this.dMMinus = be;
        } else {
          const be1 = be * 2;
          this.dr = mantissa * be1 * 2;
          this.ds = 4;
          this.dMPlus = be1;
          this.dMMinus = be;
        }
      } else if (mantissa !== two_pow_52) {
        this.dr = mantissa * 2;
        this.ds = 2 ** (1 - e);
        this.dMPlus = 1;
        this.dMMinus = 1;
      } else {
        this.dr = mantissa * 4;
        this.ds = 2 ** (2 - e);
        this.dMPlus = 2;
        this.dMMinus = 1;
      }

      if (fixedPrecision) {
        const p = quickPowTen(minPrecision);
        this.ds *= p;
        this.dr *= p;
      }
    } else {
      const m = BigInt(mantissa);
      if (e >= 0) {
        const be = 1n << BigInt(e);
        if (mantissa !== two_pow_52) {
          this.r = (m << BigInt(e)) * 2n;
          this.s = 2n;
          this.mPlus = be;
          this.mMinus = be;
        } else {
          this.r = (m << BigInt(e)) * 4n;
          this.s = 4n;
          this.mPlus = be * 2n;
          this.mMinus = be;
        }
      } else if (mantissa !== two_pow_52) {
        this.r = m * 2n;
        this.s = 2n << BigInt(-e);
        this.mPlus = 1n;
        this.mMinus = 1n;
      } else {
        this.r = m * 4n;
        this.s = 2n << BigInt(1 - e);
        this.mPlus = 2n;
        this.mMinus = 1n;
      }

      if (fixedPrecision) {
        const p = bigPowTen(minPrecision);
        this.s *= p;
        this.r *= p;
      }
    }

    this.base10Exp = this.scale();
  }

  /** The next digit, or -1 once every relevant one is out. */
  nextDigit(): number {
    if (this.finished) {
      return -1;
    }

    let low: boolean;
    let high: boolean;
    let quotient: number;
    if (this.bFastEstimateOk) {
      quotient = toInt32Truncated(this.dr / this.ds);
      this.dr = this.dr % this.ds;
      low = this.lowOk ? this.dr <= this.dMMinus : this.dr < this.dMMinus;
      high = this.highOk ? this.dr + this.dMPlus >= this.ds : this.dr + this.dMPlus > this.ds;
    } else {
      quotient = Number((this.r / this.s) & 0xffffffffn);
      this.r = this.r % this.s;
      low = this.lowOk ? this.r <= this.mMinus : this.r < this.mMinus;
      high = this.highOk ? this.r + this.mPlus >= this.s : this.r + this.mPlus > this.s;
    }

    if (quotient < 0 || quotient > 9) {
      quotient = 0;
    }

    if (!low) {
      if (!high) {
        if (this.bFastEstimateOk) {
          this.dr *= 10;
          this.dMPlus *= 10;
          this.dMMinus *= 10;
        } else {
          this.r *= 10n;
          this.mPlus *= 10n;
          this.mMinus *= 10n;
        }
      } else {
        quotient++;
        this.finished = true;
      }
    } else if (!high) {
      this.finished = true;
    } else {
      const under = this.bFastEstimateOk ? this.dr * 2 < this.ds : this.r + this.r < this.s;
      if (!under) {
        quotient++;
      }

      this.finished = true;
    }

    return quotient;
  }

  private fixupExponentEstimate(estimate: number): number {
    if (this.bFastEstimateOk) {
      if (this.highOk ? this.dr + this.dMPlus >= this.ds : this.dr + this.dMPlus > this.ds) {
        return estimate + 1;
      }

      this.dr *= 10;
      this.dMPlus *= 10;
      this.dMMinus *= 10;
      return estimate;
    }

    if (this.highOk ? this.r + this.mPlus >= this.s : this.r + this.mPlus > this.s) {
      return estimate + 1;
    }

    this.r *= 10n;
    this.mPlus *= 10n;
    this.mMinus *= 10n;
    return estimate;
  }

  private scale(): number {
    const base2Exponent = this.e + this.mantissaPrec - 1;
    const estimate = Math.ceil(base2Exponent * kLog2_10 - 0.0000000001);
    const abs = estimate > 0 ? estimate : -estimate;
    if (this.bFastEstimateOk) {
      const scale = quickPowTen(abs);
      if (estimate >= 0) {
        this.ds *= scale;
      } else {
        this.dr *= scale;
        this.dMPlus *= scale;
        this.dMMinus *= scale;
      }
    } else {
      const scale = bigPowTen(abs);
      if (estimate >= 0) {
        this.s *= scale;
      } else {
        this.r *= scale;
        this.mPlus *= scale;
        this.mMinus *= scale;
      }
    }

    return this.fixupExponentEstimate(estimate);
  }
}

const ZERO = 0x30;
const DOT = 0x2e;

/**
 * As MathUtils::convertDoubleToString, with the bug compatibility of SWF 15
 * and later (bugzilla 513039, toFixed(0)), as avmshell runs.
 */
export function convertDoubleToString(
  input: number,
  mode = DTOSTR_NORMAL,
  precisionIn = 15,
): string {
  if (input === Number.POSITIVE_INFINITY) {
    return "Infinity";
  }

  if (input === Number.NEGATIVE_INFINITY) {
    return "-Infinity";
  }

  if (Number.isNaN(input)) {
    return "NaN";
  }

  let value = input;
  let precision = precisionIn;
  if (mode === DTOSTR_NORMAL) {
    const intValue = toInt32Truncated(value);
    if (value === intValue && intValue !== -2147483648) {
      return String(intValue);
    }
  }

  const buffer: number[] = [];
  const negative = value < 0;
  const zero = value === 0;
  const noFraction = precision === 0;
  const bugzilla513039 = true;
  let round = true;
  let s = 0;
  if (negative) {
    value = -value;
    s++;
  }

  const d2a = new D2A(value, mode !== DTOSTR_NORMAL, precision);
  let exp10 = d2a.base10Exp - 1;
  const sentinel = s;
  const put = (c: number) => {
    buffer[s++] = c;
  };

  const kNormal = 0;
  const kExponential = 1;
  const kFraction = 2;
  const kFixedFraction = 3;
  let format: number;
  switch (mode) {
    case DTOSTR_FIXED:
      if (exp10 < 0) {
        format = kFixedFraction;
      } else {
        format = kNormal;
        precision++;
      }
      break;
    case DTOSTR_PRECISION:
      format = exp10 < 0 ? kFraction : exp10 >= precision ? kExponential : kNormal;
      break;
    case DTOSTR_EXPONENTIAL:
      format = kExponential;
      precision++;
      break;
    default:
      if (exp10 < 0 && exp10 > -7) {
        if (exp10 < -precision) {
          exp10 = -precision - 1;
        }
        format = kFraction;
      } else if (exp10 > 20) {
        format = kExponential;
      } else {
        format = kNormal;
      }
  }

  let wroteDecimal = false;
  switch (format) {
    case kNormal: {
      let digits = 0;
      put(ZERO);
      let digit = d2a.nextDigit();
      if (digit > 0) {
        put(digit + ZERO);
      }

      while (exp10 > 0) {
        digit = d2a.finished ? 0 : d2a.nextDigit();
        put(digit + ZERO);
        exp10--;
        digits++;
      }

      if (mode === DTOSTR_FIXED) {
        digits = 0;
      }

      if (mode === DTOSTR_NORMAL) {
        if (!d2a.finished) {
          put(DOT);
          wroteDecimal = true;
          while (!d2a.finished) {
            put(d2a.nextDigit() + ZERO);
          }
        }
      } else if (digits < precision - 1) {
        put(DOT);
        wroteDecimal = true;
        for (; digits < precision - 1; digits++) {
          digit = d2a.finished ? 0 : d2a.nextDigit();
          put(digit + ZERO);
        }
      }
      break;
    }
    case kFixedFraction: {
      put(ZERO);
      put(ZERO);
      put(DOT);
      wroteDecimal = true;
      let digits = 0;
      if (exp10 > 0) {
        while (++exp10 < 10 && digits < precision) {
          put(ZERO);
          digits++;
        }
      } else if (exp10 < 0) {
        if (bugzilla513039) {
          while (exp10 < -1 && precision > 0) {
            exp10++;
            precision--;
            put(ZERO);
          }

          if (precision === 0 && exp10 !== 0) {
            round = false;
          }
        } else {
          while (++exp10 < 0 && precision-- > 0) {
            put(ZERO);
          }
        }
      }

      for (; digits < precision; digits++) {
        if (d2a.finished) {
          if (mode === DTOSTR_NORMAL) {
            break;
          }
          put(ZERO);
        } else {
          put(d2a.nextDigit() + ZERO);
        }
      }

      exp10 = 0;
      break;
    }
    case kFraction: {
      put(ZERO);
      put(ZERO);
      put(DOT);
      wroteDecimal = true;
      if (!zero) {
        for (let i = exp10; i < -1; i++) {
          put(ZERO);
        }
      }

      let i = 0;
      while (!d2a.finished) {
        put(d2a.nextDigit() + ZERO);
        if (mode !== DTOSTR_NORMAL && ++i >= precision) {
          break;
        }
      }

      if (mode === DTOSTR_PRECISION) {
        while (i++ < precision) {
          put(d2a.finished ? ZERO : d2a.nextDigit() + ZERO);
        }
      }

      exp10 = 0;
      break;
    }
    default: {
      const digit = d2a.finished ? 0 : d2a.nextDigit();
      put(digit + ZERO);
      if ((mode === DTOSTR_NORMAL && !d2a.finished) || (mode !== DTOSTR_NORMAL && precision > 1)) {
        put(DOT);
        wroteDecimal = true;
        for (let i = 0; i < precision - 1; i++) {
          if (d2a.finished) {
            if (mode === DTOSTR_NORMAL) {
              break;
            }
            put(ZERO);
          } else {
            put(d2a.nextDigit() + ZERO);
          }
        }
      }
    }
  }

  // Rounding and truncation.
  if (round && (d2a.bFastEstimateOk || mode === DTOSTR_FIXED || mode === DTOSTR_PRECISION)) {
    if (d2a.nextDigit() > 4) {
      for (let p = s - 1; p >= sentinel; p--) {
        if (buffer[p] === DOT) {
          continue;
        }

        buffer[p]++;
        if (buffer[p] !== ZERO + 10) {
          break;
        }

        buffer[p] = ZERO;
      }
    }

    if (mode === DTOSTR_NORMAL && wroteDecimal) {
      while (buffer[s - 1] === ZERO) {
        s--;
      }

      if (buffer[s - 1] === DOT) {
        s--;
      }
    }
  }

  // Clean up zeroes, and place the exponent.
  if (exp10) {
    let firstNonZero = sentinel;
    while (firstNonZero < s && buffer[firstNonZero] === ZERO) {
      firstNonZero++;
    }

    if (s === firstNonZero) {
      put(ZERO + 1);
      exp10++;
    } else if (!zero) {
      let lastNonZero = s;
      while (lastNonZero > firstNonZero && buffer[--lastNonZero] === ZERO) {
        // the trailing zeroes
      }

      if (firstNonZero === lastNonZero) {
        exp10 += s - firstNonZero - 1;
        s = lastNonZero + 1;
      }
    }

    put(0x65); // e
    if (exp10 > 0) {
      put(0x2b); // +
    }

    for (const c of String(exp10)) {
      put(c.charCodeAt(0));
    }
  }

  let len = s;
  let start = sentinel;
  if (buffer[sentinel] === ZERO && buffer[sentinel + 1] !== DOT) {
    start = sentinel + 1;
    len--;
  }

  if (negative) {
    buffer[--start] = 0x2d; // -
  }

  if (bugzilla513039 && mode === DTOSTR_FIXED && noFraction && wroteDecimal) {
    let p = start + len - 1;
    while (buffer[p] !== DOT) {
      p--;
    }

    len = p - start;
  }

  return String.fromCharCode(...buffer.slice(start, start + len));
}

/** As MathUtils::convertDoubleToStringRadix: the integer part only, in `radix`. */
export function convertDoubleToStringRadix(input: number, radix: number): string {
  let value = input;
  const negative = value < 0;
  if (negative) {
    value = -value;
  }

  if (value < 1) {
    return "0";
  }

  let out = "";
  let uVal = Math.floor(value);
  while (uVal !== 0) {
    const j0 = uVal;
    uVal = Math.floor(uVal / radix);
    // In doubles, a "digit" of a large value can fall outside 0 to 35: as
    // avmplus, truncate it to an int, then to a char read as Latin-1.
    const j = j0 - uVal * radix;
    const d = toInt32Truncated(j);
    out = String.fromCharCode((j < 10 ? d + ZERO : d - 10 + 0x61) & 0xff) + out;
  }

  return negative ? `-${out}` : out;
}
