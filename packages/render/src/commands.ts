/** Clear the target to a colour: params red, green, blue, alpha. */
export const CLEAR = 1;
/** Draw the scene list's entries from `a`, `b` of them, under blend mode `c`. */
export const RUN = 2;
/**
 * A mask: entries from `a`, `b` of them, drawn into the stencil, where what
 * follows is drawn; and taken out again, the same entries, once it is.
 */
export const STENCIL_PUSH = 3;
export const STENCIL_POP = 4;
/**
 * A layer begun, drawn into a target of its own over the rectangle of the
 * target whose x, y, width and height are params from `a`, `b` 1 where
 * filters will read it past that rectangle, which is then clear too; and
 * composited onto the one below in blend mode `a`, coloured by row `b`
 * (or -1), its output kept as kept output `c` (Keeps), or not (-1).
 */
export const LAYER_PUSH = 5;
export const LAYER_POP = 6;
/** The filters of chain `a` of the frame's filter list run over the layer drawn into, in turn. */
export const FILTER = 7;
/**
 * A kept output (Keeps) composited again onto the target drawn into, in
 * blend mode `b`, coloured by row `c` (or -1): its rectangle's x, y, width
 * and height, then its id, are params from `a`.
 */
export const COMPOSITE = 8;
/**
 * A filtered layer drawn ahead of the stage (plan), its draws, masks and
 * held layers' composites the operations between: begun over the
 * rectangle of params from `a`, its output held as held output `b`, at
 * level `c`, one past the deepest held layer in it; ended with chain `a`
 * of the frame's filters run over it, held output `b`. Held layers come
 * before the stage's CLEAR, a level's after those it holds, and the
 * backend draws a level's side by side, their passes too.
 */
export const HOLD_PUSH = 9;
export const HOLD_POP = 10;
/** Held output `a` composited onto the target drawn into, in blend mode `b`, coloured by row `c` (or -1). */
export const HELD = 11;

/**
 * What a frame asks of the backend, in order: each operation an opcode and
 * three integers, with the floats some take apart.
 */
export class Commands {
  ops = new Int32Array(256);
  params = new Float32Array(64);
  length = 0;
  paramLength = 0;
  /**
   * Whether a layer is composited onto the target itself in erase or alpha,
   * which leaves it less than opaque where it covers, as adl clears the
   * stage, for the blends after it to read.
   */
  clearsTarget = false;

  reset(): void {
    this.length = 0;
    this.paramLength = 0;
    this.clearsTarget = false;
  }

  push(op: number, a = 0, b = 0, c = 0): void {
    if ((this.length + 1) * 4 > this.ops.length) {
      const grown = new Int32Array(this.ops.length * 2);
      grown.set(this.ops);
      this.ops = grown;
    }

    const at = this.length++ * 4;
    this.ops[at] = op;
    this.ops[at + 1] = a;
    this.ops[at + 2] = b;
    this.ops[at + 3] = c;
  }

  /** Floats for the operation pushed next, where it reads them from. */
  param(...values: number[]): number {
    const at = this.paramLength;
    if (at + values.length > this.params.length) {
      const grown = new Float32Array(Math.max(this.params.length * 2, at + values.length));
      grown.set(this.params);
      this.params = grown;
    }

    this.params.set(values, at);
    this.paramLength += values.length;
    return at;
  }
}
