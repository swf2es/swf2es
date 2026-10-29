import { renderInstance } from "./module.js";

export interface BitmapSource {
  width: number;
  height: number;
  transparent: boolean;
  /** Premultiplied ARGB, in row order. */
  pixels: Uint32Array;
}

export interface BitmapRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ConvolutionFilter {
  matrixX: number;
  matrixY: number;
  matrix: readonly number[];
  divisor: number;
  bias: number;
  color: number;
  alpha: number;
  clamp: boolean;
  preserveAlpha: boolean;
}

interface NativeExports {
  memory: WebAssembly.Memory;
  resetArena(bytes: number): number;
  convolve(params: number): number;
}

export interface ConvolverOptions {
  /** Drop instances larger than this after a call; defaults to 8 MiB, at most 128 MiB. */
  retainMemory?: number;
}

// Params.flags in convolve.zig.
const FLAG_CLAMP = 1;
const FLAG_SOURCE_TRANSPARENT = 2;
const FLAG_PRESERVE_ALPHA = 4;
const FLAG_PREMULTIPLY = 8;

// About what one call's input block and output hold: a large rect is
// convolved a band of rows at a time, so that its scratch stays far under
// retainMemory's default and the instance is kept rather than regrown.
const BAND_BYTES = 1 << 20;

/** One playback's bounded scratch. Results own their buffers; rejection leaves the source untouched. */
export class Convolver {
  private instance: NativeExports | null = null;
  private unavailable = false;
  private readonly keep: number;

  constructor(options: ConvolverOptions = {}) {
    this.keep = options.retainMemory ?? 8 << 20;
    if (!Number.isInteger(this.keep) || this.keep < 0 || this.keep > 128 << 20) {
      throw new RangeError("invalid convolution memory limit");
    }
  }

  get capacity(): number {
    return this.instance?.memory.buffer.byteLength ?? 0;
  }

  dispose(): void {
    this.instance = null;
  }

  /** Caller writes the owned output, or uses JS if this returns null. Never writes to the source. */
  readonly convolve = (
    source: BitmapSource,
    area: BitmapRect,
    filter: ConvolutionFilter,
    transparent: boolean,
  ): Uint32Array | null => {
    if (this.unavailable) {
      return null;
    }

    const { width: sw, height: sh } = source;
    const { x, y, width: w, height: h } = area;
    const cols = filter.matrixX;
    const rows = filter.matrixY;
    if (
      ![sw, sh, x, y, w, h, cols, rows].every(Number.isInteger) ||
      sw <= 0 ||
      sh <= 0 ||
      sw > 0x3fffffff ||
      sh > 0x3fffffff ||
      source.pixels.length !== sw * sh ||
      Math.abs(x) > 0x3fffffff ||
      Math.abs(y) > 0x3fffffff ||
      w <= 0 ||
      h <= 0 ||
      w > 0x100000 ||
      h > 0x100000 ||
      cols <= 0 ||
      rows <= 0 ||
      cols > 15 ||
      rows > 15
    ) {
      return null;
    }

    const clampX = (v: number) => Math.max(0, Math.min(sw - 1, v));
    const clampY = (v: number) => Math.max(0, Math.min(sh - 1, v));
    const x0 = clampX(x - (cols >> 1));
    const nw = clampX(x + w + cols - (cols >> 1) - 2) - x0 + 1;
    // Each band's output rows read its rows of the source and the kernel's
    // reach above and below them, which the next band copies again.
    const band = Math.max(1, Math.min(h, Math.floor(BAND_BYTES / ((nw + w) * 4))));
    const nhMax = Math.min(band + rows - 1, sh);
    const matrixOffset = Math.ceil((96 + nw * nhMax * 4) / 8) * 8;
    const inputMax = matrixOffset + cols * rows * 8;
    // Leave room for the stack and alignment before reserving any native input;
    // the kernel's planes hold at most 16 lines.
    if (
      !Number.isSafeInteger(inputMax) ||
      inputMax + (16 * nw + 1) * 16 + w * 32 + w * band * 4 > 127 * 1024 * 1024
    ) {
      return null;
    }

    let result: Uint32Array;
    try {
      result = new Uint32Array(w * h);
    } catch {
      return null;
    }

    try {
      if (!this.instance) {
        try {
          // An instance of the render module of its own, whose memory no fill or line shares.
          this.instance = renderInstance(() => {
            throw new Error("the bitmap kernel takes no tessellator");
          }) as unknown as NativeExports;
        } catch {
          // A missing Wasm engine or a CSP refusal is tried only once per owner.
          this.unavailable = true;
          return null;
        }
      }

      const wasm = this.instance;
      const flags =
        (filter.clamp ? FLAG_CLAMP : 0) |
        (source.transparent ? FLAG_SOURCE_TRANSPARENT : 0) |
        (filter.preserveAlpha ? FLAG_PRESERVE_ALPHA : 0) |
        (transparent ? FLAG_PREMULTIPLY : 0);
      for (let top = 0; top < h; top += band) {
        const bandY = y + top;
        const bandH = Math.min(band, h - top);
        const y0 = clampY(bandY - (rows >> 1));
        const nh = clampY(bandY + bandH + rows - (rows >> 1) - 2) - y0 + 1;
        const offset = Math.ceil((96 + nw * nh * 4) / 8) * 8;
        const pointer = wasm.resetArena(offset + cols * rows * 8);
        if (!pointer) {
          return null;
        }

        const pixelPointer = pointer + 96;
        const matrixPointer = pointer + offset;
        new Int32Array(wasm.memory.buffer, pointer, 16).set([
          sw,
          sh,
          x,
          bandY,
          w,
          bandH,
          x0,
          y0,
          nw,
          nh,
          cols,
          rows,
          flags,
          pixelPointer,
          matrixPointer,
          0,
        ]);
        new Float64Array(wasm.memory.buffer, pointer + 64, 2).set([
          filter.divisor || 1,
          filter.bias,
        ]);
        new Int32Array(wasm.memory.buffer, pointer + 80, 2).set([
          Math.floor(filter.alpha * 255) | 0,
          filter.color | 0,
        ]);

        const into = new Uint32Array(wasm.memory.buffer, pixelPointer, nw * nh);
        for (let row = 0; row < nh; row++) {
          into.set(
            source.pixels.subarray((y0 + row) * sw + x0, (y0 + row) * sw + x0 + nw),
            row * nw,
          );
        }

        const matrix = new Float64Array(wasm.memory.buffer, matrixPointer, cols * rows);
        for (let k = 0; k < matrix.length; k++) {
          matrix[k] = filter.matrix[k] || 0;
        }

        const out = wasm.convolve(pointer);
        if (!out) {
          // An ordinary allocation rejection can reuse its arena on a later call.
          return null;
        }

        // The kernel can grow memory; construct this view afterwards and copy before scratch reuse.
        result.set(new Uint32Array(wasm.memory.buffer, out, w * bandH), top * w);
      }

      return result;
    } catch {
      this.dispose();
      return null;
    } finally {
      if (this.capacity > this.keep) {
        this.dispose();
      }
    }
  };
}
