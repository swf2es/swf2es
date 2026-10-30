// JPEG XR images through jxrlib, synchronously, in one module that imports
// nothing. Each call copies its input into the module's memory, decodes in
// an arena reset first, and copies the pixels out. jxrlib is not memory
// safe on corrupt input: it may read past its tables, write through null
// pointers into the bottom of the stack, or trap, all within its instance.
// So each texture decodes in an instance of its own (freshJxr), which
// nothing one texture does can carry over to the next, and an instance
// whose call trapped, or whose memory grew past MEMORY_KEPT, is let go
// at once.
import { decodeBase64 } from "../base64.js";
import { binary } from "./binary.js";

interface Exports {
  memory: WebAssembly.Memory;
  reset(): void;
  alloc(n: number): number;
  decodeImage(input: number, length: number, format: number, limit: number): number;
  resultPointer(): number;
  resultWidth(): number;
  resultHeight(): number;
}

/** The pixel formats ATF's images hold, as jxr.c numbers them, and their bytes a pixel out: 24-bit pixels come out as BGRA. */
export const JXR_BGR = 0;
export const JXR_BGRA = 1;
export const JXR_RGB565 = 2;
export const JXR_GRAY = 3;
const BYTES = [4, 4, 2, 1];

/** An image's pixels: top-down rows of its format's bytes, unpadded. */
export interface JxrImage {
  width: number;
  height: number;
  pixels: Uint8Array;
}

/** Memory an instance may keep between calls: a 1024-pixel texture's image and its decoding. */
const MEMORY_KEPT = 8 << 20;

let compiled: WebAssembly.Module | null = null;
let instance: Exports | null = null;
let traps = 0;

/**
 * The JPEG XR file `data`, which must hold `format` and be at most `limit`
 * pixels a side; null where it does not, is corrupt, or cannot have the
 * memory it needs. A call that traps lets its instance go and is null too.
 */
export function decodeJxr(data: Uint8Array, format: number, limit: number): JxrImage | null {
  let x: Exports;
  try {
    compiled ??= new WebAssembly.Module(decodeBase64(binary));
    instance ??= new WebAssembly.Instance(compiled).exports as unknown as Exports;
    x = instance;
  } catch {
    // The host refused the module, or memory for an instance: the image does not decode.
    return null;
  }

  try {
    x.reset();
    const at = x.alloc(data.length);
    if (at === 0) {
      return null;
    }

    new Uint8Array(x.memory.buffer, at, data.length).set(data);
    if (x.decodeImage(at, data.length, format, limit) !== 0) {
      return null;
    }

    const width = x.resultWidth();
    const height = x.resultHeight();
    const n = width * height * BYTES[format];

    return { width, height, pixels: new Uint8Array(x.memory.buffer, x.resultPointer(), n).slice() };
  } catch {
    // jxrlib trapped on input it should have refused: this instance's state is not to be trusted.
    instance = null;
    traps++;
    return null;
  } finally {
    if (x.memory.buffer.byteLength > MEMORY_KEPT) {
      instance = null;
    }
  }
}

/** Let the instance go, so that the next call starts a new one: before each texture. */
export function freshJxr(): void {
  instance = null;
}

/** How many calls have trapped, for the fuzzer: each was refused, and its instance let go. */
export function jxrTraps(): number {
  return traps;
}

/** The module's memory now, for measuring: 0 when no instance is kept. */
export function jxrMemoryInUse(): number {
  return instance ? instance.memory.buffer.byteLength : 0;
}
