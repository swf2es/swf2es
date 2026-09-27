// Decodes a method body's bytecode the way avmplus' Verifier walks it: from
// the entry along fall-through, branches and the exception handlers that a
// reachable instruction can trigger. Unreachable bytes are never read, as in
// Flash; obfuscated SWFs often hide junk there.
//
// On the way it checks the method's structure as the verifier does, with its
// VerifyError numbers: frame limits, operand stack and scope stack depths at
// every instruction and where paths join, local registers, and operands that
// index the constant pool or the method's tables. Types and bindings, and
// anything that needs the scope chain the method is created in, come later.
//
// A BodyDecoder is made once per ABC and reused for every body: its scratch
// buffers and its output only grow, so decoding allocates nothing per body.
import { Abc } from "./abc";
import {
  CONSTANT_Multiname,
  CONSTANT_MultinameA,
  CONSTANT_MultinameL,
  CONSTANT_MultinameLA,
  CONSTANT_Qname,
  CONSTANT_QnameA,
  CONSTANT_RTQname,
  CONSTANT_RTQnameA,
  CONSTANT_RTQnameL,
  CONSTANT_RTQnameLA,
  CONSTANT_TypeName,
  kCannotFallOffMethodError,
  kClassInfoExceedsCountError,
  kCorruptABCError,
  kCpoolIndexRangeError,
  kGetScopeObjectBoundsError,
  kIllegalExceptionHandlerError,
  kIllegalOpcodeError,
  kIllegalOpMultinameError,
  kIllegalSetDxns,
  kInvalidBranchTargetError,
  kInvalidHasNextError,
  kInvalidNewActivationError,
  kInvalidRegisterError,
  kLastInstExceedsCodeSizeError,
  kMethodInfoExceedsCountError,
  kScopeDepthUnbalancedError,
  kScopeStackOverflowError,
  kScopeStackUnderflowError,
  kStackDepthUnbalancedError,
  kStackOverflowError,
  kStackUnderflowError,
  METHOD_NeedActivation,
  METHOD_NeedArguments,
  METHOD_NeedRest,
  METHOD_SetsDxns,
} from "./constants";
import {
  FLAG_Terminal,
  FLAG_Throws,
  OP_callproperty,
  OP_callproplex,
  OP_callpropvoid,
  OP_callstatic,
  OP_callsuper,
  OP_callsupervoid,
  OP_constructprop,
  OP_debugfile,
  OP_declocal,
  OP_declocal_i,
  OP_dxns,
  OP_dxnslate,
  OP_finddef,
  OP_getlex,
  OP_getlocal,
  OP_getlocal0,
  OP_getscopeobject,
  OP_getsuper,
  OP_hasnext2,
  OP_inclocal,
  OP_inclocal_i,
  OP_kill,
  OP_label,
  OP_lookupswitch,
  OP_newactivation,
  OP_newarray,
  OP_newcatch,
  OP_newclass,
  OP_newfunction,
  OP_newobject,
  OP_popscope,
  OP_pushdouble,
  OP_pushint,
  OP_pushnamespace,
  OP_pushscope,
  OP_pushstring,
  OP_pushuint,
  OP_pushwith,
  OP_setlocal,
  OP_setlocal0,
  OP_setsuper,
  OPERANDS_Branch,
  OPERANDS_Byte,
  OPERANDS_Debug,
  OPERANDS_Illegal,
  OPERANDS_Short,
  OPERANDS_Switch,
  OPERANDS_U30,
  OPERANDS_U30U30,
  opcodeFlags,
  opcodeOperands,
  opcodePops,
  opcodePushes,
  opcodeStack,
  STACK_ArgcA,
  STACK_ArgcB,
  STACK_CheckPushOne,
  STACK_Multiname,
} from "./opcodes";
import { ConstantPool } from "./pool";
import { Reader } from "./reader";

/**
 * The reachable instructions of one body, ordered by offset; entries past
 * `count` are stale. Operands: a is the first u30, the signed branch offset,
 * or pushbyte/pushshort's value; b the second u30 (debug: string index;
 * lookupswitch: case count - 1); c debug's register, or where lookupswitch's
 * case offsets start in `cases`.
 */
@final
export class Code {
  /** 0, or the VerifyError number avmplus would throw; then the lists are incomplete. */
  error: i32 = 0;
  count: u32 = 0;
  offset: StaticArray<u32> = new StaticArray<u32>(0);
  /** Offset of the next instruction in the code. */
  next: StaticArray<u32> = new StaticArray<u32>(0);
  opcode: StaticArray<u8> = new StaticArray<u8>(0);
  a: StaticArray<i32> = new StaticArray<i32>(0);
  b: StaticArray<u32> = new StaticArray<u32>(0);
  c: StaticArray<u32> = new StaticArray<u32>(0);
  /** lookupswitch case offsets, relative to the instruction; `caseCount` are valid. */
  cases: StaticArray<i32> = new StaticArray<i32>(0);
  caseCount: u32 = 0;

  fail(error: i32): Code {
    if (!this.error) {
      this.error = error;
    }

    return this;
  }

  /** Room for `count` instructions; old contents are not kept. */
  reserve(count: u32): void {
    if (<u32>this.offset.length >= count) {
      return;
    }

    const capacity = max(count, <u32>this.offset.length * 2);
    this.offset = new StaticArray<u32>(capacity);
    this.next = new StaticArray<u32>(capacity);
    this.opcode = new StaticArray<u8>(capacity);
    this.a = new StaticArray<i32>(capacity);
    this.b = new StaticArray<u32>(capacity);
    this.c = new StaticArray<u32>(capacity);
  }

  pushCase(offset: i32): void {
    if (this.caseCount === <u32>this.cases.length) {
      const grown = new StaticArray<i32>(max(16, this.cases.length * 2));
      memory.copy(changetype<usize>(grown), changetype<usize>(this.cases), this.caseCount << 2);
      this.cases = grown;
    }

    unchecked((this.cases[this.caseCount++] = offset));
  }
}

// Byte states in BodyDecoder.cover, which starts zeroed: unseen.
const START: u8 = 1;
const INSIDE: u8 = 2;

@final
export class BodyDecoder {
  /** The last decode's result, overwritten by the next one. */
  code: Code = new Code();
  r: Reader;

  // Scratch for the body being decoded, sized to the longest body so far.
  capacity: u32 = 0;
  /** Whether each byte starts an instruction, lies inside one, or is unseen (0). */
  cover: StaticArray<u8> = new StaticArray<u8>(0);
  /** Offsets with a known frame state: branch and handler targets. */
  known: StaticArray<u8> = new StaticArray<u8>(0);
  /** Targets of backward branches. */
  loopHeader: StaticArray<u8> = new StaticArray<u8>(0);
  /** Each decoded instruction's operands and end, by its offset. */
  slotNext: StaticArray<u32> = new StaticArray<u32>(0);
  slotA: StaticArray<i32> = new StaticArray<i32>(0);
  slotB: StaticArray<u32> = new StaticArray<u32>(0);
  slotC: StaticArray<u32> = new StaticArray<u32>(0);
  /** Operand and scope stack depth where each decoded instruction starts. */
  stackAt: StaticArray<u32> = new StaticArray<u32>(0);
  scopeAt: StaticArray<u32> = new StaticArray<u32>(0);
  /** The frame state a known target is entered with; every path in must match. */
  entryStack: StaticArray<u32> = new StaticArray<u32>(0);
  entryScope: StaticArray<u32> = new StaticArray<u32>(0);
  /** Block starts still to decode; each offset is pushed at most once. */
  work: StaticArray<u32> = new StaticArray<u32>(0);
  workCount: u32 = 0;

  start: usize = 0;
  length: u32 = 0;
  instructions: u32 = 0;
  handlerFirst: u32 = 0;
  handlerCount: u32 = 0;
  tryFrom: u32 = 0;
  tryTo: u32 = 0;
  /** A branch into the middle of an instruction, reported after other errors. */
  overlap: bool = false;

  // The method being verified and the frame state of the block being decoded.
  method: u32 = 0;
  methodFlags: u8 = 0;
  maxStack: u32 = 0;
  localCount: u32 = 0;
  maxScope: u32 = 0;
  stack: u32 = 0;
  scope: u32 = 0;

  constructor(
    public abc: Abc,
    public base: usize,
  ) {
    // Operands may read past the code up to the end of the ABC, as avmplus'
    // do into its padding; the end of the code is checked per instruction.
    this.r = new Reader(base, base + abc.length);
  }

  /** Decode body `body`; the result is valid until the next call. */
  decode(body: u32): Code {
    const abc = this.abc;
    const code = this.code;
    code.error = 0;
    code.count = 0;
    code.caseCount = 0;

    this.start = this.base + unchecked(abc.bodyCodeStart[body]);
    this.length = unchecked(abc.bodyCodeLength[body]);
    this.handlerFirst = unchecked(abc.bodyExceptionStart[body]);
    this.handlerCount = unchecked(abc.bodyExceptionStart[body + 1]) - this.handlerFirst;
    this.instructions = 0;
    this.workCount = 0;
    this.overlap = false;
    this.r.failed = false;
    this.method = unchecked(abc.bodyMethod[body]);
    this.methodFlags = unchecked(abc.methodFlags[this.method]);
    this.maxStack = unchecked(abc.bodyMaxStack[body]);
    this.localCount = unchecked(abc.bodyLocalCount[body]);
    this.reset();

    // As Verifier::verify: frame limits, exception handlers, then parameters.
    if (!this.checkFrame(body) || !this.checkHandlers() || !this.checkParams()) {
      return code;
    }

    // Code starting with a label is a block target, so loops may branch to it.
    if (load<u8>(this.start) === OP_label) {
      this.target(-1, 0, 0, 0);
    } else if (!this.block(0, 0, 0)) {
      return code;
    }

    while (this.workCount) {
      const start = unchecked(this.work[--this.workCount]);
      if (
        !this.block(start, unchecked(this.entryStack[start]), unchecked(this.entryScope[start]))
      ) {
        return code;
      }
    }

    if (this.overlap) {
      return code.fail(kInvalidBranchTargetError);
    }

    this.pack();
    return code;
  }

  /** Zeroed scratch for this body, growing it if the body is the longest yet. */
  reset(): void {
    const length = this.length;
    if (length <= this.capacity) {
      memory.fill(changetype<usize>(this.cover), 0, length);
      memory.fill(changetype<usize>(this.known), 0, length);
      memory.fill(changetype<usize>(this.loopHeader), 0, length);
      return;
    }

    const capacity = max(length, this.capacity * 2);
    this.capacity = capacity;
    this.cover = new StaticArray<u8>(capacity);
    this.known = new StaticArray<u8>(capacity);
    this.loopHeader = new StaticArray<u8>(capacity);
    this.slotNext = new StaticArray<u32>(capacity);
    this.slotA = new StaticArray<i32>(capacity);
    this.slotB = new StaticArray<u32>(capacity);
    this.slotC = new StaticArray<u32>(capacity);
    this.stackAt = new StaticArray<u32>(capacity);
    this.scopeAt = new StaticArray<u32>(capacity);
    this.entryStack = new StaticArray<u32>(capacity);
    this.entryScope = new StaticArray<u32>(capacity);
    this.work = new StaticArray<u32>(capacity);
  }

  /** As Verifier::checkFrameDefinition: a scope size that is a u30, and a frame that fits. */
  checkFrame(body: u32): bool {
    const abc = this.abc;
    const scope =
      <i64>unchecked(abc.bodyMaxScopeDepth[body]) - unchecked(abc.bodyInitScopeDepth[body]);
    const frame = <i64>this.localCount + scope + this.maxStack;
    if (scope < 0 || frame > 0x7fffffff / 8) {
      this.code.fail(kCorruptABCError);
      return false;
    }

    this.maxScope = <u32>scope;
    return true;
  }

  /** As Verifier::checkParams: registers for this, the parameters and any rest or arguments. */
  checkParams(): bool {
    const abc = this.abc;
    const params =
      unchecked(abc.methodParamStart[this.method + 1]) -
      unchecked(abc.methodParamStart[this.method]);
    if (this.localCount < params + 1) {
      this.code.fail(kCorruptABCError);
      return false;
    }

    if (this.methodFlags & (METHOD_NeedRest | METHOD_NeedArguments)) {
      return this.checkLocal(params + 1);
    }

    return true;
  }

  checkLocal(register: u32): bool {
    if (register >= this.localCount) {
      this.code.fail(kInvalidRegisterError);
      return false;
    }

    return true;
  }

  /** As Verifier::parseExceptionHandlers: sane ranges and binding catch names. */
  checkHandlers(): bool {
    const abc = this.abc;
    for (let i: u32 = 0; i < this.handlerCount; i++) {
      const h = this.handlerFirst + i;
      const from = unchecked(abc.exceptionFrom[h]);
      const to = unchecked(abc.exceptionTo[h]);
      const target = unchecked(abc.exceptionTarget[h]);
      const name = unchecked(abc.exceptionName[h]);
      if (name !== 0 && !isBinding(abc.pool, name)) {
        this.code.fail(kCorruptABCError);
        return false;
      }

      if (to < from || target < to || target >= this.length) {
        this.code.fail(kIllegalExceptionHandlerError);
        return false;
      }

      if (i === 0 || from < this.tryFrom) {
        this.tryFrom = from;
      }

      if (i === 0 || to > this.tryTo) {
        this.tryTo = to;
      }
    }

    if (!this.handlerCount) {
      this.tryFrom = 0;
      this.tryTo = 0;
    }

    return true;
  }

  /**
   * As Verifier::checkTarget and mergeState: stay in the code, back edges need
   * a label or known target, and every path into a block has the same stack
   * and scope depths.
   */
  target(from: i64, to: i64, stack: u32, scope: u32): bool {
    if (to < 0 || to >= <i64>this.length) {
      this.code.fail(kInvalidBranchTargetError);
      return false;
    }

    const t = <u32>to;
    const isNew = !unchecked(this.known[t]);
    if (to <= from && isNew && load<u8>(this.start + t) !== OP_label) {
      this.code.fail(kInvalidBranchTargetError);
      return false;
    }

    if (isNew) {
      // Code decoded as part of another block must have been reached with the same state.
      if (
        unchecked(this.cover[t]) === START &&
        !this.sameDepths(unchecked(this.stackAt[t]), unchecked(this.scopeAt[t]), stack, scope)
      ) {
        return false;
      }

      unchecked((this.known[t] = 1));
      unchecked((this.entryStack[t] = stack));
      unchecked((this.entryScope[t] = scope));
      unchecked((this.work[this.workCount++] = t));
    } else if (
      !this.sameDepths(unchecked(this.entryStack[t]), unchecked(this.entryScope[t]), stack, scope)
    ) {
      return false;
    }

    // A loop header's implicit interrupt check can throw, so it reaches the
    // handlers covering it, even when the back edge is found after its block.
    if (to <= from && !unchecked(this.loopHeader[t])) {
      unchecked((this.loopHeader[t] = 1));
      return this.throwsAt(t);
    }

    return true;
  }

  sameDepths(stack: u32, scope: u32, otherStack: u32, otherScope: u32): bool {
    if (stack !== otherStack) {
      this.code.fail(kStackDepthUnbalancedError);
      return false;
    }

    if (scope !== otherScope) {
      this.code.fail(kScopeDepthUnbalancedError);
      return false;
    }

    return true;
  }

  /** Edges from `pc` to every handler covering it; a handler starts with just the exception on the stack. */
  throwsAt(pc: u32): bool {
    if (pc < this.tryFrom || pc >= this.tryTo) {
      return true;
    }

    const abc = this.abc;
    for (let i: u32 = 0; i < this.handlerCount; i++) {
      const h = this.handlerFirst + i;
      if (pc >= unchecked(abc.exceptionFrom[h]) && pc < unchecked(abc.exceptionTo[h])) {
        if (this.maxStack < 1) {
          this.code.fail(kStackOverflowError);
          return false;
        }

        if (!this.target(<i64>pc, <i64>unchecked(abc.exceptionTarget[h]), 1, 0)) {
          return false;
        }
      }
    }

    return true;
  }

  /** Decode and check one block from `start` until it ends or runs into another block. */
  block(start: u32, stack: u32, scope: u32): bool {
    const code = this.code;
    this.stack = stack;
    this.scope = scope;
    let pc = start;

    while (true) {
      if (pc >= this.length) {
        code.fail(kCannotFallOffMethodError);
        return false;
      }

      const opcode = load<u8>(this.start + pc);
      const operands = unchecked(opcodeOperands[opcode]);
      if (operands === OPERANDS_Illegal) {
        code.fail(kIllegalOpcodeError);
        return false;
      }

      if (pc !== start && (opcode === OP_label || unchecked(this.known[pc]))) {
        return this.target(<i64>pc - 1, <i64>pc, this.stack, this.scope);
      }

      const flags = unchecked(opcodeFlags[opcode]);
      if (flags & FLAG_Throws) {
        if (!this.throwsAt(pc)) {
          return false;
        }
      }

      // Decoded already, on the way through from an earlier block.
      if (unchecked(this.cover[pc]) === START) {
        return true;
      }

      unchecked((this.stackAt[pc] = this.stack));
      unchecked((this.scopeAt[pc] = this.scope));
      if (!this.decodeAt(pc, opcode, operands) || !this.verifyAt(pc, opcode)) {
        return false;
      }

      // Targets get the state after the instruction, as in the verifier.
      const next = unchecked(this.slotNext[pc]);
      const stack = this.stack;
      const scope = this.scope;
      if (operands === OPERANDS_Branch) {
        if (!this.target(<i64>pc, <i64>next + unchecked(this.slotA[pc]), stack, scope)) {
          return false;
        }
      } else if (opcode === OP_lookupswitch) {
        if (!this.target(<i64>pc, <i64>pc + unchecked(this.slotA[pc]), stack, scope)) {
          return false;
        }

        const first = unchecked(this.slotC[pc]);
        const last = first + unchecked(this.slotB[pc]);
        for (let i = first; i <= last; i++) {
          if (!this.target(<i64>pc, <i64>pc + unchecked(code.cases[i]), stack, scope)) {
            return false;
          }
        }
      }

      if (flags & FLAG_Terminal) {
        return true;
      }

      pc = next;
    }
  }

  /** Decode the instruction at `pc` into its slots; false after recording the error. */
  decodeAt(pc: u32, opcode: u8, operands: u8): bool {
    const code = this.code;
    const r = this.r;
    r.pos = this.start + pc + 1;

    let a: i32 = 0;
    let b: u32 = 0;
    let c: u32 = 0;
    let wide: u32 = 0;
    if (operands === OPERANDS_U30) {
      wide = r.u32();
      a = <i32>wide;
    } else if (operands === OPERANDS_U30U30) {
      a = <i32>r.u32();
      b = r.u32();
      wide = <u32>a | b;
    } else if (operands === OPERANDS_Branch) {
      a = r.s24();
    } else if (operands === OPERANDS_Byte) {
      a = <i32>(<i8>r.u8());
    } else if (operands === OPERANDS_Short) {
      // The one u30 operand not range-checked: its low 16 bits are sign-extended.
      a = <i32>(<i16>r.u32());
    } else if (operands === OPERANDS_Debug) {
      a = <i32>r.u8();
      b = r.u32();
      c = r.u8();
      r.u32();
      wide = b;
    } else if (operands === OPERANDS_Switch) {
      a = r.s24();
      b = r.u32();
      wide = b;
    }

    if (wide & 0xc0000000) {
      code.fail(kCorruptABCError);
      return false;
    }

    const codeEnd = this.start + this.length;
    if (r.failed || r.pos > codeEnd) {
      code.fail(kLastInstExceedsCodeSizeError);
      return false;
    }

    if (opcode === OP_lookupswitch) {
      c = code.caseCount;
      const caseCount = <u64>b + 1;
      if (<u64>r.pos + caseCount * 3 > codeEnd) {
        code.fail(kLastInstExceedsCodeSizeError);
        return false;
      }

      for (let i: u64 = 0; i < caseCount; i++) {
        code.pushCase(r.s24());
      }
    }

    const next = <u32>(r.pos - this.start);
    for (let p = pc + 1; p < next; p++) {
      if (unchecked(this.cover[p]) === START) {
        this.overlap = true;
      }

      unchecked((this.cover[p] = INSIDE));
    }

    if (unchecked(this.cover[pc]) === INSIDE) {
      this.overlap = true;
    }

    unchecked((this.cover[pc] = START));
    unchecked((this.slotNext[pc] = next));
    unchecked((this.slotA[pc] = a));
    unchecked((this.slotB[pc] = b));
    unchecked((this.slotC[pc] = c));
    this.instructions++;
    return true;
  }

  /**
   * The checks of the instruction at `pc` in Verifier::verifyBlock that need
   * no types, in the verifier's order, and its effect on the stack and scope
   * depths; false after recording the error.
   */
  verifyAt(pc: u32, opcode: u8): bool {
    const pool = this.abc.pool;
    const a = <u32>unchecked(this.slotA[pc]);
    const b = unchecked(this.slotB[pc]);
    const stack = unchecked(opcodeStack[opcode]);
    let pops = <u64>unchecked(opcodePops[opcode]);
    const pushes = <u64>unchecked(opcodePushes[opcode]);
    const checkPushes = stack & STACK_CheckPushOne ? 1 : pushes;

    // Operands that index the pool or the method tables, checked before the stack.
    if (stack & STACK_Multiname) {
      if (a === 0 || a >= pool.multinameCount) {
        return this.fail(kCpoolIndexRangeError);
      }

      pops += runtimeParts(pool, a);
    }

    if (stack & STACK_ArgcA) {
      pops += a;
    } else if (stack & STACK_ArgcB) {
      pops += b;
    }

    if (opcode === OP_newobject) {
      pops = <u64>a * 2;
    } else if (opcode === OP_newarray) {
      pops = a;
    } else if (opcode === OP_callstatic) {
      if (a >= this.abc.methodCount) {
        return this.fail(kCorruptABCError);
      }
    } else if (opcode === OP_dxns) {
      if (!(this.methodFlags & METHOD_SetsDxns)) {
        return this.fail(kIllegalSetDxns);
      }

      return this.checkString(a);
    } else if (opcode === OP_debugfile) {
      return this.checkString(a);
    } else if (opcode === OP_kill || opcode === OP_inclocal || opcode === OP_declocal) {
      return this.checkLocal(a);
    } else if (opcode === OP_inclocal_i || opcode === OP_declocal_i) {
      return this.checkLocal(a);
    } else if (opcode === OP_popscope) {
      if (this.scope === 0) {
        return this.fail(kScopeStackUnderflowError);
      }

      this.scope--;
      return true;
    }

    if (<u64>this.stack < pops) {
      return this.fail(kStackUnderflowError);
    }

    if (<u64>this.stack - pops + checkPushes > this.maxStack) {
      return this.fail(kStackOverflowError);
    }

    if (!this.verifySpecial(pc, opcode, a, b)) {
      return false;
    }

    this.stack = <u32>(<u64>this.stack - pops + pushes);
    return true;
  }

  /** The checks after the stack check that only some opcodes have. */
  verifySpecial(pc: u32, opcode: u8, a: u32, b: u32): bool {
    const abc = this.abc;
    const pool = abc.pool;
    if (opcode >= OP_getlocal0 && opcode < OP_getlocal0 + 4) {
      return this.checkLocal(opcode - OP_getlocal0);
    }

    if (opcode >= OP_setlocal0 && opcode < OP_setlocal0 + 4) {
      return this.checkLocal(opcode - OP_setlocal0);
    }

    switch (opcode) {
      case OP_getlocal:
      case OP_setlocal:
        return this.checkLocal(a);
      case OP_hasnext2:
        if (!this.checkLocal(a) || !this.checkLocal(b)) {
          return false;
        }

        return a === b ? this.fail(kInvalidHasNextError) : true;
      case OP_pushstring:
        return this.checkString(a);
      case OP_pushint:
        return a === 0 || a >= <u32>pool.ints.length ? this.fail(kCpoolIndexRangeError) : true;
      case OP_pushuint:
        return a === 0 || a >= <u32>pool.uints.length ? this.fail(kCpoolIndexRangeError) : true;
      case OP_pushdouble:
        return a === 0 || a >= <u32>pool.doubles.length ? this.fail(kCpoolIndexRangeError) : true;
      case OP_pushnamespace:
        return a === 0 || a >= pool.nsCount ? this.fail(kCpoolIndexRangeError) : true;
      case OP_dxnslate:
        return this.methodFlags & METHOD_SetsDxns ? true : this.fail(kIllegalSetDxns);
      case OP_getlex:
        return runtimeParts(pool, a) ? this.fail(kIllegalOpMultinameError) : true;
      case OP_finddef:
        return isBinding(pool, a) ? true : this.fail(kIllegalOpMultinameError);
      case OP_callproperty:
      case OP_callproplex:
      case OP_callpropvoid:
      case OP_constructprop:
      case OP_callsuper:
      case OP_callsupervoid:
      case OP_getsuper:
      case OP_setsuper:
        return isAttribute(pool, a) ? this.fail(kIllegalOpMultinameError) : true;
      case OP_newfunction:
        return a >= abc.methodCount ? this.fail(kMethodInfoExceedsCountError) : true;
      case OP_newclass:
        return a >= abc.classCount ? this.fail(kClassInfoExceedsCountError) : true;
      case OP_newactivation:
        return this.methodFlags & METHOD_NeedActivation
          ? true
          : this.fail(kInvalidNewActivationError);
      case OP_newcatch:
        return a >= this.handlerCount ? this.fail(kInvalidNewActivationError) : true;
      case OP_pushscope:
      case OP_pushwith:
        if (this.scope + 1 > this.maxScope) {
          return this.fail(kScopeStackOverflowError);
        }

        this.scope++;
        return true;
      case OP_getscopeobject:
        // The verifier reads the index as the operand's first byte.
        return <u32>load<u8>(this.start + pc + 1) >= this.scope
          ? this.fail(kGetScopeObjectBoundsError)
          : true;
      default:
        return true;
    }
  }

  checkString(index: u32): bool {
    return index === 0 || index >= this.abc.pool.stringCount
      ? this.fail(kCpoolIndexRangeError)
      : true;
  }

  fail(error: i32): bool {
    this.code.fail(error);
    return false;
  }

  /** Copy the decoded instructions into `code` in offset order. */
  pack(): void {
    const code = this.code;
    code.reserve(this.instructions);

    let i: u32 = 0;
    for (let pc: u32 = 0; pc < this.length; pc++) {
      if (unchecked(this.cover[pc]) === START) {
        unchecked((code.offset[i] = pc));
        unchecked((code.next[i] = this.slotNext[pc]));
        unchecked((code.opcode[i] = load<u8>(this.start + pc)));
        unchecked((code.a[i] = this.slotA[pc]));
        unchecked((code.b[i] = this.slotB[pc]));
        unchecked((code.c[i] = this.slotC[pc]));
        i++;
      }
    }

    code.count = i;
  }
}

/**
 * As avmplus' Multiname::isBinding for a catch variable: a QName or Multiname
 * with a name, not an attribute or runtime name. A TypeName stands for its base.
 */
function isBinding(pool: ConstantPool, index: u32): bool {
  let mn = index;
  if (unchecked(pool.mnKind[mn]) === CONSTANT_TypeName) {
    mn = unchecked(pool.mnA[mn]);
  }

  const kind = unchecked(pool.mnKind[mn]);
  if (kind === CONSTANT_Qname) {
    return unchecked(pool.mnA[mn]) !== 0 && unchecked(pool.mnB[mn]) !== 0;
  }

  return kind === CONSTANT_Multiname && unchecked(pool.mnB[mn]) !== 0;
}

/** Values a multiname takes from the stack: a runtime namespace, a runtime name, or both. */
function runtimeParts(pool: ConstantPool, index: u32): u32 {
  const kind = unchecked(pool.mnKind[index]);
  if (
    kind === CONSTANT_RTQname ||
    kind === CONSTANT_RTQnameA ||
    kind === CONSTANT_MultinameL ||
    kind === CONSTANT_MultinameLA
  ) {
    return 1;
  }

  return kind === CONSTANT_RTQnameL || kind === CONSTANT_RTQnameLA ? 2 : 0;
}

function isAttribute(pool: ConstantPool, index: u32): bool {
  const kind = unchecked(pool.mnKind[index]);
  return (
    kind === CONSTANT_QnameA ||
    kind === CONSTANT_RTQnameA ||
    kind === CONSTANT_RTQnameLA ||
    kind === CONSTANT_MultinameA ||
    kind === CONSTANT_MultinameLA
  );
}
