// One instruction's checks, as Verifier::verifyBlock makes them and in its
// order: the operands that index the constant pool and the method's tables,
// the stack and scope depths, and what only some opcodes check; then its
// types (typing.ts), and for an instruction that wrote no IR of its own,
// the generic row the second pass writes for it.

import { TYPE_Any } from "../link/traits";
import { BodyDecoder, isBinding } from "./code";
import * as C from "./constants";
import * as ops from "./opcodes";
import {
  opcodePops,
  opcodePushes,
  opcodeStack,
  STACK_ArgcA,
  STACK_ArgcB,
  STACK_CheckPushOne,
  STACK_Multiname,
} from "./opcodes";
import { ConstantPool } from "./pool";
import { numericType, typeAt } from "./typing";

/**
 * The IR of an instruction that wrote none of its own: its opcode reading
 * the values it popped, or the register it names, and writing what it
 * pushed; branches name their target blocks.
 */
function emitGeneric(
  bd: BodyDecoder,
  pc: u32,
  opcode: u8,
  a: u32,
  b: u32,
  stackBefore: u32,
  scopeBefore: u32,
  pops: u32,
): void {
  const base = bd.stackBase;
  let src = <i32>(base + stackBefore - pops);
  let count = pops;
  let dst = bd.stack > stackBefore - pops ? <i32>(base + bd.stack - 1) : -1;
  let ra = a;
  switch (opcode) {
    case ops.OP_label:
    case ops.OP_nop:
    case ops.OP_bkpt:
    case ops.OP_bkptline:
    case ops.OP_timestamp:
      return;
    case ops.OP_getlocal:
      src = <i32>a;
      count = 1;
      break;
    case ops.OP_setlocal:
      dst = <i32>a;
      break;
    case ops.OP_pushscope:
    case ops.OP_pushwith:
      dst = <i32>(bd.localCount + scopeBefore);
      break;
    case ops.OP_popscope:
      src = <i32>(bd.localCount + scopeBefore - 1);
      count = 1;
      break;
    case ops.OP_getscopeobject:
      ra = <u32>load<u8>(bd.start + pc + 1);
      src = <i32>(bd.localCount + ra);
      count = 1;
      break;
    // Slots count from 0 in the IR, as early bound ones do.
    case ops.OP_getslot:
    case ops.OP_setslot:
    case ops.OP_getglobalslot:
    case ops.OP_setglobalslot:
      ra = a - 1;
      break;
    case ops.OP_jump:
    case ops.OP_iftrue:
    case ops.OP_iffalse:
    case ops.OP_ifeq:
    case ops.OP_ifne:
    case ops.OP_iflt:
    case ops.OP_ifle:
    case ops.OP_ifgt:
    case ops.OP_ifge:
    case ops.OP_ifstricteq:
    case ops.OP_ifstrictne:
    case ops.OP_ifnlt:
    case ops.OP_ifnle:
    case ops.OP_ifngt:
    case ops.OP_ifnge:
      ra = bd.blockOf[bd.slotNext[pc] + <u32>bd.slotA[pc]];
      break;
    case ops.OP_lookupswitch: {
      const ir = bd.ir;
      const first = bd.slotC[pc];
      const cases = ir.caseCount;
      for (let i = first; i <= first + b; i++) {
        ir.addCase(bd.blockOf[pc + bd.code.cases[i]]);
      }

      bd.emit(opcode, -1, src, count, bd.blockOf[pc + bd.slotA[pc]], cases, <i32>b, pc);
      return;
    }
    default:
      break;
  }

  if (opcode >= ops.OP_getlocal0 && opcode < ops.OP_getlocal0 + 4) {
    src = <i32>(opcode - ops.OP_getlocal0);
    count = 1;
  } else if (opcode >= ops.OP_setlocal0 && opcode < ops.OP_setlocal0 + 4) {
    dst = <i32>(opcode - ops.OP_setlocal0);
  }

  bd.emit(opcode, dst, src, count, ra, b, bd.rowC, pc);
}

/**
 * The checks of the instruction at `pc` in Verifier::verifyBlock, in the
 * verifier's order, and its effect on the stack and scope depths and, when
 * typed, on the values; false after recording the error.
 */
export function verifyAt(bd: BodyDecoder, pc: u32, opcode: u8): bool {
  const pool = bd.abc.pool;
  const a = <u32>bd.slotA[pc];
  const b = bd.slotB[pc];
  const stack = opcodeStack[opcode];
  let pops = <u64>opcodePops[opcode];
  const pushes = <u64>opcodePushes[opcode];
  const checkPushes = stack & STACK_CheckPushOne ? 1 : pushes;

  // A name looked up in the scope chain needs a scope to look in.
  if (
    bd.typed &&
    (opcode === ops.OP_getlex ||
      opcode === ops.OP_findpropstrict ||
      opcode === ops.OP_findproperty) &&
    bd.scope + bd.outer.size === 0
  ) {
    return bd.fail(C.kFindVarWithNoScopeError);
  }

  // Operands that index the pool or the method tables, checked before the stack.
  if (stack & STACK_Multiname) {
    if (a === 0 || a >= pool.multinameCount) {
      return bd.fail(C.kCpoolIndexRangeError);
    }

    pops += runtimeParts(pool, a);
  }

  if (stack & STACK_ArgcA) {
    pops += a;
  } else if (stack & STACK_ArgcB) {
    pops += b;
  }

  switch (opcode) {
    case ops.OP_newobject:
      pops = <u64>a * 2;
      break;
    case ops.OP_newarray:
      pops = a;
      break;
    case ops.OP_callstatic:
      if (a >= bd.abc.methodCount || !callable(bd, a)) {
        return bd.fail(C.kCorruptABCError);
      }
      break;
    case ops.OP_dxns:
      if (!(bd.methodFlags & C.METHOD_SetsDxns)) {
        return bd.fail(C.kIllegalSetDxns);
      }

      if (bd.emitPass) {
        bd.emit(opcode, -1, -1, 0, a, 0, 0, pc);
      }

      return bd.checkString(a);
    case ops.OP_debugfile:
      if (bd.emitPass) {
        bd.emit(opcode, -1, -1, 0, a, 0, 0, pc);
      }

      return bd.checkString(a);
    case ops.OP_kill:
      if (!bd.checkLocal(a)) {
        return false;
      }

      if (bd.typed) {
        bd.setValue(a, TYPE_Any, 0);
      }

      if (bd.emitPass) {
        bd.emit(opcode, <i32>a, -1, 0, a, 0, 0, pc);
      }

      return true;
    case ops.OP_inclocal:
    case ops.OP_declocal:
    case ops.OP_inclocal_i:
    case ops.OP_declocal_i: {
      if (!bd.checkLocal(a)) {
        return false;
      }

      if (bd.typed) {
        const integer = opcode === ops.OP_inclocal_i || opcode === ops.OP_declocal_i;
        const numeric = numericType(bd, bd.typeOf(a));
        if (!integer && bd.abc.hasFloatSupport && numeric !== bd.domain.numberType) {
          bd.retype(a, numeric);
        } else {
          bd.coerce(a, integer ? bd.domain.intType : bd.domain.numberType);
        }
      }

      if (bd.emitPass) {
        bd.emit(opcode, <i32>a, <i32>a, 1, a, 0, 0, pc);
      }

      return true;
    }
    case ops.OP_popscope:
      if (bd.scope === 0) {
        return bd.fail(C.kScopeStackUnderflowError);
      }

      bd.scope--;
      if (bd.emitPass) {
        bd.emit(opcode, -1, <i32>(bd.localCount + bd.scope), 1, 0, 0, 0, pc);
      }

      return true;
    case ops.OP_setglobalslot:
      if (bd.typed && bd.scope === 0 && bd.outer.size === 0) {
        return bd.fail(C.kNoGlobalScopeError);
      }
      break;
    default:
      break;
  }

  if (<u64>bd.stack < pops) {
    return bd.fail(C.kStackUnderflowError);
  }

  if (<u64>bd.stack - pops + checkPushes > bd.maxStack) {
    return bd.fail(C.kStackOverflowError);
  }

  const scopeBefore = bd.scope;
  if (!verifySpecial(bd, pc, opcode, a, b)) {
    return false;
  }

  bd.emitted = false;
  bd.rowC = 0;
  bd.pc = pc;
  if (bd.typed && !typeAt(bd, pc, opcode, a, b, scopeBefore)) {
    return false;
  }

  const stackBefore = bd.stack;
  bd.stack = <u32>(<u64>bd.stack - pops + pushes);
  if (bd.emitPass && !bd.emitted) {
    emitGeneric(bd, pc, opcode, a, b, stackBefore, scopeBefore, <u32>pops);
  }

  return true;
}

/** The checks after the stack check that only some opcodes have. */
function verifySpecial(bd: BodyDecoder, pc: u32, opcode: u8, a: u32, b: u32): bool {
  const abc = bd.abc;
  const pool = abc.pool;
  if (opcode >= ops.OP_getlocal0 && opcode < ops.OP_getlocal0 + 4) {
    return bd.checkLocal(opcode - ops.OP_getlocal0);
  }

  if (opcode >= ops.OP_setlocal0 && opcode < ops.OP_setlocal0 + 4) {
    return bd.checkLocal(opcode - ops.OP_setlocal0);
  }

  switch (opcode) {
    case ops.OP_getlocal:
    case ops.OP_setlocal:
      return bd.checkLocal(a);
    case ops.OP_hasnext2:
      if (!bd.checkLocal(a) || !bd.checkLocal(b)) {
        return false;
      }

      return a === b ? bd.fail(C.kInvalidHasNextError) : true;
    case ops.OP_pushstring:
      return bd.checkString(a);
    case ops.OP_pushint:
      return a === 0 || a >= <u32>pool.ints.length ? bd.fail(C.kCpoolIndexRangeError) : true;
    case ops.OP_pushuint:
      return a === 0 || a >= <u32>pool.uints.length ? bd.fail(C.kCpoolIndexRangeError) : true;
    case ops.OP_pushfloat:
      return a === 0 || a >= <u32>pool.floats.length ? bd.fail(C.kCpoolIndexRangeError) : true;
    case ops.OP_pushdouble:
      return a === 0 || a >= <u32>pool.doubles.length ? bd.fail(C.kCpoolIndexRangeError) : true;
    case ops.OP_pushnamespace:
      return a === 0 || a >= pool.nsCount ? bd.fail(C.kCpoolIndexRangeError) : true;
    case ops.OP_dxnslate:
      return bd.methodFlags & C.METHOD_SetsDxns ? true : bd.fail(C.kIllegalSetDxns);
    case ops.OP_getlex:
      return runtimeParts(pool, a) ? bd.fail(C.kIllegalOpMultinameError) : true;
    case ops.OP_finddef:
      return isBinding(pool, a) ? true : bd.fail(C.kIllegalOpMultinameError);
    case ops.OP_callproperty:
    case ops.OP_callproplex:
    case ops.OP_callpropvoid:
    case ops.OP_constructprop:
    case ops.OP_callsuper:
    case ops.OP_callsupervoid:
    case ops.OP_getsuper:
    case ops.OP_setsuper:
      return isAttribute(pool, a) ? bd.fail(C.kIllegalOpMultinameError) : true;
    case ops.OP_newfunction:
      return a >= abc.methodCount ? bd.fail(C.kMethodInfoExceedsCountError) : true;
    case ops.OP_newclass:
      return a >= abc.classCount ? bd.fail(C.kClassInfoExceedsCountError) : true;
    case ops.OP_newactivation:
      return bd.methodFlags & C.METHOD_NeedActivation
        ? true
        : bd.fail(C.kInvalidNewActivationError);
    case ops.OP_newcatch:
      return a >= bd.handlerCount ? bd.fail(C.kInvalidNewActivationError) : true;
    case ops.OP_pushscope:
    case ops.OP_pushwith:
      if (bd.scope + 1 > bd.maxScope) {
        return bd.fail(C.kScopeStackOverflowError);
      }

      bd.scope++;
      return true;
    case ops.OP_getscopeobject:
      // The verifier reads the index as the operand's first byte.
      return <u32>load<u8>(bd.start + pc + 1) >= bd.scope
        ? bd.fail(C.kGetScopeObjectBoundsError)
        : true;
    default:
      return true;
  }
}

/**
 * Whether method `m` of bd ABC may be called statically: without types
 * any may, as the structural checks cannot tell; with them, as avmplus'
 * AbcEnv, one bound to a traits by a method, getter or setter.
 */
function callable(bd: BodyDecoder, m: u32): bool {
  const domain = bd.domain;
  if (!bd.typed) {
    return true;
  }

  return domain.isVirtual(domain.methodStart[bd.index] + m);
}

/** Values a multiname takes from the stack: a runtime namespace, a runtime name, or both. */
function runtimeParts(pool: ConstantPool, index: u32): u32 {
  const kind = pool.mnKind[index];
  if (
    kind === C.CONSTANT_RTQname ||
    kind === C.CONSTANT_RTQnameA ||
    kind === C.CONSTANT_MultinameL ||
    kind === C.CONSTANT_MultinameLA
  ) {
    return 1;
  }

  return kind === C.CONSTANT_RTQnameL || kind === C.CONSTANT_RTQnameLA ? 2 : 0;
}

function isAttribute(pool: ConstantPool, index: u32): bool {
  const kind = pool.mnKind[index];
  return (
    kind === C.CONSTANT_QnameA ||
    kind === C.CONSTANT_RTQnameA ||
    kind === C.CONSTANT_RTQnameLA ||
    kind === C.CONSTANT_MultinameA ||
    kind === C.CONSTANT_MultinameLA
  );
}
