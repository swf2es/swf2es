/** Dense within the action block; preceding SWF bytes cost space only when reached. */
@final
export class Offsets {
  private local: StaticArray<i32>;
  private before: Map<i32, i32> | null = null;

  constructor(length: i32) {
    this.local = new StaticArray<i32>(length);
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

    before.set(offset, value);
  }
}
