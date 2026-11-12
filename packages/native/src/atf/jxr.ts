// JPEG XR images through jxrlib, synchronously, in one module that imports
// nothing, kept as compress's is (instance.ts). Each call copies its input
// into the module's memory, decodes in an arena reset first, and copies
// the pixels out; an encode copies its pixels in 16 rows at a time, and
// the file out. jxrlib is not memory safe on corrupt input: it may read
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
  resultSize(): number;
  encodeBegin(
    width: number,
    height: number,
    alpha: number,
    quantization: number,
    subsampling: number,
    trim: number,
  ): number;
  encodeRows(input: number, lines: number): number;
  encodeEnd(): number;
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

/** How an encode keeps chroma, as jxr.c numbers it (jxrlib's colour formats). */
export const JXR_444 = 3;
export const JXR_422 = 2;
export const JXR_420 = 1;

/** What an encode writes, Flash's BitmapData.encode's JPEGXREncoderOptions. */
export interface JxrEncodeOptions {
  /** Whether alpha is kept, and the pixels taken as premultiplied (32bppPBGRA); else 24bppBGR. */
  alpha: boolean;
  /** Flash's quantization, 0 (lossless) to 100. */
  quantization: number;
  /** JXR_444, JXR_422 or JXR_420. */
  subsampling: number;
  /** Flexbits trimmed, 0 to 15; dropped with alpha, as Flash drops them. */
  trimFlexBits: number;
}

/**
 * `pixels`, `width` by `height` of them in rows from the top, each a
 * 0xAARRGGBB (BGRA in memory), as a JPEG XR file, as Flash's
 * BitmapData.encode writes one; a RangeError if the options are out of
 * range or the module cannot have the memory.
 */
export function jxrEncode(
  pixels: Uint32Array,
  width: number,
  height: number,
  options: JxrEncodeOptions,
): Uint8Array {
  const { alpha, quantization, subsampling, trimFlexBits } = options;
  if (pixels.length !== width * height) {
    throw new RangeError(`${pixels.length} pixels are no ${width} by ${height}`);
  }

  if (
    !(width >= 1 && width <= 65536 && height >= 1 && height <= 65536) ||
    !(Number.isInteger(quantization) && quantization >= 0 && quantization <= 100) ||
    !(Number.isInteger(trimFlexBits) && trimFlexBits >= 0 && trimFlexBits <= 15) ||
    (subsampling !== JXR_444 && subsampling !== JXR_422 && subsampling !== JXR_420)
  ) {
    throw new RangeError(
      `no JPEG XR of ${width} by ${height} pixels with ${JSON.stringify(options)}`,
    );
  }

  const bytes = kept.call((x) => {
    x.reset();
    // Before the encoder's own allocations, so that its output, the last, grows in place.
    const band = x.alloc(width * 16 * 4);
    if (band === 0) {
      return null;
    }

    if (
      x.encodeBegin(width, height, alpha ? 1 : 0, quantization, subsampling, trimFlexBits) !== 0
    ) {
      return null;
    }

    for (let y = 0; y < height; y += 16) {
      const lines = Math.min(16, height - y);
      new Uint32Array(x.memory.buffer, band, width * lines).set(
        pixels.subarray(y * width, (y + lines) * width),
      );
      if (x.encodeRows(band, lines) !== 0) {
        return null;
      }
    }

    if (x.encodeEnd() !== 0) {
      return null;
    }

    return new Uint8Array(x.memory.buffer, x.resultPointer(), x.resultSize()).slice();
  });
  if (bytes === null) {
    kept.drop();
    throw new RangeError(`no memory to encode ${width} by ${height} pixels as JPEG XR`);
  }

  return bytes;
}
