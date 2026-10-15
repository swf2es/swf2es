// AVM1's numbers as strings and strings as numbers, apart from AS3's: the
// algorithms of Ruffle's (https://github.com/ruffle-rs/ruffle)
// core/src/avm1/value.rs (f64_to_string, decimal_shift, parse_float_impl,
// guess_radix, string_to_f64), translated, with its bugs, which are Flash
// Player's: MIT OR Apache-2.0, Copyright (c) 2018-2022 Ruffle LLC and Ruffle
// contributors.

const bits = new DataView(new ArrayBuffer(8));

/** The base-2 exponent of a positive double, unbiased; that of 2^-1023 for a subnormal. */
function exponentOf(n: number): number {
  bits.setFloat64(0, n);
  return ((bits.getUint32(0) >>> 20) & 0x7ff) - 1023;
}

/** `value` times 10^`exp`, by squaring, multiplying or dividing as Flash does. */
function decimalShift(value: number, exp: number): number {
  let base = 10;
  let rest = Math.abs(exp);
  while (rest > 0) {
    if (rest & 1) {
      value = exp > 0 ? value * base : value / base;
    }

    rest = Math.floor(rest / 2);
    base *= base;
  }

  return value;
}

/** Rust's f64::round: halves away from zero. */
function roundAway(n: number): number {
  return n < 0 ? -Math.round(-n) : Math.round(n);
}

const ZERO = 0x30;
const NINE = 0x39;
const DOT = 0x2e;
const MAX_DECIMAL_PLACES = 15;
/** log10(2), as Flash has it: less precise than Math.LOG10E's. */
const LOG10_2 = 0.301029995663981;

/**
 * A number as AVM1 writes it: integers as they are, others to 15
 * significant digits, rounded half away from zero, with an exponent from
 * 1e15 up and below 1e-5. Flash's rounding carries badly from 9.99... to
 * 10 for negative numbers, so -9999999999999996 is "-e+16", as in Flash.
 */
export function numberToString(n: number): string {
  if (Number.isNaN(n)) {
    return "NaN";
  }

  if (n === Number.POSITIVE_INFINITY) {
    return "Infinity";
  }

  if (n === Number.NEGATIVE_INFINITY) {
    return "-Infinity";
  }

  if (n === 0) {
    return "0";
  }

  if (n >= -2147483648 && n <= 2147483647 && Number.isInteger(n)) {
    return String(n);
  }

  const buf: number[] = [];
  const negative = n < 0;
  if (negative) {
    n = -n;
    buf.push(0x2d);
  }

  let exp2 = exponentOf(n);
  if (exp2 === -1023) {
    // A subnormal: scaled by 2^54 into the normal range for its exponent.
    exp2 = exponentOf(n * 1.801439850948198e16) - 54;
  }

  let exp = roundAway(exp2 * LOG10_2);
  // In [0, 10), the exponent's estimate being off by one at most.
  let mantissa = decimalShift(n, -exp);
  if (Math.trunc(mantissa) === 0) {
    exp--;
    mantissa = decimalShift(n, -exp);
  }

  if (Math.trunc(mantissa) >= 10) {
    exp++;
    mantissa = decimalShift(n, -exp);
  }

  const digit = (): number => {
    const d = Math.trunc(mantissa);
    mantissa = (mantissa - d) * 10;
    return ZERO + d;
  };

  if (exp >= 15) {
    // 1.2345e+15, without a place for a carry out of the first digit.
    buf.push(digit(), DOT);
    for (let i = 0; i < MAX_DECIMAL_PLACES - 1; i++) {
      buf.push(digit());
    }
  } else if (exp >= 0) {
    // 12345.678901234, after a 0 for a carry.
    buf.push(ZERO);
    for (let i = 0; i <= exp; i++) {
      buf.push(digit());
    }

    buf.push(DOT);
    for (let i = 0; i < MAX_DECIMAL_PLACES - exp - 1; i++) {
      buf.push(digit());
    }

    exp = 0;
  } else if (exp >= -5) {
    // 0.0012345678901234
    buf.push(ZERO, ZERO, DOT);
    for (let i = 0; i < -exp - 1; i++) {
      buf.push(ZERO);
    }

    for (let i = 0; i < MAX_DECIMAL_PLACES; i++) {
      buf.push(digit());
    }

    exp = 0;
  } else {
    // 1.2345e-15, after a 0 for a carry.
    buf.push(ZERO, digit(), DOT);
    for (let i = 0; i < MAX_DECIMAL_PLACES - 1; i++) {
      buf.push(digit());
    }
  }

  // The next digit rounds, half away from zero, carrying through 9s; the
  // sign and the point are passed over, and a carry out of the first digit is lost.
  if (digit() >= ZERO + 5) {
    for (let i = buf.length - 1; i >= 0; i--) {
      if (buf[i] === NINE) {
        buf[i] = ZERO;
      } else if (buf[i] >= ZERO) {
        buf[i]++;
        break;
      }
    }
  }

  while (buf.length > 0 && buf[buf.length - 1] === ZERO) {
    buf.pop();
  }

  if (buf.length > 0 && buf[buf.length - 1] === DOT) {
    buf.pop();
  }

  let start = 0;
  if (exp !== 0) {
    // Flash's repairs of the carry, which miss a negative number's.
    let lead = 0;
    while (lead < buf.length && buf[lead] === ZERO) {
      lead++;
    }

    buf.splice(0, lead);
    if (buf.length === 0) {
      buf.push(ZERO + 1);
      exp++;
    } else {
      let last = buf.length - 1;
      while (last > 0 && buf[last] === ZERO) {
        last--;
      }

      if (last === 0) {
        exp += buf.length - 1;
        buf.length = 1;
      }
    }
  }

  // A leading 0 goes, but before the point.
  const i = negative ? 1 : 0;
  if (buf[i] === ZERO && buf[i + 1] !== DOT) {
    if (i > 0) {
      buf[i] = buf[i - 1];
    }

    start = 1;
  }

  const text = String.fromCharCode(...buf.slice(start));
  return exp === 0 ? text : `${text}e${exp > 0 ? "+" : "-"}${Math.abs(exp)}`;
}

/** Flash's whitespace before a number: space, tab, line feed and carriage return. */
function isSpace(c: number): boolean {
  return c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d;
}

function isDigit(c: number): boolean {
  return c >= ZERO && c <= NINE;
}

/**
 * A decimal number, after spaces: digits, a point, more digits and an
 * exponent, summed digit by digit as Flash sums them. NaN without a digit,
 * and, `strict`, with anything after the number.
 */
export function parseFloatAvm1(s: string, strict: boolean): number {
  let i = 0;
  while (i < s.length && isSpace(s.charCodeAt(i))) {
    i++;
  }

  let negative = false;
  if (s[i] === "-" || s[i] === "+") {
    negative = s[i] === "-";
    i++;
  }

  const afterSign = i;
  while (i < s.length && isDigit(s.charCodeAt(i))) {
    i++;
  }

  let exp = i - afterSign - 1;
  if (s[i] === ".") {
    i++;
    while (i < s.length && isDigit(s.charCodeAt(i))) {
      i++;
    }
  }

  if (i === afterSign) {
    return Number.NaN;
  }

  if (s[i] === "e" || s[i] === "E") {
    i++;
    let negativeExponent = false;
    if (s[i] === "-" || s[i] === "+") {
      negativeExponent = s[i] === "-";
      i++;
    }

    let exponent = 0;
    while (i < s.length && isDigit(s.charCodeAt(i))) {
      exponent = (Math.imul(exponent, 10) + (s.charCodeAt(i) - ZERO)) | 0;
      i++;
    }

    exp = (exp + (negativeExponent ? -exponent : exponent)) | 0;
  }

  if (strict && i < s.length) {
    return Number.NaN;
  }

  let result = 0;
  for (let k = afterSign; k < s.length; k++) {
    const c = s.charCodeAt(k);
    if (isDigit(c)) {
      result += decimalShift(c - ZERO, exp);
      exp = (exp - 1) | 0;
    } else if (c !== DOT) {
      break;
    }
  }

  return negative ? -result : result;
}

/** 16 after a "0x" or "0X", 8 for a 0 and octal digits only, else 10; a sign before is passed over. */
function guessRadix(s: string): number {
  const t = s[0] === "+" || s[0] === "-" ? s.slice(1) : s;
  if (t[0] !== "0") {
    return 10;
  }

  if (t[1] === "x" || t[1] === "X") {
    return 16;
  }

  for (let i = 1; i < t.length; i++) {
    const c = t.charCodeAt(i);
    if (c < ZERO || c > 0x37) {
      return 10;
    }
  }

  return 8;
}

/** An integer in `radix`, signed, wrapping to 32 bits; NaN at any other character or none. */
function parseWrapping(s: string, radix: number): number {
  let i = 0;
  const negative = s[0] === "-";
  if (negative || s[0] === "+") {
    i = 1;
  }

  if (i >= s.length) {
    return Number.NaN;
  }

  let n = 0;
  for (; i < s.length; i++) {
    const d = Number.parseInt(s[i], radix);
    if (Number.isNaN(d)) {
      return Number.NaN;
    }

    n = (Math.imul(n, radix) + (negative ? -d : d)) | 0;
  }

  return n;
}

/**
 * A string as a number, by the version of the SWF whose code converts it:
 * from SWF 6 hex ("0x1F") and octal ("017") are integers, a sign before
 * "0x" making NaN, as in Flash; up to SWF 4 what is not a number is 0, and
 * trailing characters are let be.
 */
export function stringToNumber(s: string, version: number): number {
  if (version >= 6) {
    const radix = guessRadix(s);
    if (radix !== 10) {
      return parseWrapping(radix === 16 ? s.slice(2) : s, radix);
    }
  }

  const strict = version >= 5;
  const result = parseFloatAvm1(s, strict);
  return !strict && Number.isNaN(result) ? 0 : result;
}
