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

/** DefineFunction2's flags: what it preloads into registers from 1, and what it leaves out. */
export const FunctionFlag = {
  preloadThis: 0x001,
  suppressThis: 0x002,
  preloadArguments: 0x004,
  suppressArguments: 0x008,
  preloadSuper: 0x010,
  suppressSuper: 0x020,
  preloadRoot: 0x040,
  preloadParent: 0x080,
  preloadGlobal: 0x100,
} as const;

/** Try's flags: which bodies it has, and whether the catch's value goes to a register. */
export const TryFlag = {
  catch: 1,
  finally: 2,
  catchInRegister: 4,
} as const;

/** The opcodes of the actions without operands, by name. */
export const Simple = {
  End: 0x00,
  NextFrame: 0x04,
  PreviousFrame: 0x05,
  Play: 0x06,
  Stop: 0x07,
  ToggleQuality: 0x08,
  StopSounds: 0x09,
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
  CloneSprite: 0x24,
  RemoveSprite: 0x25,
  Trace: 0x26,
  StartDrag: 0x27,
  EndDrag: 0x28,
  StringLess: 0x29,
  Throw: 0x2a,
  CastOp: 0x2b,
  ImplementsOp: 0x2c,
  RandomNumber: 0x30,
  MBStringLength: 0x31,
  CharToAscii: 0x32,
  AsciiToChar: 0x33,
  GetTime: 0x34,
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
  /** CallFrame: from 0x80, but with no operands. */
  Call: 0x9e,
} as const;

export type SimpleAction = keyof typeof Simple;

const u16 = (n: number) => [n & 0xff, (n >> 8) & 0xff];
const i32 = (n: number) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff];
const str = (s: string) => [...new TextEncoder().encode(s), 0];

/** How an assembler writes what Flash's compiler would write otherwise. */
export interface AssemblerOptions {
  /**
   * Strings pushed as constants of a pool, which the block declares first
   * and its functions' bodies (`child()`) share, as Flash's compiler does.
   */
  pool?: boolean;
  /** A push straight after a push added to it, one Push of all the values, as Flash's compiler writes them. */
  batch?: boolean;
}

export class Avm1Assembler {
  private code: number[] = [];
  private labels = new Map<string, number>();
  /** Try headers whose flags are known once the labels are. */
  private tries: {
    at: number;
    catchAt: string;
    finallyAt: string;
    end: string;
    flags: number | undefined;
    named: boolean;
  }[] = [];
  /**
   * Offsets and sizes to patch: where the u16 goes, the label it names and
   * the offset it counts from (a branch's end, a body's start).
   */
  private fixups: { at: number; label: string; from: number | string }[] = [];
  /** Where each action starts, for WaitForFrame's count of the actions it skips. */
  private starts: number[] = [];
  /** WaitForFrame and WaitForFrame2 whose counts are known once the labels are: the count's offset, the next action's and the label. */
  private waits: { at: number; from: number; label: string }[] = [];
  /** Where the last action starts, -1 after a label or raw bytes: a Push there takes a batched push's values. */
  private last = -1;
  private readonly options: AssemblerOptions;
  /** The pool's strings and their indices, shared with the children; null without a pool. */
  private readonly strings: Map<string, number> | null;
  /** Whether the block declares the pool: the root's, not a function body's. */
  private readonly root: boolean;

  constructor(options: AssemblerOptions = {}, strings?: Map<string, number>) {
    this.options = options;
    this.root = strings === undefined;
    this.strings = strings ?? (options.pool ? new Map() : null);
  }

  /** An assembler for a function's body, written as this one writes and sharing its pool. */
  child(): Avm1Assembler {
    return new Avm1Assembler(this.options, this.strings ?? undefined);
  }

  /** An action by opcode, with its operands' bytes from 0x80. */
  action(op: number, operands: number[] = []): this {
    this.last = this.code.length;
    this.starts.push(this.code.length);
    this.code.push(op);
    if (op >= 0x80) {
      this.code.push(...u16(operands.length), ...operands);
    }

    return this;
  }

  /** Bytes as they are, for actions this does not write. */
  raw(bytes: number[]): this {
    this.code.push(...bytes);
    this.last = -1;
    return this;
  }

  label(name: string): this {
    this.labels.set(name, this.code.length);
    this.last = -1;
    return this;
  }

  push(...values: PushValue[]): this {
    const operands: number[] = [];
    for (const v of values) {
      if (typeof v === "string" && this.strings !== null) {
        let index = this.strings.get(v);
        if (index === undefined) {
          index = this.strings.size;
          this.strings.set(v, index);
        }

        operands.push(...number(constant(index)));
      } else if (typeof v === "string") {
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

    const last = this.last;
    if (this.options.batch && last >= 0 && this.code[last] === 0x96) {
      const length = this.code[last + 1] | (this.code[last + 2] << 8);
      if (length + operands.length <= 0xffff) {
        this.code.push(...operands);
        [this.code[last + 1], this.code[last + 2]] = u16(length + operands.length);
        return this;
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

  /**
   * DefineFunction2: `name` ("" for an anonymous one), its register count
   * and flags (the FunctionFlag bits), its parameters, each with its
   * register or 0 for a variable, and its body.
   */
  defineFunction2(
    name: string,
    registers: number,
    flags: number,
    params: [string, number][],
    body: Avm1Assembler,
  ): this {
    const code = body.bytes();
    return this.action(0x8e, [
      ...str(name),
      ...u16(params.length),
      registers & 0xff,
      ...u16(flags),
      ...params.flatMap(([param, r]) => [r & 0xff, ...str(param)]),
      ...u16(code.length),
    ]).raw([...code]);
  }

  /** With: the object on the stack is the scope of the body up to `end`, which follows. */
  with(end: string): this {
    this.fixups.push({ at: this.code.length + 3, label: end, from: this.code.length + 5 });
    return this.action(0x94, [0, 0]);
  }

  /**
   * Try: the try body follows, up to the label `catchAt`, the catch's up to
   * `finallyAt` and the finally's up to `end`; `into` the catch's variable
   * or register. `flags` overrides which bodies the header says it has
   * (TryFlag), by default a catch and a finally where they are not empty.
   */
  try(
    into: string | TypedValue,
    catchAt: string,
    finallyAt: string,
    end: string,
    flags?: number,
  ): this {
    const named = typeof into === "string";
    const header = named ? str(into) : [into.value & 0xff];
    const start = this.code.length + 3 + 7 + header.length;
    const at = this.code.length + 4;
    this.fixups.push({ at, label: catchAt, from: start });
    this.fixups.push({ at: at + 2, label: finallyAt, from: catchAt });
    this.fixups.push({ at: at + 4, label: end, from: finallyAt });
    this.tries.push({ at: at - 1, catchAt, finallyAt, end, flags, named });
    return this.action(0x8f, [0, 0, 0, 0, 0, 0, 0, ...header]);
  }

  /** GotoFrame: frame `frame`, 0 the first. */
  gotoFrame(frame: number): this {
    return this.action(0x81, u16(frame));
  }

  gotoLabel(label: string): this {
    return this.action(0x8c, str(label));
  }

  /** GotoFrame2 of the frame on the stack, a number or a label, playing or not, and with a scene bias where one is given. */
  gotoFrame2(play: boolean, bias?: number): this {
    const flags = (play ? 1 : 0) | (bias === undefined ? 0 : 2);
    return this.action(0x9f, bias === undefined ? [flags] : [flags, ...u16(bias)]);
  }

  setTarget(target: string): this {
    return this.action(0x8b, str(target));
  }

  getUrl(url: string, target: string): this {
    return this.action(0x83, [...str(url), ...str(target)]);
  }

  /** WaitForFrame of frame `frame` (0 the first), skipping the actions up to `label` where it is not loaded. */
  waitForFrame(frame: number, label: string): this {
    this.waits.push({ at: this.code.length + 5, from: this.code.length + 6, label });
    return this.action(0x8a, [...u16(frame), 0]);
  }

  /** WaitForFrame2 of the frame on the stack, as `waitForFrame`. */
  waitForFrame2(label: string): this {
    this.waits.push({ at: this.code.length + 3, from: this.code.length + 4, label });
    return this.action(0x8d, [0]);
  }

  storeRegister(register: number): this {
    return this.action(0x87, [register & 0xff]);
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

  /** The block's bytes, every label it jumps to defined, its pool first where it has one. */
  bytes(): Uint8Array {
    const code = [...this.code];
    for (const { at, label, from } of this.fixups) {
      const offset = this.at(label) - (typeof from === "number" ? from : this.at(from));
      code[at] = offset & 0xff;
      code[at + 1] = (offset >> 8) & 0xff;
    }

    for (const { at, from, label } of this.waits) {
      const to = this.at(label);
      code[at] = this.starts.filter((p) => p >= from && p < to).length;
    }

    for (const { at, catchAt, finallyAt, end, flags, named } of this.tries) {
      const catches = this.at(finallyAt) > this.at(catchAt) ? TryFlag.catch : 0;
      const finallies = this.at(end) > this.at(finallyAt) ? TryFlag.finally : 0;
      code[at] = (flags ?? catches | finallies) | (named ? 0 : TryFlag.catchInRegister);
    }

    if (this.root && this.strings !== null && this.strings.size > 0) {
      const strings = [...this.strings.keys()];
      const pool = [...u16(strings.length), ...strings.flatMap(str)];
      return new Uint8Array([0x88, ...u16(pool.length), ...pool, ...code]);
    }

    return new Uint8Array(code);
  }

  private at(label: string): number {
    const target = this.labels.get(label);
    if (target === undefined) {
      throw new Error(`no label ${label}`);
    }

    return target;
  }

  private branch(op: number, label: string): this {
    // Relative to the end of the branch, whose offset ends 2 bytes on.
    this.fixups.push({ at: this.code.length + 3, label, from: this.code.length + 5 });
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
