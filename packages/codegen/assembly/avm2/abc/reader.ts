// Reads the primitive types of the ABC format (AVM2 overview, chapter 4.1).
//
// The input must be followed by PADDING readable bytes, as avmplus pads its
// buffer, so a variable-length read checks the bounds once before and once
// after instead of at every byte. Wasm loads are little-endian and may be
// unaligned, like ABC data.
//
// AssemblyScript has no exceptions and an abort kills the instance, which a
// JIT must survive, so errors are sticky: a read past the end sets `failed`,
// parks at the end and returns 0. Parsers check `failed` at section ends.

export const PADDING: i32 = 16;

@final
export class Reader {
  failed: bool = false;

  constructor(
    public pos: usize,
    public end: usize,
  ) {}

  @inline
  u8(): u32 {
    const p = this.pos;
    if (p >= this.end) {
      return this.fail();
    }

    this.pos = p + 1;
    return <u32>load<u8>(p);
  }

  @inline
  u16(): u32 {
    const p = this.pos;
    if (p + 2 > this.end) {
      return this.fail();
    }

    this.pos = p + 2;
    return <u32>load<u16>(p);
  }

  @inline
  s24(): i32 {
    const p = this.pos;
    if (p + 3 > this.end) {
      return this.fail();
    }

    this.pos = p + 3;
    return <i32>load<u16>(p) | ((<i32>load<i8>(p, 2)) << 16);
  }

  /** 1 to 5 bytes, 7 bits each, low bits first; as avmplus, bits past 32 drop off. */
  u32(): u32 {
    const p = this.pos;
    if (p >= this.end) {
      return this.fail();
    }

    let result = <u32>load<u8>(p);
    let length: usize = 1;
    if (result & 0x80) {
      result = (result & 0x7f) | ((<u32>load<u8>(p, 1)) << 7);
      length = 2;
      if (result & 0x4000) {
        result = (result & 0x3fff) | ((<u32>load<u8>(p, 2)) << 14);
        length = 3;
        if (result & 0x200000) {
          result = (result & 0x1fffff) | ((<u32>load<u8>(p, 3)) << 21);
          length = 4;
          if (result & 0x10000000) {
            result = (result & 0xfffffff) | ((<u32>load<u8>(p, 4)) << 28);
            length = 5;
          }
        }
      }
    }

    if (p + length > this.end) {
      return this.fail();
    }

    this.pos = p + length;
    return result;
  }

  /** A u32 whose top two bits must be clear; avmplus rejects the ABC otherwise. */
  @inline
  u30(): u32 {
    const value = this.u32();
    if (value & 0xc0000000) {
      return this.fail();
    }

    return value;
  }

  /** The u32 bit pattern, not sign-extended: negative values take 5 bytes. */
  @inline
  s32(): i32 {
    return <i32>this.u32();
  }

  @inline
  d64(): f64 {
    const p = this.pos;
    if (p + 8 > this.end) {
      this.fail();
      return 0;
    }

    this.pos = p + 8;
    return load<f64>(p);
  }

  /** Byte length of a string_info; its UTF-8 bytes follow at `pos`. */
  @inline
  utf8Length(): u32 {
    const length = this.u30();
    if (<u64>this.pos + length > this.end) {
      return this.fail();
    }

    return length;
  }

  @inline
  skip(length: u32): void {
    if (<u64>this.pos + length > this.end) {
      this.fail();
    } else {
      this.pos += length;
    }
  }

  @inline
  private fail(): u32 {
    this.failed = true;
    this.pos = this.end;
    return 0;
  }
}
