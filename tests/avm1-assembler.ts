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

/** A string pushed as these bytes, for SWF 5's strings, which are bytes, not UTF-8. */
export interface ByteString {
  bytes: number[];
}

/**
 * A value to push: a string, a boolean, null or undefined as themselves, a
 * number as an integer where it is an i32 (but -0) and as a double else.
 */
export type PushValue = string | number | boolean | null | undefined | TypedValue | ByteString;

export const byteString = (...bytes: number[]): ByteString => ({ bytes });

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
  Subtract: 0x0b,
  Multiply: 0x0c,
  Divide: 0x0d,
  Equals: 0x0e,
  Less: 0x0f,
  And: 0x10,
  Or: 0x11,
  Not: 0x12,
  StringEquals: 0x13,
  StringLength: 0x14,
  StringExtract: 0x15,
  Pop: 0x17,
  ToInteger: 0x18,
  GetVariable: 0x1c,
  SetVariable: 0x1d,
  SetTarget2: 0x20,
  StringAdd: 0x21,
  GetProperty: 0x22,
  SetProperty: 0x23,
  Trace: 0x26,
  StringLess: 0x29,
  Throw: 0x2a,
  CastOp: 0x2b,
  ImplementsOp: 0x2c,
  MBStringLength: 0x31,
  CharToAscii: 0x32,
  AsciiToChar: 0x33,
  MBStringExtract: 0x35,
  MBCharToAscii: 0x36,
  MBAsciiToChar: 0x37,
  Delete: 0x3a,
  Delete2: 0x3b,
  DefineLocal: 0x3c,
  CallFunction: 0x3d,
  Return: 0x3e,
  Modulo: 0x3f,
  NewObject: 0x40,
  DefineLocal2: 0x41,
  InitArray: 0x42,
  InitObject: 0x43,
  TypeOf: 0x44,
  TargetPath: 0x45,
  Enumerate: 0x46,
  Add2: 0x47,
  Less2: 0x48,
  Equals2: 0x49,
  ToNumber: 0x4a,
  ToString: 0x4b,
  PushDuplicate: 0x4c,
  StackSwap: 0x4d,
  GetMember: 0x4e,
  SetMember: 0x4f,
  Increment: 0x50,
  Decrement: 0x51,
  CallMethod: 0x52,
  NewMethod: 0x53,
  InstanceOf: 0x54,
  Enumerate2: 0x55,
  BitAnd: 0x60,
  BitOr: 0x61,
  BitXor: 0x62,
  BitLShift: 0x63,
  BitRShift: 0x64,
  BitURShift: 0x65,
  StrictEquals: 0x66,
  Greater: 0x67,
  StringGreater: 0x68,
  Extends: 0x69,
} as const;

export type SimpleAction = keyof typeof Simple;

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
      } else if (v && typeof v === "object" && "bytes" in v) {
        operands.push(PushType.string, ...v.bytes, 0);
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

  /**
   * DefineFunction: `name` ("" for an anonymous one, which it pushes), its
   * parameters, and its body as another assembler writes it.
   */
  defineFunction(name: string, params: string[], body: Avm1Assembler): this {
    const code = body.bytes();
    return this.action(0x9b, [
      ...str(name),
      ...u16(params.length),
      ...params.flatMap(str),
      ...u16(code.length),
    ]).raw([...code]);
  }

  jump(label: string): this {
    return this.branch(0x99, label);
  }

  if(label: string): this {
    return this.branch(0x9d, label);
  }

  /** An action without operands, by name. */
  op(name: SimpleAction): this {
    return this.action(Simple[name]);
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
