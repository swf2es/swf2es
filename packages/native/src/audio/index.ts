// SWF's ADPCM and Nellymoser sound, decoded synchronously in one module
// that imports nothing (src/audio/root.zig), kept as compress's is: each
// call copies its input into the module's memory, decodes there in an
// arena reset first, and copies the samples out. A Nellymoser stream's
// state stays here between its calls, copied in and out with each.
import { KeptInstance } from "../instance.js";
import { binary } from "./binary.js";

interface Exports {
  memory: WebAssembly.Memory;
  reset(): void;
  alloc(n: number): number;
  resultPointer(): number;
  decodeAdpcm(input: number, length: number, channels: number): number;
  nellymoserStateSize(): number;
  nellymoserStart(state: number): void;
  decodeNellymoser(input: number, length: number, state: number): number;
}

const kept = new KeptInstance<Exports>(binary);

/** `data` in the module's memory, after a reset; 0 if it does not fit. */
function input(x: Exports, data: Uint8Array): number {
  x.reset();
  const at = x.alloc(data.length);
  if (at !== 0) {
    new Uint8Array(x.memory.buffer, at, data.length).set(data);
  }

  return at;
}

/**
 * SWF's ADPCM as 16-bit samples, channels interleaved: a code size, then
 * packets of a header per channel (a 16-bit sample and a 6-bit step index)
 * and 4095 codes, the header's sample the packet's first, as adl gives it
 * (Ruffle's decoder leaves it out). It ends where the bits do; none where
 * the module cannot have the memory.
 */
export function decodeAdpcm(data: Uint8Array, channels: 1 | 2): Int16Array {
  return kept.call((x) => {
    const at = input(x, data);
    const n = at === 0 ? -1 : x.decodeAdpcm(at, data.length, channels);
    return n <= 0
      ? new Int16Array(0)
      : new Int16Array(x.memory.buffer, x.resultPointer(), n).slice();
  });
}

/** The samples a Nellymoser block decodes to. */
export const NELLYMOSER_SAMPLES = 256;

/** Nellymoser's blocks into samples, the overlap carried from one call to the next, as a stream's blocks need. */
export class NellymoserDecoder {
  /** The stream's state as the module keeps it, made at the first call. */
  #state: Uint8Array | null = null;

  /**
   * `data`'s whole 64-byte blocks as samples from -1 to 1, 256 a block;
   * none where the module cannot have the memory, the stream's state then
   * as it was.
   */
  decode(data: Uint8Array): Float32Array {
    return kept.call((x) => {
      x.reset();
      const size = x.nellymoserStateSize();
      const state = x.alloc(size);
      if (state === 0) {
        return new Float32Array(0);
      }

      if (this.#state) {
        new Uint8Array(x.memory.buffer, state, size).set(this.#state);
      } else {
        x.nellymoserStart(state);
      }

      const at = x.alloc(data.length);
      if (at === 0) {
        return new Float32Array(0);
      }

      new Uint8Array(x.memory.buffer, at, data.length).set(data);
      const n = x.decodeNellymoser(at, data.length, state);
      if (n < 0) {
        return new Float32Array(0);
      }

      this.#state = new Uint8Array(x.memory.buffer, state, size).slice();
      return new Float32Array(x.memory.buffer, x.resultPointer(), n).slice();
    });
  }
}
