// JPEG XR images through jxrlib, synchronously, in one module that imports
// nothing, kept as compress's is (instance.ts). Each call copies its input
// into the module's memory, decodes in an arena reset first, and copies
// the pixels out. jxrlib is not memory safe on corrupt input: it may read
// past its tables, write through null pointers into the bottom of the
// stack, or trap, all within its instance. So an instance that refused an
// image, or trapped, is let go, and the next image starts in a new one:
// nothing a corrupt image did reaches another.
import { KeptInstance } from "../instance.js";
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

const kept = new KeptInstance<Exports>(binary);
let traps = 0;

/**
 * The JPEG XR file `data`, which must hold `format` and be at most `limit`
 * pixels a side; null where it does not, is corrupt, or cannot have the
 * memory it needs, and so where the module cannot be instantiated.
 */
export function decodeJxr(data: Uint8Array, format: number, limit: number): JxrImage | null {
  try {
    return kept.call((x) => {
      x.reset();
      const at = x.alloc(data.length);
      if (at !== 0) {
        new Uint8Array(x.memory.buffer, at, data.length).set(data);
      }

      if (at === 0 || x.decodeImage(at, data.length, format, limit) !== 0) {
        kept.drop();
        return null;
      }

      const width = x.resultWidth();
      const height = x.resultHeight();
      const n = width * height * BYTES[format];

      return {
        width,
        height,
        pixels: new Uint8Array(x.memory.buffer, x.resultPointer(), n).slice(),
      };
    });
  } catch {
    // A trap, which let the instance go, or a host that refused the module or its memory.
    traps++;
    return null;
  }
}

/** How many calls have thrown, for the fuzzer: each was refused. */
export function jxrTraps(): number {
  return traps;
}

/** The module's memory now, for measuring: 0 when no instance is kept. */
export function jxrMemoryInUse(): number {
  return kept.memory;
}
