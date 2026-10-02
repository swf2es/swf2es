// The JavaScript being written, as UTF-8 bytes in one growable buffer that
// is reused from method to method.
@final
export class Output {
  bytes: StaticArray<u8> = new StaticArray<u8>(1 << 16);
  length: u32 = 0;

  reset(): void {
    this.length = 0;
  }

  reserve(more: u32): void {
    if (this.length + more <= <u32>this.bytes.length) {
      return;
    }

    const grown = new StaticArray<u8>(max(this.length + more, <u32>this.bytes.length * 2));
    memory.copy(changetype<usize>(grown), changetype<usize>(this.bytes), this.length);
    this.bytes = grown;
  }

  /** Text of the emitter's own, all ASCII, put in at offset `at`, what follows moved after it. */
  insert(at: u32, s: string): void {
    const n = <u32>s.length;
    this.reserve(n);
    const base = changetype<usize>(this.bytes);
    memory.copy(base + at + n, base + at, this.length - at);
    for (let i: u32 = 0; i < n; i++) {
      this.bytes[at + i] = <u8>s.charCodeAt(i);
    }

    this.length += n;
  }

  byte(b: u8): void {
    this.reserve(1);
    this.bytes[this.length++] = b;
  }

  /** Text of the emitter's own, all ASCII. */
  text(s: string): void {
    const n = <u32>s.length;
    this.reserve(n);
    const from = changetype<usize>(s);
    const to = changetype<usize>(this.bytes) + this.length;
    let i: u32 = 0;
    // Four characters at a time, each one's low byte: its ASCII.
    for (; i + 4 <= n; i += 4) {
      const w = load<u64>(from + ((<usize>i) << 1));
      store<u32>(
        to + i,
        <u32>((w & 0xff) | ((w >> 8) & 0xff00) | ((w >> 16) & 0xff0000) | ((w >> 24) & 0xff000000)),
      );
    }

    for (; i < n; i++) {
      store<u8>(to + i, load<u16>(from + ((<usize>i) << 1)));
    }

    this.length += n;
  }

  int(n: i64): void {
    if (n < 0) {
      this.byte(0x2d);
      n = -n;
    }

    this.uint(<u64>n);
  }

  uint(n: u64): void {
    if (n >= 10) {
      this.uint(n / 10);
    }

    this.byte(<u8>(0x30 + (n % 10)));
  }

  /** A JavaScript number literal for a double: exact, and valid for NaN, infinities and -0. */
  double(d: f64): void {
    if (Number.isNaN(d)) {
      this.text("NaN");
    } else if (!Number.isFinite(d)) {
      this.text(d > 0 ? "Infinity" : "-Infinity");
    } else if (d === 0 && 1 / d < 0) {
      this.text("-0");
    } else if (d === Math.floor(d) && Math.abs(d) < 9007199254740992) {
      this.int(<i64>d);
    } else {
      // Every double round-trips through 17 significant digits.
      this.text(d.toString());
    }
  }

  /**
   * UTF-8 bytes from `ptr`, such as a string in the ABC, as a JavaScript
   * string literal of the string avmplus reads from them: quotes,
   * backslashes, line breaks and other control characters are escaped, and
   * U+2028 and U+2029, which end a line in older engines. avmplus reads a
   * pool string leniently (PoolObject::getString): a byte that starts no
   * sequence is the character of its value, and a surrogate's three bytes
   * are that code unit. What JavaScript would read otherwise, or not at
   * all, is escaped as what avmplus reads; well-formed UTF-8 is copied.
   */
  string(ptr: usize, length: u32): void {
    this.reserve(length + 2);
    this.byte(0x22);
    let i: u32 = 0;
    while (i < length) {
      const b = load<u8>(ptr + i);
      if (b < 0x80) {
        if (b === 0x22 || b === 0x5c) {
          this.byte(0x5c);
          this.byte(b);
        } else if (b < 0x20 || b === 0x7f) {
          this.text("\\x");
          this.hex(b);
        } else {
          this.byte(b);
        }

        i++;
        continue;
      }

      const n = wellFormed(ptr + i, length - i);
      if (n === 0) {
        i += this.lenient(ptr + i, length - i);
      } else if (
        b === 0xe2 &&
        load<u8>(ptr + i + 1) === 0x80 &&
        (load<u8>(ptr + i + 2) & 0xfe) === 0xa8
      ) {
        this.text(load<u8>(ptr + i + 2) === 0xa8 ? "\\u2028" : "\\u2029");
        i += 3;
      } else {
        for (let k: u32 = 0; k < n; k++) {
          this.byte(load<u8>(ptr + i + k));
        }

        i += n;
      }
    }

    this.byte(0x22);
  }

  /**
   * What avmplus reads at `ptr`, where the bytes are not well-formed UTF-8,
   * as \u escapes: a sequence by its shape alone, a surrogate's or one past
   * U+10FFFF among them, else the byte itself. How many bytes it took.
   */
  lenient(ptr: usize, left: u32): u32 {
    const c = <u32>load<u8>(ptr);
    switch (c >> 4) {
      case 12:
      case 13:
        if (left >= 2 && follows(ptr, 1)) {
          const ch = ((c & 0x1f) << 6) | bits(ptr, 1);
          if (ch >= 0x80) {
            this.unit(ch);
            return 2;
          }
        }
        break;
      case 14:
        if (left >= 3 && follows(ptr, 1) && follows(ptr, 2)) {
          const ch = ((c & 0x0f) << 12) | (bits(ptr, 1) << 6) | bits(ptr, 2);
          if (ch >= 0x800) {
            this.unit(ch);
            return 3;
          }
        }
        break;
      case 15:
        if (left >= 4 && follows(ptr, 1) && follows(ptr, 2) && follows(ptr, 3)) {
          const ch = ((c & 0x07) << 18) | (bits(ptr, 1) << 12) | (bits(ptr, 2) << 6) | bits(ptr, 3);
          if (ch >= 0x10000) {
            this.unit((((ch - 0x10000) >> 10) & 0x3ff) + 0xd800);
            this.unit(((ch - 0x10000) & 0x3ff) + 0xdc00);
            return 4;
          }
        }
        break;
      default:
        break;
    }

    this.unit(c);
    return 1;
  }

  /** A UTF-16 code unit as a \u escape. */
  unit(u: u32): void {
    this.text("\\u");
    this.hex(<u8>(u >> 8));
    this.hex(<u8>(u & 0xff));
  }

  hex(b: u8): void {
    const digits = "0123456789abcdef";
    this.byte(<u8>digits.charCodeAt(b >> 4));
    this.byte(<u8>digits.charCodeAt(b & 15));
  }
}

/**
 * How many bytes the well-formed UTF-8 sequence at `ptr` takes, which
 * JavaScript reads as avmplus does: shortest form, no surrogate, at most
 * U+10FFFF; 0 if there is none.
 */
function wellFormed(ptr: usize, left: u32): u32 {
  const c = load<u8>(ptr);
  if (c >= 0xc2 && c <= 0xdf) {
    return left >= 2 && follows(ptr, 1) ? 2 : 0;
  }

  if (c >= 0xe0 && c <= 0xef) {
    const lo: u8 = c === 0xe0 ? 0xa0 : 0x80;
    const hi: u8 = c === 0xed ? 0x9f : 0xbf;
    return left >= 3 && within(ptr, 1, lo, hi) && follows(ptr, 2) ? 3 : 0;
  }

  if (c >= 0xf0 && c <= 0xf4) {
    const lo: u8 = c === 0xf0 ? 0x90 : 0x80;
    const hi: u8 = c === 0xf4 ? 0x8f : 0xbf;
    return left >= 4 && within(ptr, 1, lo, hi) && follows(ptr, 2) && follows(ptr, 3) ? 4 : 0;
  }

  return 0;
}

/** Whether byte k from `ptr` continues a sequence: 10xxxxxx. */
function follows(ptr: usize, k: u32): bool {
  return (load<u8>(ptr + k) & 0xc0) === 0x80;
}

/** Whether byte k from `ptr` is from `lo` to `hi`. */
function within(ptr: usize, k: u32, lo: u8, hi: u8): bool {
  const b = load<u8>(ptr + k);
  return b >= lo && b <= hi;
}

/** The six bits a continuation byte k from `ptr` carries. */
function bits(ptr: usize, k: u32): u32 {
  return <u32>load<u8>(ptr + k) & 0x3f;
}
