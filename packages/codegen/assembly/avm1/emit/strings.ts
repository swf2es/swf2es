// An AVM1 string as a JavaScript string literal of what adl reads from its
// bytes. Up to SWF 5 a string is its bytes, each the character of its value:
// length and charCodeAt count bytes, 0x80 is U+0080. From SWF 6 it is UTF-8,
// read leniently: a lead byte takes as many bytes after it as its high bits
// say, continuation bytes or not, and the code point is their sum less the
// lead's offset, as Unicode's old ConvertUTF.c computes it. A byte that leads
// nothing (0x80 to 0xbf) is the character of its value; a surrogate's code
// point, or one past U+10FFFF, is a U+FFFD; and a code point of 0, or a
// sequence the string's end cuts short, ends the string there.
// tests/unit/codegen/avm1-emit.test.ts holds the cases adl was asked.
import { Output, wellFormed } from "../../output";

/** What ConvertUTF.c subtracts from the sum of a sequence of 1 to 6 bytes. */
const OFFSETS: StaticArray<u32> = [0, 0x3080, 0xe2080, 0x3c82080, 0xfa082080, 0x82082080];

/** The string of `length` bytes at `ptr`, read as UTF-8 if `utf8`, else a character a byte. */
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
      out.unit(b);
      i++;
      continue;
    }

    // Well-formed UTF-8 reads as adl reads it, and is copied.
    const n = wellFormed(ptr + i, length - i);
    if (n !== 0) {
      if (b === 0xe2 && load<u8>(ptr + i + 1) === 0x80 && (load<u8>(ptr + i + 2) & 0xfe) === 0xa8) {
        // U+2028 and U+2029 end a line in older engines.
        out.text(load<u8>(ptr + i + 2) === 0xa8 ? "\\u2028" : "\\u2029");
      } else {
        for (let k: u32 = 0; k < n; k++) {
          out.byte(load<u8>(ptr + i + k));
        }
      }

      i += n;
      continue;
    }

    const more: u32 = b < 0xc0 ? 0 : b < 0xe0 ? 1 : b < 0xf0 ? 2 : b < 0xf8 ? 3 : b < 0xfc ? 4 : 5;
    if (more >= length - i) {
      break;
    }

    let c: u32 = 0;
    for (let k: u32 = 0; k <= more; k++) {
      c = (c << 6) + <u32>load<u8>(ptr + i + k);
    }

    c -= OFFSETS[more];
    i += more + 1;
    if (c === 0) {
      break;
    }

    // Escaped, since what it reads as may be a quote or a line's end.
    if (c > 0x10ffff || (c >= 0xd800 && c <= 0xdfff)) {
      out.unit(0xfffd);
    } else if (c > 0xffff) {
      out.unit(0xd800 + ((c - 0x10000) >> 10));
      out.unit(0xdc00 + ((c - 0x10000) & 0x3ff));
    } else {
      out.unit(c);
    }
  }

  out.byte(0x22);
}
