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
    for (let i: u32 = 0; i < n; i++) {
      this.bytes[this.length++] = <u8>s.charCodeAt(i);
    }
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
   * string literal: quotes, backslashes, line breaks and other control
   * characters are escaped, and U+2028 and U+2029, which end a line in
   * older engines.
   */
  string(ptr: usize, length: u32): void {
    this.reserve(length + 2);
    this.byte(0x22);
    for (let i: u32 = 0; i < length; i++) {
      const b = load<u8>(ptr + i);
      if (b === 0x22 || b === 0x5c) {
        this.byte(0x5c);
        this.byte(b);
      } else if (b < 0x20 || b === 0x7f) {
        this.text("\\x");
        this.hex(b);
      } else if (
        b === 0xe2 &&
        i + 2 < length &&
        load<u8>(ptr + i + 1) === 0x80 &&
        (load<u8>(ptr + i + 2) & 0xfe) === 0xa8
      ) {
        this.text(load<u8>(ptr + i + 2) === 0xa8 ? "\\u2028" : "\\u2029");
        i += 2;
      } else {
        this.byte(b);
      }
    }

    this.byte(0x22);
  }

  hex(b: u8): void {
    const digits = "0123456789abcdef";
    this.byte(<u8>digits.charCodeAt(b >> 4));
    this.byte(<u8>digits.charCodeAt(b & 15));
  }
}
