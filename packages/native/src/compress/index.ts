// zlib and LZMA, synchronously, in one module that imports nothing. Each call
// copies its input into the module's memory, works there in an arena reset
// first, and copies the output out. Memory never shrinks, so an instance
// whose memory has grown past MEMORY_KEPT is dropped after its call, as is
// one whose call threw, and the next call starts a new one from the
// compiled module.
import { decodeBase64 } from "../base64.js";
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
/** The module, or the page, could not have the memory the output needed. */
export const NO_MEMORY = -3;
/** A zlib stream asked for a preset dictionary. */
export const DICTIONARY = -4;

/** What a decoder made of its input. */
export interface Decoded {
  /** DONE, FULL or one of the failures. */
  status: number;
  /**
   * The output, after `offset` bytes left for the caller: on DONE and FULL,
   * and on a failure only when `partial` asked for what decoded before it;
   * otherwise only the `offset` bytes, so that what a bomb inflated is
   * never copied out of the module only to be dropped.
   */
  bytes: Uint8Array;
  /** How many bytes of the input it read. */
  used: number;
  /** zlib's account of corrupt data, if it gave one. */
  message: string | null;
}

/** How a decoder hands its output over. */
export interface DecodeOptions {
  /** Bytes to leave before the output, for the caller to fill. */
  offset?: number;
  /** Whether a failure still gives what decoded before it. */
  partial?: boolean;
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
 * Run `f` on the instance, made first if there is none (the module compiled
 * synchronously the first time: about 90 KB, which browsers allow on the
 * main thread). An instance that threw, or whose memory grew past
 * MEMORY_KEPT, is let go.
 */
function call<T>(f: (x: Exports) => T): T {
  compiled ??= new WebAssembly.Module(decodeBase64(binary));
  instance ??= new WebAssembly.Instance(compiled).exports as unknown as Exports;
  const x = instance;
  try {
    return f(x);
  } catch (e) {
    instance = null;
    throw e;
  } finally {
    if (x.memory.buffer.byteLength > MEMORY_KEPT) {
      instance = null;
    }
  }
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

/** The result, copied out after `offset` bytes; null if the page cannot have that much. */
function output(x: Exports, offset: number): Uint8Array | null {
  const n = x.resultSize();
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(offset + n);
  } catch (e) {
    if (e instanceof RangeError) {
      return null;
    }

    throw e;
  }

  if (n) {
    bytes.set(new Uint8Array(x.memory.buffer, x.resultPointer(), n), offset);
  }

  return bytes;
}

/** A decoder's result: its output copied out only when it is wanted. */
function decoded(x: Exports, status: number, options: DecodeOptions): Decoded {
  const offset = options.offset ?? 0;
  const used = x.inputUsed();
  const message = status === CORRUPT ? cString(x, x.errorMessage()) : null;
  const wanted = status === DONE || status === FULL || options.partial === true;
  const bytes = wanted ? output(x, offset) : new Uint8Array(offset);
  if (bytes === null) {
    return { status: NO_MEMORY, bytes: new Uint8Array(offset), used, message: null };
  }

  return { status, bytes, used, message };
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
export function inflate(
  data: Uint8Array,
  raw: boolean,
  limit: number,
  options: DecodeOptions = {},
): Decoded {
  return call((x) => {
    const at = input(x, data);
    const status =
      at === 0
        ? NO_MEMORY
        : x.inflateData(at, data.length, raw ? -15 : 15, Math.min(limit, 2 ** 32 - 1));
    return decoded(x, status, options);
  });
}

/** `data` deflated at `level` (0 to 9) with zlib's default memory and window, as a zlib stream or, `raw`, a raw one. */
export function deflate(data: Uint8Array, level: number, raw: boolean): Uint8Array {
  return call((x) => {
    const at = input(x, data);
    const bytes =
      at === 0 || x.deflateData(at, data.length, level, raw ? -15 : 15) !== DONE
        ? null
        : output(x, 0);
    if (bytes === null) {
      throw new RangeError(`no memory to deflate ${data.length} bytes`);
    }

    return bytes;
  });
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
  options: DecodeOptions = {},
): Decoded {
  if (properties < 0 || properties + 5 > data.length || start < 0 || start > data.length) {
    return {
      status: TRUNCATED,
      bytes: new Uint8Array(options.offset ?? 0),
      used: 0,
      message: null,
    };
  }

  return call((x) => {
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
    return decoded(x, status, options);
  });
}

/**
 * `data` as LZMA, as avmplus' ByteArray writes it: 5 property bytes, the
 * length in 8 bytes, little-endian, and the stream, at level 9 with a 1 MB
 * dictionary, or a smaller one for less data, and no end marker.
 */
export function lzmaEncode(data: Uint8Array): Uint8Array {
  return call((x) => {
    const at = input(x, data);
    const bytes = at === 0 || x.lzmaEncode(at, data.length) !== DONE ? null : output(x, 0);
    if (bytes === null) {
      throw new RangeError(`no memory to compress ${data.length} bytes`);
    }

    return bytes;
  });
}

/** The module's memory now, for measuring: 0 when no instance is kept. */
export function memoryInUse(): number {
  return instance ? instance.memory.buffer.byteLength : 0;
}
