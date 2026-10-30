// One kept instance of a module that imports nothing, for compress and atf:
// the module compiled from its base64 the first time it is called, an
// instance made as needed, and let go after a call that threw, or whose
// memory grew past MEMORY_KEPT, since memory never shrinks.
import { decodeBase64 } from "./base64.js";

/**
 * Memory an instance may keep between calls: what a bitmap or a SWF of a
 * few MB needs, less than an LZMA encoder's for a dictionary of 1 MB.
 * Starting again costs an instantiation, a fraction of a millisecond.
 */
export const MEMORY_KEPT = 8 << 20;

export class KeptInstance<Exports extends { memory: WebAssembly.Memory }> {
  private readonly binary: string;
  private compiled: WebAssembly.Module | null = null;
  private instance: Exports | null = null;

  constructor(binary: string) {
    this.binary = binary;
  }

  /**
   * Run `f` on the instance, made first if there is none (the module
   * compiled synchronously the first time: some 100 KB, which browsers
   * allow on the main thread).
   */
  call<T>(f: (x: Exports) => T): T {
    this.compiled ??= new WebAssembly.Module(decodeBase64(this.binary));
    this.instance ??= new WebAssembly.Instance(this.compiled).exports as unknown as Exports;
    const x = this.instance;
    try {
      return f(x);
    } catch (e) {
      this.instance = null;
      throw e;
    } finally {
      if (x.memory.buffer.byteLength > MEMORY_KEPT) {
        this.instance = null;
      }
    }
  }

  /** Let the instance go, so that the next call starts a new one. */
  drop(): void {
    this.instance = null;
  }

  /** The instance's memory now, for measuring: 0 when none is kept. */
  get memory(): number {
    return this.instance ? this.instance.memory.buffer.byteLength : 0;
  }
}
