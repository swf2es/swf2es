// A source map, version 3, from the ABC's debugfile and debugline
// instructions: where the module's code for each AS3 line starts. The
// method emitter marks the output as it writes it, in order; the map then
// finds each mark's line and column in the module by walking its bytes once.
import { ConstantPool } from "../abc/pool";
import { Output } from "./output";

const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

@final
export class SourceMap {
  /** Each mark: the module offset its code starts at, its file (a string of the pool) and its line. */
  offset: u32[] = [];
  file: i32[] = [];
  line: u32[] = [];
  /** The files in the order the map lists them, by string, and each string's place in it. */
  sources: i32[] = [];
  sourceIndex: Map<i32, i32> = new Map<i32, i32>();

  reset(): void {
    this.offset.length = 0;
    this.file.length = 0;
    this.line.length = 0;
  }

  get count(): i32 {
    return this.offset.length;
  }

  /** Forget the marks from `count` on, of code written again. */
  truncate(count: i32): void {
    this.offset.length = count;
    this.file.length = count;
    this.line.length = count;
  }

  /** The code from module offset `at` on is from line `line` of `file`; nothing if either is unknown. */
  mark(at: u32, file: i32, line: u32): void {
    if (file < 0 || line === 0) {
      return;
    }

    const n = this.offset.length;
    if (n > 0 && this.file[n - 1] === file && this.line[n - 1] === line) {
      return;
    }

    if (n > 0 && this.offset[n - 1] === at) {
      this.file[n - 1] = file;
      this.line[n - 1] = line;
      return;
    }

    this.offset.push(at);
    this.file.push(file);
    this.line.push(line);
  }

  /**
   * The map's JSON into `out`, for the module in `module`: its sources as
   * paths (asc names a file `directory;package;File.as`), and its mappings,
   * columns counted in UTF-16 code units as JavaScript counts them.
   */
  write(out: Output, module: Output, pool: ConstantPool, base: usize): void {
    this.sources.length = 0;
    this.sourceIndex.clear();
    for (let m = 0; m < this.offset.length; m++) {
      const f = this.file[m];
      if (!this.sourceIndex.has(f)) {
        this.sourceIndex.set(f, this.sources.length);
        this.sources.push(f);
      }
    }

    out.reset();
    out.text('{"version":3,"sources":[');
    for (let s = 0; s < this.sources.length; s++) {
      if (s > 0) {
        out.byte(0x2c);
      }

      const f = this.sources[s];
      this.path(out, base + pool.stringStart[f], pool.stringLength[f]);
    }

    out.text('],"names":[],"mappings":"');
    let genCol: u32 = 0;
    let at: u32 = 0;
    let prevCol: i32 = 0;
    let prevSource: i32 = 0;
    let prevLine: i32 = 0;
    let first = true;
    const bytes = module.bytes;
    for (let m = 0; m < this.offset.length; m++) {
      const to = min(this.offset[m], module.length);
      for (; at < to; at++) {
        const b = bytes[at];
        if (b === 0x0a) {
          out.byte(0x3b); // ;
          genCol = 0;
          prevCol = 0;
          first = true;
        } else if ((b & 0xc0) !== 0x80) {
          // A character's first byte; one past U+FFFF is two code units.
          genCol += b >= 0xf0 ? 2 : 1;
        }
      }

      if (!first) {
        out.byte(0x2c); // ,
      }

      first = false;
      const source = this.sourceIndex.get(this.file[m]);
      const line = <i32>this.line[m] - 1;
      this.vlq(out, <i32>genCol - prevCol);
      this.vlq(out, source - prevSource);
      this.vlq(out, line - prevLine);
      this.vlq(out, 0);
      prevCol = <i32>genCol;
      prevSource = source;
      prevLine = line;
    }

    out.text('"}');
  }

  /** A pool string, UTF-8 from `ptr`, as a JSON string of a path: each `;` a `/`, never two together. */
  private path(out: Output, ptr: usize, length: u32): void {
    out.byte(0x22);
    let slash = false;
    for (let i: u32 = 0; i < length; i++) {
      let b = load<u8>(ptr + i);
      if (b === 0x3b || b === 0x5c) {
        b = 0x2f;
      }

      if (b === 0x2f) {
        if (!slash) {
          out.byte(b);
        }

        slash = true;
        continue;
      }

      slash = false;
      if (b === 0x22) {
        out.text('\\"');
      } else if (b < 0x20 || b === 0x7f) {
        out.text("\\u00");
        out.hex(b);
      } else {
        out.byte(b);
      }
    }

    out.byte(0x22);
  }

  /** n in base64 VLQ: its sign in the lowest bit, five bits a digit, the least first. */
  private vlq(out: Output, n: i32): void {
    let v: u32 = n < 0 ? ((<u32>-n) << 1) | 1 : (<u32>n) << 1;
    do {
      let digit = v & 31;
      v >>= 5;
      if (v) {
        digit |= 32;
      }

      out.byte(<u8>BASE64.charCodeAt(digit));
    } while (v);
  }
}
