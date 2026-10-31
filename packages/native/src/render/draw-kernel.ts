// BitmapData.draw of a bitmap in the normal blend mode, in the render
// module (draw.zig), one call a draw. Each draw copies into the module's
// input the rows of the source it reads and the destination's area, and
// the area back out after: no source is kept between draws, which costs no
// more than keeping them did for a game drawing hundreds of small bitmaps
// a frame, and holds nothing for them. Its own instance, so that the
// filters' calls (BitmapKernel) do not reset its input, let go of when its
// owner says it went idle, and after a draw that grew it past KEEP_BYTES.
import { renderInstance } from "./module.js";

interface DrawExports {
  memory: WebAssembly.Memory;
  resetArena(bytes: number): number;
  drawPixels(params: number): number;
  compositePixels(params: number): number;
}

/**
 * A draw, which its caller keeps and fills for each: the source's pixels
 * and size and the rows it reads, the destination's pixels (read only) and
 * width and the area drawn, and the numbers draw.zig takes.
 */
export interface DrawJob {
  source: Uint32Array;
  sourceWidth: number;
  sourceHeight: number;
  /** The first row the draw reads, and how many. */
  sourceTop: number;
  sourceRows: number;
  into: Uint32Array;
  intoWidth: number;
  x: number;
  y: number;
  width: number;
  height: number;
  /** composite's, unscaled at whole pixels (tx, ty), rather than drawBitmap's through the matrix. */
  moved: boolean;
  /** The matrix's inverse: a, b, c, d, tx, ty. */
  inverse: Float64Array;
  /** The prepared colour transform, multipliers in 256ths then offsets, red, green, blue, alpha. */
  transform: Float64Array;
  tx: number;
  ty: number;
  flags: number;
}

/** draw.zig's flags. */
export const DRAW_SMOOTH = 1;
export const DRAW_TRANSFORM = 2;
export const DRAW_OPAQUE = 4;
export const DRAW_SKIP_ZERO_ALPHA = 8;

// draw.zig's results.
const INVALID = 0;
const WRITTEN = 2;
/** draw.zig's DrawParams: 14 doubles, then 14 words. */
const PARAMS = 168;
/** The most a draw copies in, its source's rows and its area; a larger one is drawn by the caller. */
const DRAWN_BYTES = 32 << 20;
/** The input a new instance takes first. */
const FIRST_BYTES = 1 << 20;
/** The memory an instance keeps after a draw; past it, the instance is let go of. */
const KEEP_BYTES = 16 << 20;

/**
 * What a draw did: refused, where the module could not take it and the
 * caller draws it itself; drew nothing; or wrote the area, which `writeBack`
 * then copies into the store.
 */
export type DrawResult = "refused" | "untouched" | "written";

export class DrawKernel {
  private wasm: DrawExports | null = null;
  /** Whether making an instance failed once, after which the module is never tried again. */
  private broken = false;
  /** The input resetArena gave, and its bytes. */
  private input = 0;
  private inputBytes = 0;
  private buffer: ArrayBuffer | null = null;
  private words = new Uint32Array(0);
  private doubles = new Float64Array(0);
  private ints = new Int32Array(0);
  /** Where the last draw's area lies in the input. */
  private area = 0;
  /** Whether the module drew since `idle` last asked. */
  private busy = false;
  /** How many draws the module took. */
  drawn = 0;

  /** A job to fill for each draw. */
  static job(): DrawJob {
    return {
      source: new Uint32Array(0),
      sourceWidth: 0,
      sourceHeight: 0,
      sourceTop: 0,
      sourceRows: 0,
      into: new Uint32Array(0),
      intoWidth: 0,
      x: 0,
      y: 0,
      width: 0,
      height: 0,
      moved: false,
      inverse: new Float64Array(6),
      transform: new Float64Array(8),
      tx: 0,
      ty: 0,
      flags: 0,
    };
  }

  /** Whether an instance is held, with its memory. */
  get held(): boolean {
    return this.wasm !== null;
  }

  /** The job drawn in the module; never a write to the destination, which `writeBack` makes. */
  draw(job: DrawJob): DrawResult {
    try {
      return this.run(job);
    } catch {
      // A trap: never resume that instance.
      this.release();
      return "refused";
    }
  }

  /** The area the last draw wrote, copied into `into`. */
  writeBack(job: DrawJob, into: Uint32Array): void {
    const { x, y, width: w, height: h, intoWidth } = job;
    const base = this.area >> 2;
    this.refresh();
    const words = this.words;
    for (let row = 0; row < h; row++) {
      const at = base + row * w;
      into.set(words.subarray(at, at + w), (y + row) * intoWidth + x);
    }
  }

  /** Whether the module drew nothing since this was last asked. */
  idle(): boolean {
    const idle = !this.busy;
    this.busy = false;
    return idle;
  }

  /** The instance let go of, and its memory with it; the next draw makes another. */
  release(): void {
    this.wasm = null;
    this.buffer = null;
    this.words = new Uint32Array(0);
    this.doubles = new Float64Array(0);
    this.ints = new Int32Array(0);
    this.input = 0;
    this.inputBytes = 0;
  }

  private run(job: DrawJob): DrawResult {
    const { sourceWidth: sw, sourceRows: rows, width: w, height: h } = job;
    const sourceBytes = sw * rows * 4;
    const areaBytes = w * h * 4;
    if (
      job.source.length !== sw * job.sourceHeight ||
      sourceBytes + areaBytes > DRAWN_BYTES ||
      !this.room(PARAMS + sourceBytes + areaBytes)
    ) {
      return "refused";
    }

    const wasm = this.wasm as DrawExports;
    this.refresh();
    const { words, doubles, ints } = this;
    const p = this.input;
    const src = p + PARAMS;
    this.area = src + sourceBytes;
    const top = job.sourceTop * sw;
    words.set(job.source.subarray(top, top + rows * sw), src >> 2);

    const base = this.area >> 2;
    const { into, intoWidth, x, y } = job;
    for (let row = 0; row < h; row++) {
      const at = (y + row) * intoWidth + x;
      words.set(into.subarray(at, at + w), base + row * w);
    }

    const d = p >> 3;
    doubles.set(job.inverse, d);
    doubles.set(job.transform, d + 6);
    const i = (p + 112) >> 2;
    words[i] = src;
    words[i + 1] = sw;
    words[i + 2] = job.sourceHeight;
    words[i + 3] = this.area;
    ints[i + 4] = x;
    ints[i + 5] = y;
    words[i + 6] = w;
    words[i + 7] = h;
    words[i + 8] = job.flags;
    ints[i + 9] = job.tx;
    ints[i + 10] = job.ty;
    words[i + 11] = job.sourceTop;
    words[i + 12] = rows;
    words[i + 13] = 0;
    const result = job.moved ? wasm.compositePixels(p) : wasm.drawPixels(p);
    if (result === INVALID) {
      return "refused";
    }

    this.drawn++;
    this.busy = true;
    return result === WRITTEN ? "written" : "untouched";
  }

  /**
   * Whether the input holds `bytes`: an instance made where there is none,
   * one grown past KEEP_BYTES made anew, and the input taken anew where it
   * is smaller.
   */
  private room(bytes: number): boolean {
    if (this.broken) {
      return false;
    }

    // Grown past what it keeps by a large draw before, it goes, and its memory with it.
    if (this.wasm && this.wasm.memory.buffer.byteLength > KEEP_BYTES) {
      this.release();
    }

    if (this.wasm && this.inputBytes >= bytes) {
      return true;
    }

    if (!this.wasm) {
      try {
        this.wasm = renderInstance(() => {
          throw new Error("the draw kernel takes no tessellator");
        }) as unknown as DrawExports;
      } catch {
        this.broken = true;
        return false;
      }
    }

    // Half again what is asked, so that a few larger draws do not each take it anew.
    const want = Math.max(FIRST_BYTES, bytes + (bytes >> 1));
    this.input = this.wasm.resetArena(want);
    if (!this.input) {
      // Out of memory: the instance goes, and the next draw that fits makes another.
      this.release();
      return false;
    }

    this.inputBytes = want;
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
