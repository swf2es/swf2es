/**
 * Dense over the code a compile mostly reaches, the block's own bytes;
 * other SWF bytes, before or past them, cost space only when reached.
 */
@final
export class Offsets {
  private local: StaticArray<i32>;
  private dense: i32 = 0;
  private outside: Map<i32, i32> | null = null;
  private touched: i32[] = [];

  constructor(length: i32) {
    this.local = new StaticArray<i32>(length);
    this.dense = length;
  }

  reset(length: i32): void {
    if (length > this.local.length) {
      this.local = new StaticArray<i32>(max(length, this.local.length * 2));
    } else {
      memory.fill(changetype<usize>(this.local), 0, <usize>length * sizeof<i32>());
    }

    this.dense = length;
    // Map.clear allocates new storage, so reset only the entries the last block touched.
    const outside = this.outside;
    if (outside !== null) {
      for (let i = 0; i < this.touched.length; i++) {
        outside.set(this.touched[i], 0);
      }
    }

    this.touched.length = 0;
  }

  @inline
  get(offset: i32): i32 {
    if (<u32>offset < <u32>this.dense) {
      return this.local[offset];
    }

    const outside = this.outside;
    if (outside === null) {
      return 0;
    }

    return outside.has(offset) ? outside.get(offset) : 0;
  }

  @inline
  set(offset: i32, value: i32): void {
    if (<u32>offset < <u32>this.dense) {
      this.local[offset] = value;
      return;
    }

    let outside = this.outside;
    if (outside === null) {
      outside = new Map<i32, i32>();
      this.outside = outside;
    }

    if (!outside.has(offset) || outside.get(offset) === 0) {
      this.touched.push(offset);
    }

    outside.set(offset, value);
  }
}
