// Tamarin's PCRE retains captures on some paths through repeated groups. A
// later backreference can depend on that choice before the match completes.
import { decodeBase64 } from "../base64.js";
import { track } from "../memory.js";
import { binary } from "./binary.js";

declare const TextEncoder: new () => { encode(s: string): Uint8Array };
declare const TextDecoder: new (
  label: string,
  options: { ignoreBOM: boolean },
) => {
  decode(bytes: Uint8Array): string;
};
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { ignoreBOM: true });

// The shell's UTF-8 conversion consumes the unit following a high surrogate,
// including a non-low one. A trailing unpaired high makes the whole input empty.
function shellUtf8(value: string): Uint8Array {
  const badHigh = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g;
  let bad = badHigh.exec(value);
  if (!bad) {
    return encoder.encode(value);
  }

  const parts: string[] = [];
  let start = 0;
  do {
    if (bad.index + 1 === value.length) {
      return new Uint8Array();
    }
    parts.push(value.slice(start, bad.index), "\uFFFD");
    start = bad.index + 2;
    badHigh.lastIndex = start;
    bad = badHigh.exec(value);
  } while (bad);
  parts.push(value.slice(start));
  return encoder.encode(parts.join(""));
}

interface Exports {
  memory: WebAssembly.Memory;
  input(size: number, newPattern: number): number;
  compilePattern(flags: number): number;
  names(count: number, stride: number): number;
  match(size: number, start: number): number;
  result(): number;
}

export interface NamedMatch extends Array<string | undefined> {
  index: number;
  end: number;
  input: string;
  named: [string, string | undefined][];
  changesFirst: boolean;
}

class Matcher {
  private readonly x: Exports;
  private pattern?: string;
  private flags = 0;
  private valid = false;
  private groups: [string, number][] = [];
  private changesFirst = false;
  private subject?: string;
  private text = 0;
  private size = 0;
  private ascii = false;
  private byte = 0;
  private character = 0;

  constructor(module: WebAssembly.Module) {
    this.x = new WebAssembly.Instance(module).exports as unknown as Exports;
    track(this.x.memory);
  }

  private input(value: string, newPattern = false): void {
    const encoded = shellUtf8(value);
    this.size = encoded.length;
    this.text = this.x.input(this.size, +newPattern);
    new Uint8Array(this.x.memory.buffer, this.text, this.size).set(encoded);
  }

  private compile(pattern: string, flags: number): void {
    this.pattern = pattern;
    this.flags = flags;
    this.subject = undefined;
    this.groups = [];
    this.changesFirst = false;
    this.input(pattern, true);
    this.valid = !!this.x.compilePattern(flags);
    // Both compilation and Flash's scan for the (?P< spelling stop at NUL.
    const nul = pattern.indexOf("\0");
    if (!this.valid || (nul >= 0 && pattern.indexOf("(?P<") > nul)) {
      return;
    }

    // Each PCRE name-table entry starts with its big-endian capture number.
    const sizes = this.x.result();
    let at = this.x.names(sizes, sizes + 4);
    const [count, stride] = new Int32Array(this.x.memory.buffer, sizes, 2);
    const bytes = new Uint8Array(this.x.memory.buffer);
    for (let i = 0; i < count; i++) {
      const group = (bytes[at] << 8) | bytes[at + 1];
      // As in RegExpObject::_exec, a named group outside the offset vector refuses the match.
      if (group > 48) {
        this.valid = false;
        return;
      }
      const name = decoder.decode(bytes.subarray(at + 2, bytes.indexOf(0, at + 2)));
      this.groups.push([name, group]);
      this.changesFirst ||= name === "length" || name === "0";
      at += stride;
    }
  }

  // Flash indexes UTF-8 matches in characters. Global scans advance this cursor
  // monotonically, without decoding or walking the subject for each match.
  private position(bytes: Uint8Array, pos: number, byByte: boolean): number {
    if (this.ascii) {
      return pos;
    }
    if (pos < (byByte ? this.byte : this.character)) {
      this.byte = 0;
      this.character = 0;
    }
    while (this.byte < this.size && (byByte ? this.byte : this.character) < pos) {
      do {
        this.byte++;
      } while (this.byte < this.size && (bytes[this.text + this.byte] & 0xc0) === 0x80);
      this.character++;
    }

    if (byByte) {
      return this.character;
    }
    return this.character === pos ? this.byte : this.size + 1;
  }

  exec(pattern: string, flags: number, subject: string, start: number): NamedMatch | null {
    if (pattern !== this.pattern || flags !== this.flags) {
      this.compile(pattern, flags);
    }
    if (!this.valid || start < 0) {
      return null;
    }
    if (this.subject !== subject) {
      this.input(subject);
      this.subject = subject;
      this.ascii = this.size === subject.length;
      this.byte = 0;
      this.character = 0;
    }

    // StIndexableUTF8String passes the UTF-8 end offset through unchanged.
    const from =
      start >= this.size
        ? start
        : this.position(new Uint8Array(this.x.memory.buffer), start, false);
    if (from > this.size) {
      return null;
    }
    const count = this.x.match(this.size, from);
    if (count < 0) {
      return null;
    }

    // Matching can grow memory. Take fresh views once its offsets are ready.
    const bytes = new Uint8Array(this.x.memory.buffer);
    const offsets = new Int32Array(bytes.buffer, this.x.result(), 99);
    const capture = (group: number) => {
      const first = offsets[group * 2];
      const last = offsets[group * 2 + 1];
      if (first < 0 || last < first || last > this.size) {
        return undefined;
      }

      return this.ascii
        ? subject.slice(first, last)
        : decoder.decode(bytes.subarray(this.text + first, this.text + last));
    };
    const result = new Array(count) as NamedMatch;
    for (let i = 0; i < count; i++) {
      result[i] = capture(i);
    }
    result.index = this.position(bytes, offsets[0], true);
    result.end = this.position(bytes, offsets[1], true);
    result.input = subject;
    // Duplicate names are legal with (?J). Their writes to the array, in
    // name-table order, can each affect its length and numbered slots.
    result.named = this.groups.map(([name, group]) => [name, capture(group)]);
    result.changesFirst = this.changesFirst;

    return result;
  }
}

let module: WebAssembly.Module | undefined;
let previous: WeakRef<Matcher> | undefined;

/** Match in the shell's character coordinates. Consecutive global matches reuse
 * the compilation and encoded subject; the VM and its input can be collected between jobs. */
export function execNamed(
  pattern: string,
  flags: string,
  extended: boolean,
  subject: string,
  start: number,
): NamedMatch | null {
  let matcher = previous?.deref();
  if (!matcher) {
    module ??= new WebAssembly.Module(decodeBase64(binary));
    matcher = new Matcher(module);
    previous = new WeakRef(matcher);
  }

  const options =
    (flags.includes("i") ? 1 : 0) |
    (flags.includes("m") ? 2 : 0) |
    (flags.includes("s") ? 4 : 0) |
    (extended ? 8 : 0);
  try {
    return matcher.exec(pattern, options, subject, start);
  } catch (error) {
    // Compilation can exhaust its stack and a match its heap. Drop the interrupted
    // instance so the next expression starts with fresh storage.
    previous = undefined;
    if (error instanceof WebAssembly.RuntimeError) {
      return null;
    }
    throw error;
  }
}
