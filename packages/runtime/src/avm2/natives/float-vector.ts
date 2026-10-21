import type { AsObject } from "../descriptors.js";
import type { Runtime } from "../runtime.js";

/** Float identity belongs to the vector; only values leaving it need a tag. */
export class FloatVector {
  data: Float32Array;
  private count: number;

  constructor(length = 0) {
    this.data = new Float32Array(length);
    this.count = length;
  }

  get length(): number {
    return this.count;
  }

  set length(length: number) {
    if (length === 0) {
      this.data = new Float32Array(0);
    } else if (length > this.count) {
      this.reserve(length);
      this.data.fill(0, this.count, length);
    }

    this.count = length;
  }

  private reserve(length: number): void {
    if (length <= this.data.length) {
      return;
    }

    const data = new Float32Array(
      Math.max(length, this.data.length + Math.max(this.data.length >>> 1, 8)),
    );
    data.set(this.data.subarray(0, this.count));
    this.data = data;
  }

  push(value: number): number {
    this.reserve(this.count + 1);
    this.data[this.count++] = value;
    return this.count;
  }

  pop(): number | undefined {
    return this.count ? this.data[--this.count] : undefined;
  }

  shift(): number | undefined {
    if (!this.count) {
      return undefined;
    }

    const value = this.data[0];
    this.data.copyWithin(0, 1, this.count--);
    return value;
  }

  unshift(...items: number[]): number {
    const count = items.length;
    this.reserve(this.count + count);
    this.data.copyWithin(count, 0, this.count);
    this.data.set(items);
    this.count += count;
    return this.count;
  }

  splice(start: number, remove: number, ...items: number[]): number[] {
    const at = start < 0 ? Math.max(0, this.count + start) : Math.min(start, this.count);
    const deleted = Math.min(Math.max(remove, 0), this.count - at);
    const result = Array.from(this.data.subarray(at, at + deleted));
    const length = this.count - deleted + items.length;
    this.reserve(length);
    this.data.copyWithin(at + items.length, at + deleted, this.count);
    this.data.set(items, at);
    this.count = length;
    return result;
  }

  reverse(): void {
    this.data.subarray(0, this.count).reverse();
  }
}

/** Conversion precedes this check: valueOf may change the vector's size or fixedness. */
export function setFloatElement(rt: Runtime, o: AsObject, i: number, value: number): void {
  const a: FloatVector = o.$a;
  if (i > a.length || (i === a.length && o.$fixed)) {
    throw rt.error("RangeError", 1125, i, a.length);
  }

  if (i === a.length) {
    a.push(value);
  } else {
    a.data[i] = value;
  }
}
