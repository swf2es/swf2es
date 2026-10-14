// An AVM1 string as a JavaScript string literal of what Flash reads from its
// bytes, as Ruffle (https://github.com/ruffle-rs/ruffle) reads them:
// SwfStr::to_str_lossy with SwfStr::encoding_for_version, UTF-8 from SWF 6
// and Windows-1252 before, decoded as the WHATWG Encoding Standard does,
// each maximal ill-formed run of UTF-8 a U+FFFD. Ruffle is MIT OR
// Apache-2.0, Copyright (c) 2018-2022 Ruffle LLC and Ruffle contributors.
import { Output, wellFormed } from "../../output";

/** Windows-1252's characters for the bytes 0x80 to 0x9f; the rest are Latin-1's. */
const WINDOWS_1252: StaticArray<u16> = [
  0x20ac, 0x81, 0x201a, 0x192, 0x201e, 0x2026, 0x2020, 0x2021, 0x2c6, 0x2030, 0x160, 0x2039, 0x152,
  0x8d, 0x17d, 0x8f, 0x90, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x2dc, 0x2122,
  0x161, 0x203a, 0x153, 0x9d, 0x17e, 0x178,
];

/** The string of `length` bytes at `ptr`, read as UTF-8 if `utf8`, else as Windows-1252. */
export function avm1String(out: Output, ptr: usize, length: u32, utf8: bool): void {
  out.reserve(length + 2);
  out.byte(0x22);
  let i: u32 = 0;
  while (i < length) {
    const b = load<u8>(ptr + i);
    if (b < 0x80) {
      if (b === 0x22 || b === 0x5c) {
        out.byte(0x5c);
        out.byte(b);
      } else if (b < 0x20 || b === 0x7f) {
        out.text("\\x");
        out.hex(b);
      } else {
        out.byte(b);
      }

      i++;
      continue;
    }

    if (!utf8) {
      out.unit(b < 0xa0 ? <u32>WINDOWS_1252[b - 0x80] : <u32>b);
      i++;
      continue;
    }

    const n = wellFormed(ptr + i, length - i);
    if (n === 0) {
      out.unit(0xfffd);
      i += illFormed(ptr + i, length - i);
    } else if (
      b === 0xe2 &&
      load<u8>(ptr + i + 1) === 0x80 &&
      (load<u8>(ptr + i + 2) & 0xfe) === 0xa8
    ) {
      // U+2028 and U+2029 end a line in older engines.
      out.text(load<u8>(ptr + i + 2) === 0xa8 ? "\\u2028" : "\\u2029");
      i += 3;
    } else {
      for (let k: u32 = 0; k < n; k++) {
        out.byte(load<u8>(ptr + i + k));
      }

      i += n;
    }
  }

  out.byte(0x22);
}

/**
 * How many bytes from `ptr`, which start no well-formed sequence, one
 * U+FFFD replaces: the lead and the continuation bytes that could still have
 * followed it, at least one.
 */
function illFormed(ptr: usize, left: u32): u32 {
  const c = load<u8>(ptr);
  let n: u32 = 0;
  let lo: u8 = 0x80;
  let hi: u8 = 0xbf;
  if (c >= 0xc2 && c <= 0xdf) {
    n = 2;
  } else if (c >= 0xe0 && c <= 0xef) {
    n = 3;
    lo = c === 0xe0 ? 0xa0 : 0x80;
    hi = c === 0xed ? 0x9f : 0xbf;
  } else if (c >= 0xf0 && c <= 0xf4) {
    n = 4;
    lo = c === 0xf0 ? 0x90 : 0x80;
    hi = c === 0xf4 ? 0x8f : 0xbf;
  } else {
    return 1;
  }

  let k: u32 = 1;
  if (k < left) {
    const second = load<u8>(ptr + k);
    if (second < lo || second > hi) {
      return 1;
    }

    k++;
  }

  while (k < n && k < left && (load<u8>(ptr + k) & 0xc0) === 0x80) {
    k++;
  }

  return k;
}
