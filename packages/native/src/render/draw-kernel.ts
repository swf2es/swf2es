// BitmapData.draw of a bitmap in the normal blend mode, in the render
// module (draw.zig), one call a draw. A source's pixels are copied into the
// module once and kept there while its store keeps its version, so a
// bitmap drawn hundreds of times a frame crosses into Wasm once: the call
// itself. The destination's area is copied in before the call and back out
// after it, rows only as wide as the area, which is all a draw reads and
// writes of it. Its own instance, so that what it keeps is not reset by
// the filters' calls (BitmapKernel).
import { renderInstance } from "./module.js";

interface DrawExports {
  memory: WebAssembly.Memory;
  resetArena(bytes: number): number;
  alloc(bytes: number): number;
  drawPixels(params: number): number;
  compositePixels(params: number): number;
}

/** A bitmap drawn: its pixels, which are the same while `version` and the array are. */
export interface DrawSource {
  /** What the module keeps the pixels by: the store, held weakly. */
  key: object;
  version: number;
  width: number;
  height: number;
  /** Premultiplied ARGB, in row order. */
  pixels: Uint32Array;
}

/** The destination's area of a draw, within its store. */
export interface DrawArea {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * A draw's numbers: the matrix's inverse (a, b, c, d, tx, ty), or the
 * whole pixel composite moves by in tx and ty; the prepared colour
 * transform, multipliers in 256ths then offsets, red, green, blue, alpha,
 * or null; and draw.zig's flags.
 */
export interface DrawValues {
  inverse: readonly number[];
  tx: number;
  ty: number;
  transform: readonly number[] | null;
  smooth: boolean;
  opaque: boolean;
  skipZeroAlpha: boolean;
}

// draw.zig's flags and results.
const SMOOTH = 1;
const TRANSFORM = 2;
const OPAQUE = 4;
const SKIP_ZERO_ALPHA = 8;
const INVALID = 0;
const WRITTEN = 2;
/** draw.zig's DrawParams: 14 doubles, then 12 words. */
const PARAMS = 160;

/**
 * What the module holds at most, the sources it keeps and the areas' scratch:
 * past it, everything is let go of and what a draw needs copied in again.
 */
const HELD_BYTES = 48 << 20;
/** The largest source or area a draw takes in the module; a larger one is drawn by the caller. */
const DRAWN_BYTES = 16 << 20;

/** A source the module holds: as of its store's version and array, `bytes` at `at`. */
interface Kept {
  generation: number;
  version: number;
  pixels: Uint32Array;
  bytes: number;
  at: number;
}

/**
 * What a draw did: refused, where the module could not take it and the
 * caller draws it itself; drew nothing; or wrote the area, which `writeBack`
 * then copies into the store.
 */
export type DrawResult = "refused" | "untouched" | "written";

export class DrawKernel {
  private wasm: DrawExports | null = null;
  /** Counts each reset of the module's memory, which lets go of every source kept. */
  private generation = 0;
  private readonly kept = new WeakMap<object, Kept>();
  /** What the module holds since its memory was last reset. */
  private held = 0;
  private params = 0;
  private scratch = 0;
  private scratchBytes = 0;
  private buffer: ArrayBuffer | null = null;
  private words = new Uint32Array(0);
  private doubles = new Float64Array(0);
  private ints = new Int32Array(0);

  /**
   * `source` drawn into `area` of `dst` (`dstWidth` wide, read only), by
   * drawBitmap's path through the matrix, or by composite's where `moved`.
   */
  draw(
    source: DrawSource,
    dst: Uint32Array,
    dstWidth: number,
    area: DrawArea,
    values: DrawValues,
    moved: boolean,
  ): DrawResult {
    try {
      return this.run(source, dst, dstWidth, area, values, moved);
    } catch {
      // A trap: never resume that instance, nor what it kept.
      this.dispose();
      return "refused";
    }
  }

  /** The area the last draw wrote, copied into `into` (`width` wide). */
  writeBack(into: Uint32Array, width: number, area: DrawArea): void {
    const { x, y, width: w, height: h } = area;
    const base = this.scratch >> 2;
    this.refresh();
    const words = this.words;
    for (let row = 0; row < h; row++) {
      const at = base + row * w;
      into.set(words.subarray(at, at + w), (y + row) * width + x);
    }
  }

  dispose(): void {
    this.wasm = null;
    this.buffer = null;
    this.generation++;
  }

  private run(
    source: DrawSource,
    dst: Uint32Array,
    dstWidth: number,
    area: DrawArea,
    values: DrawValues,
    moved: boolean,
  ): DrawResult {
    const sourceBytes = source.width * source.height * 4;
    const areaBytes = area.width * area.height * 4;
    if (sourceBytes > DRAWN_BYTES || areaBytes > DRAWN_BYTES) {
      return "refused";
    }

    let wasm = this.wasm ?? this.start();
    if (!wasm) {
      return "refused";
    }

    let src = this.sourceAt(wasm, source);
    if (!src || !this.room(wasm, areaBytes)) {
      // Full: everything let go of, and the draw's own taken again.
      const fresh = this.reset(wasm);
      if (!fresh) {
        return "refused";
      }

      wasm = fresh;
      src = this.sourceAt(wasm, source);
      if (!src || !this.room(wasm, areaBytes)) {
        return "refused";
      }
    }

    this.refresh();
    const { words, doubles, ints } = this;
    const { x, y, width: w, height: h } = area;
    const base = this.scratch >> 2;
    for (let row = 0; row < h; row++) {
      const at = (y + row) * dstWidth + x;
      words.set(dst.subarray(at, at + w), base + row * w);
    }

    const p = this.params;
    const d = p >> 3;
    const inverse = values.inverse;
    for (let k = 0; k < 6; k++) {
      doubles[d + k] = moved ? 0 : inverse[k];
    }

    const transform = values.transform;
    for (let k = 0; k < 8; k++) {
      doubles[d + 6 + k] = transform ? transform[k] : 0;
    }

    const i = (p + 112) >> 2;
    words[i] = src;
    words[i + 1] = source.width;
    words[i + 2] = source.height;
    words[i + 3] = this.scratch;
    ints[i + 4] = x;
    ints[i + 5] = y;
    words[i + 6] = w;
    words[i + 7] = h;
    words[i + 8] =
      (values.smooth ? SMOOTH : 0) |
      (transform ? TRANSFORM : 0) |
      (values.opaque ? OPAQUE : 0) |
      (values.skipZeroAlpha ? SKIP_ZERO_ALPHA : 0);
    ints[i + 9] = values.tx;
    ints[i + 10] = values.ty;
    words[i + 11] = 0;
    const result = moved ? wasm.compositePixels(p) : wasm.drawPixels(p);
    if (result === INVALID) {
      return "refused";
    }

    return result === WRITTEN ? "written" : "untouched";
  }

  /** A new instance, its params taken. */
  private start(): DrawExports | null {
    try {
      this.wasm = renderInstance(() => {
        throw new Error("the draw kernel takes no tessellator");
      }) as unknown as DrawExports;
    } catch {
      return null;
    }

    return this.reset(this.wasm);
  }

  /** The module's memory let go of, every source with it, and the params taken again. */
  private reset(wasm: DrawExports): DrawExports | null {
    this.generation++;
    this.held = 0;
    this.scratch = 0;
    this.scratchBytes = 0;
    this.params = wasm.resetArena(PARAMS);
    return this.params ? wasm : null;
  }

  /** Where the module holds `source`'s pixels, copied in if it holds them not as they are; 0 where it is full. */
  private sourceAt(wasm: DrawExports, source: DrawSource): number {
    const bytes = source.pixels.length * 4;
    const known = this.kept.get(source.key);
    if (known && known.generation === this.generation && known.bytes === bytes) {
      if (known.version !== source.version || known.pixels !== source.pixels) {
        // Changed, as a bitmap drawn into every frame is: copied again into its place.
        this.refresh();
        this.words.set(source.pixels, known.at >> 2);
        known.version = source.version;
        known.pixels = source.pixels;
      }

      return known.at;
    }

    if (this.held + bytes > HELD_BYTES) {
      return 0;
    }

    const at = wasm.alloc(bytes);
    if (!at) {
      return 0;
    }

    this.held += bytes;
    this.refresh();
    this.words.set(source.pixels, at >> 2);
    this.kept.set(source.key, {
      generation: this.generation,
      version: source.version,
      pixels: source.pixels,
      bytes,
      at,
    });
    return at;
  }

  /** Whether the scratch holds `bytes`, taken anew where it is smaller. */
  private room(wasm: DrawExports, bytes: number): boolean {
    if (this.scratchBytes >= bytes) {
      return true;
    }

    // Twice what is asked of a small one, so that a few larger areas do not each take one.
    const want = bytes < 1 << 20 ? Math.max(bytes * 2, 64 << 10) : bytes;
    if (this.held + want > HELD_BYTES) {
      return false;
    }

    const at = wasm.alloc(want);
    if (!at) {
      return false;
    }

    this.held += want;
    this.scratch = at;
    this.scratchBytes = want;
    return true;
  }

  /** The views of the memory made again where it grew, which detached them. */
  private refresh(): void {
    const buffer = (this.wasm as DrawExports).memory.buffer;
    if (buffer !== this.buffer) {
      this.buffer = buffer;
      this.words = new Uint32Array(buffer);
      this.doubles = new Float64Array(buffer);
      this.ints = new Int32Array(buffer);
    }
  }
}
