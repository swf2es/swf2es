// Compressed texture uploads, one whole level at a time in dxt.zig. The
// input is kept between levels and grown only as needed; the result is a
// view to consume before the next call, as context3d's TS encoder gives.
import { renderInstance } from "./module.js";

interface DxtExports {
  memory: WebAssembly.Memory;
  resetArena(bytes: number): number;
  encodeDxt(
    source: number,
    destination: number,
    width: number,
    height: number,
    alpha: number,
  ): number;
}

/** Enough to keep a 2048² DXT5 upload's input and output, including growth slack. */
const KEEP_BYTES = 32 << 20;
const FIRST_BYTES = 64 << 10;

export class DxtEncoder {
  private wasm: DxtExports | null = null;
  private broken = false;
  private input = 0;
  private inputBytes = 0;
  /** Successful native encodes, so a reference comparison can rule out falling back. */
  encoded = 0;

  /** The memory kept now: a larger level's instance goes before the next call. */
  get capacity(): number {
    return this.wasm?.memory.buffer.byteLength ?? 0;
  }

  /** Release the instance and its memory; the next level makes another. */
  release(): void {
    this.wasm = null;
    this.input = 0;
    this.inputBytes = 0;
  }

  /**
   * Top-down RGBA to DXT1 or DXT5, matching the TS encoder's blocks. The
   * result stays valid until the next call; null leaves the level to TS.
   */
  encode = (rgba: Uint8Array, dxt5: boolean, width: number, height: number): Uint8Array | null => {
    if (
      !Number.isInteger(width) ||
      !Number.isInteger(height) ||
      width <= 0 ||
      height <= 0 ||
      width > 4096 ||
      height > 4096 ||
      rgba.length !== width * height * 4
    ) {
      return null;
    }

    try {
      // A caller may use an earlier result as a smaller level's input. Preserve it if growth
      // detaches that view, or a large earlier level causes its instance to be replaced.
      if (this.wasm && rgba.buffer === this.wasm.memory.buffer) {
        rgba = rgba.slice();
      }

      const length = Math.ceil(width / 4) * Math.ceil(height / 4) * (dxt5 ? 16 : 8);
      if (!this.room(rgba.length + length)) {
        return null;
      }

      const wasm = this.wasm as DxtExports;
      const destination = this.input + rgba.length;
      new Uint8Array(wasm.memory.buffer, this.input, rgba.length).set(rgba);
      if (!wasm.encodeDxt(this.input, destination, width, height, dxt5 ? 1 : 0)) {
        return null;
      }

      this.encoded++;
      return new Uint8Array(wasm.memory.buffer, destination, length);
    } catch {
      // A trapped instance is never resumed, and a refused module leaves the TS path available.
      this.release();
      return null;
    }
  };

  private room(bytes: number): boolean {
    if (this.broken) {
      return false;
    }

    if (this.wasm && this.wasm.memory.buffer.byteLength > KEEP_BYTES) {
      this.release();
    }

    if (this.wasm && this.inputBytes >= bytes) {
      return true;
    }

    if (!this.wasm) {
      try {
        this.wasm = renderInstance(() => {
          throw new Error("the DXT encoder takes no tessellator");
        }) as unknown as DxtExports;
      } catch {
        this.broken = true;
        return false;
      }
    }

    const want = Math.max(FIRST_BYTES, bytes + Math.floor(bytes / 2));
    this.input = this.wasm.resetArena(want);
    if (!this.input) {
      this.release();
      return false;
    }

    this.inputBytes = want;
    return true;
  }
}
