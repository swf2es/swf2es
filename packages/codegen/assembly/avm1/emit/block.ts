// An AVM1 block as JavaScript: an array of its regions' functions, the
// block's own code first, then its functions' bodies, each written once in
// the dispatcher form (docs/avm1.md, "The dispatcher"), never inlined into
// the region that defines it, since a body may define itself. A region
// makes its operand stack, `st`, a JavaScript array. A region whose code
// is one block that nothing jumps into is written straight, without the
// dispatcher.
//
// The actions written so far: Push of constants, ConstantPool, Trace, Pop,
// Jump, If, Play, Stop and End. Every other action Flash knows is a call
// that throws, V.notYet, and one it does not know is skipped, as Flash
// skips it. An action Flash cannot read, cut short or a Push of a value
// type it does not know, stops the SWF, V.halt, as adl does.

import { Output } from "../../output";
import { Action, Actions, ERROR_None } from "../actions/decode";
import * as ops from "../actions/opcodes";
import { POOL_Unknown, poolAfter, poolsOf } from "../flow/pool";
import { branches, Flow, fallsThrough, fallsTo, Region } from "../flow/regions";
import { avm1String } from "./strings";

@final
export class BlockEmitter {
  /** The SWF's version, which decides how its strings read. */
  version: i32 = 0;

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
    out.text("function (cx) {\nconst st = [];\n");

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

    // Where control goes from the block's end; a Jump has gone already.
    const action = actions.actions[region.order[last]];
    if (!fallsThrough(action)) {
      if (action.error !== ERROR_None || action.opcode !== ops.OP_Jump) {
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
          this.notYet("Push of a register");
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
