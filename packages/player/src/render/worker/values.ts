// Typed numeric records share the frame's Float64 storage. Strings preserve
// UTF-16 code units, including lone surrogates used by ActionScript strings.
export class ValuesWriter {
  constructor(
    readonly data: Float64Array,
    public at: number,
  ) {}

  number(value: number): void {
    if (this.at >= this.data.length) {
      throw new RangeError("scene snapshot exceeds its slot capacity");
    }

    this.data[this.at++] = value;
  }

  string(value: string): void {
    this.number(value.length);
    for (let i = 0; i < value.length; i++) {
      this.number(value.charCodeAt(i));
    }
  }
}

export class ValuesReader {
  constructor(
    readonly data: Float64Array,
    public at: number,
  ) {}

  number(): number {
    if (this.at >= this.data.length) {
      throw new Error("truncated scene snapshot content");
    }

    return this.data[this.at++];
  }

  integer(min: number, max: number): number {
    const value = this.number();
    if (!Number.isSafeInteger(value) || value < min || value > max) {
      throw new Error("invalid scene snapshot content value");
    }

    return value;
  }

  boolean(): boolean {
    return !!this.integer(0, 1);
  }

  count(): number {
    return this.integer(0, this.data.length - this.at - 1);
  }

  string(): string {
    const length = this.count();
    const chunks: string[] = [];
    let chunk = "";
    for (let i = 0; i < length; i++) {
      chunk += String.fromCharCode(this.integer(0, 65535));
      if (chunk.length === 1024) {
        chunks.push(chunk);
        chunk = "";
      }
    }

    chunks.push(chunk);
    return chunks.join("");
  }
}
