// UTF-8 as avmplus reads and writes it: an invalid byte reads as the
// character of its value, a lone surrogate writes as U+FFFD. ByteArray,
// AMF and the shell's natives share it.
//
// Translated from avmplus' core/UnicodeUtils.cpp, this file is subject to
// the Mozilla Public License, v. 2.0: http://mozilla.org/MPL/2.0/.

// TextEncoder is the web's and node's alike, though not ECMAScript's,
// whose library alone the runtime is typed against.
declare const TextEncoder: new () => { encode(s: string): Uint8Array };

/** The host's UTF-8 encoder, which writes a lone surrogate as U+FFFD, as utf8() does. */
const encoder = new TextEncoder();

/**
 * Below this length, a string encodes faster here than through
 * TextEncoder, whose call costs more than the loop saves (about 90
 * characters in V8).
 */
const ENCODER_LENGTH = 96;

/**
 * As UnicodeUtils::Utf16ToUtf8: a surrogate pair as four bytes, a lone
 * surrogate as U+FFFD. avmshell's writeUTFBytes loses characters around a
 * lone one instead; this keeps them, and the UTF-8 valid.
 */
export function utf8(s: string): Uint8Array {
  if (s.length >= ENCODER_LENGTH) {
    return encoder.encode(s);
  }

  // ASCII, byte for byte.
  let ascii = true;
  for (let i = 0; i < s.length && ascii; i++) {
    ascii = s.charCodeAt(i) < 0x80;
  }

  if (ascii) {
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) {
      out[i] = s.charCodeAt(i);
    }

    return out;
  }

  const out = new Uint8Array(s.length * 3);
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    let ch = s.charCodeAt(i);
    if (ch < 0x80) {
      out[n++] = ch;
      continue;
    }

    if (ch < 0x800) {
      out[n++] = 0xc0 | ((ch >> 6) & 0x1f);
      out[n++] = 0x80 | (ch & 0x3f);
      continue;
    }

    if (ch >= 0xd800 && ch <= 0xdbff) {
      const ch2 = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
      if (ch2 >= 0xdc00 && ch2 <= 0xdfff) {
        i++;
        const ucs4 = ((ch - 0xd800) << 10) + (ch2 - 0xdc00) + 0x10000;
        out[n++] = 0xf0 | ((ucs4 >> 18) & 0x07);
        out[n++] = 0x80 | ((ucs4 >> 12) & 0x3f);
        out[n++] = 0x80 | ((ucs4 >> 6) & 0x3f);
        out[n++] = 0x80 | (ucs4 & 0x3f);
        continue;
      }

      ch = 0xfffd;
    } else if (ch >= 0xdc00 && ch <= 0xdfff) {
      ch = 0xfffd;
    }

    out[n++] = 0xe0 | ((ch >> 12) & 0x0f);
    out[n++] = 0x80 | ((ch >> 6) & 0x3f);
    out[n++] = 0x80 | (ch & 0x3f);
  }

  return out.subarray(0, n);
}

/**
 * As UnicodeUtils::Utf8ToUtf16, not strict: a byte that does not start a
 * valid sequence is the character of its value, and a four-byte sequence
 * may start with 0xF8 to 0xFF, as Flash Player 9 and 10 read them.
 */
/** The length from which fromUtf8 first looks for ASCII. */
const ASCII_LENGTH = 16;

export function fromUtf8(bytes: Uint8Array): string {
  const n = bytes.length;
  // ASCII, as most text is: its bytes are its characters. Below
  // ASCII_LENGTH bytes, a character at a time, until one is not.
  if (n < ASCII_LENGTH) {
    let s = "";
    let k = 0;
    for (; k < n && bytes[k] < 0x80; k++) {
      s += String.fromCharCode(bytes[k]);
    }

    if (k === n) {
      return s;
    }
  } else {
    let ascii = 0;
    while (ascii < n && bytes[ascii] < 0x80) {
      ascii++;
    }

    if (ascii === n) {
      let s = "";
      for (let k = 0; k < n; k += 8192) {
        s += String.fromCharCode.apply(null, bytes.subarray(k, k + 8192) as unknown as number[]);
      }

      return s;
    }
  }

  const out: number[] = [];
  let i = 0;
  while (i < n) {
    const c = bytes[i];
    const left = n - i;
    switch (c >> 4) {
      case 12:
      case 13: {
        if (left >= 2 && (bytes[i + 1] & 0xc0) === 0x80) {
          const ch = ((c << 6) & 0x7c0) | (bytes[i + 1] & 0x3f);
          if (ch >= 0x80) {
            out.push(ch);
            i += 2;
            continue;
          }
        }
        break;
      }
      case 14: {
        if (left >= 3 && (bytes[i + 1] & 0xc0) === 0x80 && (bytes[i + 2] & 0xc0) === 0x80) {
          const ch = ((c << 12) & 0xf000) | ((bytes[i + 1] << 6) & 0xfc0) | (bytes[i + 2] & 0x3f);
          if (ch >= 0x800) {
            out.push(ch);
            i += 3;
            continue;
          }
        }
        break;
      }
      case 15: {
        if (
          left >= 4 &&
          (bytes[i + 1] & 0xc0) === 0x80 &&
          (bytes[i + 2] & 0xc0) === 0x80 &&
          (bytes[i + 3] & 0xc0) === 0x80
        ) {
          const ch =
            ((c << 18) & 0x1c0000) |
            ((bytes[i + 1] << 12) & 0x3f000) |
            ((bytes[i + 2] << 6) & 0xfc0) |
            (bytes[i + 3] & 0x3f);
          if (ch >= 0x10000) {
            out.push((((ch - 0x10000) >> 10) & 0x3ff) + 0xd800, ((ch - 0x10000) & 0x3ff) + 0xdc00);
            i += 4;
            continue;
          }
        }
        break;
      }
      default:
        break;
    }

    // Not a sequence: the byte itself.
    out.push(c);
    i++;
  }

  return fromCodes(out);
}

/** A string of UTF-16 code units, in chunks, as String.fromCharCode takes only so many arguments. */
export function fromCodes(units: number[]): string {
  let s = "";
  for (let k = 0; k < units.length; k += 8192) {
    s += String.fromCharCode(...units.slice(k, k + 8192));
  }

  return s;
}
