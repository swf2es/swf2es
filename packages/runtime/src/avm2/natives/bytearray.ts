// flash.utils.ByteArray and domain memory, as avmplus' ByteArray and
// DataInput/DataOutput implement them. The buffer keeps avmplus' capacity:
// it grows as avmplus' Grower grows it, zeroing what a reallocation adds,
// so bytes a shorter length left behind come back when the length grows
// within the capacity, as they do in avmplus. UTF-8 is avmplus' own
// (utf8.ts).
//
// Translated from avmplus' core/ByteArrayGlue.cpp and core/DataIO.cpp,
// this file is subject to the Mozilla Public License, v. 2.0:
// http://mozilla.org/MPL/2.0/.
import {
  CompressedDataError,
  CompressedDataTooLargeError,
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
import type { Runtime } from "../runtime.js";
import type { Traits } from "../traits.js";
import { fromCodes, fromUtf8, utf8 } from "../utf8.js";
import { Bytes, bytesOf, copyBytes, GLOBAL_MEMORY_MIN_SIZE } from "./bytes.js";
import { type Natives, registerNativeClass } from "./define.js";

const kAMF0 = 0;
const kAMF3 = 3;

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

/** The longest string readUTFBytes reads a character at a time. */
const SHORT_STRING = 24;

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
  if (b.shared !== null) {
    // In place, for every worker, as avmplus swaps the shared Buffer's array.
    const previous = b.length;
    b.position = 0;
    b.write(bytes);
    if (previous > bytes.length) {
      b.buffer.fill(0, bytes.length, previous);
    }

    b.length = bytes.length;
    b.position = position >>> 0;
    b.notify();
    return;
  }

  b.setBuffer(new Uint8Array(bytes));
  b.length = bytes.length;
  b.position = position >>> 0;
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

    // A short ASCII string, as a C program's names are, a character at a time from the buffer
    // itself: no views of it made, and a single character is one the engine already has. A NUL
    // ends it; a byte past ASCII, a BOM's first among them, is read the long way.
    if (n <= SHORT_STRING) {
      const buffer = b.buffer;
      const at = b.position;
      let s = "";
      let k = 0;
      for (; k < n; k++) {
        const c = buffer[at + k];
        if (c === 0 || c >= 0x80) {
          break;
        }

        s += String.fromCharCode(c);
      }

      if (k === n || buffer[at + k] === 0) {
        b.position = (at + n) >>> 0;
        return s;
      }
    }

    let bytes = b.buffer.subarray(b.position, b.position + n);
    if (BOM(bytes)) {
      bytes = bytes.subarray(3);
    }

    const s = fromUtf8(toNul(bytes));
    b.position = (b.position + n) >>> 0;
    return s;
  };

  class ByteArrayNatives {
    declare $bytes: Bytes;

    static get defaultObjectEncoding() {
      return rt.defaultObjectEncoding;
    }

    // Unchecked, unlike an instance's: avmshell and Flash take any uint, a
    // new ByteArray starts with it, and writeObject reads an encoding below
    // 3 as AMF0 (#1508 in avmshell), any other as AMF3.
    static set defaultObjectEncoding(v: Value) {
      rt.defaultObjectEncoding = rt.toUint(v);
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
      // Not redundant: toUint's own `>>> 0` serves every caller, and once
      // one passes it 2^31 or more, JavaScriptCore makes doubles there for
      // all of them (see Bytes).
      b.position = rt.toUint(v) >>> 0;
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
      return bytesOf(rt, this).shareable;
    }

    // As ByteArray::setShareable: once shareable, always; its memory is
    // shared when it first crosses to another worker.
    set shareable(v: Value) {
      if (rt.toBoolean(v)) {
        bytesOf(rt, this).shareable = true;
      }
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

      return b.compareAndSwapInt(at, rt.toInt(expected), rt.toInt(next));
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

      return b.compareAndSwapLength(rt.toInt(expected), length >>> 0);
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

      // From the buffer as it is now: a target that grows, this ByteArray
      // too, gets a new buffer, and the bytes come from the old one. As in
      // DataInput::ReadByteArray, the target is sized first: one that
      // cannot grow leaves the position where it was.
      const to = bytesOf(rt, bytes);
      const source = b.buffer;
      const from = b.position;
      if (offset + count >= to.length) {
        to.extend(offset + count);
      }

      b.position = (from + count) >>> 0;
      copyBytes(to.buffer, offset, source, from, count);
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

      if (count > 0) {
        b.write(from.buffer, offset, count);
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
        // As avmplus: an output it cannot allocate is a MemoryError, corrupt data an IOError.
        if (e instanceof CompressedDataTooLargeError) {
          throw rt.error("flash.errors::MemoryError", 1000);
        }

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

  // AMF3 whatever their objectEncoding, as ObjectOutputObject::writeObject
  // and ObjectInputObject::readObject: avmshell and Flash alike.
  class ObjectOutputNatives {
    writeObject(this: AsObject, v: Value): void {
      const stream: Writer = this.$amf;
      stream.value(v);
    }
  }

  class ObjectInputNatives {
    readObject(this: AsObject): Value {
      const stream: Reader = this.$amf;
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
    rt.refreshMemory = null;
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
  // Shared, its length as the other workers left it, its view made again if it changed.
  rt.refreshMemory = b.shared !== null ? () => b.notify() : null;
}
