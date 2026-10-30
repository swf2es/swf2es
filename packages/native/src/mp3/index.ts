// The compiled module is shared; each extraction has its own small decoder state.
import { decodeBase64 } from "../base64.js";
import { binary } from "./binary.js";

interface Exports {
  memory: WebAssembly.Memory;
  input(): number;
  output(): number;
  decode(length: number): number;
  channels(): number;
  rate(): number;
}

let compiled: WebAssembly.Module | null = null;
let preparing: Promise<void> | null = null;

/**
 * Compile before scripts run; the decoder itself is instantiated only on
 * demand. Never rejects: an engine that cannot compile the module leaves
 * MP3 decoding unavailable (mp3Available) rather than failing every load.
 */
export function prepareMp3(): Promise<void> {
  preparing ??= WebAssembly.compile(decodeBase64(binary)).then(
    (module) => {
      compiled = module;
    },
    () => {},
  );

  return preparing;
}

/** Whether prepareMp3 compiled the decoder, so an Mp3Decoder can be made. */
export function mp3Available(): boolean {
  return compiled !== null;
}

/** A sequence of whole MP3 frames. PCM is overwritten by the next read, and must be copied out. */
export class Mp3Decoder {
  private readonly wasm: Exports;
  private readonly input: Uint8Array;
  readonly pcm: Float32Array;

  constructor() {
    if (!compiled) {
      throw new Error("prepareMp3 must finish before decoding");
    }

    this.wasm = new WebAssembly.Instance(compiled).exports as unknown as Exports;
    this.input = new Uint8Array(this.wasm.memory.buffer, this.wasm.input(), 4096);
    this.pcm = new Float32Array(this.wasm.memory.buffer, this.wasm.output(), 2304);
  }

  /** Decode one whole frame, keeping its bit reservoir and synthesis state for the next. */
  read(bytes: Uint8Array): number {
    if (bytes.length > this.input.length) {
      return 0;
    }

    this.input.set(bytes);
    return this.wasm.decode(bytes.length);
  }

  get channels(): number {
    return this.wasm.channels();
  }

  get rate(): number {
    return this.wasm.rate();
  }
}
