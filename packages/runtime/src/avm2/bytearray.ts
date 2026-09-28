// flash.utils.ByteArray and domain memory, as avmplus' ByteArray and
// DataInput/DataOutput implement them. The buffer keeps avmplus' capacity:
// it grows as avmplus' Grower grows it, zeroing what a reallocation adds,
// so bytes a shorter length left behind come back when the length grows
// within the capacity, as they do in avmplus. UTF-8 is avmplus' own: an
// invalid byte reads as the character of its value.
//
// Translated from avmplus' core/ByteArrayGlue.cpp, core/DataIO.cpp and
// core/UnicodeUtils.cpp, this file is subject to the Mozilla Public
// License, v. 2.0: http://mozilla.org/MPL/2.0/.
import type { AsObject, IndexHook, Runtime, Traits, Value } from "./runtime.js";

const kGrowthIncr = 4096;
const kHugeGrowthThreshold = 24 * 1024 * 1024;
const kHugeGrowthIncr = 24 * 1024 * 1024;
/** DomainEnv::GLOBAL_MEMORY_MIN_SIZE: domain memory's least length. */
export const GLOBAL_MEMORY_MIN_SIZE = 1024;
const kAMF0 = 0;
const kAMF3 = 3;

/**
 * A ByteArray's state: its buffer, as long as its capacity, and its length
 * and position. A read or write takes its offset first: growing replaces
 * the buffer and its view.
 */
export class Bytes {
  buffer = new Uint8Array(0);
  view = new DataView(this.buffer.buffer);
  length = 0;
  position = 0;
  littleEndian = false;
  /** As ByteArray's constructor: ByteArray.defaultObjectEncoding when it is made. */
  objectEncoding: number;
  /** Whether it is the domain memory, which it then tells when its buffer or length changes. */
  subscribed = false;

  constructor(
    readonly rt: Runtime,
    readonly owner: AsObject,
  ) {
    this.objectEncoding = rt.defaultObjectEncoding;
  }

  get available(): number {
    return this.length > this.position ? this.length - this.position : 0;
  }

  /** As Grower::ReallocBackingStore: a new buffer, the old length's bytes copied and the rest zero. */
  private realloc(capacityIn: number, minimum: number, fromSetter: boolean): void {
    let capacity = capacityIn;
    if (capacity < minimum) {
      capacity = minimum;
    }

    if (!(this.buffer.length === 0 && fromSetter) && capacity < kGrowthIncr) {
      capacity = kGrowthIncr;
    }

    if (capacity === this.buffer.length) {
      return;
    }

    const next = new Uint8Array(capacity);
    next.set(this.buffer.subarray(0, Math.min(capacity, this.length)));
    this.buffer = next;
    this.view = new DataView(next.buffer);
  }

  /** As Grower::EnsureWritableCapacity: double, at least `minimum`, and 4096 unless the setter sizes an empty one. */
  private ensure(minimum: number, fromSetter: boolean): void {
    if (minimum > 0xffffffff - 2 * 4096) {
      throw this.rt.error("flash.errors::MemoryError", 1000);
    }

    if (minimum > this.buffer.length) {
      this.realloc(this.buffer.length * 2, minimum, fromSetter);
    }
  }

  /** As ByteArray::SetLengthCommon. */
  setLength(length: number, fromSetter = false): void {
    if (this.subscribed && length < GLOBAL_MEMORY_MIN_SIZE) {
      throw this.rt.error("RangeError", 1506);
    }

    if (!fromSetter || (length < kHugeGrowthThreshold && this.length < kHugeGrowthThreshold)) {
      if (length > this.buffer.length) {
        this.ensure(length, fromSetter);
      }
    } else {
      const rounded = Math.ceil(length / kHugeGrowthIncr) * kHugeGrowthIncr;
      const capacity = rounded <= 0xffffffff - 2 * 4096 ? rounded : length;
      if (capacity !== this.buffer.length) {
        this.realloc(capacity, length, true);
      }
    }

    this.length = length;
    if (this.position > length) {
      this.position = length;
    }

    this.notify();
  }

  /** Tell the domain memory, if this is it, where the bytes are now. */
  notify(): void {
    if (this.subscribed) {
      this.rt.memory = new DataView(this.buffer.buffer, 0, this.length);
    }
  }

  /** As ByteArray::Clear: no buffer at all. */
  clear(): void {
    if (this.subscribed) {
      throw this.rt.error("RangeError", 1506);
    }

    this.buffer = new Uint8Array(0);
    this.view = new DataView(this.buffer.buffer);
    this.length = 0;
    this.position = 0;
  }

  /** As requestBytesForShortRead: the offset of `n` bytes to read, or EOFError. */
  shortRead(n: number): number {
    const at = this.position;
    if (at >= this.length || at + n > this.length) {
      throw this.rt.error("flash.errors::EOFError", 2030);
    }

    this.position = at + n;
    return at;
  }

  /** As requestBytesForShortWrite: the offset of `n` bytes to write, the length grown to hold them. */
  shortWrite(n: number): number {
    const at = this.position;
    if (at >= this.length || at + n > this.length) {
      if (at + n > 0xffffffff) {
        throw this.rt.error("flash.errors::MemoryError", 1000);
      }

      this.setLength(at + n);
    }

    this.position = at + n;
    return at;
  }

  /** As DataInput::CheckEOF. */
  checkEOF(count: number): void {
    if (this.available < count) {
      throw this.rt.error("flash.errors::EOFError", 2030);
    }
  }

  /** As ByteArray::Read: `count` bytes from the position. */
  read(count: number): Uint8Array {
    this.checkEOF(count);
    const bytes = this.buffer.slice(this.position, this.position + count);
    this.position += count;
    return bytes;
  }

  /** As ByteArray::Write: `bytes` at the position; the length grows to the position after. */
  write(bytes: Uint8Array): void {
    const count = bytes.length;
    if (count > 0xffffffff - this.position) {
      throw this.rt.error("flash.errors::MemoryError", 1000);
    }

    const end = this.position + count;
    if (end > this.buffer.length) {
      this.ensure(end, false);
    }

    this.buffer.set(bytes, this.position);
    this.position = end;
    if (this.length < this.position) {
      this.length = this.position;
    }

    this.notify();
  }

  /** As ByteArray's operator[] for a write: the length grows to hold `index`. */
  setByte(index: number, value: number): void {
    if (index >= this.length) {
      if (index === 0xffffffff) {
        throw this.rt.error("flash.errors::MemoryError", 1000);
      }

      this.setLength(index + 1);
    }

    this.buffer[index] = value;
  }
}

/** How a ByteArray's elements are indexed: its bytes; past its length undefined, and a write grows it. */
export const byteArrayHook: IndexHook & { create: (traits: Traits, rt: Runtime) => AsObject } = {
  // Its state from the start: it takes defaultObjectEncoding as it is then.
  create: (traits, rt) => {
    const o = Object.create(traits.proto);
    o.$bytes = new Bytes(rt, o);
    return o;
  },
  getIndex: (o, i) => {
    const b: Bytes | undefined = o.$bytes;
    return b && i < b.length ? b.buffer[i] : undefined;
  },
  setIndex: (o, i, v, rt) => {
    bytesOf(rt, o).setByte(i, rt.toInt(v) & 0xff);
  },
  hasIndex: (o, i) => {
    const b: Bytes | undefined = o.$bytes;
    return b !== undefined && i < b.length;
  },
};

/** A ByteArray's state, made the first time a native needs it. */
export function bytesOf(rt: Runtime, o: AsObject): Bytes {
  if (!o.$bytes) {
    o.$bytes = new Bytes(rt, o);
  }

  return o.$bytes;
}

/** As UnicodeUtils::Utf16ToUtf8: a surrogate pair as four bytes, a lone surrogate as U+FFFD. */
export function utf8(s: string): Uint8Array {
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
export function fromUtf8(bytes: Uint8Array): string {
  const out: number[] = [];
  const n = bytes.length;
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
function fromCodes(units: number[]): string {
  let s = "";
  for (let k = 0; k < units.length; k += 8192) {
    s += String.fromCharCode(...units.slice(k, k + 8192));
  }

  return s;
}

/** The bytes up to the first NUL, as avmplus reads a C string. */
function toNul(bytes: Uint8Array): Uint8Array {
  const nul = bytes.indexOf(0);
  return nul < 0 ? bytes : bytes.subarray(0, nul);
}

const BOM = (b: Uint8Array) => b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf;

type Natives = Record<string, (rt: Runtime) => (...args: Value[]) => Value>;

/** ByteArray's natives, by the names the compiler gives them. */
export function byteArrayNatives(): Natives {
  const c = "flash.utils::ByteArray";
  const own = "flash.utils:ByteArray";
  const natives: Natives = {};
  const method = (name: string, f: (rt: Runtime, b: Bytes, ...args: Value[]) => Value) => {
    natives[`${c}#${name}`] = (rt) =>
      function (this: AsObject, ...args: Value[]) {
        return f(rt, bytesOf(rt, this), ...args);
      };
  };

  const nonNull = (rt: Runtime, v: Value, name: string) => {
    if (v === null || v === undefined) {
      throw rt.error("TypeError", 2007, name);
    }
  };

  natives[`${c}.get:defaultObjectEncoding`] = (rt) => () => rt.defaultObjectEncoding;
  natives[`${c}.set:defaultObjectEncoding`] = (rt) => (v: Value) => {
    const e = rt.toUint(v);
    if (e !== kAMF0 && e !== kAMF3) {
      throw rt.error("ArgumentError", 2008, "objectEncoding");
    }

    rt.defaultObjectEncoding = e;
  };

  method("get:length", (_rt, b) => b.length);
  method("set:length", (rt, b, v) => b.setLength(rt.toUint(v), true));
  method("get:position", (_rt, b) => b.position);
  method("set:position", (rt, b, v) => {
    b.position = rt.toUint(v);
  });
  method("get:bytesAvailable", (_rt, b) => b.available);
  method("get:endian", (_rt, b) => (b.littleEndian ? "littleEndian" : "bigEndian"));
  method("set:endian", (rt, b, v) => {
    nonNull(rt, v, "endian");
    const type = rt.toString(v);
    if (type === "bigEndian" || type === "littleEndian") {
      b.littleEndian = type === "littleEndian";
    } else {
      throw rt.error("ArgumentError", 2008, "type");
    }
  });
  method("get:objectEncoding", (_rt, b) => b.objectEncoding);
  method("set:objectEncoding", (rt, b, v) => {
    const e = rt.toUint(v);
    if (e !== kAMF0 && e !== kAMF3) {
      throw rt.error("ArgumentError", 2008, "objectEncoding");
    }

    b.objectEncoding = e;
  });
  method("get:shareable", () => false);
  method("set:shareable", () => undefined);
  method("clear", (_rt, b) => {
    b.clear();
  });

  // Reads.
  method("readBoolean", (_rt, b) => {
    const at = b.shortRead(1);
    return b.buffer[at] !== 0;
  });
  method("readByte", (_rt, b) => {
    const at = b.shortRead(1);
    return b.view.getInt8(at);
  });
  method("readUnsignedByte", (_rt, b) => {
    const at = b.shortRead(1);
    return b.buffer[at];
  });
  method("readShort", (_rt, b) => {
    const at = b.shortRead(2);
    return b.view.getInt16(at, b.littleEndian);
  });
  method("readUnsignedShort", (_rt, b) => {
    const at = b.shortRead(2);
    return b.view.getUint16(at, b.littleEndian);
  });
  method("readInt", (_rt, b) => {
    const at = b.shortRead(4);
    return b.view.getInt32(at, b.littleEndian);
  });
  method("readUnsignedInt", (_rt, b) => {
    const at = b.shortRead(4);
    return b.view.getUint32(at, b.littleEndian);
  });
  method("readFloat", (_rt, b) => {
    const at = b.shortRead(4);
    return b.view.getFloat32(at, b.littleEndian);
  });
  method("readDouble", (_rt, b) => {
    const at = b.shortRead(8);
    return b.view.getFloat64(at, b.littleEndian);
  });

  // As ByteArrayObject::readUTFBytes: a BOM skipped, and a NUL ends the string.
  const readUTFBytes = (rt: Runtime, b: Bytes, n: number) => {
    if (b.available < n) {
      throw rt.error("flash.errors::EOFError", 2030);
    }

    let bytes = b.buffer.subarray(b.position, b.position + n);
    if (BOM(bytes)) {
      bytes = bytes.subarray(3);
    }

    const s = fromUtf8(toNul(bytes));
    b.position += n;
    return s;
  };
  method("readUTFBytes", (rt, b, n) => readUTFBytes(rt, b, rt.toUint(n)));
  method("readUTF", (rt, b) => {
    const at = b.shortRead(2);
    return readUTFBytes(rt, b, b.view.getUint16(at, b.littleEndian));
  });

  // avmshell converts no other charset: the bytes are checked, and nothing read.
  method("readMultiByte", (rt, b, n, charSet) => {
    nonNull(rt, charSet, "charSet");
    b.checkEOF(rt.toUint(n));
    return "";
  });

  // As DataInput::ReadByteArray: into `bytes` at `offset`, growing it to hold them.
  method("readBytes", (rt, b, bytes, offsetIn = 0, lengthIn = 0) => {
    nonNull(rt, bytes, "bytes");
    const offset = rt.toUint(offsetIn);
    let count = rt.toUint(lengthIn);
    const available = b.available;
    if (count === 0) {
      count = available;
    }

    if (count > available) {
      throw rt.error("flash.errors::EOFError", 2030);
    }

    if (offset + count > 0xffffffff) {
      throw rt.error("RangeError", 2006);
    }

    const to = bytesOf(rt, bytes);
    const read = b.read(count);
    if (offset + count >= to.length) {
      to.setLength(offset + count);
    }

    to.buffer.set(read, offset);
  });

  // Writes.
  method("writeBoolean", (_rt, b, v) => {
    const at = b.shortWrite(1);
    b.buffer[at] = v ? 1 : 0;
  });
  method("writeByte", (rt, b, v) => {
    const at = b.shortWrite(1);
    b.buffer[at] = rt.toInt(v) & 0xff;
  });
  method("writeShort", (rt, b, v) => {
    const at = b.shortWrite(2);
    b.view.setInt16(at, rt.toInt(v), b.littleEndian);
  });
  method("writeInt", (rt, b, v) => {
    const at = b.shortWrite(4);
    b.view.setInt32(at, rt.toInt(v), b.littleEndian);
  });
  method("writeUnsignedInt", (rt, b, v) => {
    const at = b.shortWrite(4);
    b.view.setUint32(at, rt.toUint(v), b.littleEndian);
  });
  method("writeFloat", (rt, b, v) => {
    const at = b.shortWrite(4);
    b.view.setFloat32(at, rt.toNumber(v), b.littleEndian);
  });
  method("writeDouble", (rt, b, v) => {
    const at = b.shortWrite(8);
    b.view.setFloat64(at, rt.toNumber(v), b.littleEndian);
  });
  method("writeUTFBytes", (rt, b, v) => {
    nonNull(rt, v, "value");
    b.write(utf8(rt.toString(v)));
  });
  method("writeUTF", (rt, b, v) => {
    nonNull(rt, v, "value");
    const bytes = utf8(rt.toString(v));
    if (bytes.length > 65535) {
      throw rt.error("RangeError", 2006);
    }

    const at = b.shortWrite(2);
    b.view.setUint16(at, bytes.length, b.littleEndian);
    b.write(bytes);
  });
  method("writeMultiByte", (rt, _b, value, charSet) => {
    nonNull(rt, value, "value");
    nonNull(rt, charSet, "charSet");
  });

  // As ByteArrayObject::writeBytes and DataOutput::WriteByteArray.
  method("writeBytes", (rt, b, bytes, offsetIn = 0, lengthIn = 0) => {
    nonNull(rt, bytes, "bytes");
    const from = bytesOf(rt, bytes);
    let offset = rt.toUint(offsetIn);
    let count = rt.toUint(lengthIn);
    if (count === 0) {
      count = (from.length - offset) >>> 0;
    }

    const length = from.length;
    if (offset > length) {
      offset = length;
    }

    if (count === 0) {
      count = length - offset;
    }

    if (count > length - offset) {
      throw rt.error("RangeError", 2006);
    }

    if (count > 0) {
      b.write(from.buffer.slice(offset, offset + count));
    }
  });

  // As ByteArrayObject::_toString: by its BOM, UTF-8 or UTF-16 of either
  // order, else UTF-8; all of its length, NULs too.
  natives[`${c}#${own}::_toString`] = (rt) =>
    function (this: AsObject) {
      const b = bytesOf(rt, this);
      const bytes = b.buffer.subarray(0, b.length);
      if (bytes.length >= 3) {
        if (BOM(bytes)) {
          return fromUtf8(bytes.subarray(3));
        }

        if ((bytes[0] === 0xfe && bytes[1] === 0xff) || (bytes[0] === 0xff && bytes[1] === 0xfe)) {
          const little = bytes[0] === 0xff;
          const units: number[] = [];
          const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
          for (let i = 2; i + 1 < bytes.length; i += 2) {
            units.push(view.getUint16(i, little));
          }

          return fromCodes(units);
        }
      }

      return fromUtf8(bytes);
    };

  return natives;
}

/** avmshell's Domain: its domain memory is the runtime's, a ByteArray or the scratch memory. */
export function domainNatives(): Natives {
  const c = "avmplus::Domain";
  return {
    [`${c}.get:currentDomain`]: (rt) => () => rt.currentDomain(),
    [`${c}.get:MIN_DOMAIN_MEMORY_LENGTH`]: () => () => GLOBAL_MEMORY_MIN_SIZE,
    [`${c}#get:domainMemory`]: (rt) => () => rt.memoryProvider,
    // As DomainEnv::set_globalMemory: null for the scratch memory; a ByteArray shorter than the least length fails.
    [`${c}#set:domainMemory`]: (rt) => (v: Value) => {
      const previous: AsObject | null = rt.memoryProvider;
      if (v === null || v === undefined) {
        if (previous) {
          bytesOf(rt, previous).subscribed = false;
        }

        rt.memoryProvider = null;
        rt.memory = rt.scratchMemory;
        return;
      }

      const b = bytesOf(rt, v);
      if (b.length < GLOBAL_MEMORY_MIN_SIZE) {
        throw rt.error("Error", 1504);
      }

      b.subscribed = true;
      b.notify();
      if (previous && previous !== v) {
        bytesOf(rt, previous).subscribed = false;
      }

      rt.memoryProvider = v;
    },
  };
}
