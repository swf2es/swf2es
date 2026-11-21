/**
 * Floats a row: an object's transform on the stage and its colour
 * transform, four texels of a float texture. The linear part; the
 * translation; the multipliers; the offsets, over 255.
 */
export const ROW_FLOATS = 16;
/** Rows a line of the rows' texture. */
export const ROWS_A_LINE = 256;

/** The rows of a frame's draws, written in order and uploaded together. */
export class Rows {
  data = new Float32Array(ROWS_A_LINE * ROW_FLOATS);
  count = 0;

  /** Written from the first row again, as a frame starts. */
  reset(): void {
    this.count = 0;
  }

  /** The rows from `count` on taken off, as rows written only to be compared are. */
  truncate(count: number): void {
    this.count = count;
  }

  /** Rows `first` to `end` of `from` written after these, as they were: the index of the first. */
  append(from: Rows, first: number, end: number): number {
    const row = this.count;
    this.count += end - first;
    if (this.count * ROW_FLOATS > this.data.length) {
      let length = this.data.length * 2;
      while (this.count * ROW_FLOATS > length) {
        length *= 2;
      }

      const grown = new Float32Array(length);
      grown.set(this.data.subarray(0, row * ROW_FLOATS));
      this.data = grown;
    }

    // By index, as a view to copy from would be an allocation each span.
    const source = from.data;
    const data = this.data;
    const last = end * ROW_FLOATS;
    for (let i = first * ROW_FLOATS, to = row * ROW_FLOATS; i < last; i++, to++) {
      data[to] = source[i];
    }

    return row;
  }

  /**
   * A row for the transform at `places[at]`, a b c d tx ty: numbers a
   * caller keeps in a typed array, so that none are boxed passing them.
   */
  addPlaced(places: Float64Array, at: number, ct: ColorRow | null): number {
    return this.add(
      places[at],
      places[at + 1],
      places[at + 2],
      places[at + 3],
      places[at + 4],
      places[at + 5],
      ct,
    );
  }

  /** A row for the translation of the transform at `places[at]` alone. */
  addTranslated(places: Float64Array, at: number, ct: ColorRow | null): number {
    return this.add(1, 0, 0, 1, places[at + 4], places[at + 5], ct);
  }

  /**
   * A row for the transform `m` and, unless null, the colour transform's
   * multipliers and offsets `ct`: its index.
   */
  add(
    a: number,
    b: number,
    c: number,
    d: number,
    tx: number,
    ty: number,
    ct: ColorRow | null,
  ): number {
    const row = this.count++;
    if (this.count * ROW_FLOATS > this.data.length) {
      const grown = new Float32Array(this.data.length * 2);
      grown.set(this.data);
      this.data = grown;
    }

    const out = this.data;
    const at = row * ROW_FLOATS;
    out[at] = a;
    out[at + 1] = b;
    out[at + 2] = c;
    out[at + 3] = d;
    out[at + 4] = tx;
    out[at + 5] = ty;
    out[at + 6] = 0;
    out[at + 7] = 0;
    out[at + 8] = ct ? ct.rMul : 1;
    out[at + 9] = ct ? ct.gMul : 1;
    out[at + 10] = ct ? ct.bMul : 1;
    out[at + 11] = ct ? ct.aMul : 1;
    out[at + 12] = ct ? ct.rAdd / 255 : 0;
    out[at + 13] = ct ? ct.gAdd / 255 : 0;
    out[at + 14] = ct ? ct.bAdd / 255 : 0;
    out[at + 15] = ct ? ct.aAdd / 255 : 0;
    return row;
  }
}

/** A colour transform as Flash gives one: multipliers, and offsets from -255 to 255. */
export interface ColorRow {
  rMul: number;
  gMul: number;
  bMul: number;
  aMul: number;
  rAdd: number;
  gAdd: number;
  bAdd: number;
  aAdd: number;
}
