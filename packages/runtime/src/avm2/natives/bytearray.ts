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
import {
  CompressedDataError,
  deflateCompress,
  LZMA_HEADER,
  lzmaByteArrayCompress,
  lzmaByteArrayUncompress,
  zlibCompress,
  zlibUncompress,
} from "@swf2es/format";
import type { ExternalStream, Reader, Writer } from "../amf.js";
import type { AsObject, Method, Value } from "../descriptors.js";
import type { IndexHook } from "../hooks.js";
import type { Runtime, Traits } from "../runtime.js";
import { type Natives, registerNativeClass } from "./define.js";

const kGrowthIncr = 4096;
const kHugeGrowthThreshold = 24 * 1024 * 1024;
const kHugeGrowthIncr = 24 * 1024 * 1024;
/**
 * The most a ByteArray holds: what a 32-bit avmshell, as the oracle's, can
 * allocate, beyond which it fails with MemoryError 1000, and less than a
 * browser's ArrayBuffer may be refused at.
 */
const kMaxCapacity = 0x80000000;
/** DomainEnv::GLOBAL_MEMORY_MIN_SIZE: domain memory's least length. */
export const GLOBAL_MEMORY_MIN_SIZE = 1024;
const kAMF0 = 0;
const kAMF3 = 3;

/** A count of bytes, which a ByteArray and its runtime share. */
interface Count {
  bytes: number;
}

/** The capacity of each runtime's ByteArrays, live or not yet collected. */
const runtimeCapacity = new WeakMap<Runtime, Count>();
/** A ByteArray collected: its capacity no longer counted, by its runtime's count and its own. */
const collected = new FinalizationRegistry<{ runtime: Count; own: Count }>(({ runtime, own }) => {
  runtime.bytes -= own.bytes;
});

/** The capacity of `rt`'s ByteArrays, which avmshell's System counts in its memory. */
export function byteArrayCapacity(rt: Runtime): number {
  return runtimeCapacity.get(rt)?.bytes ?? 0;
}

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
  /** Its runtime's capacity count, and its own part of it. */
  private readonly capacity: { runtime: Count; own: Count };

  constructor(
    readonly rt: Runtime,
    readonly owner: AsObject,
  ) {
    this.objectEncoding = rt.defaultObjectEncoding;
    let runtime = runtimeCapacity.get(rt);
    if (!runtime) {
      runtime = { bytes: 0 };
      runtimeCapacity.set(rt, runtime);
    }

    this.capacity = { runtime, own: { bytes: 0 } };
    collected.register(this, this.capacity);
  }

  /** Its buffer replaced by `next`, its runtime's capacity count with it. */
  setBuffer(next: Uint8Array<ArrayBuffer>): void {
    const { runtime, own } = this.capacity;
    runtime.bytes += next.length - own.bytes;
    own.bytes = next.length;
    this.buffer = next;
    this.view = new DataView(next.buffer);
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

    if (minimum > kMaxCapacity) {
      throw this.rt.error("flash.errors::MemoryError", 1000);
    }

    capacity = Math.min(capacity, kMaxCapacity);
    if (capacity === this.buffer.length) {
      return;
    }

    let next: Uint8Array<ArrayBuffer>;
    try {
      next = new Uint8Array(capacity);
    } catch {
      // The host would not give it the memory, as the system would not give avmplus.
      throw this.rt.error("flash.errors::MemoryError", 1000);
    }

    next.set(this.buffer.subarray(0, Math.min(capacity, this.length)));
    this.setBuffer(next);
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

  /** Tell the domain memory, if this is it, where the bytes are now: a new view only if they moved or their length changed. */
  notify(): void {
    const rt = this.rt;
    if (
      this.subscribed &&
      (rt.memory.buffer !== this.buffer.buffer || rt.memoryLength !== this.length)
    ) {
      rt.memory = new DataView(this.buffer.buffer, 0, this.length);
    }
  }

  /** As ByteArray::Clear: no buffer at all. */
  clear(): void {
    if (this.subscribed) {
      throw this.rt.error("RangeError", 1506);
    }

    this.setBuffer(new Uint8Array(0));
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

  /** As read, but the bytes themselves, not a copy: for a caller that only reads them, at once. */
  readView(count: number): Uint8Array {
    this.checkEOF(count);
    const bytes = this.buffer.subarray(this.position, this.position + count);
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

/** As ByteArrayObject::algorithmToEnum: zlib, deflate or lzma; null a TypeError, any other an IOError. */
function algorithmOf(rt: Runtime, algorithm: Value): "zlib" | "deflate" | "lzma" {
  if (algorithm === null || algorithm === undefined) {
    throw rt.error("TypeError", 2007, "algorithm");
  }

  const name = rt.toString(algorithm);
  if (name === "zlib" || name === "deflate" || name === "lzma") {
    return name;
  }

  throw rt.error("flash.errors::IOError", 2058);
}

/** A ByteArray's bytes, all of them, replaced by a copy of `bytes`, its position `position`; the domain memory told, if it is. */
function replaceBytes(b: Bytes, bytes: Uint8Array, position: number): void {
  b.setBuffer(new Uint8Array(bytes));
  b.length = bytes.length;
  b.position = position;
  b.notify();
}

/** ByteArray's natives, by the names the compiler gives them. */
/** ByteArray's natives, for `rt`: written as a class, each running with the ByteArray object as `this`. */
export function byteArrayNatives(rt: Runtime): Natives {
  const own = "flash.utils:ByteArray";
  const natives: Natives = {};

  const nonNull = (rt: Runtime, v: Value, name: string) => {
    if (v === null || v === undefined) {
      throw rt.error("TypeError", 2007, name);
    }
  };

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

  class ByteArrayNatives {
    declare $bytes: Bytes;

    static get defaultObjectEncoding() {
      return rt.defaultObjectEncoding;
    }

    static set defaultObjectEncoding(v: Value) {
      const e = rt.toUint(v);
      if (e !== kAMF0 && e !== kAMF3) {
        throw rt.error("ArgumentError", 2008, "objectEncoding");
      }

      rt.defaultObjectEncoding = e;
    }

    get length() {
      const b = bytesOf(rt, this);
      return b.length;
    }

    set length(v: Value) {
      const b = bytesOf(rt, this);
      b.setLength(rt.toUint(v), true);
    }

    get position() {
      const b = bytesOf(rt, this);
      return b.position;
    }

    set position(v: Value) {
      const b = bytesOf(rt, this);
      b.position = rt.toUint(v);
    }

    get bytesAvailable() {
      const b = bytesOf(rt, this);
      return b.available;
    }

    get endian() {
      const b = bytesOf(rt, this);
      return b.littleEndian ? "littleEndian" : "bigEndian";
    }

    set endian(v: Value) {
      const b = bytesOf(rt, this);
      nonNull(rt, v, "endian");
      const type = rt.toString(v);
      if (type === "bigEndian" || type === "littleEndian") {
        b.littleEndian = type === "littleEndian";
      } else {
        throw rt.error("ArgumentError", 2008, "type");
      }
    }

    get objectEncoding() {
      const b = bytesOf(rt, this);
      return b.objectEncoding;
    }

    set objectEncoding(v: Value) {
      const b = bytesOf(rt, this);
      const e = rt.toUint(v);
      if (e !== kAMF0 && e !== kAMF3) {
        throw rt.error("ArgumentError", 2008, "objectEncoding");
      }

      b.objectEncoding = e;
    }

    get shareable() {
      return false;
    }

    set shareable(_v: Value) {
      // Shareable byte arrays are not shared here.
    }

    clear() {
      const b = bytesOf(rt, this);
      b.clear();
    }

    // As ByteArray::CAS: the int at a word-aligned index within the bytes,
    // replaced by `next` if it is `expected`; the int there before.
    atomicCompareAndSwapIntAt(index: Value, expected: Value, next: Value) {
      const b = bytesOf(rt, this);
      const at = rt.toInt(index) >>> 0;
      if (b.length < 4 || at > b.length - 4 || at % 4 !== 0) {
        throw rt.error("RangeError", 1506);
      }

      const previous = b.view.getInt32(at, true);
      if (previous === rt.toInt(expected)) {
        b.view.setInt32(at, rt.toInt(next), true);
      }

      return previous;
    }

    // As ByteArrayObject::atomicCompareAndSwapLength: the length set to
    // `next` if it is `expected`, as its setter sets it; the length before.
    // The domain memory refuses a length below its least, as later avmplus
    // does; the oracle's avmshell sets it.
    atomicCompareAndSwapLength(expected: Value, next: Value) {
      const b = bytesOf(rt, this);
      const length = rt.toInt(next);
      if (b.subscribed && length < GLOBAL_MEMORY_MIN_SIZE) {
        throw rt.error("RangeError", 1506);
      }

      const previous = b.length;
      if (previous === rt.toInt(expected)) {
        b.setLength(length >>> 0, true);
      }

      return previous;
    }

    // Reads.
    readBoolean() {
      const b = bytesOf(rt, this);
      const at = b.shortRead(1);
      return b.buffer[at] !== 0;
    }

    readByte() {
      const b = bytesOf(rt, this);
      const at = b.shortRead(1);
      return b.view.getInt8(at);
    }

    readUnsignedByte() {
      const b = bytesOf(rt, this);
      const at = b.shortRead(1);
      return b.buffer[at];
    }

    readShort() {
      const b = bytesOf(rt, this);
      const at = b.shortRead(2);
      return b.view.getInt16(at, b.littleEndian);
    }

    readUnsignedShort() {
      const b = bytesOf(rt, this);
      const at = b.shortRead(2);
      return b.view.getUint16(at, b.littleEndian);
    }

    readInt() {
      const b = bytesOf(rt, this);
      const at = b.shortRead(4);
      return b.view.getInt32(at, b.littleEndian);
    }

    readUnsignedInt() {
      const b = bytesOf(rt, this);
      const at = b.shortRead(4);
      return b.view.getUint32(at, b.littleEndian);
    }

    readFloat() {
      const b = bytesOf(rt, this);
      const at = b.shortRead(4);
      return b.view.getFloat32(at, b.littleEndian);
    }

    readDouble() {
      const b = bytesOf(rt, this);
      const at = b.shortRead(8);
      return b.view.getFloat64(at, b.littleEndian);
    }

    readUTFBytes(n: Value) {
      const b = bytesOf(rt, this);
      return readUTFBytes(rt, b, rt.toUint(n));
    }

    readUTF() {
      const b = bytesOf(rt, this);
      const at = b.shortRead(2);
      return readUTFBytes(rt, b, b.view.getUint16(at, b.littleEndian));
    }

    // avmshell converts no other charset: the bytes are checked, and nothing read.
    readMultiByte(n: Value, charSet: Value) {
      const b = bytesOf(rt, this);
      nonNull(rt, charSet, "charSet");
      b.checkEOF(rt.toUint(n));
      return "";
    }

    // As DataInput::ReadByteArray: into `bytes` at `offset`, growing it to hold them.
    readBytes(bytes: Value, offsetIn: Value = 0, lengthIn: Value = 0) {
      const b = bytesOf(rt, this);
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

      // A view, not a copy: set copies once, and as memmove where the two
      // are one ByteArray. A target that grows keeps the view's bytes as
      // they were.
      const to = bytesOf(rt, bytes);
      const read = b.readView(count);
      if (offset + count >= to.length) {
        to.setLength(offset + count);
      }

      to.buffer.set(read, offset);
    }

    // Writes.
    writeBoolean(v: Value) {
      const b = bytesOf(rt, this);
      const at = b.shortWrite(1);
      b.buffer[at] = v ? 1 : 0;
    }

    writeByte(v: Value) {
      const b = bytesOf(rt, this);
      const at = b.shortWrite(1);
      b.buffer[at] = rt.toInt(v) & 0xff;
    }

    writeShort(v: Value) {
      const b = bytesOf(rt, this);
      const at = b.shortWrite(2);
      b.view.setInt16(at, rt.toInt(v), b.littleEndian);
    }

    writeInt(v: Value) {
      const b = bytesOf(rt, this);
      const at = b.shortWrite(4);
      b.view.setInt32(at, rt.toInt(v), b.littleEndian);
    }

    writeUnsignedInt(v: Value) {
      const b = bytesOf(rt, this);
      const at = b.shortWrite(4);
      b.view.setUint32(at, rt.toUint(v), b.littleEndian);
    }

    writeFloat(v: Value) {
      const b = bytesOf(rt, this);
      const at = b.shortWrite(4);
      b.view.setFloat32(at, rt.toNumber(v), b.littleEndian);
    }

    writeDouble(v: Value) {
      const b = bytesOf(rt, this);
      const at = b.shortWrite(8);
      b.view.setFloat64(at, rt.toNumber(v), b.littleEndian);
    }

    writeUTFBytes(v: Value) {
      const b = bytesOf(rt, this);
      nonNull(rt, v, "value");
      b.write(utf8(rt.toString(v)));
    }

    writeUTF(v: Value) {
      const b = bytesOf(rt, this);
      nonNull(rt, v, "value");
      const bytes = utf8(rt.toString(v));
      if (bytes.length > 65535) {
        throw rt.error("RangeError", 2006);
      }

      const at = b.shortWrite(2);
      b.view.setUint16(at, bytes.length, b.littleEndian);
      b.write(bytes);
    }

    writeMultiByte(value: Value, charSet: Value) {
      nonNull(rt, value, "value");
      nonNull(rt, charSet, "charSet");
    }

    // As ByteArrayObject::writeBytes and DataOutput::WriteByteArray.
    writeBytes(bytes: Value, offsetIn: Value = 0, lengthIn: Value = 0) {
      const b = bytesOf(rt, this);
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

      // A view, not a copy, as readBytes reads.
      if (count > 0) {
        b.write(from.buffer.subarray(offset, offset + count));
      }
    }

    // As ByteArrayObject::_compress and _uncompress, which compress(),
    // uncompress(), deflate() and inflate() call: the algorithm checked
    // first, and an empty ByteArray left as it is. The domain memory is
    // compressed too, as avmshell's is: its Domain does not subscribe to it
    // as the player refuses a subscribed one (3735). Compressing leaves the position at the end, uncompressing at 0;
    // data that does not uncompress leaves the ByteArray as it was.
    [`${own}::_compress`](algorithm: Value) {
      const kind = algorithmOf(rt, algorithm);
      const b = bytesOf(rt, this);
      if (b.length === 0) {
        return;
      }

      const data = b.buffer.subarray(0, b.length);
      const out =
        kind === "zlib"
          ? zlibCompress(data)
          : kind === "deflate"
            ? deflateCompress(data)
            : lzmaByteArrayCompress(data);
      replaceBytes(b, out, out.length);
    }

    [`${own}::_uncompress`](algorithm: Value) {
      const kind = algorithmOf(rt, algorithm);
      const b = bytesOf(rt, this);
      if (b.length === 0) {
        return;
      }

      const data = b.buffer.subarray(0, b.length);
      let out: Uint8Array;
      if (kind === "lzma") {
        // As UncompressViaLzma: too short for its header is left as it is, and
        // a length past 32 bits a MemoryError before anything is read.
        if (b.length < LZMA_HEADER) {
          return;
        }

        if (data[9] | data[10] | data[11] | data[12]) {
          throw rt.error("flash.errors::MemoryError", 1000);
        }
      }

      try {
        out =
          kind === "lzma"
            ? lzmaByteArrayUncompress(data)
            : zlibUncompress(data, kind === "deflate");
      } catch (e) {
        if (e instanceof CompressedDataError) {
          throw rt.error("flash.errors::IOError", 2058);
        }

        throw e;
      }

      replaceBytes(b, out, 0);
    }

    // As ByteArrayObject::_toString: by its BOM, UTF-8 or UTF-16 of either
    // order, else UTF-8; all of its length, NULs too.
    [`${own}::_toString`]() {
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
    }
  }

  registerNativeClass(natives, "flash.utils::ByteArray", ByteArrayNatives);

  // flash.utils' ObjectOutput and ObjectInput, what writeExternal and
  // readExternal are given: the ByteArray's own writes and reads, in the
  // stream's byte order, and its objects through the stream's tables.
  const delegated = (target: object, names: string[]) => {
    const from = ByteArrayNatives.prototype as unknown as Record<string, Method>;
    for (const name of names) {
      const f = from[name];
      Object.defineProperty(target, name, {
        value(this: AsObject, ...args: Value[]) {
          const stream: ExternalStream = this.$amf;
          const b = stream.bytes;
          const order = b.littleEndian;
          b.littleEndian = stream.littleEndian;
          try {
            return f.apply(b.owner, args);
          } finally {
            b.littleEndian = order;
          }
        },
      });
    }
  };
  const streamState = {
    get endian(): string {
      return (this as unknown as AsObject).$amf.littleEndian ? "littleEndian" : "bigEndian";
    },
    set endian(v: Value) {
      nonNull(rt, v, "endian");
      if (v !== "bigEndian" && v !== "littleEndian") {
        throw rt.error("ArgumentError", 2008, "type");
      }

      (this as unknown as AsObject).$amf.littleEndian = v === "littleEndian";
    },
    get objectEncoding(): number {
      return (this as unknown as AsObject).$amf.objectEncoding;
    },
    set objectEncoding(v: Value) {
      const encoding = rt.toUint(v);
      if (encoding !== 0 && encoding !== 3) {
        throw rt.error("ArgumentError", 2008, "objectEncoding");
      }

      (this as unknown as AsObject).$amf.objectEncoding = encoding;
    },
  };

  class ObjectOutputNatives {
    writeObject(this: AsObject, v: Value): void {
      const stream: Writer = this.$amf;
      if (stream.objectEncoding !== 3) {
        throw rt.unsupported("AMF0");
      }

      stream.value(v);
    }
  }

  class ObjectInputNatives {
    readObject(this: AsObject): Value {
      const stream: Reader = this.$amf;
      if (stream.objectEncoding !== 3) {
        throw rt.unsupported("AMF0");
      }

      return stream.value();
    }

    get bytesAvailable(): number {
      return (this as unknown as AsObject).$amf.bytes.available;
    }
  }

  for (const Class of [ObjectOutputNatives, ObjectInputNatives]) {
    Object.defineProperties(Class.prototype, Object.getOwnPropertyDescriptors(streamState));
  }

  delegated(ObjectOutputNatives.prototype, [
    "writeBytes",
    "writeBoolean",
    "writeByte",
    "writeShort",
    "writeInt",
    "writeUnsignedInt",
    "writeFloat",
    "writeDouble",
    "writeMultiByte",
    "writeUTF",
    "writeUTFBytes",
  ]);
  delegated(ObjectInputNatives.prototype, [
    "readBytes",
    "readBoolean",
    "readByte",
    "readUnsignedByte",
    "readShort",
    "readUnsignedShort",
    "readInt",
    "readUnsignedInt",
    "readFloat",
    "readDouble",
    "readMultiByte",
    "readUTF",
    "readUTFBytes",
  ]);
  registerNativeClass(natives, "flash.utils::ObjectOutput", ObjectOutputNatives);
  registerNativeClass(natives, "flash.utils::ObjectInput", ObjectInputNatives);
  return natives;
}

/**
 * As DomainEnv::set_globalMemory: the domain memory set to ByteArray `v`, or
 * to the scratch memory for null; a ByteArray shorter than the least length
 * fails. avmshell's Domain and the player's ApplicationDomain both set it.
 */
export function setDomainMemory(rt: Runtime, v: Value): void {
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
}
