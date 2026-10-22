// zlib and LZMA, synchronously, in one module that imports nothing. Each call
// copies its input into the module's memory, works there in an arena reset
// first, and copies the output out. Memory never shrinks, so an instance
// whose memory has grown past MEMORY_KEPT is dropped after its call and the
// next call starts a new one from the compiled module.
import { binary } from "./binary.js";

interface Exports {
  memory: WebAssembly.Memory;
  reset(): void;
  alloc(n: number): number;
  resultPointer(): number;
  resultSize(): number;
  inputUsed(): number;
  errorMessage(): number;
  inflateData(input: number, length: number, windowBits: number, limit: number): number;
  deflateData(input: number, length: number, level: number, windowBits: number): number;
  lzmaDecode(properties: number, input: number, length: number, size: number): number;
  lzmaEncode(input: number, length: number): number;
}

/** The stream ended. */
export const DONE = 0;
/** The output reached its limit before the stream ended. */
export const FULL = 1;
/** The data is not what it says. */
export const CORRUPT = -1;
/** The input ended before the stream did. */
export const TRUNCATED = -2;
/** The module could not have the memory it needed. */
export const NO_MEMORY = -3;
/** A zlib stream asked for a preset dictionary. */
export const DICTIONARY = -4;

/** What a decoder made of its input. */
export interface Decoded {
  /** DONE, FULL or one of the failures; on a failure, `bytes` holds what was decoded before it. */
  status: number;
  /** The output, after `offset` bytes left for the caller. */
  bytes: Uint8Array;
  /** How many bytes of the input it read. */
  used: number;
  /** zlib's account of corrupt data, if it gave one. */
  message: string | null;
}

/**
 * Memory an instance may keep between calls: what a bitmap or a SWF of a
 * few MB needs, less than an LZMA encoder's for a dictionary of 1 MB.
 * Starting again costs an instantiation, a fraction of a millisecond.
 */
export const MEMORY_KEPT = 8 << 20;

let compiled: WebAssembly.Module | null = null;
let instance: Exports | null = null;

/**
 * The module, compiled synchronously the first time (about 90 KB; browsers
 * allow a synchronous compile of that size on the main thread), and an
 * instance of it.
 */
function wasm(): Exports {
  if (instance) {
    return instance;
  }

  compiled ??= new WebAssembly.Module(Uint8Array.from(atob(binary), (c) => c.charCodeAt(0)));
  instance = new WebAssembly.Instance(compiled).exports as unknown as Exports;
  return instance;
}

/** `data` in the module's memory, after a reset; 0 if it does not fit. */
function input(x: Exports, data: Uint8Array): number {
  x.reset();
  const at = x.alloc(data.length);
  if (at !== 0) {
    new Uint8Array(x.memory.buffer, at, data.length).set(data);
  }

  return at;
}

/** The result, copied out after `offset` bytes, and the instance let go if it grew too large. */
function output(x: Exports, offset: number): Uint8Array {
  const n = x.resultSize();
  const bytes = new Uint8Array(offset + n);
  if (n) {
    bytes.set(new Uint8Array(x.memory.buffer, x.resultPointer(), n), offset);
  }

  return bytes;
}

function release(x: Exports): void {
  if (x.memory.buffer.byteLength > MEMORY_KEPT) {
    instance = null;
  }
}

function cString(x: Exports, at: number): string | null {
  if (at === 0) {
    return null;
  }

  const memory = new Uint8Array(x.memory.buffer);
  let end = at;
  while (memory[end] !== 0) {
    end++;
  }

  return String.fromCharCode(...memory.subarray(at, end));
}

/**
 * Inflate a zlib stream, or with `raw` a raw deflate stream, to at most
 * `limit` bytes. What follows the stream's end is not read.
 */
export function inflate(data: Uint8Array, raw: boolean, limit: number, offset = 0): Decoded {
  const x = wasm();
  try {
    const at = input(x, data);
    const status =
      at === 0
        ? NO_MEMORY
        : x.inflateData(at, data.length, raw ? -15 : 15, Math.min(limit, 2 ** 32 - 1));
    return {
      status,
      bytes: output(x, offset),
      used: x.inputUsed(),
      message: status === CORRUPT ? cString(x, x.errorMessage()) : null,
    };
  } finally {
    release(x);
  }
}

/** `data` deflated at `level` (0 to 9) with zlib's default memory and window, as a zlib stream or, `raw`, a raw one. */
export function deflate(data: Uint8Array, level: number, raw: boolean): Uint8Array {
  const x = wasm();
  try {
    const at = input(x, data);
    if (at === 0 || x.deflateData(at, data.length, level, raw ? -15 : 15) !== DONE) {
      throw new RangeError(`no memory to deflate ${data.length} bytes`);
    }

    return output(x, 0);
  } finally {
    release(x);
  }
}

/**
 * Decode the LZMA stream at `start` of `data`, whose 5 property bytes are at
 * `properties`, to `size` bytes, or fewer if its end marker comes first.
 * Properties past 224 are corrupt, a dictionary is at least 4 KB, and any
 * read past the data's end fails, as a whole stream never makes one.
 */
export function lzmaDecode(
  data: Uint8Array,
  properties: number,
  start: number,
  size: number,
  offset = 0,
): Decoded {
  if (properties < 0 || properties + 5 > data.length || start < 0 || start > data.length) {
    return { status: TRUNCATED, bytes: new Uint8Array(offset), used: 0, message: null };
  }

  const x = wasm();
  try {
    const from = Math.min(properties, start);
    const at = input(x, data.subarray(from));
    const status =
      at === 0
        ? NO_MEMORY
        : x.lzmaDecode(
            at + properties - from,
            at + start - from,
            data.length - start,
            Math.min(size, 2 ** 32 - 1),
          );
    return { status, bytes: output(x, offset), used: x.inputUsed(), message: null };
  } finally {
    release(x);
  }
}

/**
 * `data` as LZMA, as avmplus' ByteArray writes it: 5 property bytes, the
 * length in 8 bytes, little-endian, and the stream, at level 9 with a 1 MB
 * dictionary and no end marker.
 */
export function lzmaEncode(data: Uint8Array): Uint8Array {
  const x = wasm();
  try {
    const at = input(x, data);
    if (at === 0 || x.lzmaEncode(at, data.length) !== DONE) {
      throw new RangeError(`no memory to compress ${data.length} bytes`);
    }

    return output(x, 0);
  } finally {
    release(x);
  }
}

/** The module's memory now, for measuring: 0 when no instance is kept. */
export function memoryInUse(): number {
  return instance ? instance.memory.buffer.byteLength : 0;
}
