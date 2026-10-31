// The operand stack as a block writes it: a Push's values, and the value
// an action pushes that the next action takes straight from it, its
// `st.push(value);` and that action's `st.pop()` become the value itself.

import { Action, Actions } from "../actions/decode";
import * as ops from "../actions/opcodes";
import { POOL_Unknown } from "../flow/pool";
import { BlockEmitter } from "./block";

export function push(em: BlockEmitter, actions: Actions, action: Action, pool: i32): void {
  const out = em.out;
  if (action.count === 0) {
    return;
  }

  const start = out.length;
  out.text("st.push(");
  let last = out.length;
  for (let i = action.first; i < action.first + action.count; i++) {
    if (i > action.first) {
      out.text(", ");
    }

    last = out.length;

    const number = actions.valueNumber[i];
    const index = actions.valueIndex[i];
    switch (actions.valueType[i]) {
      case ops.PUSH_String:
        em.string(actions, index);
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
        constant(em, actions, pool, index);
        break;
      default:
        if (!em.register(index)) {
          out.text("undefined");
        }
        break;
    }
  }

  out.text(");\n");
  em.pendStmt = start;
  em.pendExpr = last;
  em.pendMulti = action.count > 1;
  em.pendEnd = out.length;
}

/** Constant `index` of pool `pool`: its string, undefined past its end, or the activation's. */
function constant(em: BlockEmitter, actions: Actions, pool: i32, index: i32): void {
  const out = em.out;
  if (pool === POOL_Unknown) {
    out.text("cx.pool[");
    out.uint(index);
    out.text("]");
    return;
  }

  const set = actions.actions[pool];
  if (index < set.count) {
    em.string(actions, set.first + index);
  } else {
    out.text("undefined");
  }
}

/**
 * `V.<name>` of the `operands` values on top of the stack, the top first,
 * its result pushed.
 */
export function operation(em: BlockEmitter, name: string, operands: i32): void {
  const out = em.out;
  const start = detach(em);
  out.text("st.push(V.");
  out.text(name);
  out.byte(0x28);
  value(em);
  out.text(
    operands === 3 ? ", st.pop(), st.pop()));\n" : operands === 2 ? ", st.pop()));\n" : "));\n",
  );
  pushed(em, start);
}

/**
 * `prefix`, the value on top of the stack, popped, and `rest`: where the
 * action before pushed it, `st.push(value);` and `st.pop()` become the
 * value itself, evaluated where the push was, as nothing comes between.
 * Where the statement it writes starts.
 */
export function top(em: BlockEmitter, prefix: string, rest: string): u32 {
  const out = em.out;
  const start = detach(em);
  out.text(prefix);
  value(em);
  out.text(rest);
  return start;
}

/**
 * The value the action before pushed, if any, taken out of its push into
 * `scratch`; where the statement that takes it starts.
 */
function detach(em: BlockEmitter): u32 {
  const out = em.out;
  em.detached = -1;
  if (em.pendEnd === 0 || em.pendEnd !== out.length) {
    return out.length;
  }

  // The value, out of its push, after what stays of that push.
  const from = em.pendExpr;
  const length = out.length - 3 - from;
  if (length > <u32>em.scratch.length) {
    em.scratch = new StaticArray<u8>(max(<i32>length, em.scratch.length * 2));
  }

  memory.copy(changetype<usize>(em.scratch), changetype<usize>(out.bytes) + from, length);
  if (em.pendMulti) {
    out.length = from - 2;
    out.text(");\n");
  } else {
    out.length = em.pendStmt;
  }

  em.detached = <i32>length;
  return out.length;
}

/** The value detach took, else `st.pop()`. */
function value(em: BlockEmitter): void {
  const out = em.out;
  const length = em.detached;
  if (length < 0) {
    out.text("st.pop()");
  } else {
    out.reserve(<u32>length);
    memory.copy(
      changetype<usize>(out.bytes) + out.length,
      changetype<usize>(em.scratch),
      <usize>length,
    );
    out.length += <u32>length;
  }

  em.pendEnd = 0;
}

/**
 * The statement from `start`, `st.push(value);`, then `text` if given,
 * whose value the next action may take.
 */
export function pushed(em: BlockEmitter, start: u32, text: string | null = null): void {
  if (text !== null) {
    em.out.text(text);
  }

  em.pendStmt = start;
  em.pendExpr = start + 8;
  em.pendMulti = false;
  em.pendEnd = em.out.length;
}
