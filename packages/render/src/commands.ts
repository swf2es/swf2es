/** Clear the target to a colour: params red, green, blue, alpha. */
export const CLEAR = 1;
/** Draw the scene list's entries from `a`, `b` of them, under blend mode `c`. */
export const RUN = 2;

/**
 * What a frame asks of the backend, in order: each operation an opcode and
 * three integers, with the floats some take apart.
 */
export class Commands {
  ops = new Int32Array(256);
  params = new Float32Array(64);
  length = 0;
  paramLength = 0;

  reset(): void {
    this.length = 0;
    this.paramLength = 0;
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
