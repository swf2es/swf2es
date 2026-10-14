// Decodes the actions of an AVM1 block, each where control reaches it.
//
// Where Flash's readings of malformed actions are not documented, this
// follows Ruffle's (https://github.com/ruffle-rs/ruffle), swf/src/avm1/read.rs
// and core/src/avm1/activation.rs: MIT OR Apache-2.0, Copyright (c)
// 2018-2022 Ruffle LLC and Ruffle contributors. From it: an action's operands
// are read from wherever they lie and the next action is where its length
// says, whatever the operands took; a nested body's size adds to that
// length; a Push skips a value type it does not know; a Try shorter than its
// header is empty; and a ConstantPool keeps the strings it could read.
import * as ops from "./opcodes";

/** The action decoded as Flash reads it. */
export const ERROR_None: u8 = 0;
/**
 * Its opcode's length, its length, an operand or a nested body runs past the
 * block's end. adl stops the whole SWF at a length past the end and runs no
 * further at an operand past it; the block ends there.
 */
export const ERROR_Truncated: u8 = 1;

/**
 * One action at an offset of the block. Its operands, by opcode:
 *
 * - GotoFrame: `a` the frame.
 * - GetUrl: strings `first` (the URL) and `first + 1` (the target).
 * - StoreRegister: `a` the register.
 * - ConstantPool: strings `first` to `first + count`.
 * - WaitForFrame: `a` the frame, `b` how many actions to skip, `target` the
 *   offset that skips them, once `Actions.skip` has set it.
 * - SetTarget, GotoLabel: string `first`.
 * - WaitForFrame2: `b` and `target` as WaitForFrame's.
 * - DefineFunction: string `first` the name, then `count - 1` parameters;
 *   `a` the register count, `b` the flags and, per parameter, its string's
 *   register (DefineFunction2 only); the body from `s0` to `s1`.
 * - Try: `a` its flags, `b` the catch's register or string `first` its
 *   variable (`count` 1); the try body from `s0` to `s1`, the catch's to
 *   `s2`, the finally's to `s3`.
 * - With: the body from `s0` to `s1`.
 * - Push: values `first` to `first + count`.
 * - Jump, If: `a` the offset, `target` the offset it goes to.
 * - GetUrl2: `a` the flags.
 * - GotoFrame2: `a` 1 to play, `b` the scene bias.
 *
 * A target may be before the block or past its end.
 */
@final
export class Action {
  opcode: u8 = 0;
  error: u8 = ERROR_None;
  /** Where the next action starts: past the operands and any nested body. */
  next: i32 = 0;
  a: i32 = 0;
  b: i32 = 0;
  target: i32 = 0;
  first: i32 = 0;
  count: i32 = 0;
  s0: i32 = 0;
  s1: i32 = 0;
  s2: i32 = 0;
  s3: i32 = 0;
  /** Whether a WaitForFrame's target is set (Actions.skip). */
  skips: bool = false;
  /** A DefineFunction's body's region (flow/regions.ts), -1 for none. */
  region: i32 = -1;

  constructor(public offset: i32) {}
}

/**
 * A block's actions, decoded on demand, each offset once: control may reach
 * an offset inside another action, and from several regions. Strings are
 * ranges of the block's bytes, without their zero; what they read as
 * depends on the SWF's version, which the emitter knows.
 */
@final
export class Actions {
  actions: Action[] = [];
  /** By offset, the index of the action there plus one; 0 before it is decoded. */
  at: StaticArray<i32>;
  stringStart: i32[] = [];
  stringLength: i32[] = [];
  /** A DefineFunction2 parameter's register, 0 for none; 0 for other strings. */
  stringRegister: u8[] = [];
  valueType: u8[] = [];
  /** A float, double, integer or boolean value. */
  valueNumber: f64[] = [];
  /** A string value's string, a register or a constant's index. */
  valueIndex: i32[] = [];

  /**
   * How many bytes decoding has read, strings looked through included: a
   * block crafted so that many offsets decode long Pushes or look through
   * the same long run of bytes for a string's zero costs this, not its size.
   */
  read: i64 = 0;

  // The operand reader: a position, and whether a read ran past the end.
  private pos: i32 = 0;
  private failed: bool = false;

  constructor(public bytes: Uint8Array) {
    this.at = new StaticArray<i32>(bytes.length);
  }

  get length(): i32 {
    return this.bytes.length;
  }

  /** The action at `offset`, from 0 to the block's length, excluded. */
  decode(offset: i32): Action {
    const known = this.at[offset];
    if (known !== 0) {
      return this.actions[known - 1];
    }

    const action = new Action(offset);
    this.operands(action);
    this.at[offset] = this.actions.length + 1;
    this.actions.push(action);
    return action;
  }

  /**
   * Sets a WaitForFrame's target: where the actions it skips end, read one
   * after the other, without following jumps. Not done as it is decoded,
   * since the actions it skips may be WaitForFrames too.
   */
  skip(action: Action): void {
    if (action.skips) {
      return;
    }

    let p = action.next;
    for (let k = 0; k < action.b && p < this.length; k++) {
      p = this.decode(p).next;
    }

    action.target = p;
    action.skips = true;
  }

  private operands(action: Action): void {
    const end = this.length;
    const opcode = this.bytes[action.offset];
    action.opcode = opcode;
    if (opcode < 0x80) {
      action.next = action.offset + 1;
      return;
    }

    this.pos = action.offset + 1;
    this.failed = false;
    let length = <i32>this.u16();
    if (this.failed) {
      // Only the opcode was read.
      action.error = ERROR_Truncated;
      action.next = action.offset + 1;
      return;
    }

    const start = this.pos;
    // Nested bodies' sizes, which the position passes without reading.
    let bodies = 0;
    switch (opcode) {
      case ops.OP_GotoFrame:
        action.a = this.u16();
        break;
      case ops.OP_GetUrl:
        action.first = this.string();
        this.string();
        action.count = 2;
        break;
      case ops.OP_StoreRegister:
        action.a = this.u8();
        break;
      case ops.OP_ConstantPool:
        this.constantPool(action);
        break;
      case ops.OP_WaitForFrame:
        action.a = this.u16();
        action.b = this.u8();
        break;
      case ops.OP_SetTarget:
      case ops.OP_GotoLabel:
        action.first = this.string();
        action.count = 1;
        break;
      case ops.OP_WaitForFrame2:
        action.b = this.u8();
        break;
      case ops.OP_DefineFunction:
      case ops.OP_DefineFunction2:
        bodies = this.defineFunction(action, opcode === ops.OP_DefineFunction2);
        length += bodies;
        break;
      case ops.OP_Try:
        if (length >= 7) {
          bodies = this.try(action);
          length += bodies;
        } else {
          // Too short for its header: a Try with empty bodies, after it.
          const at = start + length;
          action.s0 = at;
          action.s1 = at;
          action.s2 = at;
          action.s3 = at;
        }
        break;
      case ops.OP_With: {
        bodies = <i32>this.u16();
        length += bodies;
        this.body(action, bodies);
        break;
      }
      case ops.OP_Push:
        this.push(action, start + length);
        break;
      case ops.OP_Jump:
      case ops.OP_If:
        action.a = this.i16();
        break;
      case ops.OP_GetUrl2: {
        const flags = this.u8();
        // A method of 3 is none.
        action.a = (flags & ops.GETURL_MethodMask) === ops.GETURL_MethodMask ? flags & ~3 : flags;
        break;
      }
      case ops.OP_GotoFrame2: {
        const flags = this.u8();
        action.a = flags & 1;
        action.b = flags & 2 ? this.u16() : 0;
        break;
      }
      default:
        break;
    }

    this.read += <i64>(this.pos - start - bodies);
    // Wherever the operands ended, the next action is where the length says.
    // A length past the block's end, read or not, is as truncated: adl
    // stops the whole SWF there, even with the bytes that follow in it.
    const next = <i64>start + length;
    if (next > <i64>end) {
      this.failed = true;
    }

    action.next = <i32>min(next, <i64>end);
    if (this.failed) {
      action.error = ERROR_Truncated;
      return;
    }

    if (opcode === ops.OP_Jump || opcode === ops.OP_If) {
      action.target = action.next + action.a;
    }
  }

  private constantPool(action: Action): void {
    const count = this.u16();
    action.first = this.stringStart.length;
    for (let i: u32 = 0; i < count; i++) {
      // A string without its zero ends the pool, not the action.
      if (this.string() < 0) {
        this.failed = false;
        break;
      }

      action.count++;
    }
  }

  /** The header and body of a DefineFunction or DefineFunction2; the body's size. */
  private defineFunction(action: Action, two: bool): i32 {
    action.first = this.string();
    const params = this.u16();
    if (two) {
      action.a = this.u8();
      action.b = this.u16() & ops.FUNCTION_Mask;
    }

    for (let i: u32 = 0; i < params && !this.failed; i++) {
      const register = two ? <u8>this.u8() : 0;
      const index = this.string();
      if (index >= 0) {
        this.stringRegister[index] = register;
      }
    }

    action.count = 1 + params;
    const size = <i32>this.u16();
    this.body(action, size);
    return size;
  }

  /** Try's header and bodies; the bodies' size. */
  private try(action: Action): i32 {
    const flags = this.u8() & ops.TRY_Mask;
    const trySize = <i32>this.u16();
    const catchSize = <i32>this.u16();
    const finallySize = <i32>this.u16();
    action.a = flags;
    if (flags & ops.TRY_CatchInRegister) {
      action.b = this.u8();
    } else {
      action.first = this.string();
      action.count = 1;
    }

    const at = this.pos;
    action.s0 = at;
    action.s1 = at + trySize;
    action.s2 = action.s1 + catchSize;
    action.s3 = action.s2 + finallySize;
    if (action.s3 > this.length) {
      this.failed = true;
    }

    this.pos = action.s3;
    return trySize + catchSize + finallySize;
  }

  /** A nested body of `size` bytes from here. */
  private body(action: Action, size: i32): void {
    action.s0 = this.pos;
    action.s1 = this.pos + size;
    if (action.s1 > this.length) {
      this.failed = true;
    }

    this.pos = action.s1;
  }

  /** Push's values, until its end. */
  private push(action: Action, end: i32): void {
    action.first = this.valueType.length;
    while (this.pos < end && !this.failed) {
      const type = <u8>this.u8();
      let number: f64 = 0;
      let index: i32 = 0;
      switch (type) {
        case ops.PUSH_String:
          index = this.string();
          break;
        case ops.PUSH_Float:
          number = <f64>reinterpret<f32>(this.u32());
          break;
        case ops.PUSH_Null:
        case ops.PUSH_Undefined:
          break;
        case ops.PUSH_Register:
        case ops.PUSH_Constant8:
          index = this.u8();
          break;
        case ops.PUSH_Boolean:
          number = this.u8() !== 0 ? 1 : 0;
          break;
        case ops.PUSH_Double: {
          // The high word first, each word little-endian.
          const high = <u64>this.u32();
          const low = <u64>this.u32();
          number = reinterpret<f64>((high << 32) | low);
          break;
        }
        case ops.PUSH_Integer:
          number = <f64>(<i32>this.u32());
          break;
        case ops.PUSH_Constant16:
          index = this.u16();
          break;
        default:
          // Flash Player 9 skips a type it does not know, and so does Ruffle;
          // adl stops the SWF.
          continue;
      }

      if (this.failed) {
        break;
      }

      this.valueType.push(type);
      this.valueNumber.push(number);
      this.valueIndex.push(index);
      action.count++;
    }
  }

  private u8(): u32 {
    const p = this.pos;
    if (p >= this.length) {
      this.failed = true;
      return 0;
    }

    this.pos = p + 1;
    return <u32>this.bytes[p];
  }

  private u16(): u32 {
    const p = this.pos;
    if (p + 2 > this.length) {
      this.failed = true;
      return 0;
    }

    this.pos = p + 2;
    return <u32>this.bytes[p] | ((<u32>this.bytes[p + 1]) << 8);
  }

  private i16(): i32 {
    return <i32>(<i16>this.u16());
  }

  private u32(): u32 {
    const p = this.pos;
    if (p + 4 > this.length) {
      this.failed = true;
      return 0;
    }

    this.pos = p + 4;
    const bytes = this.bytes;
    return (
      <u32>bytes[p] |
      ((<u32>bytes[p + 1]) << 8) |
      ((<u32>bytes[p + 2]) << 16) |
      ((<u32>bytes[p + 3]) << 24)
    );
  }

  /**
   * A string up to its zero, added to the strings: its index, or -1, with
   * the reader failed and the position unchanged, if no zero ends it.
   */
  private string(): i32 {
    const from = this.pos;
    const bytes = this.bytes;
    let p = from;
    while (p < this.length && bytes[p] !== 0) {
      p++;
    }

    this.read += <i64>(p - from);
    if (p >= this.length) {
      this.failed = true;
      return -1;
    }

    const index = this.stringStart.length;
    this.stringStart.push(from);
    this.stringLength.push(p - from);
    this.stringRegister.push(0);
    this.pos = p + 1;
    return index;
  }
}
