// A small AVM1 assembler for tests: actions by name, Push's values by their
// JavaScript types, and jumps to labels, resolved when the bytes are taken.
//
//   const block = new Avm1Assembler()
//     .push("hello").trace()
//     .push(true).if("end").stop()
//     .label("end").end()
//     .bytes();

/** Push's value types (SWF file format specification, ActionPush). */
export const PushType = {
  string: 0,
  float: 1,
  null: 2,
  undefined: 3,
  register: 4,
  boolean: 5,
  double: 6,
  integer: 7,
  constant8: 8,
  constant16: 9,
} as const;

/** A value Push writes with a type its JavaScript type does not say. */
export interface TypedValue {
  type: number;
  value: number;
}

/**
 * A value to push: a string, a boolean, null or undefined as themselves, a
 * number as an integer where it is an i32 (but -0) and as a double else.
 */
export type PushValue = string | number | boolean | null | undefined | TypedValue;

export const float = (value: number): TypedValue => ({ type: PushType.float, value });
export const double = (value: number): TypedValue => ({ type: PushType.double, value });
export const register = (value: number): TypedValue => ({ type: PushType.register, value });
/** Constant `value` of the pool, as a u8 index where it fits, else a u16 one. */
export const constant = (value: number): TypedValue => ({
  type: value < 256 ? PushType.constant8 : PushType.constant16,
  value,
});
export const constant16 = (value: number): TypedValue => ({ type: PushType.constant16, value });

/** The opcodes of the actions without operands, by name. */
export const Simple = {
  End: 0x00,
  NextFrame: 0x04,
  PreviousFrame: 0x05,
  Play: 0x06,
  Stop: 0x07,
  Add: 0x0a,
  Not: 0x12,
  Pop: 0x17,
  GetVariable: 0x1c,
  SetVariable: 0x1d,
  Trace: 0x26,
  Throw: 0x2a,
  Return: 0x3e,
  Add2: 0x47,
  Equals2: 0x49,
} as const;

const u16 = (n: number) => [n & 0xff, (n >> 8) & 0xff];
const i32 = (n: number) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff];
const str = (s: string) => [...new TextEncoder().encode(s), 0];

export class Avm1Assembler {
  private code: number[] = [];
  private labels = new Map<string, number>();
  /** Branches to patch: where their offset goes and the label it names. */
  private fixups: { at: number; label: string }[] = [];

  /** An action by opcode, with its operands' bytes from 0x80. */
  action(op: number, operands: number[] = []): this {
    this.code.push(op);
    if (op >= 0x80) {
      this.code.push(...u16(operands.length), ...operands);
    }

    return this;
  }

  /** Bytes as they are, for actions this does not write. */
  raw(bytes: number[]): this {
    this.code.push(...bytes);
    return this;
  }

  label(name: string): this {
    this.labels.set(name, this.code.length);
    return this;
  }

  push(...values: PushValue[]): this {
    const operands: number[] = [];
    for (const v of values) {
      if (typeof v === "string") {
        operands.push(PushType.string, ...str(v));
      } else if (typeof v === "boolean") {
        operands.push(PushType.boolean, v ? 1 : 0);
      } else if (v === null) {
        operands.push(PushType.null);
      } else if (v === undefined) {
        operands.push(PushType.undefined);
      } else if (typeof v === "number") {
        operands.push(...(Object.is(v, -0) || (v | 0) !== v ? number(double(v)) : number(v)));
      } else {
        operands.push(...number(v));
      }
    }

    return this.action(0x96, operands);
  }

  constantPool(...strings: string[]): this {
    return this.action(0x88, [...u16(strings.length), ...strings.flatMap(str)]);
  }

  jump(label: string): this {
    return this.branch(0x99, label);
  }

  if(label: string): this {
    return this.branch(0x9d, label);
  }

  trace(): this {
    return this.action(Simple.Trace);
  }

  pop(): this {
    return this.action(Simple.Pop);
  }

  play(): this {
    return this.action(Simple.Play);
  }

  stop(): this {
    return this.action(Simple.Stop);
  }

  end(): this {
    return this.action(Simple.End);
  }

  /** The block's bytes, every label it jumps to defined. */
  bytes(): Uint8Array {
    const code = [...this.code];
    for (const { at, label } of this.fixups) {
      const target = this.labels.get(label);
      if (target === undefined) {
        throw new Error(`no label ${label}`);
      }

      // Relative to the end of the branch, whose offset ends 2 bytes on.
      const offset = target - (at + 2);
      code[at] = offset & 0xff;
      code[at + 1] = (offset >> 8) & 0xff;
    }

    return new Uint8Array(code);
  }

  private branch(op: number, label: string): this {
    this.fixups.push({ at: this.code.length + 3, label });
    return this.action(op, [0, 0]);
  }
}

/** A typed value's bytes, its type first. */
function number(v: TypedValue | number): number[] {
  if (typeof v === "number") {
    return [PushType.integer, ...i32(v)];
  }

  switch (v.type) {
    case PushType.float: {
      const view = new DataView(new ArrayBuffer(4));
      view.setFloat32(0, v.value, true);
      return [v.type, ...new Uint8Array(view.buffer)];
    }
    case PushType.double: {
      // The high word first, each word little-endian.
      const view = new DataView(new ArrayBuffer(8));
      view.setFloat64(0, v.value, true);
      const bytes = [...new Uint8Array(view.buffer)];
      return [v.type, ...bytes.slice(4), ...bytes.slice(0, 4)];
    }
    case PushType.integer:
      return [v.type, ...i32(v.value)];
    case PushType.constant16:
      return [v.type, ...u16(v.value)];
    default:
      return [v.type, v.value & 0xff];
  }
}
