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
 * values, as the player keeps them: blurs 0 to 255 or NaN, quality 0 to 15,
 * strength 0 to 255, alphas 0 to 1, colours of 24 bits; others are refused.
 * `invert` reads 255 less the source's alpha, as an inner glow blurs what
 * the source leaves; `table` is a gradient filter's 256 premultiplied
 * colours.
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

/**
 * What a tile's input and scratch take at most, so that a filter over a
 * large bitmap keeps its instance under retainMemory's default; a tile
 * whose filter reaches far may take up to MOST_TILE_BYTES rather than be
 * mostly reach.
 */
const TILE_BYTES = 4 << 20;
const MOST_TILE_BYTES = 64 << 20;
/** The arena's header an allocation, its alignment and the stack's room, with some to spare. */
const SLACK = 64 << 10;

/**
 * Whether `area` is a rect blur.zig takes: whole, of some size. It never
 * sees where the rect lies, which the blocks copied in hold.
 */
function sized(area: BitmapRect): boolean {
  const { x, y, width: w, height: h } = area;
  return (
    Number.isSafeInteger(x) &&
    Number.isSafeInteger(y) &&
    Number.isInteger(w) &&
    Number.isInteger(h) &&
    w > 0 &&
    h > 0 &&
    w <= 0x100000 &&
    h <= 0x100000
  );
}

/** A blur as the player keeps it: 0 to 255, or NaN, which blurs nothing. */
function blurry(v: number): boolean {
  return Number.isNaN(v) || (v >= 0 && v <= 255);
}

const unit = (v: number) => v >= 0 && v <= 1;
const rgb = (v: number) => Number.isInteger(v) && v >= 0 && v <= 0xffffff;

/** How far `quality` runs of a blur reach, each way: each half its box, whole taps. */
function reach(blur: number, quality: number): number {
  return quality * Math.ceil((blur || 0) / 2);
}

/** The bytes a run's line buffer and sums take over a plane `w` wide (blur.zig's blur). */
function runBytes(w: number, blurX: number, blurY: number): number {
  const line = blurX > 1 ? (w + 2 * Math.ceil(blurX / 2) + 3) * 4 : 0;
  return line + (blurY > 1 ? w * 4 : 0);
}

/**
 * How far `rects` move alike so that, where all lie wholly past the bitmap
 * on one side, they lie just past it: [x, y]. As far out as the player lets
 * a rect lie, past the kernels' bounds, they read there what they read
 * there, the bitmap's edge or nothing.
 */
function inward(source: BitmapSource, rects: readonly BitmapRect[]): [number, number] {
  const along = (lo: number, hi: number, length: number) =>
    hi <= 0 ? -hi : lo >= length ? length - lo : 0;
  return [
    along(
      Math.min(...rects.map((r) => r.x)),
      Math.max(...rects.map((r) => r.x + r.width)),
      source.width,
    ),
    along(
      Math.min(...rects.map((r) => r.y)),
      Math.max(...rects.map((r) => r.y + r.height)),
      source.height,
    ),
  ];
}

/** `rect` moved by (dx, dy). */
const moved = (rect: BitmapRect, [dx, dy]: readonly number[]): BitmapRect => ({
  ...rect,
  x: rect.x + dx,
  y: rect.y + dy,
});

/**
 * `area` in tiles of up to `side` pixels a side, `bytes` of a tile `w` by
 * `h` within TILE_BYTES where its reach lets it: tiles four times the reach
 * wide at least, up to MOST_TILE_BYTES. Null where even the least does not
 * fit the module.
 */
function tiles(
  area: BitmapRect,
  far: number,
  bytes: (w: number, h: number) => number,
): BitmapRect[] | null {
  const of = (side: number) => bytes(Math.min(side, area.width), Math.min(side, area.height));
  let side = Math.max(area.width, area.height);
  while (side > 16 && of(side) > TILE_BYTES && (side > 4 * far || of(side) > MOST_TILE_BYTES)) {
    side = Math.ceil(side / 2);
  }

  if (!(of(side) + SLACK <= MOST_BYTES)) {
    return null;
  }

  const out: BitmapRect[] = [];
  for (let y = 0; y < area.height; y += side) {
    for (let x = 0; x < area.width; x += side) {
      out.push({
        x: area.x + x,
        y: area.y + y,
        width: Math.min(side, area.width - x),
        height: Math.min(side, area.height - y),
      });
    }
  }

  return out;
}

/** What a call's input and scratch may take of the module's 128 MiB, the stack's and statics' room left. */
const MOST_BYTES = 120 * 1024 * 1024;

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

/** The alpha of `area` of the source into `into`, a byte a pixel; 0 past the bitmap. */
function copyAlpha(source: BitmapSource, area: BitmapRect, into: Uint8Array): void {
  const { width: sw, height: sh, pixels } = source;
  const x0 = Math.max(0, area.x);
  const y0 = Math.max(0, area.y);
  const x1 = Math.min(sw, area.x + area.width);
  const y1 = Math.min(sh, area.y + area.height);
  if (x0 > area.x || y0 > area.y || x1 < area.x + area.width || y1 < area.y + area.height) {
    into.fill(0);
  }

  for (let sy = y0; sy < y1 && x1 > x0; sy++) {
    let o = (sy - area.y) * area.width + x0 - area.x;
    const end = sy * sw + x1;
    for (let i = sy * sw + x0; i < end; i++) {
      into[o++] = pixels[i] >>> 24;
    }
  }
}

/** A read of the blurred block `read` at each pixel of a layer's tile, moved by (x, y). */
interface Move {
  read: number;
  x: number;
  y: number;
}

/**
 * The blocks of the source a layer over `area` blurs the alpha of, and its
 * reads of them, moved by each of `offsets`: blurred once over where they
 * all read and as far round it as the blur reaches (hx, hy), as a bevel
 * reads on and back; reads further apart than `area` is wide or high, each
 * over its own, so that a block is `area`'s size wherever the offset takes
 * it. As the player's JS read them.
 */
function alphaReads(
  area: BitmapRect,
  hx: number,
  hy: number,
  offsets: readonly (readonly [number, number])[],
): { reads: BitmapRect[]; moves: Move[] } {
  const kxs = offsets.map(([dx]) => Math.floor(dx));
  const kys = offsets.map(([, dy]) => Math.floor(dy));
  const x0 = Math.min(...kxs);
  const y0 = Math.min(...kys);
  const spanX = Math.max(...kxs) - x0;
  const spanY = Math.max(...kys) - y0;
  if (offsets.length > 1 && (spanX > area.width || spanY > area.height)) {
    const each = offsets.map((offset) => alphaReads(area, hx, hy, [offset]));
    return {
      reads: each.map(({ reads }) => reads[0]),
      moves: each.map(({ moves }, k) => ({ ...moves[0], read: k })),
    };
  }

  return {
    reads: [
      {
        x: area.x + x0 - hx,
        y: area.y + y0 - hy,
        width: area.width + 1 + spanX + 2 * hx,
        height: area.height + 1 + spanY + 2 * hy,
      },
    ],
    moves: offsets.map(([dx, dy], i) => ({
      read: 0,
      x: hx + (kxs[i] - x0) + (dx - kxs[i]),
      y: hy + (kys[i] - y0) + (dy - kys[i]),
    })),
  };
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
    const cols = filter.matrixX;
    const rows = filter.matrixY;
    // Wholly past the kernel's reach of the bitmap, every tap reads alike, the nearest edge's or
    // the filter's colour, wherever the rect is.
    const [dx, dy] = inward(source, [
      {
        x: area.x - cols,
        y: area.y - rows,
        width: area.width + 2 * cols,
        height: area.height + 2 * rows,
      },
    ]);
    const { x, y, width: w, height: h } = moved(area, [dx, dy]);
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
   * null where the values are not the player's or the pixels would not fit.
   * Large rects are filtered in tiles, each read as far round as the blur
   * reaches. A trap is made again in a new instance once. Never writes to
   * the source.
   */
  readonly blur = (
    source: BitmapSource,
    area: BitmapRect,
    blurX: number,
    blurY: number,
    quality: number,
  ): Uint32Array | null => {
    if (
      !sized(area) ||
      !blurry(blurX) ||
      !blurry(blurY) ||
      !(Number.isInteger(quality) && quality >= 0 && quality <= 15)
    ) {
      return null;
    }

    const hx = reach(blurX, quality);
    const hy = reach(blurY, quality);
    const blockBytes = (w: number, h: number) => {
      const bw = w + 2 * hx;
      const n = bw * (h + 2 * hy);
      return 32 + n * 6 + runBytes(bw, blurX, blurY);
    };
    const parts = tiles(area, Math.max(hx, hy), blockBytes);
    if (!parts) {
      return null;
    }

    const result = new Uint32Array(area.width * area.height);
    return this.call((wasm) => {
      for (const t of parts) {
        const block = {
          x: t.x - hx,
          y: t.y - hy,
          width: t.width + 2 * hx,
          height: t.height + 2 * hy,
        };
        const n = block.width * block.height;
        const pointer = wasm.resetArena(32 + n * 4);
        if (!pointer) {
          return null;
        }

        new Int32Array(wasm.memory.buffer, pointer, 4).set([
          block.width,
          block.height,
          quality,
          pointer + 32,
        ]);
        new Float64Array(wasm.memory.buffer, pointer + 16, 2).set([blurX, blurY]);
        copy(source, block, new Uint32Array(wasm.memory.buffer, pointer + 32, n));
        const out = wasm.blurFilter(pointer);
        if (!out) {
          return null;
        }

        // The tile's rows of its block, past the reach round it.
        const blurred = new Uint32Array(wasm.memory.buffer, out, n);
        for (let row = 0; row < t.height; row++) {
          const from = (row + hy) * block.width + hx;
          result.set(
            blurred.subarray(from, from + t.width),
            (t.y - area.y + row) * area.width + t.x - area.x,
          );
        }
      }

      return result;
    }, true);
  };

  /**
   * A glow's, a shadow's, a bevel's or a gradient one's result over `area`
   * of the source (blur.zig), read from the source moved by each of
   * `offsets` (one, or two for a bevel, on and back): the alpha of blocks of
   * the source blurred, read there, and the layer placed on the source's
   * pixels; owned by the caller, null where the values are not the player's
   * or the pixels would not fit. Large rects are filtered in tiles. A trap
   * is made again in a new instance once. Never writes to the source.
   */
  readonly layer = (
    source: BitmapSource,
    area: BitmapRect,
    f: LayerFilter,
    offsets: readonly (readonly [number, number])[],
  ): Uint32Array | null => {
    const kind = KINDS.indexOf(f.kind);
    const bevel = f.kind === "bevel" || f.kind === "gradientBevel";
    if (
      kind < 0 ||
      !sized(area) ||
      offsets.length !== (bevel ? 2 : 1) ||
      !offsets.every(([x, y]) => Math.abs(x) < 2 ** 31 && Math.abs(y) < 2 ** 31) ||
      !(Number.isInteger(f.quality) && f.quality >= 0 && f.quality <= 15) ||
      !blurry(f.blurX) ||
      !blurry(f.blurY) ||
      !(f.strength >= 0 && f.strength <= 255) ||
      !unit(f.alpha) ||
      !unit(f.highlightAlpha) ||
      !unit(f.shadowAlpha) ||
      !rgb(f.color) ||
      !rgb(f.highlightColor) ||
      !rgb(f.shadowColor) ||
      (f.table !== null && f.table.length !== 256)
    ) {
      return null;
    }

    const hx = reach(f.blurX, f.quality);
    const hy = reach(f.blurY, f.quality);
    // A tile's pixels, its blocks' alpha and their scratch, and its reads' planes and columns.
    const tileBytes = (w: number, h: number) => {
      const { reads } = alphaReads({ x: 0, y: 0, width: w, height: h }, hx, hy, offsets);
      const read = reads.reduce(
        (sum, r) => sum + r.width * r.height * 2 + runBytes(r.width, f.blurX, f.blurY),
        0,
      );
      return LAYER_PARAMS + TABLE_BYTES + w * h * 4 + read + offsets.length * (w * h + w * 16);
    };
    const parts = tiles(area, Math.max(hx, hy), tileBytes);
    if (!parts) {
      return null;
    }

    const flags =
      (f.inner ? LAYER_INNER : 0) |
      (f.knockout ? LAYER_KNOCKOUT : 0) |
      (f.hideObject ? LAYER_HIDE_OBJECT : 0) |
      (f.type === "inner" ? LAYER_TYPE_INNER : 0) |
      (f.type === "outer" ? LAYER_TYPE_OUTER : 0) |
      (f.invert ? LAYER_INVERT : 0);
    const result = new Uint32Array(area.width * area.height);
    return this.call((wasm) => {
      for (const t of parts) {
        const { reads, moves } = alphaReads(t, hx, hy, offsets);
        const n = t.width * t.height;
        const alpha = reads.reduce((sum, r) => sum + r.width * r.height, 0);
        const pointer = wasm.resetArena(LAYER_PARAMS + TABLE_BYTES + n * 4 + alpha);
        if (!pointer) {
          return null;
        }

        const buffer = wasm.memory.buffer;
        const table = pointer + LAYER_PARAMS;
        const pixels = table + TABLE_BYTES;
        const ints = new Int32Array(buffer, pointer, LAYER_PARAMS / 4);
        ints.fill(0);
        ints.set([kind, flags, t.width, t.height, pixels, f.quality, reads.length, moves.length]);
        let at = pixels + n * 4;
        for (const [k, r] of reads.entries()) {
          ints.set([at, r.width, r.height], 8 + k * 4);
          copyAlpha(source, r, new Uint8Array(buffer, at, r.width * r.height));
          at += r.width * r.height;
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

        copy(source, t, new Uint32Array(buffer, pixels, n));
        const out = wasm.layerFilter(pointer);
        if (!out) {
          return null;
        }

        const placed = new Uint32Array(wasm.memory.buffer, out, n);
        for (let row = 0; row < t.height; row++) {
          result.set(
            placed.subarray(row * t.width, (row + 1) * t.width),
            (t.y - area.y + row) * area.width + t.x - area.x,
          );
        }
      }

      return result;
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
