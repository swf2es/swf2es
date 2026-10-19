/** Dense within the action block; preceding SWF bytes cost space only when reached. */
@final
export class Offsets {
  private local: StaticArray<i32>;
  private before: Map<i32, i32> | null = null;
  private touched: i32[] = [];

  constructor(length: i32) {
    this.local = new StaticArray<i32>(length);
  }

  reset(length: i32): void {
    if (length > this.local.length) {
      this.local = new StaticArray<i32>(max(length, this.local.length * 2));
    } else {
      memory.fill(changetype<usize>(this.local), 0, <usize>length * sizeof<i32>());
    }

    // Map.clear allocates new storage, so reset only the entries the last block touched.
    const before = this.before;
    if (before !== null) {
      for (let i = 0; i < this.touched.length; i++) {
        before.set(this.touched[i], 0);
      }
    }

    this.touched.length = 0;
  }

  @inline
  get(offset: i32): i32 {
    if (offset >= 0) {
      return this.local[offset];
    }

    const before = this.before;
    if (before === null) {
      return 0;
    }

    return before.has(offset) ? before.get(offset) : 0;
  }

  @inline
  set(offset: i32, value: i32): void {
    if (offset >= 0) {
      this.local[offset] = value;
      return;
    }

    let before = this.before;
    if (before === null) {
      before = new Map<i32, i32>();
      this.before = before;
    }

    if (!before.has(offset) || before.get(offset) === 0) {
      this.touched.push(offset);
    }

    before.set(offset, value);
  }
}
