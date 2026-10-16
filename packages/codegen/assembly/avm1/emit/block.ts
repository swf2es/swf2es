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
// which make a function of a region, StoreRegister and Return; Extends,
// InstanceOf, CastOp, ImplementsOp and RandomNumber; the clip actions,
// SetTarget, SetTarget2, GetProperty, SetProperty, the gotos, NextFrame,
// PrevFrame, WaitForFrame and WaitForFrame2 (a branch on whether the frame
// is loaded), TargetPath, Call, StopSounds, ToggleQuality, GetTime,
// CloneSprite and RemoveSprite. A function's region takes its `this` and
// its arguments, and a DefineFunction2's registers are its `let`s; every
// other register is one of the movie's four, `cx.g`. A jump back counts
// down V.budget, and the script timeout's check reads the clock only as
// the count runs out. With, Try and Throw are calls too, and a region
// that has a With or a Try keeps what they hold on the activation, by
// ranges of its blocks, which come off as control leaves them (see
// `heldRanges`). Every other action Flash knows is a call that throws,
// V.notYet, and one it does not know is skipped, as Flash skips it. An
// action Flash cannot read, cut short or a Push of a value type it does
// not know, stops the SWF,
// V.halt, as adl does.

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
  /** The block being written. */
  private k: i32 = 0;
  /** Whether the region has a With or a Try: without, it is written as before. */
  private holds: bool = false;
  /**
   * The region's ranges of blocks, `from` and `to` (excluded) in pairs,
   * that a Try's handlers or a finally's throw or Return hold over: control
   * leaving one goes through V.leave.
   */
  private handled: i32[] = [];
  /**
   * The ranges that scopes hold over, With and catch bodies, and the first
   * action past each: control going anywhere else goes through V.leave,
   * and the block past one is `late`, V.scopes after its first action.
   */
  private scoped: i32[] = [];
  private late: bool[] = [];
  /** The finally bodies, which a throw or a Return may leave held to the exit. */
  private finallies: i32[] = [];
  /** The try and catch bodies of Trys with a finally, which a Return runs first. */
  private returns: i32[] = [];
  /** Whether the region has a Try, whose throws its dispatcher catches. */
  private tries: bool = false;
  /** The registers the region's catches take values into. */
  private catchRegisters: i32[] = [];

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
      // A body is called with its `this` and its arguments (docs/avm1.md, "Functions and
      // registers"); a SWF 4's runs as a SWF 5's (the corpus's `swf4_function_calls`).
      out.text("function (cx, self, args) {\nconst st = cx.st;\n");
      if (this.version < 5) {
        out.text("const V = V5;\n");
      }
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
    this.heldRanges(actions, region);
    const dispatch = n > 1 || jumpsWithin(actions, region);
    if (dispatch) {
      out.text("let b = ");
      out.uint(region.blockAt(region.start));
      out.text(
        this.tries ? ";\nfor (;;) try { for (;;) switch (b) {\n" : ";\nfor (;;) switch (b) {\n",
      );
      if (this.holds) {
        out.text("case -1:\nreturn cx.ret;\n");
      }
    }

    for (let k = 0; k < n; k++) {
      if (dispatch) {
        out.text("case ");
        out.uint(k);
        out.text(":\n");
      }

      this.k = k;
      this.code(actions, region, k, pools[k]);
    }

    if (!dispatch) {
      out.text("}");
    } else if (this.tries) {
      out.text("} } catch (e) {\nb = V.caught(cx, e, b);\n");
      this.catchInto();
      out.text("}\n}");
    } else {
      out.text("}\n}");
    }
  }

  /**
   * The ranges of blocks the region's Withs and Trys hold over. The blocks
   * are in order of their offsets, and a body's bounds start blocks, so
   * each body is the blocks from the first at or after its start to the
   * first at or after its end.
   */
  private heldRanges(actions: Actions, region: Region): void {
    const handled = this.handled;
    const scoped = this.scoped;
    const finallies = this.finallies;
    const returns = this.returns;
    const late = this.late;
    handled.length = 0;
    scoped.length = 0;
    finallies.length = 0;
    returns.length = 0;
    late.length = 0;
    this.catchRegisters.length = 0;
    this.tries = false;
    this.holds = false;
    for (let i = 0; i < region.actions.length; i++) {
      const action = actions.actions[region.actions[i]];
      if (action.error !== ERROR_None) {
        continue;
      }

      if (action.opcode === ops.OP_With) {
        this.holds = true;
        scoped.push(firstFrom(region, action.s0));
        scoped.push(firstFrom(region, action.s1));
      } else if (action.opcode === ops.OP_Try) {
        this.holds = true;
        this.tries = true;
        const flags = <u32>action.a;
        const from = firstFrom(region, action.s0);
        const catchFrom = firstFrom(region, action.s1);
        const finallyFrom = firstFrom(region, action.s2);
        const finallyTo = flags & ops.TRY_Finally ? firstFrom(region, action.s3) : finallyFrom;
        handled.push(from);
        handled.push(finallyFrom);
        if (flags & ops.TRY_Catch) {
          // A throw's scopes and the catch's variable hold over the catch body.
          scoped.push(catchFrom);
          scoped.push(finallyFrom);
          if (flags & ops.TRY_CatchInRegister && !this.catchRegisters.includes(action.b)) {
            this.catchRegisters.push(action.b);
          }
        }

        if (finallyFrom < finallyTo) {
          handled.push(finallyFrom);
          handled.push(finallyTo);
          finallies.push(finallyFrom);
          finallies.push(finallyTo);
          returns.push(from);
          returns.push(finallyFrom);
        }
      }
    }

    if (!this.holds) {
      return;
    }

    // The block past each scope's body, whose first action runs in it.
    const n = region.blocks.length;
    for (let k = 0; k < n; k++) {
      late.push(false);
    }

    for (let i = 1; i < scoped.length; i += 2) {
      if (scoped[i] < n) {
        late[scoped[i]] = true;
      }
    }
  }

  /** The catch handler's part that sets a register a catch took a value into. */
  private catchInto(): void {
    const out = this.out;
    const registers = this.catchRegisters;
    if (registers.length === 0) {
      return;
    }

    out.text("switch (cx.into) {\n");
    for (let i = 0; i < registers.length; i++) {
      const r = registers[i];
      if (r >= this.registers && r >= 4) {
        continue;
      }

      out.text("case ");
      out.uint(r);
      out.text(": ");
      this.register(r);
      out.text(" = cx.thrown; break;\n");
    }
    out.text("}\n");
  }

  /** Block `k` of the region, which starts with pool `pool`. */
  private code(actions: Actions, region: Region, k: i32, pool: i32): void {
    const out = this.out;
    const first = region.blockFirst[k];
    const last = region.blockFirst[k + 1] - 1;
    // A late block's first action runs in the scopes whose body it is past, which come off
    // after it, as control goes on in the block. A With there pushes its object over them, and
    // they come off with it (adl); a Try's handlers go over them once they are off.
    let late = this.holds && this.late[k];
    for (let i = first; i <= last; i++) {
      const index = region.order[i];
      const action = actions.actions[index];
      if (late && action.error === ERROR_None) {
        if (action.opcode === ops.OP_Try) {
          this.scopes(k);
          late = false;
        } else if (action.opcode === ops.OP_With || !fallsThrough(action)) {
          late = false;
        }
      }

      this.action(actions, region, action, pool);
      pool = poolAfter(actions, index, pool);
      if (late) {
        this.scopes(k);
        late = false;
      }
    }

    // Where control goes from the block's end; a Jump or a Return has gone already.
    const action = actions.actions[region.order[last]];
    if (!fallsThrough(action)) {
      if (action.error !== ERROR_None) {
        out.text("return;\n");
      } else if (action.opcode === ops.OP_End) {
        this.exit();
        out.byte(0x0a);
      } else if (action.opcode !== ops.OP_Jump && action.opcode !== ops.OP_Return) {
        out.text("return;\n");
      }

      return;
    }

    // The next block in the switch is the next case.
    const to = fallsTo(action);
    if (!region.runs(to) || region.blockAt(to) !== k + 1) {
      this.goto(region, to);
      out.byte(0x0a);
    } else if (leaves(this.handled, k, k + 1)) {
      out.text("b = V.leave(cx, ");
      out.uint(k + 1);
      out.text("); continue;\n");
    } else if (this.tries) {
      // A throw takes the block it is thrown in from `b`.
      out.text("b = ");
      out.uint(k + 1);
      out.text(";\n");
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
      case ops.OP_Extends:
        out.text("V.extends(cx, st.pop(), st.pop());\n");
        break;
      case ops.OP_InstanceOf:
        out.text("st.push(V.instanceOf(cx, st.pop(), st.pop()));\n");
        break;
      case ops.OP_CastOp:
        out.text("st.push(V.castOp(cx, st.pop(), st.pop()));\n");
        break;
      case ops.OP_ImplementsOp:
        out.text("V.implementsOp(cx);\n");
        break;
      case ops.OP_RandomNumber:
        out.text("st.push(V.randomNumber(st.pop()));\n");
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
        // A Try's finally runs first, where one holds.
        if (within(this.returns, this.k)) {
          out.text("b = V.ret(cx); continue;\n");
        } else {
          out.text("return st.pop();\n");
        }
        break;
      case ops.OP_With:
        out.text("if (!V.with(cx, st.pop(), ");
        out.uint(firstFrom(region, action.s0));
        out.text(", ");
        out.uint(firstFrom(region, action.s1));
        out.text(")) { ");
        this.goto(region, action.next);
        out.text(" }\n");
        break;
      case ops.OP_Try:
        this.try(actions, region, action);
        break;
      case ops.OP_Throw:
        out.text("V.throw(st.pop());\n");
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
        this.branch(region, action.target);
        break;
      case ops.OP_WaitForFrame:
        // A frame not loaded skips the actions after.
        out.text("if (!V.frameLoaded(cx, ");
        out.uint(action.a);
        out.text(")) ");
        this.branch(region, action.target);
        break;
      case ops.OP_WaitForFrame2:
        out.text("if (!V.frameLoaded2(cx, st.pop())) ");
        this.branch(region, action.target);
        break;
      case ops.OP_GotoFrame:
        out.text("V.gotoFrame(cx, ");
        out.uint(action.a);
        out.text(");\n");
        break;
      case ops.OP_GotoLabel:
        out.text("V.gotoLabel(cx, ");
        this.string(actions, action.first);
        out.text(");\n");
        break;
      case ops.OP_GotoFrame2:
        out.text(
          action.a !== 0
            ? "V.gotoFrame2(cx, st.pop(), true, "
            : "V.gotoFrame2(cx, st.pop(), false, ",
        );
        out.uint(action.b);
        out.text(");\n");
        break;
      case ops.OP_NextFrame:
        out.text("V.nextFrame(cx);\n");
        break;
      case ops.OP_PreviousFrame:
        out.text("V.prevFrame(cx);\n");
        break;
      case ops.OP_SetTarget:
        out.text("V.setTarget(cx, ");
        this.string(actions, action.first);
        out.text(");\n");
        break;
      case ops.OP_SetTarget2:
        out.text("V.setTarget2(cx, st.pop());\n");
        break;
      case ops.OP_GetProperty:
        out.text("st.push(V.getProperty(cx, st.pop(), st.pop()));\n");
        break;
      case ops.OP_SetProperty:
        out.text("V.setProperty(cx, st.pop(), st.pop(), st.pop());\n");
        break;
      case ops.OP_TargetPath:
        out.text("st.push(V.targetPath(cx, st.pop()));\n");
        break;
      case ops.OP_Call:
        out.text("V.callFrame(cx, st.pop());\n");
        break;
      case ops.OP_StopSounds:
        out.text("V.stopSounds(cx);\n");
        break;
      case ops.OP_GetTime:
        out.text("st.push(V.getTime(cx));\n");
        break;
      case ops.OP_CloneSprite:
        out.text("V.cloneSprite(cx, st.pop(), st.pop(), st.pop());\n");
        break;
      case ops.OP_RemoveSprite:
        out.text("V.removeSprite(cx, st.pop());\n");
        break;
      case ops.OP_ToggleQuality:
        out.text("V.toggleQuality(cx);\n");
        break;
      default:
        if (ops.opcodeKnown[op]) {
          this.notYet(ops.opcodeNames[op]);
          out.text(";\n");
        }
        break;
    }
  }

  /** The branch of an If or a WaitForFrame to `target`: there, or the region's exit. */
  private branch(region: Region, target: i32): void {
    const out = this.out;
    if (region.runs(target) || within(this.finallies, this.k)) {
      out.text("{ ");
      this.goto(region, target);
      out.text(" }\n");
    } else {
      out.text("return;\n");
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

  /**
   * Control from the block being written to `offset`, its block or out of
   * the region, without a line's end: through V.leave where it leaves
   * what a With or a Try holds.
   */
  private goto(region: Region, offset: i32): void {
    const out = this.out;
    if (!region.runs(offset)) {
      this.exit();
      return;
    }

    const to = region.blockAt(offset);
    // A jump back may loop: it counts down to the script timeout's check (docs/avm1.md, "The frame").
    if (to <= this.k) {
      out.text("if (--V.budget < 0) V.timeout(cx); ");
    }

    if (leaves(this.handled, this.k, to) || crosses(this.scoped, this.k, to)) {
      out.text("b = V.leave(cx, ");
      out.uint(to);
      out.text("); continue;");
    } else {
      out.text("b = ");
      out.uint(to);
      out.text("; continue;");
    }
  }

  /** Control out of the region: through V.leave where a finally may hold a throw or a Return. */
  private exit(): void {
    this.out.text(within(this.finallies, this.k) ? "b = V.leave(cx, -1); continue;" : "return;");
  }

  /** V.scopes after the first action of the late block `k`. */
  private scopes(k: i32): void {
    const out = this.out;
    out.text("V.scopes(cx, ");
    out.uint(k);
    out.text(");\n");
  }

  /**
   * Try: its bodies as ranges of blocks, where a throw lands for the catch
   * (-1 out of the region, -2 for none), and the catch's variable or
   * register.
   */
  private try(actions: Actions, region: Region, action: Action): void {
    const out = this.out;
    const flags = <u32>action.a;
    const finallyFrom = firstFrom(region, action.s2);
    out.text("V.try(cx, ");
    out.uint(firstFrom(region, action.s0));
    out.text(", ");
    out.uint(firstFrom(region, action.s1));
    out.text(", ");
    out.uint(finallyFrom);
    out.text(", ");
    out.uint(flags & ops.TRY_Finally ? firstFrom(region, action.s3) : finallyFrom);
    out.text(", ");
    if (!(flags & ops.TRY_Catch)) {
      out.text("-2");
    } else if (region.runs(action.s1)) {
      out.uint(region.blockAt(action.s1));
    } else {
      out.text("-1");
    }
    out.text(", ");
    if (flags & ops.TRY_CatchInRegister) {
      out.uint(action.b);
    } else if (action.count > 0) {
      this.string(actions, action.first);
    } else {
      // Too short for its header: no catch.
      out.text('""');
    }
    out.text(");\n");
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

/** The index of the region's first block at or after `offset`, its count past them all. */
function firstFrom(region: Region, offset: i32): i32 {
  const blocks = region.blocks;
  let low = 0;
  let high = blocks.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (blocks[mid] < offset) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }

  return low;
}

/** Whether control from block `from` to block `to` leaves one of `ranges`. */
function leaves(ranges: i32[], from: i32, to: i32): bool {
  for (let i = 0; i < ranges.length; i += 2) {
    if (ranges[i] <= from && from < ranges[i + 1] && !(ranges[i] <= to && to < ranges[i + 1])) {
      return true;
    }
  }

  return false;
}

/**
 * Whether control from block `from` to block `to` leaves one of the scopes'
 * `ranges`, which hold over the first block past them too, as it starts.
 */
function crosses(ranges: i32[], from: i32, to: i32): bool {
  for (let i = 0; i < ranges.length; i += 2) {
    if (ranges[i] <= from && from <= ranges[i + 1] && !(ranges[i] <= to && to <= ranges[i + 1])) {
      return true;
    }
  }

  return false;
}

/** Whether block `k` is in one of `ranges`, `from` and `to` (excluded) in pairs. */
function within(ranges: i32[], k: i32): bool {
  for (let i = 0; i < ranges.length; i += 2) {
    if (ranges[i] <= k && k < ranges[i + 1]) {
      return true;
    }
  }

  return false;
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
