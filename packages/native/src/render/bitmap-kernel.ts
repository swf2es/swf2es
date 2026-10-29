import { renderInstance, renderModule } from "./module.js";

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

/**
 * A glow's, a drop shadow's, a bevel's or a gradient glow's or bevel's
 * values, as the player keeps them (alphas in 255ths, strength in 256ths),
 * and what the layer reads: `invert`, 255 less the source's alpha, as an
 * inner glow blurs what the source leaves; a gradient filter's 256
 * premultiplied colours.
 */
export interface LayerFilter {
  kind: "glow" | "dropShadow" | "bevel" | "gradientGlow" | "gradientBevel";
  inner: boolean;
  knockout: boolean;
  hideObject: boolean;
  /** A bevel's or a gradient filter's: "inner", "outer" or "full". */
  type: string;
  invert: boolean;
  quality: number;
  blurX: number;
  blurY: number;
  strength: number;
  alpha: number;
  highlightAlpha: number;
  shadowAlpha: number;
  color: number;
  highlightColor: number;
  shadowColor: number;
  table: Uint32Array | null;
}

/** A read of the blurred block `read` at each pixel of the layer, moved by (x, y). */
export interface LayerMove {
  read: number;
  x: number;
  y: number;
}

interface NativeExports {
  memory: WebAssembly.Memory;
  resetArena(bytes: number): number;
  convolve(params: number): number;
  blurFilter(params: number): number;
  layerFilter(params: number): number;
}

// blur.zig's Kind and Flags.
const KINDS = ["glow", "dropShadow", "bevel", "gradientGlow", "gradientBevel"];
const LAYER_INNER = 1;
const LAYER_KNOCKOUT = 2;
const LAYER_HIDE_OBJECT = 4;
const LAYER_TYPE_INNER = 8;
const LAYER_TYPE_OUTER = 16;
const LAYER_INVERT = 32;
/** blur.zig's LayerParams, and a gradient's table after it. */
const LAYER_PARAMS = 176;
const TABLE_BYTES = 1024;

/** What a call's input and scratch may take of the module's 128 MiB, the stack's room left. */
const MOST_BYTES = 120 * 1024 * 1024;

/** Whether `area` is a rect the kernels take: whole, of some size, within an int's reach. */
function takes(area: BitmapRect): boolean {
  const { x, y, width: w, height: h } = area;
  return (
    [x, y, w, h].every(Number.isInteger) &&
    w > 0 &&
    h > 0 &&
    Math.abs(x) <= 0x3fffffff &&
    Math.abs(y) <= 0x3fffffff &&
    w <= 0x100000 &&
    h <= 0x100000
  );
}

/** `area` of the source into `into`, row by row; 0 past the bitmap. */
function copy(source: BitmapSource, area: BitmapRect, into: Uint32Array): void {
  const { width: sw, height: sh, pixels } = source;
  const x0 = Math.max(0, area.x);
  const y0 = Math.max(0, area.y);
  const x1 = Math.min(sw, area.x + area.width);
  const y1 = Math.min(sh, area.y + area.height);
  if (x0 > area.x || y0 > area.y || x1 < area.x + area.width || y1 < area.y + area.height) {
    into.fill(0);
  }

  for (let sy = y0; sy < y1 && x1 > x0; sy++) {
    into.set(pixels.subarray(sy * sw + x0, sy * sw + x1), (sy - area.y) * area.width + x0 - area.x);
  }
}

export interface BitmapKernelOptions {
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

/**
 * BitmapData's CPU filters in the render module: a convolution
 * (convolve.zig), and a blur, a glow, a drop shadow, a bevel and a gradient
 * glow or bevel (blur.zig), on one instance, its scratch bounded. It
 * compiles the render module as it is made, and throws where the host
 * refuses it. Results own their buffers; rejection leaves the source
 * untouched.
 */
export class BitmapKernel {
  private instance: NativeExports | null = null;
  private readonly keep: number;

  constructor(options: BitmapKernelOptions = {}) {
    this.keep = options.retainMemory ?? 8 << 20;
    if (!Number.isInteger(this.keep) || this.keep < 0 || this.keep > 128 << 20) {
      throw new RangeError("invalid bitmap kernel memory limit");
    }

    renderModule();
  }

  get capacity(): number {
    return this.instance?.memory.buffer.byteLength ?? 0;
  }

  dispose(): void {
    this.instance = null;
  }

  /**
   * The convolved pixels, owned by the caller, or null where they would not
   * fit; where the instance traps, the call is made again in a new one
   * once. Never writes to the source.
   */
  readonly convolve = (
    source: BitmapSource,
    area: BitmapRect,
    filter: ConvolutionFilter,
    transparent: boolean,
  ): Uint32Array | null => this.run(source, area, filter, transparent, true);

  /** convolve, made again in a new instance where this one traps if `again`. */
  private run(
    source: BitmapSource,
    area: BitmapRect,
    filter: ConvolutionFilter,
    transparent: boolean,
    again: boolean,
  ): Uint32Array | null {
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
      // A trap: never resume that instance; the call once more in a new one.
      this.dispose();
      return again ? this.run(source, area, filter, transparent, false) : null;
    } finally {
      if (this.capacity > this.keep) {
        this.dispose();
      }
    }
  }

  /**
   * The blur filter over `area` of the source, 0 past the bitmap: its
   * premultiplied channels blurred apart (blur.zig), owned by the caller;
   * null where they would not fit. A trap is made again in a new instance
   * once. Never writes to the source.
   */
  readonly blur = (
    source: BitmapSource,
    area: BitmapRect,
    blurX: number,
    blurY: number,
    quality: number,
  ): Uint32Array | null => {
    const n = area.width * area.height;
    if (!takes(area) || !(quality >= 0 && quality <= 15) || n * 6 + area.width * 8 > MOST_BYTES) {
      return null;
    }

    return this.call((wasm) => {
      const pointer = wasm.resetArena(32 + n * 4);
      if (!pointer) {
        return null;
      }

      new Int32Array(wasm.memory.buffer, pointer, 4).set([
        area.width,
        area.height,
        quality | 0,
        pointer + 32,
      ]);
      new Float64Array(wasm.memory.buffer, pointer + 16, 2).set([blurX, blurY]);
      copy(source, area, new Uint32Array(wasm.memory.buffer, pointer + 32, n));
      const out = wasm.blurFilter(pointer);
      return out ? new Uint32Array(wasm.memory.buffer.slice(out, out + n * 4)) : null;
    }, true);
  };

  /**
   * A glow's, a shadow's, a bevel's or a gradient one's result over `area`
   * of the source (blur.zig): the alpha of each of `reads`, blocks of the
   * source, blurred, each of `moves` read from its block, and the layer
   * placed on the source's pixels; owned by the caller, null where they
   * would not fit. A trap is made again in a new instance once. Never
   * writes to the source.
   */
  readonly layer = (
    source: BitmapSource,
    area: BitmapRect,
    f: LayerFilter,
    reads: readonly BitmapRect[],
    moves: readonly LayerMove[],
  ): Uint32Array | null => {
    const kind = KINDS.indexOf(f.kind);
    const n = area.width * area.height;
    const read = reads.reduce((sum, r) => sum + r.width * r.height, 0);
    if (
      kind < 0 ||
      !takes(area) ||
      !reads.every(takes) ||
      reads.length < 1 ||
      reads.length > 2 ||
      moves.length < 1 ||
      moves.length > 2 ||
      !(f.quality >= 0 && f.quality <= 15) ||
      (f.table !== null && f.table.length !== 256) ||
      n * (4 + moves.length) + read * 6 + area.width * 24 > MOST_BYTES
    ) {
      return null;
    }

    return this.call((wasm) => {
      const pointer = wasm.resetArena(LAYER_PARAMS + TABLE_BYTES + (n + read) * 4);
      if (!pointer) {
        return null;
      }

      const buffer = wasm.memory.buffer;
      const table = pointer + LAYER_PARAMS;
      const pixels = table + TABLE_BYTES;
      const flags =
        (f.inner ? LAYER_INNER : 0) |
        (f.knockout ? LAYER_KNOCKOUT : 0) |
        (f.hideObject ? LAYER_HIDE_OBJECT : 0) |
        (f.type === "inner" ? LAYER_TYPE_INNER : 0) |
        (f.type === "outer" ? LAYER_TYPE_OUTER : 0) |
        (f.invert ? LAYER_INVERT : 0);
      const ints = new Int32Array(buffer, pointer, LAYER_PARAMS / 4);
      ints.fill(0);
      ints.set([
        kind,
        flags,
        area.width,
        area.height,
        pixels,
        f.quality | 0,
        reads.length,
        moves.length,
      ]);
      let at = pixels + n * 4;
      for (const [k, r] of reads.entries()) {
        ints.set([at, r.width, r.height], 8 + k * 4);
        copy(source, r, new Uint32Array(buffer, at, r.width * r.height));
        at += r.width * r.height * 4;
      }

      const floats = new Float64Array(buffer, pointer, LAYER_PARAMS / 8);
      for (const [k, m] of moves.entries()) {
        ints[16 + k * 6] = m.read;
        floats[9 + k * 3] = m.x;
        floats[10 + k * 3] = m.y;
      }

      floats.set([f.blurX, f.blurY, f.strength, f.alpha, f.highlightAlpha, f.shadowAlpha], 14);
      ints.set([f.color, f.highlightColor, f.shadowColor, table], 40);
      if (f.table) {
        new Uint32Array(buffer, table, 256).set(f.table);
      }

      copy(source, area, new Uint32Array(buffer, pixels, n));
      const out = wasm.layerFilter(pointer);
      return out ? new Uint32Array(wasm.memory.buffer.slice(out, out + n * 4)) : null;
    }, true);
  };

  /** `body` on the instance, made where there is none: made again in a new one where it traps if `again`. */
  private call(
    body: (wasm: NativeExports) => Uint32Array | null,
    again: boolean,
  ): Uint32Array | null {
    try {
      if (!this.instance) {
        try {
          this.instance = renderInstance(() => {
            throw new Error("the bitmap kernel takes no tessellator");
          }) as unknown as NativeExports;
        } catch {
          return null;
        }
      }

      return body(this.instance);
    } catch {
      // A trap: never resume that instance.
      this.dispose();
      return again ? this.call(body, false) : null;
    } finally {
      if (this.capacity > this.keep) {
        this.dispose();
      }
    }
  }
}
