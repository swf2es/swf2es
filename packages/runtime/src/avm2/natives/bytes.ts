// A ByteArray's state, Bytes: its buffer, grown as avmplus' Grower grows
// it, its length and position, and the capacity its runtime counts; which
// the natives (bytearray.ts), AMF and domain memory read and write.
//
// Translated from avmplus' core/ByteArrayGlue.cpp, this file is subject to
// the Mozilla Public License, v. 2.0: http://mozilla.org/MPL/2.0/.
import type { AsObject } from "../descriptors.js";
import type { Runtime } from "../runtime.js";
import {
  canShareMemory,
  type GrowableShared,
  type GrowableSharedConstructor,
  notIsolated,
  type SharedBytesMemory,
  sharedObjectsOf,
} from "./shared-bytes.js";

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
 *
 * A length or position is stored through `>>> 0`, as a uint32: an int32
 * while below 2^31, and a double only from there.
 * JavaScriptCore keeps a number its JIT once made a double a double, and
 * an addition that has seen one makes doubles from then on: a double
 * offset fails the int32 check of a DataView or typed array access, and
 * after enough failures JavaScriptCore calls DataView's methods instead
 * of inlining them, a quarter slower on every read and write. V8 makes
 * small integers of them itself.
 */
export class Bytes {
  buffer: Uint8Array = new Uint8Array(0);
  view = new DataView(this.buffer.buffer);
  length = 0;
  position = 0;
  littleEndian = false;
  /** As ByteArray's constructor: ByteArray.defaultObjectEncoding when it is made. */
  objectEncoding: number;
  /** Whether it is the domain memory, which it then tells when its buffer or length changes. */
  subscribed = false;
  /**
   * Whether `shareable` was set true, which cannot be undone: the
   * ByteArray then crosses to another worker as its memory, not a copy.
   */
  shareable = false;
  /**
   * Its memory once it has crossed to another worker (share), which its
   * buffer and view are then over, tracking its length as it grows; null
   * until then, when it is a ByteArray like any other.
   */
  shared: SharedBytesMemory | null = null;
  /** The shared memory's words, the length first, and its bytes as words for the atomics. */
  private sharedWords: Int32Array | null = null;
  private sharedInts: Int32Array | null = null;
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

    if (this.shared !== null) {
      this.reshare(capacity);
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

    this.reserve(length, fromSetter);
    this.length = length >>> 0;
    if (this.position > length) {
      this.position = length >>> 0;
    }

    this.notify();
  }

  /**
   * The length made at least `length`, as a write past the end makes it:
   * shared, by a compare and swap that only ever raises it, so that
   * workers appending at once never lower what another made it.
   */
  extend(length: number): void {
    if (this.shared === null) {
      this.setLength(length);
      return;
    }

    this.reserve(length, false);
    this.raise(length);
    this.notify();
  }

  /** A shared length raised to `length` unless another worker made it as long. */
  private raise(length: number): void {
    const words = this.sharedWords as Int32Array;
    for (;;) {
      const now = Atomics.load(words, 0) >>> 0;
      if (now >= length || Atomics.compareExchange(words, 0, now | 0, length | 0) >>> 0 === now) {
        return;
      }
    }
  }

  /** As Grower::SetLengthCommon, before the length is set: the capacity for `length`. */
  private reserve(length: number, fromSetter: boolean): void {
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

  /** As ByteArray::Clear: no buffer at all; shared, every worker's ByteArray for it empty. */
  clear(): void {
    if (this.subscribed) {
      throw this.rt.error("RangeError", 1506);
    }

    this.position = 0;
    if (this.shared !== null) {
      // The memory cannot shrink: what it held is zeroed, as a new buffer
      // would be once it grows again, before the length is told, so that a
      // worker that grows it once it is empty writes into zeroes already.
      this.buffer.fill(0);
      this.length = 0;
      return;
    }

    this.setBuffer(new Uint8Array(0));
    this.length = 0;
  }

  /**
   * Its memory, shared from now on: a growable SharedArrayBuffer its bytes
   * move to once, and that this ByteArray, and every worker's ByteArray for
   * it, uses from then on. Where memory cannot be shared, the error that
   * names cross-origin isolation.
   */
  share(): SharedBytesMemory {
    if (this.shared !== null) {
      return this.shared;
    }

    if (!canShareMemory()) {
      throw notIsolated("a shareable ByteArray");
    }

    const capacity = Math.max(this.buffer.length, this.length);
    const Shared = SharedArrayBuffer as unknown as GrowableSharedConstructor;
    let data: SharedArrayBuffer | null = null;
    // As much room to grow as a ByteArray has, or as much as the host reserves.
    for (let max = kMaxCapacity; data === null; max /= 2) {
      try {
        data = new Shared(capacity, { maxByteLength: Math.max(max, capacity) });
      } catch {
        if (max <= capacity) {
          throw this.rt.error("flash.errors::MemoryError", 1000);
        }
      }
    }

    new Uint8Array(data).set(this.buffer);
    const memory: SharedBytesMemory = {
      id: Math.floor(Math.random() * 2 ** 52),
      meta: new SharedArrayBuffer(8),
      data,
    };
    new Int32Array(memory.meta)[0] = this.length | 0;
    this.adopt(memory);
    sharedObjectsOf(this.rt).set(memory.id, new WeakRef(this.owner));
    return memory;
  }

  /**
   * Use `memory`, shared, as its bytes and length from now on. Its length
   * becomes an accessor of the memory's word on this object alone, so that
   * every read sees another worker's change and every write is seen, and
   * a ByteArray that shares nothing reads a plain field as before.
   */
  adopt(memory: SharedBytesMemory): void {
    this.shared = memory;
    this.shareable = true;
    const words = new Int32Array(memory.meta);
    this.sharedWords = words;
    Object.defineProperty(this, "length", {
      get: () => Atomics.load(words, 0) >>> 0,
      set: (length: number) => Atomics.store(words, 0, length | 0),
      configurable: true,
    });
    // Views that track the memory's length as any worker grows it.
    this.buffer = new Uint8Array(memory.data);
    this.view = new DataView(memory.data);
    this.sharedInts = new Int32Array(memory.data);
    const { runtime, own } = this.capacity;
    runtime.bytes += memory.data.byteLength - own.bytes;
    own.bytes = memory.data.byteLength;
    if (this.subscribed) {
      this.rt.refreshMemory = () => this.notify();
    }

    this.notify();
  }

  /**
   * A shared memory's capacity made at least `capacity`: it grows in place,
   * which every worker sees, and never shrinks, as another worker may have
   * grown it past what this one asks for since. Nor is what a smaller
   * buffer would drop zeroed: without avmplus' safepoint, another worker
   * may have grown the length again and written there meanwhile, so bytes
   * past a lowered length may come back when it grows again.
   */
  private reshare(capacity: number): void {
    const data = (this.shared as SharedBytesMemory).data as unknown as GrowableShared;
    if (capacity <= data.byteLength) {
      return;
    }

    if (capacity > data.maxByteLength) {
      throw this.rt.error("flash.errors::MemoryError", 1000);
    }

    try {
      data.grow(capacity);
    } catch {
      // Another worker grew it meanwhile, to as much or more, or the host refused.
      if (data.byteLength < capacity) {
        throw this.rt.error("flash.errors::MemoryError", 1000);
      }
    }

    const { runtime, own } = this.capacity;
    runtime.bytes += data.byteLength - own.bytes;
    own.bytes = data.byteLength;
  }

  /** As ByteArray::CAS, once the index is checked: atomic where the memory is shared. */
  compareAndSwapInt(at: number, expected: number, next: number): number {
    if (this.sharedInts !== null) {
      return Atomics.compareExchange(this.sharedInts, at >> 2, expected, next);
    }

    const previous = this.view.getInt32(at, true);
    if (previous === expected) {
      this.view.setInt32(at, next, true);
    }

    return previous;
  }

  /**
   * As UnprotectedAtomicCompareAndSwapLength: the length set to `next`, as
   * its setter sets it, if it is `expected`; the length before. Shared,
   * the capacity is made first and the length swapped atomically, so that
   * of workers growing it at once one wins.
   */
  compareAndSwapLength(expected: number, next: number): number {
    if (this.shared === null) {
      const previous = this.length;
      if (previous === expected) {
        this.setLength(next, true);
      }

      return previous;
    }

    // Read once: another worker may change it between two reads.
    const now = this.length;
    if (now !== expected) {
      return now;
    }

    // Only grows the memory, so it does nothing another worker would undo if the swap fails.
    this.reserve(next, true);
    const previous =
      Atomics.compareExchange(this.sharedWords as Int32Array, 0, expected | 0, next | 0) >>> 0;
    if (previous === expected && this.position > next) {
      this.position = next;
    }

    this.notify();
    return previous;
  }

  /** As requestBytesForShortRead: the offset of `n` bytes to read, or EOFError. */
  shortRead(n: number): number {
    const at = this.position;
    if (at >= this.length || at + n > this.length) {
      throw this.rt.error("flash.errors::EOFError", 2030);
    }

    this.position = (at + n) >>> 0;
    return at;
  }

  /** As requestBytesForShortWrite: the offset of `n` bytes to write, the length grown to hold them. */
  shortWrite(n: number): number {
    const at = this.position;
    if (at >= this.length || at + n > this.length) {
      if (at + n > 0xffffffff) {
        throw this.rt.error("flash.errors::MemoryError", 1000);
      }

      this.extend(at + n);
    }

    this.position = (at + n) >>> 0;
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
    this.position = (this.position + count) >>> 0;
    return bytes;
  }

  /** As read, but the bytes themselves, not a copy: for a caller that only reads them, at once. */
  readView(count: number): Uint8Array {
    this.checkEOF(count);
    const bytes = this.buffer.subarray(this.position, this.position + count);
    this.position = (this.position + count) >>> 0;
    return bytes;
  }

  /**
   * As ByteArray::Write: `count` bytes of `source` from `offset`, all of
   * it by default, at the position; the length grows to the position after.
   */
  write(source: Uint8Array, offset = 0, count = source.length): void {
    // Before the buffer is read: making room may replace it.
    const at = this.claim(count);
    copyBytes(this.buffer, at, source, offset, count);
  }

  /**
   * As ByteArray::Write but for the bytes, which the caller writes itself:
   * room for `count` at the position, which moves past them, the length
   * growing to it. Where in the buffer they start.
   */
  claim(count: number): number {
    if (count > 0xffffffff - this.position) {
      throw this.rt.error("flash.errors::MemoryError", 1000);
    }

    const at = this.position;
    const end = (at + count) >>> 0;
    if (end > this.buffer.length) {
      this.ensure(end, false);
    }

    this.position = end;
    if (this.length < end) {
      if (this.shared === null) {
        this.length = end;
      } else {
        this.raise(end);
      }
    }

    this.notify();
    return at;
  }

  /** As ByteArray's operator[] for a write: the length grows to hold `index`. */
  setByte(index: number, value: number): void {
    if (index >= this.length) {
      if (index === 0xffffffff) {
        throw this.rt.error("flash.errors::MemoryError", 1000);
      }

      this.extend(index + 1);
    }

    this.buffer[index] = value;
  }
}

/** Below this many bytes, copyBytes copies one at a time. */
const COPY_LOOP_LENGTH = 32;

/**
 * `count` bytes of `source` from `offset` copied into `target` at `at`,
 * as memmove copies them where the two are one array. Part of `source`,
 * fewer than COPY_LOOP_LENGTH bytes, is copied one at a time: the
 * subarray set() would take costs more than they do, in JavaScriptCore up
 * to about 64 bytes and in V8 up to about 32. All of it set() copies
 * faster than a loop in V8, and as fast in JavaScriptCore.
 */
export function copyBytes(
  target: Uint8Array,
  at: number,
  source: Uint8Array,
  offset: number,
  count: number,
): void {
  if (source === target) {
    target.copyWithin(at, offset, offset + count);
  } else if (offset === 0 && count === source.length) {
    target.set(source, at);
  } else if (count < COPY_LOOP_LENGTH) {
    for (let i = 0; i < count; i++) {
      target[at + i] = source[offset + i];
    }
  } else {
    target.set(source.subarray(offset, offset + count), at);
  }
}

/** A ByteArray's state, made the first time a native needs it. */
export function bytesOf(rt: Runtime, o: AsObject): Bytes {
  if (!o.$bytes) {
    o.$bytes = new Bytes(rt, o);
  }

  return o.$bytes;
}
