// Decodes and verifies a method body the way avmplus' Verifier walks it:
// from the entry along fall-through, branches and the exception handlers
// that a reachable instruction can trigger. Unreachable bytes are never
// read, as in Flash; obfuscated SWFs often hide junk there.
//
// Every walk checks the method's structure as the verifier does, with its
// VerifyError numbers: frame limits, operand stack and scope stack depths at
// every instruction and where paths join, local registers, and operands that
// index the constant pool or the method's tables.
//
// With a domain the walk is typed: each local, scope entry and stack slot has
// a type, whether it is known not to be null, and whether it is a with scope.
// Where paths join, the states merge to their common types; a block whose
// entry state changes is walked again, until none changes. That is avmplus'
// first verifier phase, and the type checks are its.
//
// A BodyDecoder is made once per ABC and reused for every body: its scratch
// buffers and its output only grow, so decoding allocates nothing per body.
import { IR_CheckNull, IR_Coerce, Ir } from "../ir/ir";
import { Domain } from "../link/domain";
import { Scope, TYPE_Any } from "../link/traits";
import { BIND_Ambiguous, canAssign, commonBase, isNumeric } from "../link/types";
import { Abc } from "./abc";
import * as C from "./constants";
import * as ops from "./opcodes";
import {
  FLAG_Terminal,
  FLAG_Throws,
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
import {
  binding,
  callProperty,
  callStatic,
  callSuper,
  coerceArgs,
  coerceSuper,
  findDef,
  findProperty,
  getProperty,
  getSuper,
  globalScope,
  propertyDepth,
  readBinding,
  setProperty,
  slot,
  typeName,
} from "./properties";
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

    this.cases[this.caseCount++] = offset;
  }
}

// Byte states in BodyDecoder.cover, which starts zeroed: unseen.
const START: u8 = 1;
const INSIDE: u8 = 2;

// Frame value flags.
export const NOT_NULL: u8 = 1;
export const WITH: u8 = 2;

// Multiname parts, as avmplus' Multiname flags.
export const MN_Attr: u8 = 1;
export const MN_Rtns: u8 = 2;
export const MN_Rtname: u8 = 4;
export const MN_QName: u8 = 8;

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
  /** Where a known target's entry values start in entryType and entryFlags. */
  entryAt: StaticArray<u32> = new StaticArray<u32>(0);
  /** Whether a known target is on the work list. */
  pending: StaticArray<u8> = new StaticArray<u8>(0);
  /** The block whose walk last went through each instruction. */
  walkOf: StaticArray<u32> = new StaticArray<u32>(0);
  /** Block starts still to walk, each at most once at a time. */
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

  // Typed verification, with a domain; without one, an empty stand-in.
  domain: Domain;
  typed: bool;
  index: u32 = 0;
  /** The method's domain-wide id, and the traits it belongs to or -1. */
  global: u32 = 0;
  declarer: i32 = -1;
  outer: Scope = new Scope();
  frameSize: u32 = 0;
  /** The current values: locals, then maxScope scope entries, then the stack. */
  valueType: StaticArray<i32> = new StaticArray<i32>(0);
  valueFlags: StaticArray<u8> = new StaticArray<u8>(0);
  entryType: StaticArray<i32> = new StaticArray<i32>(0);
  entryFlags: StaticArray<u8> = new StaticArray<u8>(0);
  entryUsed: u32 = 0;
  /** Each handler's exception type and catch scope type. */
  handlerType: i32[] = [];
  /**
   * Bumped whenever a local may have changed: a local set, or the frame
   * loaded whole. A handler edge whose locals are the same as at the last
   * merge into it, at the version of handlerMerged, changes nothing there.
   */
  localsVersion: u64 = 1;
  handlerMerged: StaticArray<u64> = new StaticArray<u64>(0);
  handlerScope: i32[] = [];
  /**
   * avmplus' second verifier phase: blocks walked once more in code order
   * with their final states, capturing the scope chains of the classes and
   * functions the method creates.
   */
  emitPass: bool = false;
  /** Methods (domain-wide ids) whose scope chain the last decode captured. */
  captured: u32[] = [];
  /** The IR the second pass writes, valid until the next decode. */
  ir: Ir = new Ir();
  /** The block number of each block start. */
  blockOf: StaticArray<u32> = new StaticArray<u32>(0);
  /** Whether the instruction being verified wrote its own IR, and the extra operand of a generic one. */
  emitted: bool = false;
  rowC: i32 = 0;
  /** The instruction being verified. */
  pc: u32 = 0;

  constructor(
    public abc: Abc,
    public base: usize,
    domain: Domain | null = null,
    index: u32 = 0,
  ) {
    // Operands may read past the code up to the end of the ABC, as avmplus'
    // do into its padding; the end of the code is checked per instruction.
    this.r = new Reader(base, base + abc.length);
    this.domain = domain !== null ? domain : new Domain();
    this.typed = domain !== null;
    this.index = index;
  }

  /**
   * Decode body `body`, created in scope chain `outer` (empty by default, as
   * for a script's initializer); the result is valid until the next call.
   */
  decode(body: u32, outer: Scope | null = null): Code {
    const abc = this.abc;
    const code = this.code;
    code.error = 0;
    code.count = 0;
    code.caseCount = 0;

    this.start = this.base + abc.bodyCodeStart[body];
    this.length = abc.bodyCodeLength[body];
    this.handlerFirst = abc.bodyExceptionStart[body];
    this.handlerCount = abc.bodyExceptionStart[body + 1] - this.handlerFirst;
    if (<u32>this.handlerMerged.length < this.handlerCount) {
      this.handlerMerged = new StaticArray<u64>(this.handlerCount);
    }

    // No merge yet into this body's handlers: every version before now.
    memory.fill(changetype<usize>(this.handlerMerged), 0, (<usize>this.handlerCount) << 3);
    this.localsVersion++;
    this.instructions = 0;
    this.workCount = 0;
    this.entryUsed = 0;
    this.overlap = false;
    this.r.failed = false;
    this.method = abc.bodyMethod[body];
    this.methodFlags = abc.methodFlags[this.method];
    this.maxStack = abc.bodyMaxStack[body];
    this.localCount = abc.bodyLocalCount[body];
    this.outer = outer !== null ? outer : new Scope();
    this.reset();

    // As Verifier::verify: frame limits, exception handlers, then parameters.
    if (!this.checkFrame(body) || !this.checkHandlers() || !this.checkParams()) {
      return code;
    }

    if (this.typed && !this.initTypes()) {
      return code;
    }

    // Code starting with a label is a block target, so loops may branch to it.
    // Otherwise the entry block has no target, but a typed walk may need to
    // walk it again, so its state is kept all the same.
    this.stack = 0;
    this.scope = 0;
    if (load<u8>(this.start) === ops.OP_label) {
      if (!this.target(-1, 0, 0, 0)) {
        return code;
      }
    } else {
      if (this.typed) {
        this.entryStack[0] = 0;
        this.entryScope[0] = 0;
        this.saveEntry(0);
      }

      if (!this.block(0, 0, 0)) {
        return code;
      }
    }

    while (this.workCount) {
      const start = this.work[--this.workCount];
      this.pending[start] = 0;
      this.loadEntry(start);
      if (!this.block(start, this.entryStack[start], this.entryScope[start])) {
        return code;
      }
    }

    if (this.overlap) {
      return code.fail(C.kInvalidBranchTargetError);
    }

    if (this.typed && !this.secondPass()) {
      return code;
    }

    this.pack();
    return code;
  }

  /**
   * As the verifier's phase 2: walk the blocks in code order with their
   * final entry states, writing the IR.
   */
  secondPass(): bool {
    this.emitPass = true;
    this.captured.length = 0;
    const ir = this.ir;
    ir.reset(this.localCount, this.maxScope, this.frameSize);
    ir.outerSize = this.outer.size;
    let blocks: u32 = 0;
    for (let pc: u32 = 0; pc < this.length; pc++) {
      if (pc === 0 || this.known[pc]) {
        this.blockOf[pc] = blocks++;
      }
    }

    // A handler nothing in its range can throw into has no block, and no use.
    const abc = this.abc;
    for (let i: u32 = 0; i < this.handlerCount; i++) {
      const h = this.handlerFirst + i;
      if (!this.known[abc.exceptionTarget[h]]) {
        continue;
      }

      ir.addHandler(
        abc.exceptionFrom[h],
        abc.exceptionTo[h],
        this.blockOf[abc.exceptionTarget[h]],
        this.handlerType[i],
        this.handlerScope[i],
      );
    }

    let ok = true;
    for (let pc: u32 = 0; pc < this.length && ok; pc++) {
      if (pc === 0 || this.known[pc]) {
        this.loadEntry(pc);
        ir.addBlock(pc, this.entryStack[pc], this.entryScope[pc], this.valueType, this.valueFlags);
        ok = this.block(pc, this.entryStack[pc], this.entryScope[pc]);
      }
    }

    this.emitPass = false;
    return ok;
  }

  /** Write an IR instruction, typed as its destination is now. */
  emit(op: u16, dst: i32, src: i32, count: u32, a: u32, b: u32, c: i32, pc: u32): void {
    const ir = this.ir;
    const i = ir.add(op, dst, src, count, a, b, c, pc);
    if (dst >= 0) {
      ir.type[i] = this.valueType[dst];
      ir.notNull[i] = this.valueFlags[dst] & NOT_NULL;
    }
  }

  /**
   * The IR of an instruction that wrote none of its own: its opcode reading
   * the values it popped, or the register it names, and writing what it
   * pushed; branches name their target blocks.
   */
  emitGeneric(
    pc: u32,
    opcode: u8,
    a: u32,
    b: u32,
    stackBefore: u32,
    scopeBefore: u32,
    pops: u32,
  ): void {
    const base = this.stackBase;
    let src = <i32>(base + stackBefore - pops);
    let count = pops;
    let dst = this.stack > stackBefore - pops ? <i32>(base + this.stack - 1) : -1;
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
        dst = <i32>(this.localCount + scopeBefore);
        break;
      case ops.OP_popscope:
        src = <i32>(this.localCount + scopeBefore - 1);
        count = 1;
        break;
      case ops.OP_getscopeobject:
        ra = <u32>load<u8>(this.start + pc + 1);
        src = <i32>(this.localCount + ra);
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
        ra = this.blockOf[this.slotNext[pc] + <u32>this.slotA[pc]];
        break;
      case ops.OP_lookupswitch: {
        const ir = this.ir;
        const first = this.slotC[pc];
        const cases = ir.caseCount;
        for (let i = first; i <= first + b; i++) {
          ir.addCase(this.blockOf[pc + this.code.cases[i]]);
        }

        this.emit(opcode, -1, src, count, this.blockOf[pc + this.slotA[pc]], cases, <i32>b, pc);
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

    this.emit(opcode, dst, src, count, ra, b, this.rowC, pc);
  }

  /** Zeroed scratch for this body, growing it if the body is the longest yet. */
  reset(): void {
    const length = this.length;
    if (length <= this.capacity) {
      memory.fill(changetype<usize>(this.cover), 0, length);
      memory.fill(changetype<usize>(this.known), 0, length);
      memory.fill(changetype<usize>(this.loopHeader), 0, length);
      memory.fill(changetype<usize>(this.pending), 0, length);
      return;
    }

    const capacity = max(length, this.capacity * 2);
    this.capacity = capacity;
    this.cover = new StaticArray<u8>(capacity);
    this.known = new StaticArray<u8>(capacity);
    this.loopHeader = new StaticArray<u8>(capacity);
    this.pending = new StaticArray<u8>(capacity);
    this.slotNext = new StaticArray<u32>(capacity);
    this.slotA = new StaticArray<i32>(capacity);
    this.slotB = new StaticArray<u32>(capacity);
    this.slotC = new StaticArray<u32>(capacity);
    this.stackAt = new StaticArray<u32>(capacity);
    this.scopeAt = new StaticArray<u32>(capacity);
    this.entryStack = new StaticArray<u32>(capacity);
    this.entryScope = new StaticArray<u32>(capacity);
    this.entryAt = new StaticArray<u32>(capacity);
    this.walkOf = new StaticArray<u32>(capacity);
    this.blockOf = new StaticArray<u32>(capacity);
    this.work = new StaticArray<u32>(capacity);
  }

  /** As Verifier::checkFrameDefinition: a scope size that is a u30, and a frame that fits. */
  checkFrame(body: u32): bool {
    const abc = this.abc;
    const scope = <i64>abc.bodyMaxScopeDepth[body] - abc.bodyInitScopeDepth[body];
    const frame = <i64>this.localCount + scope + this.maxStack;
    if (scope < 0 || frame > 0x7fffffff / 8) {
      this.code.fail(C.kCorruptABCError);
      return false;
    }

    this.maxScope = <u32>scope;
    this.frameSize = <u32>frame;
    return true;
  }

  /** As Verifier::checkParams: registers for this, the parameters and any rest or arguments. */
  checkParams(): bool {
    const abc = this.abc;
    const params = abc.methodParamStart[this.method + 1] - abc.methodParamStart[this.method];
    if (this.localCount < params + 1) {
      this.code.fail(C.kCorruptABCError);
      return false;
    }

    if (this.methodFlags & (C.METHOD_NeedRest | C.METHOD_NeedArguments)) {
      return this.checkLocal(params + 1);
    }

    return true;
  }

  checkLocal(register: u32): bool {
    if (register >= this.localCount) {
      this.code.fail(C.kInvalidRegisterError);
      return false;
    }

    return true;
  }

  /**
   * As Verifier::parseExceptionHandlers: known catch types, binding catch
   * names and sane ranges.
   */
  checkHandlers(): bool {
    const abc = this.abc;
    const domain = this.domain;
    const typed = this.typed;
    this.handlerType.length = 0;
    this.handlerScope.length = 0;
    for (let i: u32 = 0; i < this.handlerCount; i++) {
      const h = this.handlerFirst + i;
      const from = abc.exceptionFrom[h];
      const to = abc.exceptionTo[h];
      const target = abc.exceptionTarget[h];
      const name = abc.exceptionName[h];
      let type = TYPE_Any;
      if (typed && abc.exceptionType[h] !== 0) {
        type = typeName(this, abc.exceptionType[h]);
        if (type < TYPE_Any) {
          return false;
        }
      }

      if (name !== 0 && !isBinding(abc.pool, name)) {
        this.code.fail(C.kCorruptABCError);
        return false;
      }

      if (to < from || target < to || target >= this.length) {
        this.code.fail(C.kIllegalExceptionHandlerError);
        return false;
      }

      if (i === 0 || from < this.tryFrom) {
        this.tryFrom = from;
      }

      if (i === 0 || to > this.tryTo) {
        this.tryTo = to;
      }

      if (typed) {
        this.handlerType.push(type);
        this.handlerScope.push(
          name === 0 ? domain.objectType() : domain.catchTraits(this.index, h, name, type),
        );
      }
    }

    if (!this.handlerCount) {
      this.tryFrom = 0;
      this.tryTo = 0;
    }

    return true;
  }

  /**
   * As the start of Verifier::verify: the method's signature, and the entry
   * state: `this` and the parameters of their types, `this` not null, the
   * rest or arguments array, then untyped locals.
   */
  initTypes(): bool {
    const domain = this.domain;
    const traits = domain.traits;
    this.global = domain.methodStart[this.index] + this.method;
    this.declarer = traits.methodTraits[this.global];
    const error = traits.sign(domain, this.global);
    if (error) {
      return this.fail(error);
    }

    if (<u32>this.valueType.length < this.frameSize) {
      this.valueType = new StaticArray<i32>(this.frameSize);
      this.valueFlags = new StaticArray<u8>(this.frameSize);
    }

    const m = this.global;
    const count = traits.paramCount[m];
    this.setValue(0, traits.receiverType[m], NOT_NULL);
    for (let p: u32 = 0; p < count; p++) {
      this.setValue(p + 1, traits.paramType[traits.paramStart[m] + p], 0);
    }

    let firstLocal = count + 1;
    if (this.methodFlags & (C.METHOD_NeedRest | C.METHOD_NeedArguments)) {
      this.setValue(firstLocal++, domain.arrayType, NOT_NULL);
    }

    for (let i = firstLocal; i < this.localCount; i++) {
      this.setValue(i, TYPE_Any, 0);
    }

    return true;
  }

  // Frame values: locals from 0, scope entries from localCount, the stack from
  // localCount + maxScope.

  @inline
  setValue(i: u32, type: i32, flags: u8): void {
    this.valueType[i] = type;
    this.valueFlags[i] = flags;
    if (i < this.localCount) {
      this.localsVersion++;
    }
  }

  @inline
  get stackBase(): u32 {
    return this.localCount + this.maxScope;
  }

  /** The index of the value `n` from the top of the stack, 1 being the top. */
  @inline
  peek(n: u32): u32 {
    return this.stackBase + this.stack - n;
  }

  @inline
  typeOf(i: u32): i32 {
    return this.valueType[i];
  }

  @inline
  isNotNull(i: u32): bool {
    return (this.valueFlags[i] & NOT_NULL) !== 0;
  }

  /** Save the current state as known target t's entry state. */
  saveEntry(t: u32): void {
    const size = this.frameSize;
    if (this.entryUsed + size > <u32>this.entryType.length) {
      const capacity = max(this.entryUsed + size, <u32>this.entryType.length * 2);
      const types = new StaticArray<i32>(capacity);
      const flags = new StaticArray<u8>(capacity);
      memory.copy(changetype<usize>(types), changetype<usize>(this.entryType), this.entryUsed << 2);
      memory.copy(changetype<usize>(flags), changetype<usize>(this.entryFlags), this.entryUsed);
      this.entryType = types;
      this.entryFlags = flags;
    }

    const at = this.entryUsed;
    this.entryAt[t] = at;
    this.entryUsed += size;
    memory.copy(
      changetype<usize>(this.entryType) + ((<usize>at) << 2),
      changetype<usize>(this.valueType),
      (<usize>size) << 2,
    );
    memory.copy(
      changetype<usize>(this.entryFlags) + <usize>at,
      changetype<usize>(this.valueFlags),
      size,
    );
  }

  /** Make known target t's entry state the current one. */
  loadEntry(t: u32): void {
    if (!this.typed) {
      return;
    }

    this.localsVersion++;
    const at = this.entryAt[t];
    memory.copy(
      changetype<usize>(this.valueType),
      changetype<usize>(this.entryType) + ((<usize>at) << 2),
      (<usize>this.frameSize) << 2,
    );
    memory.copy(
      changetype<usize>(this.valueFlags),
      changetype<usize>(this.entryFlags) + <usize>at,
      this.frameSize,
    );
  }

  /**
   * As Verifier::mergeState: merge the current values into known target t's
   * entry state, whose depths are the same: types to their common base, not
   * null only if both are. Returns 1 if the entry changed, 0 if not, -1 after
   * recording 1068 for a with scope meeting another scope.
   */
  mergeEntry(t: u32): i32 {
    const at = this.entryAt[t];
    const stackBase = this.stackBase;
    // The locals and scopes, then the stack, not what lies between.
    const low = this.mergeRange(at, 0, this.localCount + this.scope);
    if (low < 0) {
      return -1;
    }

    const high = this.mergeRange(at, stackBase, stackBase + this.stack);
    return high < 0 ? -1 : low | high;
  }

  /** mergeEntry for values [from, to) of the entry state at `at`. */
  @inline
  mergeRange(at: u32, from: u32, to: u32): i32 {
    let changed = 0;
    for (let i = from; i < to; i++) {
      const flags = this.valueFlags[i];
      const entryFlags = this.entryFlags[at + i];
      if ((flags ^ entryFlags) & WITH) {
        this.fail(C.kCannotMergeTypesError);
        return -1;
      }

      const entryType = this.entryType[at + i];
      const valueType = this.valueType[i];
      const mergedFlags = entryFlags & (flags | WITH);
      // Most merges meet the same type, which stays.
      if (valueType === entryType && mergedFlags === entryFlags) {
        continue;
      }

      const merged = commonBase(this.domain, entryType, valueType);
      if (merged !== entryType || mergedFlags !== entryFlags) {
        this.entryType[at + i] = merged;
        this.entryFlags[at + i] = mergedFlags;
        changed = 1;
      }
    }

    return changed;
  }

  /** Put known target t on the work list unless it is there already. */
  requeue(t: u32): void {
    if (!this.pending[t]) {
      this.pending[t] = 1;
      this.work[this.workCount++] = t;
    }
  }

  /**
   * As Verifier::checkTarget and mergeState: stay in the code, back edges need
   * a label or known target, and every path into a block has the same stack
   * and scope depths, whose values merge.
   */
  target(from: i64, to: i64, stack: u32, scope: u32): bool {
    // The second phase only visits what the first already checked.
    if (this.emitPass) {
      return true;
    }

    if (to < 0 || to >= <i64>this.length) {
      this.code.fail(C.kInvalidBranchTargetError);
      return false;
    }

    const t = <u32>to;
    const isNew = !this.known[t];
    if (to <= from && isNew && load<u8>(this.start + t) !== ops.OP_label) {
      this.code.fail(C.kInvalidBranchTargetError);
      return false;
    }

    if (isNew) {
      // Code decoded as part of another block must have been reached with the same state.
      const walked = this.cover[t] === START;
      if (walked && !this.sameDepths(this.stackAt[t], this.scopeAt[t], stack, scope)) {
        return false;
      }

      this.known[t] = 1;
      this.entryStack[t] = stack;
      this.entryScope[t] = scope;
      if (this.typed) {
        this.saveEntry(t);
      }

      this.requeue(t);

      // The block that walked through t must now end there and merge into it.
      if (walked && this.typed && this.walkOf[t] !== t) {
        this.requeue(this.walkOf[t]);
      }
    } else {
      if (!this.sameDepths(this.entryStack[t], this.entryScope[t], stack, scope)) {
        return false;
      }

      if (this.typed) {
        const changed = this.mergeEntry(t);
        if (changed < 0) {
          return false;
        }

        if (changed) {
          this.requeue(t);
        }
      }
    }

    // A loop header's implicit interrupt check can throw, so it reaches the
    // handlers covering it, even when the back edge is found after its block.
    if (to <= from && !this.loopHeader[t]) {
      this.loopHeader[t] = 1;
      if (this.typed) {
        // Its handlers are reached with the state it is entered with.
        this.saveCurrent();
        this.loadEntry(t);
        const stackNow = this.stack;
        const scopeNow = this.scope;
        this.stack = stack;
        this.scope = scope;
        const reached = this.throwsAt(t);
        this.stack = stackNow;
        this.scope = scopeNow;
        this.restoreCurrent();
        return reached;
      }

      return this.throwsAt(t);
    }

    return true;
  }

  // The values of the block being walked, while a loop header's handler
  // edges are followed from its entry state instead.
  savedType: StaticArray<i32> = new StaticArray<i32>(0);
  savedFlags: StaticArray<u8> = new StaticArray<u8>(0);

  saveCurrent(): void {
    if (<u32>this.savedType.length < this.frameSize) {
      this.savedType = new StaticArray<i32>(this.frameSize);
      this.savedFlags = new StaticArray<u8>(this.frameSize);
    }

    memory.copy(
      changetype<usize>(this.savedType),
      changetype<usize>(this.valueType),
      (<usize>this.frameSize) << 2,
    );
    memory.copy(
      changetype<usize>(this.savedFlags),
      changetype<usize>(this.valueFlags),
      this.frameSize,
    );
  }

  restoreCurrent(): void {
    this.localsVersion++;
    memory.copy(
      changetype<usize>(this.valueType),
      changetype<usize>(this.savedType),
      (<usize>this.frameSize) << 2,
    );
    memory.copy(
      changetype<usize>(this.valueFlags),
      changetype<usize>(this.savedFlags),
      this.frameSize,
    );
  }

  sameDepths(stack: u32, scope: u32, otherStack: u32, otherScope: u32): bool {
    if (stack !== otherStack) {
      this.code.fail(C.kStackDepthUnbalancedError);
      return false;
    }

    if (scope !== otherScope) {
      this.code.fail(C.kScopeDepthUnbalancedError);
      return false;
    }

    return true;
  }

  /**
   * Edges from `pc` to every handler covering it. A handler starts with the
   * locals as they are, no scopes, and just the exception on the stack.
   */
  throwsAt(pc: u32): bool {
    if (this.emitPass || pc < this.tryFrom || pc >= this.tryTo) {
      return true;
    }

    const abc = this.abc;
    for (let i: u32 = 0; i < this.handlerCount; i++) {
      const h = this.handlerFirst + i;
      if (pc >= abc.exceptionFrom[h] && pc < abc.exceptionTo[h]) {
        if (this.maxStack < 1) {
          this.code.fail(C.kStackOverflowError);
          return false;
        }

        if (!this.typed) {
          if (!this.target(<i64>pc, <i64>abc.exceptionTarget[h], 1, 0)) {
            return false;
          }

          continue;
        }

        // The same locals as when last merged into this handler change
        // nothing there, once a backward edge has made it a loop header.
        const to = abc.exceptionTarget[h];
        if (this.handlerMerged[i] === this.localsVersion && (to > pc || this.loopHeader[to])) {
          continue;
        }

        const stack = this.stack;
        const scope = this.scope;
        const base = this.stackBase;
        const firstType = this.valueType[base];
        const firstFlags = this.valueFlags[base];
        const type = this.handlerType[i];
        this.setValue(base, type, this.domain.typeNotNull(type) ? NOT_NULL : 0);
        this.stack = 1;
        this.scope = 0;
        const reached = this.target(<i64>pc, <i64>abc.exceptionTarget[h], 1, 0);
        this.stack = stack;
        this.scope = scope;
        this.setValue(base, firstType, firstFlags);
        if (!reached) {
          return false;
        }

        this.handlerMerged[i] = this.localsVersion;
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
        code.fail(C.kCannotFallOffMethodError);
        return false;
      }

      const opcode = load<u8>(this.start + pc);
      const operands = opcodeOperands[opcode];
      if (operands === OPERANDS_Illegal) {
        code.fail(C.kIllegalOpcodeError);
        return false;
      }

      if (pc !== start && (opcode === ops.OP_label || this.known[pc])) {
        return this.target(<i64>pc - 1, <i64>pc, this.stack, this.scope);
      }

      // A loop header's implicit interrupt check can throw too, with the
      // state the block is entered with.
      const flags = opcodeFlags[opcode];
      if (flags & FLAG_Throws || (pc === start && this.typed && this.loopHeader[pc])) {
        if (!this.throwsAt(pc)) {
          return false;
        }
      }

      // Decoded already, walking through from an earlier block: without types
      // it was checked with the same depths, so only a typed walk goes on.
      if (this.cover[pc] === START) {
        if (!this.typed) {
          return true;
        }
      } else if (!this.decodeAt(pc, opcode, operands)) {
        return false;
      }

      this.walkOf[pc] = start;
      this.stackAt[pc] = this.stack;
      this.scopeAt[pc] = this.scope;
      if (!this.verifyAt(pc, opcode)) {
        return false;
      }

      // Targets get the state after the instruction, as in the verifier.
      const next = this.slotNext[pc];
      const stack = this.stack;
      const scope = this.scope;
      if (operands === OPERANDS_Branch) {
        if (!this.target(<i64>pc, <i64>next + this.slotA[pc], stack, scope)) {
          return false;
        }
      } else if (opcode === ops.OP_lookupswitch) {
        if (!this.target(<i64>pc, <i64>pc + this.slotA[pc], stack, scope)) {
          return false;
        }

        const first = this.slotC[pc];
        const last = first + this.slotB[pc];
        for (let i = first; i <= last; i++) {
          if (!this.target(<i64>pc, <i64>pc + code.cases[i], stack, scope)) {
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
      code.fail(C.kCorruptABCError);
      return false;
    }

    const codeEnd = this.start + this.length;
    if (r.failed || r.pos > codeEnd) {
      code.fail(C.kLastInstExceedsCodeSizeError);
      return false;
    }

    if (opcode === ops.OP_lookupswitch) {
      c = code.caseCount;
      const caseCount = <u64>b + 1;
      if (<u64>r.pos + caseCount * 3 > codeEnd) {
        code.fail(C.kLastInstExceedsCodeSizeError);
        return false;
      }

      for (let i: u64 = 0; i < caseCount; i++) {
        code.pushCase(r.s24());
      }
    }

    const next = <u32>(r.pos - this.start);
    for (let p = pc + 1; p < next; p++) {
      if (this.cover[p] === START) {
        this.overlap = true;
      }

      this.cover[p] = INSIDE;
    }

    if (this.cover[pc] === INSIDE) {
      this.overlap = true;
    }

    this.cover[pc] = START;
    this.slotNext[pc] = next;
    this.slotA[pc] = a;
    this.slotB[pc] = b;
    this.slotC[pc] = c;
    this.instructions++;
    return true;
  }

  /**
   * The checks of the instruction at `pc` in Verifier::verifyBlock, in the
   * verifier's order, and its effect on the stack and scope depths and, when
   * typed, on the values; false after recording the error.
   */
  verifyAt(pc: u32, opcode: u8): bool {
    const pool = this.abc.pool;
    const a = <u32>this.slotA[pc];
    const b = this.slotB[pc];
    const stack = opcodeStack[opcode];
    let pops = <u64>opcodePops[opcode];
    const pushes = <u64>opcodePushes[opcode];
    const checkPushes = stack & STACK_CheckPushOne ? 1 : pushes;

    // A name looked up in the scope chain needs a scope to look in.
    if (
      this.typed &&
      (opcode === ops.OP_getlex ||
        opcode === ops.OP_findpropstrict ||
        opcode === ops.OP_findproperty) &&
      this.scope + this.outer.size === 0
    ) {
      return this.fail(C.kFindVarWithNoScopeError);
    }

    // Operands that index the pool or the method tables, checked before the stack.
    if (stack & STACK_Multiname) {
      if (a === 0 || a >= pool.multinameCount) {
        return this.fail(C.kCpoolIndexRangeError);
      }

      pops += runtimeParts(pool, a);
    }

    if (stack & STACK_ArgcA) {
      pops += a;
    } else if (stack & STACK_ArgcB) {
      pops += b;
    }

    if (opcode === ops.OP_newobject) {
      pops = <u64>a * 2;
    } else if (opcode === ops.OP_newarray) {
      pops = a;
    } else if (opcode === ops.OP_callstatic) {
      if (a >= this.abc.methodCount || !this.callable(a)) {
        return this.fail(C.kCorruptABCError);
      }
    } else if (opcode === ops.OP_dxns) {
      if (!(this.methodFlags & C.METHOD_SetsDxns)) {
        return this.fail(C.kIllegalSetDxns);
      }

      if (this.emitPass) {
        this.emit(opcode, -1, -1, 0, a, 0, 0, pc);
      }

      return this.checkString(a);
    } else if (opcode === ops.OP_debugfile) {
      if (this.emitPass) {
        this.emit(opcode, -1, -1, 0, a, 0, 0, pc);
      }

      return this.checkString(a);
    } else if (opcode === ops.OP_kill) {
      if (!this.checkLocal(a)) {
        return false;
      }

      if (this.typed) {
        this.setValue(a, TYPE_Any, 0);
      }

      if (this.emitPass) {
        this.emit(opcode, <i32>a, -1, 0, a, 0, 0, pc);
      }

      return true;
    } else if (
      opcode === ops.OP_inclocal ||
      opcode === ops.OP_declocal ||
      opcode === ops.OP_inclocal_i ||
      opcode === ops.OP_declocal_i
    ) {
      if (!this.checkLocal(a)) {
        return false;
      }

      if (this.typed) {
        const integer = opcode === ops.OP_inclocal_i || opcode === ops.OP_declocal_i;
        this.coerce(a, integer ? this.domain.intType : this.domain.numberType);
      }

      if (this.emitPass) {
        this.emit(opcode, <i32>a, <i32>a, 1, a, 0, 0, pc);
      }

      return true;
    } else if (opcode === ops.OP_popscope) {
      if (this.scope === 0) {
        return this.fail(C.kScopeStackUnderflowError);
      }

      this.scope--;
      if (this.emitPass) {
        this.emit(opcode, -1, <i32>(this.localCount + this.scope), 1, 0, 0, 0, pc);
      }

      return true;
    } else if (opcode === ops.OP_setglobalslot && this.typed) {
      if (this.scope === 0 && this.outer.size === 0) {
        return this.fail(C.kNoGlobalScopeError);
      }
    }

    if (<u64>this.stack < pops) {
      return this.fail(C.kStackUnderflowError);
    }

    if (<u64>this.stack - pops + checkPushes > this.maxStack) {
      return this.fail(C.kStackOverflowError);
    }

    const scopeBefore = this.scope;
    if (!this.verifySpecial(pc, opcode, a, b)) {
      return false;
    }

    this.emitted = false;
    this.rowC = 0;
    this.pc = pc;
    if (this.typed && !this.typeAt(pc, opcode, a, b, scopeBefore)) {
      return false;
    }

    const stackBefore = this.stack;
    this.stack = <u32>(<u64>this.stack - pops + pushes);
    if (this.emitPass && !this.emitted) {
      this.emitGeneric(pc, opcode, a, b, stackBefore, scopeBefore, <u32>pops);
    }

    return true;
  }

  /** The checks after the stack check that only some opcodes have. */
  verifySpecial(pc: u32, opcode: u8, a: u32, b: u32): bool {
    const abc = this.abc;
    const pool = abc.pool;
    if (opcode >= ops.OP_getlocal0 && opcode < ops.OP_getlocal0 + 4) {
      return this.checkLocal(opcode - ops.OP_getlocal0);
    }

    if (opcode >= ops.OP_setlocal0 && opcode < ops.OP_setlocal0 + 4) {
      return this.checkLocal(opcode - ops.OP_setlocal0);
    }

    switch (opcode) {
      case ops.OP_getlocal:
      case ops.OP_setlocal:
        return this.checkLocal(a);
      case ops.OP_hasnext2:
        if (!this.checkLocal(a) || !this.checkLocal(b)) {
          return false;
        }

        return a === b ? this.fail(C.kInvalidHasNextError) : true;
      case ops.OP_pushstring:
        return this.checkString(a);
      case ops.OP_pushint:
        return a === 0 || a >= <u32>pool.ints.length ? this.fail(C.kCpoolIndexRangeError) : true;
      case ops.OP_pushuint:
        return a === 0 || a >= <u32>pool.uints.length ? this.fail(C.kCpoolIndexRangeError) : true;
      case ops.OP_pushdouble:
        return a === 0 || a >= <u32>pool.doubles.length ? this.fail(C.kCpoolIndexRangeError) : true;
      case ops.OP_pushnamespace:
        return a === 0 || a >= pool.nsCount ? this.fail(C.kCpoolIndexRangeError) : true;
      case ops.OP_dxnslate:
        return this.methodFlags & C.METHOD_SetsDxns ? true : this.fail(C.kIllegalSetDxns);
      case ops.OP_getlex:
        return runtimeParts(pool, a) ? this.fail(C.kIllegalOpMultinameError) : true;
      case ops.OP_finddef:
        return isBinding(pool, a) ? true : this.fail(C.kIllegalOpMultinameError);
      case ops.OP_callproperty:
      case ops.OP_callproplex:
      case ops.OP_callpropvoid:
      case ops.OP_constructprop:
      case ops.OP_callsuper:
      case ops.OP_callsupervoid:
      case ops.OP_getsuper:
      case ops.OP_setsuper:
        return isAttribute(pool, a) ? this.fail(C.kIllegalOpMultinameError) : true;
      case ops.OP_newfunction:
        return a >= abc.methodCount ? this.fail(C.kMethodInfoExceedsCountError) : true;
      case ops.OP_newclass:
        return a >= abc.classCount ? this.fail(C.kClassInfoExceedsCountError) : true;
      case ops.OP_newactivation:
        return this.methodFlags & C.METHOD_NeedActivation
          ? true
          : this.fail(C.kInvalidNewActivationError);
      case ops.OP_newcatch:
        return a >= this.handlerCount ? this.fail(C.kInvalidNewActivationError) : true;
      case ops.OP_pushscope:
      case ops.OP_pushwith:
        if (this.scope + 1 > this.maxScope) {
          return this.fail(C.kScopeStackOverflowError);
        }

        this.scope++;
        return true;
      case ops.OP_getscopeobject:
        // The verifier reads the index as the operand's first byte.
        return <u32>load<u8>(this.start + pc + 1) >= this.scope
          ? this.fail(C.kGetScopeObjectBoundsError)
          : true;
      default:
        return true;
    }
  }

  /**
   * Whether method `m` of this ABC may be called statically: without types
   * any may, as the structural checks cannot tell; with them, as avmplus'
   * AbcEnv, one bound to a traits by a method, getter or setter.
   */
  callable(m: u32): bool {
    const domain = this.domain;
    if (!this.typed) {
      return true;
    }

    return domain.isVirtual(domain.methodStart[this.index] + m);
  }

  /**
   * The type effects and type checks of the instruction at `pc`, as in
   * Verifier::verifyBlock, before the stack depth changes; `scope` is the
   * scope depth before the instruction.
   */
  typeAt(pc: u32, opcode: u8, a: u32, b: u32, scope: u32): bool {
    const domain = this.domain;
    const top = this.peek(1);
    switch (opcode) {
      case ops.OP_lookupswitch:
        return this.peekType(1, domain.intType);
      case ops.OP_pushnull:
        return this.push(domain.nullType, 0);
      case ops.OP_pushundefined:
        return this.push(domain.voidType, 0);
      case ops.OP_pushtrue:
      case ops.OP_pushfalse:
        return this.push(domain.booleanType, NOT_NULL);
      case ops.OP_pushnan:
      case ops.OP_pushdouble:
        return this.push(domain.numberType, NOT_NULL);
      case ops.OP_pushbyte:
      case ops.OP_pushshort:
      case ops.OP_pushint:
        return this.push(domain.intType, NOT_NULL);
      case ops.OP_pushuint:
        return this.push(domain.uintType, NOT_NULL);
      case ops.OP_pushstring:
        return this.push(domain.stringType, NOT_NULL);
      case ops.OP_pushnamespace:
        return this.push(domain.namespaceType, NOT_NULL);
      case ops.OP_setlocal:
        this.setValue(a, this.typeOf(top), this.valueFlags[top] & NOT_NULL);
        return true;
      case ops.OP_getlocal:
        return this.push(this.typeOf(a), this.valueFlags[a] & NOT_NULL);
      case ops.OP_newfunction:
        if (this.emitPass && !this.captureFunction(a)) {
          return false;
        }

        this.rowC = <i32>(domain.methodStart[this.index] + a);
        return this.push(domain.functionType, NOT_NULL);
      case ops.OP_getlex: {
        // The scope object found is the receiver of the get.
        if (!findProperty(this, ops.OP_findpropstrict, a)) {
          return false;
        }

        this.stack++;
        const got = getProperty(this, a, 1);
        this.stack--;
        return got;
      }
      case ops.OP_findpropstrict:
      case ops.OP_findproperty:
        return findProperty(this, opcode, a);
      case ops.OP_newclass:
        if (this.emitPass && !this.captureClass(a)) {
          return false;
        }

        this.coerce(top, domain.classInstanceType());
        this.setValue(top, domain.staticTraitsOf(this.index, a), NOT_NULL);
        this.rowC = domain.staticTraitsOf(this.index, a);
        return true;
      case ops.OP_finddef:
        return findDef(this, a);
      case ops.OP_setproperty:
      case ops.OP_initproperty:
        return setProperty(this, opcode, a);
      case ops.OP_getproperty: {
        const n = propertyDepth(this, a, 1);
        return n > 0 && getProperty(this, a, n);
      }
      case ops.OP_getdescendants: {
        const n = propertyDepth(this, a, 1);
        if (n === 0) {
          return false;
        }

        this.checkNull(this.peek(n));
        return this.popPush(n, TYPE_Any, 0);
      }
      case ops.OP_checkfilter:
      case ops.OP_convert_o:
        this.checkNull(top);
        return true;
      case ops.OP_deleteproperty: {
        const n = propertyDepth(this, a, 1);
        if (n === 0) {
          return false;
        }

        this.checkNull(this.peek(n));
        return this.popPush(n, domain.booleanType, NOT_NULL);
      }
      case ops.OP_astype: {
        const t = typeName(this, a);
        if (t < TYPE_Any) {
          return false;
        }

        if (!canAssign(domain, t, this.typeOf(top))) {
          const result = t !== TYPE_Any && domain.isMachineType(t) ? domain.objectType() : t;
          return this.popPush(1, result, domain.typeNotNull(result) ? NOT_NULL : 0);
        }

        return true;
      }
      case ops.OP_astypelate: {
        let t = domain.instanceTraitsOf(this.typeOf(this.peek(1)));
        if (t !== TYPE_Any && domain.isMachineType(t)) {
          t = domain.objectType();
        }

        return this.popPush(2, t, domain.typeNotNull(t) ? NOT_NULL : 0);
      }
      // The conversion is the instruction itself, which only retypes the value.
      case ops.OP_coerce: {
        const t = typeName(this, a);
        if (t < TYPE_Any) {
          return false;
        }

        this.rowC = t;
        this.retype(top, t);
        return true;
      }
      case ops.OP_convert_b:
      case ops.OP_coerce_b:
        this.retype(top, domain.booleanType);
        return true;
      case ops.OP_coerce_o:
        this.retype(top, domain.objectType());
        return true;
      case ops.OP_coerce_a:
        this.retype(top, TYPE_Any);
        return true;
      case ops.OP_convert_i:
      case ops.OP_coerce_i:
        this.retype(top, domain.intType);
        return true;
      case ops.OP_convert_u:
      case ops.OP_coerce_u:
        this.retype(top, domain.uintType);
        return true;
      case ops.OP_convert_d:
      case ops.OP_coerce_d:
        this.retype(top, domain.numberType);
        return true;
      case ops.OP_coerce_s:
        this.retype(top, domain.stringType);
        return true;
      case ops.OP_iftrue:
      case ops.OP_iffalse:
        this.coerce(top, domain.booleanType);
        return true;
      case ops.OP_returnvalue:
        this.coerce(top, domain.traits.returnType[this.global]);
        return true;
      case ops.OP_istype:
        if (typeName(this, a) < TYPE_Any) {
          return false;
        }

        return this.popPush(1, domain.booleanType, NOT_NULL);
      case ops.OP_istypelate:
        return this.popPush(2, domain.booleanType, NOT_NULL);
      case ops.OP_convert_s:
      case ops.OP_esc_xelem:
      case ops.OP_esc_xattr:
      case ops.OP_typeof:
        return this.popPush(1, domain.stringType, NOT_NULL);
      case ops.OP_callstatic:
        return callStatic(this, a, b);
      case ops.OP_call:
        return this.popPush(a + 2, TYPE_Any, 0);
      case ops.OP_construct: {
        const t = domain.instanceTraitsOf(this.typeOf(this.peek(a + 1)));
        return this.popPush(a + 1, t, NOT_NULL);
      }
      case ops.OP_callmethod: {
        // Always rejected, as avmplus has done since Flash Player 9.
        if (a === 0) {
          return this.fail(C.kZeroDispIdError);
        }

        return this.fail(
          this.typeOf(this.peek(b + 1)) === TYPE_Any
            ? C.kCorruptABCError
            : C.kIllegalEarlyBindingError,
        );
      }
      case ops.OP_callproperty:
      case ops.OP_callproplex:
      case ops.OP_callpropvoid:
        return callProperty(this, opcode, a, b);
      case ops.OP_constructprop: {
        const n = propertyDepth(this, a, b + 1);
        if (n === 0) {
          return false;
        }

        const obj = this.peek(n);
        const type = this.typeOf(obj);
        const found = binding(this, type, a);
        if (found === BIND_Ambiguous) {
          return false;
        }

        const ctraits = readBinding(this, type, found);
        if (ctraits < TYPE_Any) {
          return false;
        }

        this.checkNull(obj);
        this.rowC = ctraits;
        const itraits = domain.instanceTraitsOf(ctraits);
        return this.popPush(n, itraits, itraits === TYPE_Any ? 0 : NOT_NULL);
      }
      case ops.OP_applytype:
        return this.popPush(a + 1, TYPE_Any, NOT_NULL);
      case ops.OP_callsuper:
      case ops.OP_callsupervoid:
        return callSuper(this, opcode, a, b);
      case ops.OP_getsuper:
        return getSuper(this, a);
      case ops.OP_setsuper: {
        const n = propertyDepth(this, a, 2);
        if (n === 0) {
          return false;
        }

        const obj = this.peek(n);
        if (coerceSuper(this, obj) < TYPE_Any) {
          return false;
        }

        this.checkNull(obj);
        return true;
      }
      case ops.OP_constructsuper: {
        const obj = this.peek(a + 1);
        const base = coerceSuper(this, obj);
        if (base < TYPE_Any) {
          return false;
        }

        const init = domain.traits.init[base];
        if (init >= 0 && !coerceArgs(this, <u32>init, a)) {
          return false;
        }

        this.checkNull(obj);
        return true;
      }
      case ops.OP_newobject:
        for (let n: u32 = 2; n <= 2 * a; n += 2) {
          if (!this.peekType(n, domain.stringType)) {
            return false;
          }
        }

        return this.popPush(2 * a, domain.objectType(), NOT_NULL);
      case ops.OP_newarray:
        return this.popPush(a, domain.arrayType, NOT_NULL);
      case ops.OP_pushscope:
      case ops.OP_pushwith: {
        const type = this.typeOf(top);
        const outer = this.outer;
        if (opcode === ops.OP_pushscope && scope === 0 && outer.extra !== TYPE_Any) {
          if (type === TYPE_Any || !domain.traits.subtypeOf(<u32>type, <u32>outer.extra)) {
            return this.fail(C.kIllegalOperandTypeError);
          }
        }

        this.setValue(
          this.localCount + scope,
          type,
          opcode === ops.OP_pushwith ? NOT_NULL | WITH : NOT_NULL,
        );
        return true;
      }
      case ops.OP_newactivation: {
        const t = domain.bodyTraits[this.index][this.abc.methodBody[this.method]];
        const error = t >= 0 ? domain.traits.resolve(domain, <u32>t) : 0;
        if (error) {
          return this.fail(error);
        }

        return this.push(t, NOT_NULL);
      }
      case ops.OP_newcatch:
        return this.push(this.handlerScope[a], NOT_NULL);
      case ops.OP_getscopeobject: {
        const i = this.localCount + load<u8>(this.start + pc + 1);
        return this.push(this.typeOf(i), this.valueFlags[i] & NOT_NULL);
      }
      case ops.OP_getouterscope: {
        const outer = this.outer;
        if (a >= outer.size) {
          return this.fail(C.kGetScopeObjectBoundsError);
        }

        return this.push(outer.types[a], NOT_NULL);
      }
      case ops.OP_getglobalscope:
        return globalScope(this) >= TYPE_Any;
      case ops.OP_getglobalslot: {
        const global = globalScope(this);
        if (global < TYPE_Any) {
          return false;
        }

        // The global object pushed is replaced by the slot's value.
        const slotType = slot(this, global, a - 1);
        return (
          slotType >= TYPE_Any && this.push(slotType, domain.typeNotNull(slotType) ? NOT_NULL : 0)
        );
      }
      case ops.OP_setglobalslot: {
        const outer = this.outer;
        const global = outer.size > 0 ? outer.types[0] : this.typeOf(this.localCount);
        const slotType = slot(this, global, a - 1);
        if (slotType < TYPE_Any) {
          return false;
        }

        this.coerce(top, slotType);
        return true;
      }
      case ops.OP_getslot: {
        const slotType = slot(this, this.typeOf(top), a - 1);
        if (slotType < TYPE_Any) {
          return false;
        }

        this.checkNull(top);
        return this.popPush(1, slotType, domain.typeNotNull(slotType) ? NOT_NULL : 0);
      }
      case ops.OP_setslot: {
        const slotType = slot(this, this.typeOf(this.peek(2)), a - 1);
        if (slotType < TYPE_Any) {
          return false;
        }

        this.coerce(top, slotType);
        this.checkNull(this.peek(2));
        return true;
      }
      case ops.OP_dup:
        return this.push(this.typeOf(top), this.valueFlags[top] & NOT_NULL);
      case ops.OP_swap: {
        const below = this.peek(2);
        const type = this.typeOf(top);
        const flags = this.valueFlags[top] & NOT_NULL;
        this.setValue(top, this.typeOf(below), this.valueFlags[below] & NOT_NULL);
        this.setValue(below, type, flags);
        return true;
      }
      case ops.OP_lessthan:
      case ops.OP_greaterthan:
      case ops.OP_lessequals:
      case ops.OP_greaterequals: {
        // A comparison with a number compares numbers.
        const lhs = this.peek(2);
        const lt = this.typeOf(lhs);
        const rt = this.typeOf(top);
        if (lt !== TYPE_Any && rt !== TYPE_Any) {
          if (!isNumeric(domain, lt) && isNumeric(domain, rt)) {
            this.coerce(lhs, domain.numberType);
          } else if (isNumeric(domain, lt) && !isNumeric(domain, rt)) {
            this.coerce(top, domain.numberType);
          }
        }

        return this.popPush(2, domain.booleanType, NOT_NULL);
      }
      case ops.OP_in:
        this.checkNull(top);
        return this.popPush(2, domain.booleanType, NOT_NULL);
      case ops.OP_equals:
      case ops.OP_strictequals:
      case ops.OP_instanceof:
        return this.popPush(2, domain.booleanType, NOT_NULL);
      case ops.OP_not:
        this.coerce(top, domain.booleanType);
        return this.popPush(1, domain.booleanType, NOT_NULL);
      case ops.OP_add: {
        const lhs = this.peek(2);
        const lt = this.typeOf(lhs);
        const rt = this.typeOf(top);
        const string = domain.stringType;
        if ((lt === string && this.isNotNull(lhs)) || (rt === string && this.isNotNull(top))) {
          return this.popPush(2, string, NOT_NULL);
        }

        if (isNumeric(domain, lt) && isNumeric(domain, rt)) {
          return this.popPush(2, domain.numberType, NOT_NULL);
        }

        // A number or a string, but not null either way.
        return this.popPush(2, domain.objectType(), NOT_NULL);
      }
      case ops.OP_modulo:
      case ops.OP_subtract:
      case ops.OP_divide:
      case ops.OP_multiply:
        this.coerce(this.peek(2), domain.numberType);
        this.coerce(top, domain.numberType);
        return this.popPush(2, domain.numberType, NOT_NULL);
      case ops.OP_negate:
      case ops.OP_increment:
      case ops.OP_decrement:
        this.coerce(top, domain.numberType);
        return true;
      case ops.OP_increment_i:
      case ops.OP_decrement_i:
      case ops.OP_negate_i:
      case ops.OP_bitnot:
        this.coerce(top, domain.intType);
        return true;
      case ops.OP_add_i:
      case ops.OP_subtract_i:
      case ops.OP_multiply_i:
      case ops.OP_bitand:
      case ops.OP_bitor:
      case ops.OP_bitxor:
      case ops.OP_lshift:
      case ops.OP_rshift:
        this.coerce(this.peek(2), domain.intType);
        this.coerce(top, domain.intType);
        return this.popPush(2, domain.intType, NOT_NULL);
      case ops.OP_urshift:
        this.coerce(this.peek(2), domain.intType);
        this.coerce(top, domain.intType);
        return this.popPush(2, domain.uintType, NOT_NULL);
      case ops.OP_nextvalue:
      case ops.OP_nextname:
        return this.peekType(1, domain.intType) && this.popPush(2, TYPE_Any, 0);
      case ops.OP_hasnext:
        return this.peekType(1, domain.intType) && this.popPush(2, domain.intType, NOT_NULL);
      case ops.OP_hasnext2:
        if (this.typeOf(b) !== domain.intType) {
          return this.fail(C.kIllegalOperandTypeError);
        }

        this.setValue(a, TYPE_Any, 0);
        return this.push(domain.booleanType, NOT_NULL);
      case ops.OP_sxi1:
      case ops.OP_sxi8:
      case ops.OP_sxi16:
      case ops.OP_li8:
      case ops.OP_li16:
      case ops.OP_li32:
        this.coerce(top, domain.intType);
        return this.popPush(1, domain.intType, NOT_NULL);
      case ops.OP_lf32:
      case ops.OP_lf64:
        this.coerce(top, domain.intType);
        return this.popPush(1, domain.numberType, NOT_NULL);
      case ops.OP_si8:
      case ops.OP_si16:
      case ops.OP_si32:
        this.coerce(this.peek(2), domain.intType);
        this.coerce(top, domain.intType);
        return true;
      case ops.OP_sf32:
      case ops.OP_sf64:
        this.coerce(this.peek(2), domain.numberType);
        this.coerce(top, domain.intType);
        return true;
      default:
        break;
    }

    if (opcode >= ops.OP_setlocal0 && opcode < ops.OP_setlocal0 + 4) {
      this.setValue(opcode - ops.OP_setlocal0, this.typeOf(top), this.valueFlags[top] & NOT_NULL);
    } else if (opcode >= ops.OP_getlocal0 && opcode < ops.OP_getlocal0 + 4) {
      const i = <u32>(opcode - ops.OP_getlocal0);
      return this.push(this.typeOf(i), this.valueFlags[i] & NOT_NULL);
    }

    return true;
  }

  // Typed helpers, working on the stack before the instruction's depth change.

  /** Push a value; the instruction's stack effect sets the depth afterwards. */
  push(type: i32, flags: u8): bool {
    this.setValue(this.stackBase + this.stack, type, flags);
    return true;
  }

  /** Replace the top `n` values with one. */
  popPush(n: u32, type: i32, flags: u8): bool {
    this.setValue(this.stackBase + this.stack - n, type, flags);
    return true;
  }

  /** As Verifier::emitCoerce: value i becomes `type`, still null or not. */
  coerce(i: u32, type: i32): void {
    const changes = this.valueType[i] !== type;
    this.setValue(i, type, this.valueFlags[i] & NOT_NULL);
    if (this.emitPass && changes && type !== TYPE_Any) {
      this.emit(IR_Coerce, <i32>i, <i32>i, 1, 0, 0, type, this.pc);
    }
  }

  /** As FrameState::setType from a conversion instruction: value i becomes `type`, without IR of its own. */
  retype(i: u32, type: i32): void {
    this.setValue(i, type, this.valueFlags[i] & NOT_NULL);
  }

  /** As Verifier::emitCheckNull: value i is known not null from here on. */
  checkNull(i: u32): void {
    if (this.emitPass && !(this.valueFlags[i] & NOT_NULL)) {
      this.emit(IR_CheckNull, -1, <i32>i, 1, 0, 0, 0, this.pc);
    }

    this.valueFlags[i] = this.valueFlags[i] | NOT_NULL;
    if (i < this.localCount) {
      this.localsVersion++;
    }
  }

  /** As Verifier::peekType: the value `n` from the top must be exactly `type`. */
  peekType(n: u32, type: i32): bool {
    return this.typeOf(this.peek(n)) === type ? true : this.fail(C.kIllegalOperandTypeError);
  }

  /** Write the instruction's own IR row, instead of the generic one. */
  emitOn(op: u16, dst: i32, src: i32, count: u32, a: u32, b: u32, c: i32): bool {
    if (this.emitPass) {
      this.emit(op, dst, src, count, a, b, c, this.pc);
      this.emitted = true;
    }

    return true;
  }

  /** The scope chain `outer` and the scopes pushed so far, with an optional last entry and extra. */
  scopeHere(last: i32, extra: i32): Scope {
    const outer = this.outer;
    const scope = new Scope();
    for (let i: u32 = 0; i < outer.size; i++) {
      scope.types.push(outer.types[i]);
      scope.withs.push(outer.withs[i]);
    }

    for (let i: u32 = 0; i < this.scope; i++) {
      const v = this.localCount + i;
      scope.types.push(this.typeOf(v));
      scope.withs.push(this.valueFlags[v] & WITH ? 1 : 0);
    }

    if (last !== -2) {
      scope.types.push(last);
      scope.withs.push(0);
    }

    scope.size = scope.types.length;
    scope.extra = extra;
    return scope;
  }

  /**
   * As the ScopeWriter's OP_newfunction: function m is created in the scope
   * chain here, once; a method bound to traits cannot be a function, and one
   * created again must be created alike, unless it creates itself.
   */
  captureFunction(m: u32): bool {
    const domain = this.domain;
    const traits = domain.traits;
    const global = domain.methodStart[this.index] + m;
    const scope = this.scopeHere(-2, TYPE_Any);
    const current = traits.functionScope[global];
    // Created again alike, it is still queued, so that verifying the ABC again finds it.
    if (current !== null) {
      if (!current.equals(scope) && global !== this.global) {
        return this.fail(C.kCorruptABCError);
      }

      this.captured.push(global);
      return true;
    }

    if (traits.methodTraits[global] >= 0) {
      return this.fail(C.kCorruptABCError);
    }

    traits.methodFunction[global] = 1;
    const error = traits.sign(domain, global);
    if (error) {
      return this.fail(error);
    }

    traits.functionScope[global] = scope;
    this.captured.push(global);
    return true;
  }

  /**
   * As the ScopeWriter's OP_newclass: the innermost scope must be the base
   * class object; the class's static methods run in the scope chain here,
   * its instance methods in that and the class object, once, and a class
   * created again must be created alike. Both traits resolve.
   */
  captureClass(i: u32): bool {
    const domain = this.domain;
    const traits = domain.traits;
    const ctraits = domain.staticTraitsOf(this.index, i);
    const itraits = domain.instanceTraitsOf(ctraits);
    if (this.scope === 0) {
      return this.fail(C.kCorruptABCError);
    }

    const innermost = this.typeOf(this.localCount + this.scope - 1);
    if (innermost === TYPE_Any || domain.instanceTraitsOf(innermost) !== traits.base[itraits]) {
      return this.fail(C.kCorruptABCError);
    }

    const cscope = this.scopeHere(-2, ctraits);
    const iscope = this.scopeHere(ctraits, itraits);
    const error = traits.resolve(domain, <u32>ctraits) || traits.resolve(domain, <u32>itraits);
    if (error) {
      return this.fail(error);
    }

    const current = traits.scope[ctraits];
    if (current !== null) {
      const instance = traits.scope[itraits];
      if (instance === null || !current.equals(cscope) || !instance.equals(iscope)) {
        return this.fail(C.kCorruptABCError);
      }
    } else {
      traits.scope[ctraits] = cscope;
      traits.scope[itraits] = iscope;
    }

    domain.methodsOf(<u32>ctraits, this.captured);
    domain.methodsOf(<u32>itraits, this.captured);
    return true;
  }

  checkString(index: u32): bool {
    return index === 0 || index >= this.abc.pool.stringCount
      ? this.fail(C.kCpoolIndexRangeError)
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
      if (this.cover[pc] === START) {
        code.offset[i] = pc;
        code.next[i] = this.slotNext[pc];
        code.opcode[i] = load<u8>(this.start + pc);
        code.a[i] = this.slotA[pc];
        code.b[i] = this.slotB[pc];
        code.c[i] = this.slotC[pc];
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
  if (pool.mnKind[mn] === C.CONSTANT_TypeName) {
    mn = pool.mnA[mn];
  }

  const kind = pool.mnKind[mn];
  if (kind === C.CONSTANT_Qname) {
    return pool.mnA[mn] !== 0 && pool.mnB[mn] !== 0;
  }

  return kind === C.CONSTANT_Multiname && pool.mnB[mn] !== 0;
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

/** A multiname's MN_* parts, as avmplus' Multiname flags. */
export function nameParts(pool: ConstantPool, index: u32): u8 {
  let kind = pool.mnKind[index];
  if (kind === C.CONSTANT_TypeName) {
    kind = pool.mnKind[pool.mnA[index]];
  }

  switch (kind) {
    case C.CONSTANT_Qname:
      return MN_QName;
    case C.CONSTANT_QnameA:
      return MN_QName | MN_Attr;
    case C.CONSTANT_RTQname:
      return MN_QName | MN_Rtns;
    case C.CONSTANT_RTQnameA:
      return MN_QName | MN_Rtns | MN_Attr;
    case C.CONSTANT_RTQnameL:
      return MN_QName | MN_Rtns | MN_Rtname;
    case C.CONSTANT_RTQnameLA:
      return MN_QName | MN_Rtns | MN_Rtname | MN_Attr;
    case C.CONSTANT_MultinameL:
      return MN_Rtname;
    case C.CONSTANT_MultinameLA:
      return MN_Rtname | MN_Attr;
    case C.CONSTANT_MultinameA:
      return MN_Attr;
    default:
      return 0;
  }
}

/**
 * Verify, with types, every method of ABC `index` that its scripts can
 * run: each script's initializer and methods, then each class's and
 * function's methods once creating them captured their scope chain, as
 * avmplus verifies each before it first runs. The result is each body's
 * VerifyError, 0 if it verified, or -1 if nothing could run it.
 */
export function verifyMethods(domain: Domain, index: u32): StaticArray<i32> {
  const abc = domain.abcs[index];
  const traits = domain.traits;
  const results = new StaticArray<i32>(abc.bodyCount);
  for (let b: u32 = 0; b < abc.bodyCount; b++) {
    results[b] = -1;
  }

  const queue: u32[] = [];
  const scripts = domain.scriptTraits[index];
  for (let s: u32 = 0; s < abc.scriptCount; s++) {
    domain.methodsOf(scripts[s], queue);
  }

  const methods = domain.methodStart[index];
  const decoder = new BodyDecoder(abc, domain.abcBase[index], domain, index);
  for (let q = 0; q < queue.length; q++) {
    const m = queue[q];
    const body = abc.methodBody[m - methods];
    const scope = traits.scopeOf(m);
    if (body < 0 || scope === null || results[body] !== -1) {
      continue;
    }

    results[body] = decoder.decode(<u32>body, scope).error;
    for (let c = 0; c < decoder.captured.length; c++) {
      queue.push(decoder.captured[c]);
    }
  }

  return results;
}
