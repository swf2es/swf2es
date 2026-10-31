// An AVM1 block as JavaScript: an array of its regions' functions, the
// block's own code first, then its functions' bodies, each written once in
// the dispatcher form (docs/avm1.md, "The dispatcher"), never inlined into
// the region that defines it, since a body may define itself. A region
// takes the operand stack, `st`, from the activation, since Flash's is one
// stack that a frame's blocks and the calls they make share. A region whose code
// is one block that nothing jumps into is written straight, without the
// dispatcher. Its actions are actions.ts's, where control goes control.ts's,
// and its operand stack stack.ts's.

import { Output } from "../../output";
import { Action, Actions, ERROR_None } from "../actions/decode";
import * as ops from "../actions/opcodes";
import { poolAfter, poolsOf } from "../flow/pool";
import { Flow, fallsThrough, fallsTo, REGION_Function, REGION_Unit, Region } from "../flow/regions";
import { action as writeAction } from "./actions";
import {
  catchInto,
  end,
  exit,
  firstFrom,
  goto,
  heldRanges,
  jumpsWithin,
  leaves,
  scopes,
} from "./control";
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
  registers: i32 = 0;
  /** The block being written. */
  k: i32 = 0;
  /** Whether the region has a With or a Try: without, it is written as before. */
  holds: bool = false;
  /**
   * The region's ranges of blocks, `from` and `to` (excluded) in pairs,
   * that a Try's handlers or a finally's throw or Return hold over: control
   * leaving one goes through V.leave.
   */
  handled: i32[] = [];
  /**
   * The ranges that scopes hold over, With and catch bodies, and the first
   * action past each: control going anywhere else goes through V.leave,
   * and the block past one is `late`, V.scopes after its first action.
   */
  scoped: i32[] = [];
  late: bool[] = [];
  /** The finally bodies, which a throw or a Return may leave held to the exit. */
  finallies: i32[] = [];
  /** The try and catch bodies of Trys with a finally, which a Return runs first. */
  returns: i32[] = [];
  /** Whether the region has a Try, whose throws its dispatcher catches. */
  tries: bool = false;
  /** The registers the region's catches take values into. */
  catchRegisters: i32[] = [];
  /**
   * The push the last action wrote, whose last value the next action may
   * take as it is (`top`): where its statement and that value start, and
   * where it ends, 0 where there is none; whether values come before it.
   */
  pendStmt: u32 = 0;
  pendExpr: u32 = 0;
  pendEnd: u32 = 0;
  pendMulti: bool = false;
  scratch: StaticArray<u8> = new StaticArray<u8>(256);
  /** How long the value `detach` took is, -1 for none. */
  detached: i32 = -1;
  /** Whether the region being written is a unit's own, which returns where control goes. */
  inUnit: bool = false;
  /** Whether the unit being written runs as a SWF 5's function, `V5`. */
  private unitFive: bool = false;
  /** Whether the region being written runs as a SWF 5's function. */
  five: bool = false;
  /**
   * The units the code written so far goes on in through V.far, four
   * numbers each: the offset in the SWF, where its region ends, where its
   * actions' bytes end and whether it runs as a SWF 5's function.
   */
  units: i32[] = [];
  /** The offsets in the SWF a unit's own code returns, where control goes on. */
  exits: i32[] = [];
  /**
   * What the last unit written depends on: the same unit runs for a
   * region that ends at or past `unitHigh`, its actions' bytes ending at
   * or past `unitReach` (V.far); -1 for neither, only its own.
   */
  unitHigh: i64 = 0;
  unitReach: i64 = 0;

  // The minimal runtime cannot reclaim each block's analysis during a module call.
  actions: Actions = new Actions(new Uint8Array(0));
  private flow: Flow = new Flow(this.actions);
  private pools: StaticArray<i32> = new StaticArray<i32>(0);
  private poolWork: i32[] = [];

  constructor(public out: Output) {}

  /** The block's entry, retaining the surrounding SWF for backward jumps. */
  block(bytes: Uint8Array, offset: i32, length: i32): void {
    if (offset < 0 || length < 0 || <i64>offset + <i64>length > <i64>bytes.length) {
      bytes = new Uint8Array(0);
      offset = 0;
      length = 0;
    }

    const actions = this.actions;
    actions.reset(bytes, offset, length);
    this.flow.reset();
    this.unitFive = false;
    this.regions(actions);
  }

  /**
   * The unit of the code at `at` in the SWF, of a region that runs until
   * control is at or past `end`, its actions read up to `bound`; `five` if
   * it runs as a SWF 5's function. Written as a block is, its own code
   * returning where control goes on: an offset in the SWF, -1 where the
   * region ends, -2 where it returns `cx.ret`.
   *
   * Its home is the bytes from `at` up to `high` (units.ts): what it
   * reaches there, a loop that stays there included, runs in one function,
   * and a jump back before `at` goes on in another unit, so that a loop
   * whose head is before it goes round through V.far.
   */
  unit(bytes: Uint8Array, at: i32, end: i32, bound: i32, five: bool, high: i32): void {
    const actions = this.actions;
    const home = high - at;
    actions.reset(bytes, at, bound - at, home);
    const flow = this.flow;
    flow.reset(REGION_Unit, 0, end - at, 0, home);
    this.unitFive = five;
    const calls = this.units.length;
    this.regions(actions);
    // A region that keeps all it reaches, which may reach the region's end,
    // a call of V.far, which names the bound, or an action that the bytes'
    // end cut short, which more bytes might not, make the unit this
    // region's alone.
    if (flow.widened || flow.tooLarge || this.units.length > calls || actions.reach > bound - at) {
      this.unitHigh = -1;
      this.unitReach = -1;
    } else {
      this.unitHigh = <i64>high;
      this.unitReach = <i64>at + actions.reach;
    }
  }

  private regions(actions: Actions): void {
    const out = this.out;
    const flow = this.flow;
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
    this.inUnit = region.kind === REGION_Unit;
    this.five = region.kind === REGION_Function ? this.version < 5 : this.inUnit && this.unitFive;
    if (region.kind !== REGION_Function) {
      out.text("function (cx) {\nconst st = cx.st;\n");
      if (this.five) {
        out.text("const V = V5;\n");
      }
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

    const pools = poolsOf(actions, region, this.pools, this.poolWork);
    this.pools = pools;
    heldRanges(this, actions, region);
    const dispatch = n > 1 || jumpsWithin(actions, region);
    if (dispatch) {
      out.text("let b = ");
      out.uint(region.blockAt(region.start));
      out.text(
        this.tries ? ";\nfor (;;) try { for (;;) switch (b) {\n" : ";\nfor (;;) switch (b) {\n",
      );
      if (this.holds) {
        out.text(this.inUnit ? "case -1:\nreturn -2;\n" : "case -1:\nreturn cx.ret;\n");
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
      catchInto(this);
      out.text("}\n}");
    } else {
      out.text("}\n}");
    }
  }

  /** Block `k` of the region, which starts with pool `pool`. */
  private code(actions: Actions, region: Region, k: i32, pool: i32): void {
    const out = this.out;
    this.pendEnd = 0;
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
          scopes(this, k);
          late = false;
        } else if (action.opcode === ops.OP_With || !fallsThrough(action)) {
          late = false;
        }
      }

      writeAction(this, actions, region, action, pool);
      pool = poolAfter(actions, index, pool);
      if (late) {
        scopes(this, k);
        late = false;
      }
    }

    // Where control goes from the block's end; a Jump or a Return has gone already.
    const action = actions.actions[region.order[last]];
    if (!fallsThrough(action)) {
      if (action.error !== ERROR_None) {
        end(this);
      } else if (action.opcode === ops.OP_End) {
        exit(this);
        out.byte(0x0a);
      } else if (action.opcode !== ops.OP_Jump && action.opcode !== ops.OP_Return) {
        end(this);
      }

      return;
    }

    // The next block in the switch is the next case.
    const to = fallsTo(action);
    if (!region.runs(to) || region.blockAt(to) !== k + 1) {
      goto(this, region, to);
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
  register(register: i32): bool {
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
   * Try: its bodies as ranges of blocks, where a throw lands for the catch
   * (-1 out of the region, -2 for none), and the catch's variable or
   * register.
   */
  try(actions: Actions, region: Region, action: Action): void {
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

  string(actions: Actions, index: i32): void {
    avm1String(
      this.out,
      actions.bytes.dataStart + <usize>actions.stringStart[index],
      <u32>actions.stringLength[index],
      this.version >= 6,
    );
  }
}
