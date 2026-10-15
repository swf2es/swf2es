// An AVM1 block as JavaScript: an array of its regions' functions, the
// block's own code first, then its functions' bodies, each written once in
// the dispatcher form (docs/avm1.md, "The dispatcher"), never inlined into
// the region that defines it, since a body may define itself. A region
// takes the operand stack, `st`, from the activation, since Flash's is one
// stack that a frame's blocks and the calls they make share. A region whose code
// is one block that nothing jumps into is written straight, without the
// dispatcher.
//
// The actions written so far: Push, ConstantPool, Trace, Pop, Jump, If,
// Play, Stop, End, PushDuplicate and StackSwap, and the arithmetic,
// comparison, logical, bitwise, string and conversion actions, each a call
// of its version's operation (V.add2, V.less2...), and the variable, member,
// object and call actions, each a call that takes its operands as they are
// popped, the top first, or pops them itself where their number is on the
// stack (V.initObject, V.callMethod...); DefineFunction and DefineFunction2,
// which make a function of a region, StoreRegister and Return. A function's
// region takes its `this` and its arguments, and a DefineFunction2's
// registers are its `let`s; every other register is one of the movie's
// four, `cx.g`. Every other action Flash knows is a call that throws,
// V.notYet, and one it does not know is skipped, as Flash skips it. An
// action Flash cannot read, cut short or a Push of a value type it does not
// know, stops the SWF, V.halt, as adl does.

import { Output } from "../../output";
import { Action, Actions, ERROR_None } from "../actions/decode";
import * as ops from "../actions/opcodes";
import { POOL_Unknown, poolAfter, poolsOf } from "../flow/pool";
import { branches, Flow, fallsThrough, fallsTo, REGION_Function, Region } from "../flow/regions";
import { avm1String } from "./strings";

@final
export class BlockEmitter {
  /** The SWF's version, which decides how its strings read (strings.ts). */
  version: i32 = 0;
  /**
   * The registers of the region being written, its own `let`s `r0` up to
   * this: a DefineFunction2's count, 0 for any other region, whose
   * registers are the four global ones.
   */
  private registers: i32 = 0;

  constructor(public out: Output) {}

  /** The entry of the block `bytes` hold, written to `out`. */
  block(bytes: Uint8Array): void {
    const out = this.out;
    const actions = new Actions(bytes);
    const flow = new Flow(actions);
    out.byte(0x5b);
    if (flow.tooLarge) {
      out.text("function (cx) {\nV.tooLarge();\n}]");
      return;
    }

    for (let r = 0; r < flow.regions.length; r++) {
      if (r > 0) {
        out.text(", ");
      }

      this.region(actions, flow.regions[r]);
    }

    out.byte(0x5d);
  }

  private region(actions: Actions, region: Region): void {
    const out = this.out;
    this.registers = 0;
    if (region.kind !== REGION_Function) {
      out.text("function (cx) {\nconst st = cx.st;\n");
    } else {
      // A body is called with its `this` and its arguments (docs/avm1.md, "Functions and registers").
      out.text("function (cx, self, args) {\nconst st = cx.st;\n");
      const opener = actions.actions[region.opener];
      if (opener.opcode === ops.OP_DefineFunction2) {
        this.registers = opener.a;
        this.preload(actions, opener);
      }
    }

    const n = region.blocks.length;
    if (n === 0) {
      out.text("}");
      return;
    }

    const pools = poolsOf(actions, region);
    const dispatch = n > 1 || jumpsWithin(actions, region);
    if (dispatch) {
      out.text("let b = ");
      out.uint(region.blockAt(region.start));
      out.text(";\nfor (;;) switch (b) {\n");
    }

    for (let k = 0; k < n; k++) {
      if (dispatch) {
        out.text("case ");
        out.uint(k);
        out.text(":\n");
      }

      this.code(actions, region, k, pools[k]);
    }

    out.text(dispatch ? "}\n}" : "}");
  }

  /** Block `k` of the region, which starts with pool `pool`. */
  private code(actions: Actions, region: Region, k: i32, pool: i32): void {
    const out = this.out;
    const last = region.blockFirst[k + 1] - 1;
    for (let i = region.blockFirst[k]; i <= last; i++) {
      const index = region.order[i];
      this.action(actions, region, actions.actions[index], pool);
      pool = poolAfter(actions, index, pool);
    }

    // Where control goes from the block's end; a Jump or a Return has gone already.
    const action = actions.actions[region.order[last]];
    if (!fallsThrough(action)) {
      if (
        action.error !== ERROR_None ||
        (action.opcode !== ops.OP_Jump && action.opcode !== ops.OP_Return)
      ) {
        out.text("return;\n");
      }

      return;
    }

    // The next block in the switch is the next case.
    const to = fallsTo(action);
    if (!region.runs(to) || region.blockAt(to) !== k + 1) {
      this.goto(region, to);
      out.byte(0x0a);
    }
  }

  private action(actions: Actions, region: Region, action: Action, pool: i32): void {
    const out = this.out;
    if (action.error !== ERROR_None) {
      // adl stops the whole SWF at an action it cannot read; the block's end returns.
      out.text("V.halt(cx);\n");
      return;
    }

    const op = action.opcode;
    switch (op) {
      case ops.OP_End:
        break;
      case ops.OP_Push:
        this.push(actions, action, pool);
        break;
      case ops.OP_ConstantPool:
        out.text("V.constantPool(cx, [");
        for (let i = 0; i < action.count; i++) {
          if (i > 0) {
            out.text(", ");
          }

          this.string(actions, action.first + i);
        }
        out.text("]);\n");
        break;
      case ops.OP_Trace:
        out.text("V.trace(cx, st.pop());\n");
        break;
      case ops.OP_Pop:
        out.text("st.pop();\n");
        break;
      case ops.OP_Play:
        out.text("V.play(cx);\n");
        break;
      case ops.OP_Stop:
        out.text("V.stop(cx);\n");
        break;
      case ops.OP_Add:
        this.operation("add", 2);
        break;
      case ops.OP_Add2:
        this.operation("add2", 2);
        break;
      case ops.OP_Subtract:
        this.operation("subtract", 2);
        break;
      case ops.OP_Multiply:
        this.operation("multiply", 2);
        break;
      case ops.OP_Divide:
        this.operation("divide", 2);
        break;
      case ops.OP_Modulo:
        this.operation("modulo", 2);
        break;
      case ops.OP_Equals:
        this.operation("equals", 2);
        break;
      case ops.OP_Equals2:
        this.operation("equals2", 2);
        break;
      case ops.OP_StrictEquals:
        this.operation("strictEquals", 2);
        break;
      case ops.OP_Less:
        this.operation("less", 2);
        break;
      case ops.OP_Less2:
        this.operation("less2", 2);
        break;
      case ops.OP_Greater:
        this.operation("greater", 2);
        break;
      case ops.OP_And:
        this.operation("and", 2);
        break;
      case ops.OP_Or:
        this.operation("or", 2);
        break;
      case ops.OP_Not:
        this.operation("not", 1);
        break;
      case ops.OP_BitAnd:
        this.operation("bitAnd", 2);
        break;
      case ops.OP_BitOr:
        this.operation("bitOr", 2);
        break;
      case ops.OP_BitXor:
        this.operation("bitXor", 2);
        break;
      case ops.OP_BitLShift:
        this.operation("bitLShift", 2);
        break;
      case ops.OP_BitRShift:
        this.operation("bitRShift", 2);
        break;
      case ops.OP_BitURShift:
        this.operation("bitURShift", 2);
        break;
      case ops.OP_Increment:
        this.operation("increment", 1);
        break;
      case ops.OP_Decrement:
        this.operation("decrement", 1);
        break;
      case ops.OP_StringAdd:
        this.operation("stringAdd", 2);
        break;
      case ops.OP_StringEquals:
        this.operation("stringEquals", 2);
        break;
      case ops.OP_StringLess:
        this.operation("stringLess", 2);
        break;
      case ops.OP_StringGreater:
        this.operation("stringGreater", 2);
        break;
      case ops.OP_StringLength:
        this.operation("stringLength", 1);
        break;
      case ops.OP_MBStringLength:
        this.operation("mbStringLength", 1);
        break;
      case ops.OP_StringExtract:
        this.operation("stringExtract", 3);
        break;
      case ops.OP_MBStringExtract:
        this.operation("mbStringExtract", 3);
        break;
      case ops.OP_CharToAscii:
        this.operation("charToAscii", 1);
        break;
      case ops.OP_AsciiToChar:
        this.operation("asciiToChar", 1);
        break;
      case ops.OP_MBCharToAscii:
        this.operation("mbCharToAscii", 1);
        break;
      case ops.OP_MBAsciiToChar:
        this.operation("mbAsciiToChar", 1);
        break;
      case ops.OP_ToNumber:
        this.operation("toNumber", 1);
        break;
      case ops.OP_ToString:
        this.operation("toString", 1);
        break;
      case ops.OP_ToInteger:
        this.operation("toInteger", 1);
        break;
      case ops.OP_TypeOf:
        this.operation("typeOf", 1);
        break;
      case ops.OP_GetVariable:
        out.text("st.push(V.getVariable(cx, st.pop()));\n");
        break;
      case ops.OP_SetVariable:
        out.text("V.setVariable(cx, st.pop(), st.pop());\n");
        break;
      case ops.OP_DefineLocal:
        out.text("V.defineLocal(cx, st.pop(), st.pop());\n");
        break;
      case ops.OP_DefineLocal2:
        out.text("V.defineLocal2(cx, st.pop());\n");
        break;
      case ops.OP_GetMember:
        out.text("st.push(V.getMember(cx, st.pop(), st.pop()));\n");
        break;
      case ops.OP_SetMember:
        out.text("V.setMember(cx, st.pop(), st.pop(), st.pop());\n");
        break;
      case ops.OP_Delete:
        out.text("st.push(V.deleteMember(cx, st.pop(), st.pop()));\n");
        break;
      case ops.OP_Delete2:
        out.text("st.push(V.deleteVariable(cx, st.pop()));\n");
        break;
      case ops.OP_Enumerate:
        out.text("V.enumerate(cx, st.pop());\n");
        break;
      case ops.OP_Enumerate2:
        out.text("V.enumerate2(cx, st.pop());\n");
        break;
      case ops.OP_InitObject:
        out.text("V.initObject(cx);\n");
        break;
      case ops.OP_InitArray:
        out.text("V.initArray(cx);\n");
        break;
      case ops.OP_CallFunction:
        out.text("V.callFunction(cx);\n");
        break;
      case ops.OP_CallMethod:
        out.text("V.callMethod(cx);\n");
        break;
      case ops.OP_NewObject:
        out.text("V.newObject(cx);\n");
        break;
      case ops.OP_NewMethod:
        out.text("V.newMethod(cx);\n");
        break;
      case ops.OP_DefineFunction:
      case ops.OP_DefineFunction2:
        this.defineFunction(actions, action);
        break;
      case ops.OP_StoreRegister:
        // The value stays: popped and pushed again, undefined on an empty stack.
        out.text("st.push(");
        if (this.register(action.a)) {
          out.text(" = ");
        }
        out.text("st.pop());\n");
        break;
      case ops.OP_Return:
        out.text("return st.pop();\n");
        break;
      case ops.OP_PushDuplicate:
        out.text("{ const a = st.pop(); st.push(a, a); }\n");
        break;
      case ops.OP_StackSwap:
        out.text("{ const a = st.pop(), b = st.pop(); st.push(a, b); }\n");
        break;
      case ops.OP_Jump:
        this.goto(region, action.target);
        out.byte(0x0a);
        break;
      case ops.OP_If:
        out.text("if (V.toBoolean(st.pop())) ");
        if (region.runs(action.target)) {
          out.text("{ ");
          this.goto(region, action.target);
          out.text(" }\n");
        } else {
          out.text("return;\n");
        }
        break;
      default:
        if (ops.opcodeKnown[op]) {
          this.notYet(ops.opcodeNames[op]);
          out.text(";\n");
        }
        break;
    }
  }

  /**
   * A DefineFunction2's registers, `let`s, and what it loads into them as
   * it is called: its preloads in order from r1, each where its flag is
   * set (one that is also suppressed undefined, but `arguments`), then its
   * parameters that have one. A register past the count takes nothing.
   */
  private preload(actions: Actions, action: Action): void {
    const out = this.out;
    const count = this.registers;
    if (count === 0) {
      return;
    }

    out.text("let ");
    for (let r = 0; r < count; r++) {
      if (r > 0) {
        out.text(", ");
      }

      out.byte(0x72);
      out.uint(r);
    }
    out.text(";\n");

    const flags = <u32>action.b;
    let r = 1;
    if (flags & ops.FUNCTION_PreloadThis) {
      this.load(r++, flags & ops.FUNCTION_SuppressThis ? "undefined" : "self");
    }

    if (flags & ops.FUNCTION_PreloadArguments) {
      this.load(r++, "V.argumentsOf(cx, args)");
    }

    if (flags & ops.FUNCTION_PreloadSuper) {
      this.load(r++, flags & ops.FUNCTION_SuppressSuper ? "undefined" : "V.superOf(cx, self)");
    }

    if (flags & ops.FUNCTION_PreloadRoot) {
      this.load(r++, "V.root(cx)");
    }

    // A clip without a parent, the root, has no register for it: _global takes it.
    const parent = (flags & ops.FUNCTION_PreloadParent) !== 0;
    const global = (flags & ops.FUNCTION_PreloadGlobal) !== 0;
    if (parent && r < count) {
      out.text("{ const p = V.parentOf(cx); if (p !== undefined) { r");
      out.uint(r);
      out.text(" = p;");
      if (global && r + 1 < count) {
        out.text(" r");
        out.uint(r + 1);
        out.text(" = cx.global;");
      }
      out.text(" }");
      if (global) {
        out.text(" else { r");
        out.uint(r);
        out.text(" = cx.global; }");
      }
      out.text(" }\n");
    } else if (global && !parent) {
      this.load(r, "cx.global");
    }

    for (let i = 1; i < action.count; i++) {
      const register = <i32>actions.stringRegister[action.first + i];
      if (register > 0 && register < count) {
        out.byte(0x72);
        out.uint(register);
        out.text(" = args[");
        out.uint(i - 1);
        out.text("];\n");
      }
    }
  }

  /** `r<register> = <value>;`, where the region has the register. */
  private load(register: i32, value: string): void {
    const out = this.out;
    if (register >= this.registers) {
      return;
    }

    out.byte(0x72);
    out.uint(register);
    out.text(" = ");
    out.text(value);
    out.text(";\n");
  }

  /**
   * Register `register` as an expression: the region's own, or one of the
   * four global ones, the movie's; any other is none.
   */
  private register(register: i32): bool {
    const out = this.out;
    if (register < this.registers) {
      out.byte(0x72);
      out.uint(register);
      return true;
    }

    if (register < 4) {
      out.text("cx.g[");
      out.uint(register);
      out.byte(0x5d);
      return true;
    }

    return false;
  }

  /**
   * DefineFunction and DefineFunction2: the function made of region
   * `action.region`, with its name, and its parameters that are variables,
   * null for those in a register; a DefineFunction2's flags.
   */
  private defineFunction(actions: Actions, action: Action): void {
    const out = this.out;
    const two = action.opcode === ops.OP_DefineFunction2;
    out.text(two ? "V.defineFunction2(cx, " : "V.defineFunction(cx, ");
    out.uint(action.region);
    out.text(", ");
    this.string(actions, action.first);
    out.text(", [");
    for (let i = 1; i < action.count; i++) {
      if (i > 1) {
        out.text(", ");
      }

      const index = action.first + i;
      if (two && actions.stringRegister[index] !== 0) {
        out.text("null");
      } else {
        this.string(actions, index);
      }
    }
    out.byte(0x5d);
    if (two) {
      out.text(", ");
      out.uint(<u32>action.b);
    }
    out.text(");\n");
  }

  /** Control to `offset`, its block or out of the region, without a line's end. */
  private goto(region: Region, offset: i32): void {
    const out = this.out;
    if (!region.runs(offset)) {
      out.text("return;");
    } else {
      out.text("b = ");
      out.uint(region.blockAt(offset));
      out.text("; continue;");
    }
  }

  private push(actions: Actions, action: Action, pool: i32): void {
    const out = this.out;
    if (action.count === 0) {
      return;
    }

    out.text("st.push(");
    for (let i = action.first; i < action.first + action.count; i++) {
      if (i > action.first) {
        out.text(", ");
      }

      const number = actions.valueNumber[i];
      const index = actions.valueIndex[i];
      switch (actions.valueType[i]) {
        case ops.PUSH_String:
          this.string(actions, index);
          break;
        case ops.PUSH_Float:
        case ops.PUSH_Double:
        case ops.PUSH_Integer:
          out.double(number);
          break;
        case ops.PUSH_Null:
          out.text("null");
          break;
        case ops.PUSH_Undefined:
          out.text("undefined");
          break;
        case ops.PUSH_Boolean:
          out.text(number !== 0 ? "true" : "false");
          break;
        case ops.PUSH_Constant8:
        case ops.PUSH_Constant16:
          this.constant(actions, pool, index);
          break;
        default:
          if (!this.register(index)) {
            out.text("undefined");
          }
          break;
      }
    }

    out.text(");\n");
  }

  /** Constant `index` of pool `pool`: its string, undefined past its end, or the activation's. */
  private constant(actions: Actions, pool: i32, index: i32): void {
    const out = this.out;
    if (pool === POOL_Unknown) {
      out.text("cx.pool[");
      out.uint(index);
      out.text("]");
      return;
    }

    const set = actions.actions[pool];
    if (index < set.count) {
      this.string(actions, set.first + index);
    } else {
      out.text("undefined");
    }
  }

  private string(actions: Actions, index: i32): void {
    avm1String(
      this.out,
      actions.bytes.dataStart + <usize>actions.stringStart[index],
      <u32>actions.stringLength[index],
      this.version >= 6,
    );
  }

  /**
   * `V.<name>` of the `operands` values on top of the stack, the top first,
   * its result pushed.
   */
  private operation(name: string, operands: i32): void {
    const out = this.out;
    out.text("st.push(V.");
    out.text(name);
    out.byte(0x28);
    for (let i = 0; i < operands; i++) {
      out.text(i > 0 ? ", st.pop()" : "st.pop()");
    }

    out.text("));\n");
  }

  private notYet(name: string): void {
    const out = this.out;
    out.text('V.notYet("');
    out.text(name);
    out.text('")');
  }
}

/** Whether a branch of the region goes to one of its blocks, as a loop to its only one. */
function jumpsWithin(actions: Actions, region: Region): bool {
  for (let i = 0; i < region.order.length; i++) {
    const action = actions.actions[region.order[i]];
    if (branches(action) && region.runs(action.target)) {
      return true;
    }

    if (
      action.error === ERROR_None &&
      (action.opcode === ops.OP_With || action.opcode === ops.OP_Try)
    ) {
      return true;
    }
  }

  return false;
}
