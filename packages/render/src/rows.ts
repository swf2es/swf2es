/**
 * Floats a row: an object's transform on the stage and its colour
 * transform, four texels of a float texture. The linear part; the
 * translation; the multipliers; the offsets, over 255.
 */
export const ROW_FLOATS = 16;
/** Rows a line of the rows' texture. */
export const ROWS_A_LINE = 256;
/**
 * Floats of a span from which Rows.append copies through a view: below
 * it, copying by index costs less than making the view.
 */
const SPAN_VIEW_FLOATS = 4 * ROW_FLOATS;

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

    // A short span by index, as a view to copy from would be an allocation each span; a long one
    // through the view, which copies it much faster.
    const source = from.data;
    const data = this.data;
    const start = first * ROW_FLOATS;
    const last = end * ROW_FLOATS;
    if (last - start < SPAN_VIEW_FLOATS) {
      for (let i = start, to = row * ROW_FLOATS; i < last; i++, to++) {
        data[to] = source[i];
      }
    } else {
      data.set(source.subarray(start, last), row * ROW_FLOATS);
    }

    return row;
  }

  /**
   * A row for the transform at `places[at]`, a b c d tx ty: numbers a
   * caller keeps in a typed array, so that none are boxed passing them.
   */
  addPlaced(places: Float64Array, at: number, ct: ColorRow | null): number {
    // Written here, not passed to add, which would box them where it is not inlined.
    const row = this.next();
    const out = this.data;
    const to = row * ROW_FLOATS;
    out[to] = places[at];
    out[to + 1] = places[at + 1];
    out[to + 2] = places[at + 2];
    out[to + 3] = places[at + 3];
    out[to + 4] = places[at + 4];
    out[to + 5] = places[at + 5];
    this.color(to, ct);
    return row;
  }

  /** A row for the translation of the transform at `places[at]` alone. */
  addTranslated(places: Float64Array, at: number, ct: ColorRow | null): number {
    const row = this.next();
    const out = this.data;
    const to = row * ROW_FLOATS;
    out[to] = 1;
    out[to + 1] = 0;
    out[to + 2] = 0;
    out[to + 3] = 1;
    out[to + 4] = places[at + 4];
    out[to + 5] = places[at + 5];
    this.color(to, ct);
    return row;
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
    const row = this.next();
    const out = this.data;
    const at = row * ROW_FLOATS;
    out[at] = a;
    out[at + 1] = b;
    out[at + 2] = c;
    out[at + 3] = d;
    out[at + 4] = tx;
    out[at + 5] = ty;
    this.color(at, ct);
    return row;
  }

  /** A row taken, the store grown for it: its index. */
  private next(): number {
    const row = this.count++;
    if (this.count * ROW_FLOATS > this.data.length) {
      const grown = new Float32Array(this.data.length * 2);
      grown.set(this.data);
      this.data = grown;
    }

    return row;
  }

  /** The row at `data[at]` coloured by `ct`, or by nothing where it is null. */
  private color(at: number, ct: ColorRow | null): void {
    const out = this.data;
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
