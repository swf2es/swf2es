// Numbers to and from strings as AS3 converts them: JavaScript's own
// conversions where they give avmplus' results, which is nearly always and
// many times faster, and avmplus' rules where they do not.

import { convertDoubleToString } from "./numbers.js";

/**
 * As avmplus' String to Number: JavaScript's, without its binary and octal
 * prefixes. JavaScript skips the whitespace trim() does, so a number it
 * reads is avmplus' unless it came from such a prefix; only that, or one it
 * cannot read, needs avmplus' own rules.
 */
export function stringToNumber(s: string): number {
  const n = Number(s);
  if (!Number.isNaN(n)) {
    return binaryOrOctal(s) ? Number.NaN : n;
  }

  return unreadNumber(s);
}

/** Whether `s`, which JavaScript read as a number, starts with a binary or octal prefix. */
function binaryOrOctal(s: string): boolean {
  let i = 0;
  while (i < s.length) {
    const c = s.charCodeAt(i);
    if (c !== 0x20 && (c < 0x09 || c > 0x0d)) {
      break;
    }

    i++;
  }

  // Whitespace past ASCII is rare: trimStart knows all of it.
  if (s.charCodeAt(i) > 0x7f) {
    return /^0[bBoO]/.test(s.trimStart());
  }

  const next = s.charCodeAt(i + 1) | 0x20;
  return s.charCodeAt(i) === 0x30 && (next === 0x62 || next === 0x6f);
}

/**
 * A string JavaScript reads as NaN, as avmplus reads it: a sign before a hex
 * number, a NUL that ends the number, an exponent with no digits; anything
 * else, a binary or octal prefix among it, is NaN.
 */
function unreadNumber(s: string): number {
  const t = s.trim();
  if (/^[-+]0[xX]/.test(t)) {
    const n = Number(t.slice(1));
    return t[0] === "-" ? -n : n;
  }

  // As avmplus, a NUL ends the number, and one before any is none.
  const nul = s.indexOf("\0");
  if (nul > 0 && s.slice(0, nul).trim() !== "") {
    return stringToNumber(s.slice(0, nul));
  }

  // "4e" or "4e+": the exponent is left off.
  const bare = /^([-+]?(?:\d+\.?\d*|\.\d+))[eE]\+?$/.exec(t);
  return bare ? Number(bare[1]) : Number.NaN;
}

/**
 * A number as AS3 writes it: avmplus' own formatting, not JavaScript's,
 * though the two agree, and JavaScript's is some ten times faster, for an
 * int, and for a number from 1e-6 up to 1e15 that JavaScript writes with 15
 * significant digits or fewer. Both write the shortest digits that read
 * back as the number, and no two decimals of 15 digits read back as one
 * double; past 15 they can part on the last digit, which avmplus rounds up
 * (209.14077758789063 where JavaScript has ...062), and from 1e15 up every
 * number takes 16 or more (tests/unit/runtime/numbers.test.ts).
 */
export function numberToString(n: number): string {
  if ((n | 0) === n) {
    return String(n);
  }

  const magnitude = n < 0 ? -n : n;
  if (magnitude >= 1e-6 && magnitude < 1e15) {
    const text = String(n);
    if (significantDigits(text) <= 15) {
      return text;
    }
  }

  return convertDoubleToString(n);
}

/** The significant digits in a number JavaScript wrote in plain decimals: all but its leading zeros. */
function significantDigits(text: string): number {
  let digits = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c > 0x30 && c <= 0x39) {
      digits++;
    } else if (c === 0x30 && digits > 0) {
      digits++;
    }
  }

  return digits;
}

/**
 * The number AS3 reads back from the string it writes for `n`, as
 * stringToNumber(numberToString(n)), without writing it. Below 1e21 D2A
 * writes every digit Burger and Dybvig's shortest form needs, so the string
 * reads back as the number itself, but -0 writes "0"; from 1e21 up it writes
 * an exponent with 15 digits at most, which can read back as another number
 * (1.79769313486231e+308 for Number.MAX_VALUE, past which it is Infinity).
 */
export function numberReadBack(n: number): number {
  const magnitude = n < 0 ? -n : n;
  if (magnitude < 1e21) {
    return n === 0 ? 0 : n;
  }

  // NaN and the infinities write as names that read back as themselves.
  if (Number.isNaN(n) || magnitude === Number.POSITIVE_INFINITY) {
    return n;
  }

  return stringToNumber(convertDoubleToString(n));
}
