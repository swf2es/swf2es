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
import { Domain } from "../link/domain";
import { BIND_None, TYPE_Any } from "../link/traits";
import {
  BIND_Ambiguous,
  bindingType,
  canAssign,
  commonBase,
  getBinding,
  isBindingName,
  isNumeric,
} from "../link/types";
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
  kAmbiguousBindingError,
  kCannotFallOffMethodError,
  kCannotMergeTypesError,
  kClassInfoExceedsCountError,
  kCorruptABCError,
  kCpoolIndexRangeError,
  kDanglingFunctionError,
  kFindVarWithNoScopeError,
  kGetScopeObjectBoundsError,
  kIllegalEarlyBindingError,
  kIllegalExceptionHandlerError,
  kIllegalOpcodeError,
  kIllegalOperandTypeError,
  kIllegalOpMultinameError,
  kIllegalSetDxns,
  kIllegalSuperCallError,
  kInvalidBranchTargetError,
  kInvalidHasNextError,
  kInvalidNewActivationError,
  kInvalidRegisterError,
  kLastInstExceedsCodeSizeError,
  kMethodInfoExceedsCountError,
  kNoGlobalScopeError,
  kScopeDepthUnbalancedError,
  kScopeStackOverflowError,
  kScopeStackUnderflowError,
  kSlotExceedsCountError,
  kStackDepthUnbalancedError,
  kStackOverflowError,
  kStackUnderflowError,
  kWrongArgumentCountError,
  kZeroDispIdError,
  METHOD_NeedActivation,
  METHOD_NeedArguments,
  METHOD_NeedRest,
  METHOD_SetsDxns,
} from "./constants";
import {
  FLAG_Terminal,
  FLAG_Throws,
  OP_add,
  OP_add_i,
  OP_applytype,
  OP_astype,
  OP_astypelate,
  OP_bitand,
  OP_bitnot,
  OP_bitor,
  OP_bitxor,
  OP_call,
  OP_callmethod,
  OP_callproperty,
  OP_callproplex,
  OP_callpropvoid,
  OP_callstatic,
  OP_callsuper,
  OP_callsupervoid,
  OP_checkfilter,
  OP_coerce,
  OP_coerce_a,
  OP_coerce_b,
  OP_coerce_d,
  OP_coerce_i,
  OP_coerce_o,
  OP_coerce_s,
  OP_coerce_u,
  OP_construct,
  OP_constructprop,
  OP_constructsuper,
  OP_convert_b,
  OP_convert_d,
  OP_convert_i,
  OP_convert_o,
  OP_convert_s,
  OP_convert_u,
  OP_debugfile,
  OP_declocal,
  OP_declocal_i,
  OP_decrement,
  OP_decrement_i,
  OP_deleteproperty,
  OP_divide,
  OP_dup,
  OP_dxns,
  OP_dxnslate,
  OP_equals,
  OP_esc_xattr,
  OP_esc_xelem,
  OP_finddef,
  OP_findproperty,
  OP_findpropstrict,
  OP_getdescendants,
  OP_getglobalscope,
  OP_getglobalslot,
  OP_getlex,
  OP_getlocal,
  OP_getlocal0,
  OP_getouterscope,
  OP_getproperty,
  OP_getscopeobject,
  OP_getslot,
  OP_getsuper,
  OP_greaterequals,
  OP_greaterthan,
  OP_hasnext,
  OP_hasnext2,
  OP_in,
  OP_inclocal,
  OP_inclocal_i,
  OP_increment,
  OP_increment_i,
  OP_initproperty,
  OP_instanceof,
  OP_istype,
  OP_istypelate,
  OP_kill,
  OP_label,
  OP_lessequals,
  OP_lessthan,
  OP_lf32,
  OP_lf64,
  OP_li8,
  OP_li16,
  OP_li32,
  OP_lookupswitch,
  OP_lshift,
  OP_modulo,
  OP_multiply,
  OP_multiply_i,
  OP_negate,
  OP_negate_i,
  OP_newactivation,
  OP_newarray,
  OP_newcatch,
  OP_newclass,
  OP_newfunction,
  OP_newobject,
  OP_nextname,
  OP_nextvalue,
  OP_not,
  OP_popscope,
  OP_pushbyte,
  OP_pushdouble,
  OP_pushfalse,
  OP_pushint,
  OP_pushnamespace,
  OP_pushnan,
  OP_pushnull,
  OP_pushscope,
  OP_pushshort,
  OP_pushstring,
  OP_pushtrue,
  OP_pushuint,
  OP_pushundefined,
  OP_pushwith,
  OP_rshift,
  OP_setglobalslot,
  OP_setlocal,
  OP_setlocal0,
  OP_setproperty,
  OP_setslot,
  OP_setsuper,
  OP_strictequals,
  OP_subtract,
  OP_subtract_i,
  OP_swap,
  OP_sxi1,
  OP_sxi8,
  OP_sxi16,
  OP_typeof,
  OP_urshift,
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

/**
 * The scope chain a method is created in (avmplus' ScopeTypeChain): the
 * types of its `size` entries, and whether each is a with scope. An `extra`
 * type other than TYPE_Any constrains the method's first own scope, as for
 * class methods, whose `this` must be of their class.
 */
@final
export class Scope {
  size: u32 = 0;
  types: i32[] = [];
  withs: u8[] = [];
  extra: i32 = TYPE_Any;
}

// Byte states in BodyDecoder.cover, which starts zeroed: unseen.
const START: u8 = 1;
const INSIDE: u8 = 2;

// Frame value flags.
const NOT_NULL: u8 = 1;
const WITH: u8 = 2;

// Multiname parts, as avmplus' Multiname flags.
const MN_Attr: u8 = 1;
const MN_Rtns: u8 = 2;
const MN_Rtname: u8 = 4;
const MN_QName: u8 = 8;

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
  handlerScope: i32[] = [];

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

    this.start = this.base + unchecked(abc.bodyCodeStart[body]);
    this.length = unchecked(abc.bodyCodeLength[body]);
    this.handlerFirst = unchecked(abc.bodyExceptionStart[body]);
    this.handlerCount = unchecked(abc.bodyExceptionStart[body + 1]) - this.handlerFirst;
    this.instructions = 0;
    this.workCount = 0;
    this.entryUsed = 0;
    this.overlap = false;
    this.r.failed = false;
    this.method = unchecked(abc.bodyMethod[body]);
    this.methodFlags = unchecked(abc.methodFlags[this.method]);
    this.maxStack = unchecked(abc.bodyMaxStack[body]);
    this.localCount = unchecked(abc.bodyLocalCount[body]);
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
    if (load<u8>(this.start) === OP_label) {
      if (!this.target(-1, 0, 0, 0)) {
        return code;
      }
    } else {
      if (this.typed) {
        unchecked((this.entryStack[0] = 0));
        unchecked((this.entryScope[0] = 0));
        this.saveEntry(0);
      }

      if (!this.block(0, 0, 0)) {
        return code;
      }
    }

    while (this.workCount) {
      const start = unchecked(this.work[--this.workCount]);
      unchecked((this.pending[start] = 0));
      this.loadEntry(start);
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
    this.frameSize = <u32>frame;
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
      const from = unchecked(abc.exceptionFrom[h]);
      const to = unchecked(abc.exceptionTo[h]);
      const target = unchecked(abc.exceptionTarget[h]);
      const name = unchecked(abc.exceptionName[h]);
      let type = TYPE_Any;
      if (typed && unchecked(abc.exceptionType[h]) !== 0) {
        type = this.typeName(unchecked(abc.exceptionType[h]));
        if (type < TYPE_Any) {
          return false;
        }
      }

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
    this.global = unchecked(domain.methodStart[this.index]) + this.method;
    this.declarer = unchecked(traits.methodTraits[this.global]);
    const error = traits.sign(domain, this.global);
    if (error) {
      return this.fail(error);
    }

    if (<u32>this.valueType.length < this.frameSize) {
      this.valueType = new StaticArray<i32>(this.frameSize);
      this.valueFlags = new StaticArray<u8>(this.frameSize);
    }

    const m = this.global;
    const count = unchecked(traits.paramCount[m]);
    this.setValue(0, unchecked(traits.receiverType[m]), NOT_NULL);
    for (let p: u32 = 0; p < count; p++) {
      this.setValue(p + 1, unchecked(traits.paramType[traits.paramStart[m] + p]), 0);
    }

    let firstLocal = count + 1;
    if (this.methodFlags & (METHOD_NeedRest | METHOD_NeedArguments)) {
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
    unchecked((this.valueType[i] = type));
    unchecked((this.valueFlags[i] = flags));
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
    return unchecked(this.valueType[i]);
  }

  @inline
  isNotNull(i: u32): bool {
    return (unchecked(this.valueFlags[i]) & NOT_NULL) !== 0;
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
    unchecked((this.entryAt[t] = at));
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

    const at = unchecked(this.entryAt[t]);
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
    const domain = this.domain;
    const at = unchecked(this.entryAt[t]);
    const scopeTop = this.localCount + this.scope;
    const stackBase = this.stackBase;
    const stackTop = stackBase + this.stack;
    let changed = 0;
    for (let i: u32 = 0; i < stackTop; i++) {
      if (i >= scopeTop && i < stackBase) {
        i = stackBase - 1;
        continue;
      }

      const flags = unchecked(this.valueFlags[i]);
      const entryFlags = unchecked(this.entryFlags[at + i]);
      if ((flags ^ entryFlags) & WITH) {
        this.fail(kCannotMergeTypesError);
        return -1;
      }

      const entryType = unchecked(this.entryType[at + i]);
      const merged = commonBase(domain, entryType, unchecked(this.valueType[i]));
      const mergedFlags = entryFlags & (flags | WITH);
      if (merged !== entryType || mergedFlags !== entryFlags) {
        unchecked((this.entryType[at + i] = merged));
        unchecked((this.entryFlags[at + i] = mergedFlags));
        changed = 1;
      }
    }

    return changed;
  }

  /** Put known target t on the work list unless it is there already. */
  requeue(t: u32): void {
    if (!unchecked(this.pending[t])) {
      unchecked((this.pending[t] = 1));
      unchecked((this.work[this.workCount++] = t));
    }
  }

  /**
   * As Verifier::checkTarget and mergeState: stay in the code, back edges need
   * a label or known target, and every path into a block has the same stack
   * and scope depths, whose values merge.
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
      const walked = unchecked(this.cover[t]) === START;
      if (
        walked &&
        !this.sameDepths(unchecked(this.stackAt[t]), unchecked(this.scopeAt[t]), stack, scope)
      ) {
        return false;
      }

      unchecked((this.known[t] = 1));
      unchecked((this.entryStack[t] = stack));
      unchecked((this.entryScope[t] = scope));
      if (this.typed) {
        this.saveEntry(t);
      }

      this.requeue(t);

      // The block that walked through t must now end there and merge into it.
      if (walked && this.typed && unchecked(this.walkOf[t]) !== t) {
        this.requeue(unchecked(this.walkOf[t]));
      }
    } else {
      if (
        !this.sameDepths(unchecked(this.entryStack[t]), unchecked(this.entryScope[t]), stack, scope)
      ) {
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
    if (to <= from && !unchecked(this.loopHeader[t])) {
      unchecked((this.loopHeader[t] = 1));
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
      this.code.fail(kStackDepthUnbalancedError);
      return false;
    }

    if (scope !== otherScope) {
      this.code.fail(kScopeDepthUnbalancedError);
      return false;
    }

    return true;
  }

  /**
   * Edges from `pc` to every handler covering it. A handler starts with the
   * locals as they are, no scopes, and just the exception on the stack.
   */
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

        if (!this.typed) {
          if (!this.target(<i64>pc, <i64>unchecked(abc.exceptionTarget[h]), 1, 0)) {
            return false;
          }

          continue;
        }

        const stack = this.stack;
        const scope = this.scope;
        const base = this.stackBase;
        const firstType = unchecked(this.valueType[base]);
        const firstFlags = unchecked(this.valueFlags[base]);
        const type = unchecked(this.handlerType[i]);
        this.setValue(base, type, this.domain.typeNotNull(type) ? NOT_NULL : 0);
        this.stack = 1;
        this.scope = 0;
        const reached = this.target(<i64>pc, <i64>unchecked(abc.exceptionTarget[h]), 1, 0);
        this.stack = stack;
        this.scope = scope;
        this.setValue(base, firstType, firstFlags);
        if (!reached) {
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

      // A loop header's implicit interrupt check can throw too, with the
      // state the block is entered with.
      const flags = unchecked(opcodeFlags[opcode]);
      if (flags & FLAG_Throws || (pc === start && this.typed && unchecked(this.loopHeader[pc]))) {
        if (!this.throwsAt(pc)) {
          return false;
        }
      }

      // Decoded already, walking through from an earlier block: without types
      // it was checked with the same depths, so only a typed walk goes on.
      if (unchecked(this.cover[pc]) === START) {
        if (!this.typed) {
          return true;
        }
      } else if (!this.decodeAt(pc, opcode, operands)) {
        return false;
      }

      unchecked((this.walkOf[pc] = start));
      unchecked((this.stackAt[pc] = this.stack));
      unchecked((this.scopeAt[pc] = this.scope));
      if (!this.verifyAt(pc, opcode)) {
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
   * The checks of the instruction at `pc` in Verifier::verifyBlock, in the
   * verifier's order, and its effect on the stack and scope depths and, when
   * typed, on the values; false after recording the error.
   */
  verifyAt(pc: u32, opcode: u8): bool {
    const pool = this.abc.pool;
    const a = <u32>unchecked(this.slotA[pc]);
    const b = unchecked(this.slotB[pc]);
    const stack = unchecked(opcodeStack[opcode]);
    let pops = <u64>unchecked(opcodePops[opcode]);
    const pushes = <u64>unchecked(opcodePushes[opcode]);
    const checkPushes = stack & STACK_CheckPushOne ? 1 : pushes;

    // A name looked up in the scope chain needs a scope to look in.
    if (
      this.typed &&
      (opcode === OP_getlex || opcode === OP_findpropstrict || opcode === OP_findproperty) &&
      this.scope + this.outer.size === 0
    ) {
      return this.fail(kFindVarWithNoScopeError);
    }

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
      if (a >= this.abc.methodCount || !this.callable(a)) {
        return this.fail(kCorruptABCError);
      }
    } else if (opcode === OP_dxns) {
      if (!(this.methodFlags & METHOD_SetsDxns)) {
        return this.fail(kIllegalSetDxns);
      }

      return this.checkString(a);
    } else if (opcode === OP_debugfile) {
      return this.checkString(a);
    } else if (opcode === OP_kill) {
      if (!this.checkLocal(a)) {
        return false;
      }

      if (this.typed) {
        this.setValue(a, TYPE_Any, 0);
      }

      return true;
    } else if (opcode === OP_inclocal || opcode === OP_declocal) {
      if (!this.checkLocal(a)) {
        return false;
      }

      if (this.typed) {
        this.coerce(a, this.domain.numberType);
      }

      return true;
    } else if (opcode === OP_inclocal_i || opcode === OP_declocal_i) {
      if (!this.checkLocal(a)) {
        return false;
      }

      if (this.typed) {
        this.coerce(a, this.domain.intType);
      }

      return true;
    } else if (opcode === OP_popscope) {
      if (this.scope === 0) {
        return this.fail(kScopeStackUnderflowError);
      }

      this.scope--;
      return true;
    } else if (opcode === OP_setglobalslot && this.typed) {
      if (this.scope === 0 && this.outer.size === 0) {
        return this.fail(kNoGlobalScopeError);
      }
    }

    if (<u64>this.stack < pops) {
      return this.fail(kStackUnderflowError);
    }

    if (<u64>this.stack - pops + checkPushes > this.maxStack) {
      return this.fail(kStackOverflowError);
    }

    const scopeBefore = this.scope;
    if (!this.verifySpecial(pc, opcode, a, b)) {
      return false;
    }

    if (this.typed && !this.typeAt(pc, opcode, a, b, scopeBefore)) {
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

    return domain.isVirtual(unchecked(domain.methodStart[this.index]) + m);
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
      case OP_lookupswitch:
        return this.peekType(1, domain.intType);
      case OP_pushnull:
        return this.push(domain.nullType, 0);
      case OP_pushundefined:
        return this.push(domain.voidType, 0);
      case OP_pushtrue:
      case OP_pushfalse:
        return this.push(domain.booleanType, NOT_NULL);
      case OP_pushnan:
      case OP_pushdouble:
        return this.push(domain.numberType, NOT_NULL);
      case OP_pushbyte:
      case OP_pushshort:
      case OP_pushint:
        return this.push(domain.intType, NOT_NULL);
      case OP_pushuint:
        return this.push(domain.uintType, NOT_NULL);
      case OP_pushstring:
        return this.push(domain.stringType, NOT_NULL);
      case OP_pushnamespace:
        return this.push(domain.namespaceType, NOT_NULL);
      case OP_setlocal:
        this.setValue(a, this.typeOf(top), unchecked(this.valueFlags[top]) & NOT_NULL);
        return true;
      case OP_getlocal:
        return this.push(this.typeOf(a), unchecked(this.valueFlags[a]) & NOT_NULL);
      case OP_newfunction:
        return this.push(domain.functionType, NOT_NULL);
      case OP_getlex: {
        // The scope object found is the receiver of the get.
        if (!this.findProperty(a)) {
          return false;
        }

        this.stack++;
        const got = this.getProperty(a, 1);
        this.stack--;
        return got;
      }
      case OP_findpropstrict:
      case OP_findproperty:
        return this.findProperty(a);
      case OP_newclass:
        this.coerce(top, domain.classInstanceType());
        this.setValue(top, domain.staticTraitsOf(this.index, a), NOT_NULL);
        return true;
      case OP_finddef:
        return this.findDef(a);
      case OP_setproperty:
      case OP_initproperty:
        return this.setProperty(opcode, a);
      case OP_getproperty: {
        const n = this.propertyDepth(a, 1);
        return n > 0 && this.getProperty(a, n);
      }
      case OP_getdescendants: {
        const n = this.propertyDepth(a, 1);
        if (n === 0) {
          return false;
        }

        this.checkNull(this.peek(n));
        return this.popPush(n, TYPE_Any, 0);
      }
      case OP_checkfilter:
      case OP_convert_o:
        this.checkNull(top);
        return true;
      case OP_deleteproperty: {
        const n = this.propertyDepth(a, 1);
        if (n === 0) {
          return false;
        }

        this.checkNull(this.peek(n));
        return this.popPush(n, domain.booleanType, NOT_NULL);
      }
      case OP_astype: {
        const t = this.typeName(a);
        if (t < TYPE_Any) {
          return false;
        }

        if (!canAssign(domain, t, this.typeOf(top))) {
          const result = t !== TYPE_Any && domain.isMachineType(t) ? domain.objectType() : t;
          return this.popPush(1, result, domain.typeNotNull(result) ? NOT_NULL : 0);
        }

        return true;
      }
      case OP_astypelate: {
        let t = domain.instanceTraitsOf(this.typeOf(this.peek(1)));
        if (t !== TYPE_Any && domain.isMachineType(t)) {
          t = domain.objectType();
        }

        return this.popPush(2, t, domain.typeNotNull(t) ? NOT_NULL : 0);
      }
      case OP_coerce: {
        const t = this.typeName(a);
        if (t < TYPE_Any) {
          return false;
        }

        this.coerce(top, t);
        return true;
      }
      case OP_convert_b:
      case OP_coerce_b:
        this.coerce(top, domain.booleanType);
        return true;
      case OP_coerce_o:
        this.coerce(top, domain.objectType());
        return true;
      case OP_coerce_a:
        this.coerce(top, TYPE_Any);
        return true;
      case OP_convert_i:
      case OP_coerce_i:
        this.coerce(top, domain.intType);
        return true;
      case OP_convert_u:
      case OP_coerce_u:
        this.coerce(top, domain.uintType);
        return true;
      case OP_convert_d:
      case OP_coerce_d:
        this.coerce(top, domain.numberType);
        return true;
      case OP_coerce_s:
        this.coerce(top, domain.stringType);
        return true;
      case OP_istype:
        if (this.typeName(a) < TYPE_Any) {
          return false;
        }

        return this.popPush(1, domain.booleanType, NOT_NULL);
      case OP_istypelate:
        return this.popPush(2, domain.booleanType, NOT_NULL);
      case OP_convert_s:
      case OP_esc_xelem:
      case OP_esc_xattr:
      case OP_typeof:
        return this.popPush(1, domain.stringType, NOT_NULL);
      case OP_callstatic:
        return this.callStatic(a, b);
      case OP_call:
        return this.popPush(a + 2, TYPE_Any, 0);
      case OP_construct: {
        const t = domain.instanceTraitsOf(this.typeOf(this.peek(a + 1)));
        return this.popPush(a + 1, t, NOT_NULL);
      }
      case OP_callmethod: {
        // Always rejected, as avmplus has done since Flash Player 9.
        if (a === 0) {
          return this.fail(kZeroDispIdError);
        }

        return this.fail(
          this.typeOf(this.peek(b + 1)) === TYPE_Any ? kCorruptABCError : kIllegalEarlyBindingError,
        );
      }
      case OP_callproperty:
      case OP_callproplex:
      case OP_callpropvoid:
        return this.callProperty(opcode, a, b);
      case OP_constructprop: {
        const n = this.propertyDepth(a, b + 1);
        if (n === 0) {
          return false;
        }

        const obj = this.peek(n);
        const type = this.typeOf(obj);
        const binding = this.binding(type, a);
        if (binding === BIND_Ambiguous) {
          return false;
        }

        const ctraits = this.readBinding(type, binding);
        if (ctraits < TYPE_Any) {
          return false;
        }

        this.checkNull(obj);
        const itraits = domain.instanceTraitsOf(ctraits);
        return this.popPush(n, itraits, itraits === TYPE_Any ? 0 : NOT_NULL);
      }
      case OP_applytype:
        return this.popPush(a + 1, TYPE_Any, NOT_NULL);
      case OP_callsuper:
      case OP_callsupervoid:
        return this.callSuper(opcode, a, b);
      case OP_getsuper:
        return this.getSuper(a);
      case OP_setsuper: {
        const n = this.propertyDepth(a, 2);
        if (n === 0) {
          return false;
        }

        const obj = this.peek(n);
        if (this.coerceSuper(obj) < TYPE_Any) {
          return false;
        }

        this.checkNull(obj);
        return true;
      }
      case OP_constructsuper: {
        const obj = this.peek(a + 1);
        const base = this.coerceSuper(obj);
        if (base < TYPE_Any) {
          return false;
        }

        const init = unchecked(domain.traits.init[base]);
        if (init >= 0 && !this.coerceArgs(<u32>init, a)) {
          return false;
        }

        this.checkNull(obj);
        return true;
      }
      case OP_newobject:
        for (let n: u32 = 2; n <= 2 * a; n += 2) {
          if (!this.peekType(n, domain.stringType)) {
            return false;
          }
        }

        return this.popPush(2 * a, domain.objectType(), NOT_NULL);
      case OP_newarray:
        return this.popPush(a, domain.arrayType, NOT_NULL);
      case OP_pushscope:
      case OP_pushwith: {
        const type = this.typeOf(top);
        const outer = this.outer;
        if (opcode === OP_pushscope && scope === 0 && outer.extra !== TYPE_Any) {
          if (type === TYPE_Any || !domain.traits.subtypeOf(<u32>type, <u32>outer.extra)) {
            return this.fail(kIllegalOperandTypeError);
          }
        }

        this.setValue(
          this.localCount + scope,
          type,
          opcode === OP_pushwith ? NOT_NULL | WITH : NOT_NULL,
        );
        return true;
      }
      case OP_newactivation: {
        const t = unchecked(domain.bodyTraits[this.index][this.abc.methodBody[this.method]]);
        const error = t >= 0 ? domain.traits.resolve(domain, <u32>t) : 0;
        if (error) {
          return this.fail(error);
        }

        return this.push(t, NOT_NULL);
      }
      case OP_newcatch:
        return this.push(unchecked(this.handlerScope[a]), NOT_NULL);
      case OP_getscopeobject: {
        const i = this.localCount + load<u8>(this.start + pc + 1);
        return this.push(this.typeOf(i), unchecked(this.valueFlags[i]) & NOT_NULL);
      }
      case OP_getouterscope: {
        const outer = this.outer;
        if (a >= outer.size) {
          return this.fail(kGetScopeObjectBoundsError);
        }

        return this.push(unchecked(outer.types[a]), NOT_NULL);
      }
      case OP_getglobalscope:
        return this.globalScope() >= TYPE_Any;
      case OP_getglobalslot: {
        const global = this.globalScope();
        if (global < TYPE_Any) {
          return false;
        }

        // The global object pushed is replaced by the slot's value.
        const slotType = this.slot(global, a - 1);
        return (
          slotType >= TYPE_Any && this.push(slotType, domain.typeNotNull(slotType) ? NOT_NULL : 0)
        );
      }
      case OP_setglobalslot: {
        const outer = this.outer;
        const global = outer.size > 0 ? unchecked(outer.types[0]) : this.typeOf(this.localCount);
        const slotType = this.slot(global, a - 1);
        if (slotType < TYPE_Any) {
          return false;
        }

        this.coerce(top, slotType);
        return true;
      }
      case OP_getslot: {
        const slotType = this.slot(this.typeOf(top), a - 1);
        if (slotType < TYPE_Any) {
          return false;
        }

        this.checkNull(top);
        return this.popPush(1, slotType, domain.typeNotNull(slotType) ? NOT_NULL : 0);
      }
      case OP_setslot: {
        const slotType = this.slot(this.typeOf(this.peek(2)), a - 1);
        if (slotType < TYPE_Any) {
          return false;
        }

        this.coerce(top, slotType);
        this.checkNull(this.peek(2));
        return true;
      }
      case OP_dup:
        return this.push(this.typeOf(top), unchecked(this.valueFlags[top]) & NOT_NULL);
      case OP_swap: {
        const below = this.peek(2);
        const type = this.typeOf(top);
        const flags = unchecked(this.valueFlags[top]) & NOT_NULL;
        this.setValue(top, this.typeOf(below), unchecked(this.valueFlags[below]) & NOT_NULL);
        this.setValue(below, type, flags);
        return true;
      }
      case OP_lessthan:
      case OP_greaterthan:
      case OP_lessequals:
      case OP_greaterequals: {
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
      case OP_in:
        this.checkNull(top);
        return this.popPush(2, domain.booleanType, NOT_NULL);
      case OP_equals:
      case OP_strictequals:
      case OP_instanceof:
        return this.popPush(2, domain.booleanType, NOT_NULL);
      case OP_not:
        return this.popPush(1, domain.booleanType, NOT_NULL);
      case OP_add: {
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
      case OP_modulo:
      case OP_subtract:
      case OP_divide:
      case OP_multiply:
        return this.popPush(2, domain.numberType, NOT_NULL);
      case OP_negate:
      case OP_increment:
      case OP_decrement:
        this.coerce(top, domain.numberType);
        return true;
      case OP_increment_i:
      case OP_decrement_i:
      case OP_negate_i:
      case OP_bitnot:
        this.coerce(top, domain.intType);
        return true;
      case OP_add_i:
      case OP_subtract_i:
      case OP_multiply_i:
      case OP_bitand:
      case OP_bitor:
      case OP_bitxor:
      case OP_lshift:
      case OP_rshift:
        return this.popPush(2, domain.intType, NOT_NULL);
      case OP_urshift:
        return this.popPush(2, domain.uintType, NOT_NULL);
      case OP_nextvalue:
      case OP_nextname:
        return this.peekType(1, domain.intType) && this.popPush(2, TYPE_Any, 0);
      case OP_hasnext:
        return this.peekType(1, domain.intType) && this.popPush(2, domain.intType, NOT_NULL);
      case OP_hasnext2:
        if (this.typeOf(b) !== domain.intType) {
          return this.fail(kIllegalOperandTypeError);
        }

        this.setValue(a, TYPE_Any, 0);
        return this.push(domain.booleanType, NOT_NULL);
      case OP_sxi1:
      case OP_sxi8:
      case OP_sxi16:
      case OP_li8:
      case OP_li16:
      case OP_li32:
        return this.popPush(1, domain.intType, NOT_NULL);
      case OP_lf32:
      case OP_lf64:
        return this.popPush(1, domain.numberType, NOT_NULL);
      default:
        break;
    }

    if (opcode >= OP_setlocal0 && opcode < OP_setlocal0 + 4) {
      this.setValue(
        opcode - OP_setlocal0,
        this.typeOf(top),
        unchecked(this.valueFlags[top]) & NOT_NULL,
      );
    } else if (opcode >= OP_getlocal0 && opcode < OP_getlocal0 + 4) {
      const i = <u32>(opcode - OP_getlocal0);
      return this.push(this.typeOf(i), unchecked(this.valueFlags[i]) & NOT_NULL);
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
    this.setValue(i, type, unchecked(this.valueFlags[i]) & NOT_NULL);
  }

  /** As Verifier::emitCheckNull: value i is known not null from here on. */
  checkNull(i: u32): void {
    unchecked((this.valueFlags[i] = this.valueFlags[i] | NOT_NULL));
  }

  /** As Verifier::peekType: the value `n` from the top must be exactly `type`. */
  peekType(n: u32, type: i32): bool {
    return this.typeOf(this.peek(n)) === type ? true : this.fail(kIllegalOperandTypeError);
  }

  /**
   * As Verifier::checkPropertyMultiname: count the runtime parts of
   * multiname `mn` above the `n` values below them, checking that a runtime
   * name with a namespace is a String and a runtime namespace a Namespace.
   * Returns the depth of the receiver, or 0 after recording an error.
   */
  propertyDepth(mn: u32, n: u32): u32 {
    const domain = this.domain;
    const parts = nameParts(this.abc.pool, mn);
    if (parts & MN_Rtname) {
      if (parts & MN_QName && !this.peekType(n, domain.stringType)) {
        return 0;
      }

      n++;
    }

    if (parts & MN_Rtns) {
      if (!this.peekType(n, domain.namespaceType)) {
        return 0;
      }

      n++;
    }

    return n;
  }

  /** The binding of `mn` on `type`, recording 1008 if it is ambiguous. */
  binding(type: i32, mn: u32): u32 {
    const b = getBinding(this.domain, this.index, type, mn);
    if (b === BIND_Ambiguous) {
      this.fail(kAmbiguousBindingError);
    }

    return b;
  }

  /** As Verifier::readBinding: resolve `type`, then the type of its binding b; below TYPE_Any on error. */
  readBinding(type: i32, b: u32): i32 {
    if (type < 0) {
      return TYPE_Any;
    }

    const domain = this.domain;
    const error = domain.traits.resolve(domain, <u32>type);
    if (error) {
      this.fail(error);
      return -2;
    }

    return bindingType(domain, type, b);
  }

  /** As Verifier::checkTypeName: the type multiname `mn` names; below TYPE_Any on error. */
  typeName(mn: u32): i32 {
    const pool = this.abc.pool;
    if (mn === 0 || mn >= pool.multinameCount) {
      this.fail(kCpoolIndexRangeError);
      return -2;
    }

    const domain = this.domain;
    const t = domain.checkTypeName(this.index, mn);
    if (t < TYPE_Any) {
      this.fail(domain.typeError);
    }

    return t;
  }

  /**
   * As Verifier::emitCoerceArgs: method m must take `argc` arguments, which
   * become its parameter types, and the receiver below them its receiver type.
   */
  coerceArgs(m: u32, argc: u32): bool {
    const domain = this.domain;
    const traits = domain.traits;
    const error = traits.sign(domain, m);
    if (error) {
      return this.fail(error);
    }

    const count = unchecked(traits.paramCount[m]);
    const required = count - unchecked(traits.optionalCount[m]);
    if (argc < required || (argc > count && !domain.allowsExtraArgs(m))) {
      return this.fail(kWrongArgumentCountError);
    }

    const start = unchecked(traits.paramStart[m]);
    for (let k: u32 = 1; k <= argc; k++) {
      const target = k <= count ? unchecked(traits.paramType[start + k - 1]) : TYPE_Any;
      this.coerce(this.peek(argc - k + 1), target);
    }

    this.coerce(this.peek(argc + 1), unchecked(traits.receiverType[m]));
    return true;
  }

  /** As Verifier::emitCoerceSuper: the receiver at i becomes the declaring class's base. */
  coerceSuper(i: u32): i32 {
    const base = this.declarer >= 0 ? unchecked(this.domain.traits.base[this.declarer]) : -1;
    if (base < 0) {
      this.fail(kIllegalSuperCallError);
      return -2;
    }

    this.coerce(i, base);
    return base;
  }

  /**
   * As Verifier::checkEarlySlotBinding and checkSlot: `type` must come from
   * this ABC and allow early binding, and have slot `slot`, whose type this
   * returns; below TYPE_Any on error.
   */
  slot(type: i32, slot: u32): i32 {
    const domain = this.domain;
    const traits = domain.traits;
    if (
      type < 0 ||
      unchecked(traits.abc[type]) !== this.index ||
      !traits.allowEarlyBinding(<u32>type)
    ) {
      this.fail(kIllegalEarlyBindingError);
      return -2;
    }

    const error = traits.resolve(domain, <u32>type);
    if (error) {
      this.fail(error);
      return -2;
    }

    if (slot >= unchecked(traits.slotCount[type])) {
      this.fail(kSlotExceedsCountError);
      return -2;
    }

    return unchecked(traits.slotType[traits.slotStart[type] + slot]);
  }

  /** As Verifier::checkGetGlobalScope: push the global object; its type, below TYPE_Any on error. */
  globalScope(): i32 {
    const outer = this.outer;
    if (outer.size > 0) {
      const t = unchecked(outer.types[0]);
      this.push(t, NOT_NULL);
      return t;
    }

    if (this.scope === 0) {
      this.fail(kGetScopeObjectBoundsError);
      return -2;
    }

    const i = this.localCount;
    this.push(this.typeOf(i), unchecked(this.valueFlags[i]) & NOT_NULL);
    return this.typeOf(i);
  }

  /**
   * As Verifier::emitFindProperty: the scope object a name is found on, from
   * the innermost scope out, stopping at a with scope, then the scripts that
   * define it; else an Object, after the runtime name parts are popped.
   */
  findProperty(mn: u32): bool {
    const domain = this.domain;
    const outer = this.outer;
    if (isBindingName(domain, this.index, mn)) {
      // With no outer scopes, the global object is a local scope, which is not bound early.
      const base = this.localCount + (outer.size === 0 ? 1 : 0);
      let i = <i32>(this.localCount + this.scope) - 1;
      for (; i >= <i32>base; i--) {
        const b = this.binding(this.typeOf(<u32>i), mn);
        if (b === BIND_Ambiguous) {
          return false;
        }

        if (b !== 0) {
          return this.push(this.typeOf(<u32>i), unchecked(this.valueFlags[i]) & NOT_NULL);
        }

        if (unchecked(this.valueFlags[i]) & WITH) {
          break;
        }
      }

      if (i < <i32>base) {
        let j = <i32>outer.size - 1;
        for (; j > 0; j--) {
          const t = unchecked(outer.types[j]);
          const b = this.binding(t, mn);
          if (b === BIND_Ambiguous) {
            return false;
          }

          if (b !== 0) {
            return this.push(t, NOT_NULL);
          }

          if (unchecked(outer.withs[j])) {
            break;
          }
        }

        if (j <= 0) {
          const script = domain.findScript(this.index, mn);
          if (script >= 0) {
            return this.push(script, NOT_NULL);
          }
        }
      }
    }

    const n = this.propertyDepth(mn, 1);
    if (n === 0) {
      return false;
    }

    return this.popPush(n - 1, domain.objectType(), NOT_NULL);
  }

  /** As Verifier's OP_finddef: the global object of the script that defines `mn`, else Object. */
  findDef(mn: u32): bool {
    const domain = this.domain;
    const script = domain.findScript(this.index, mn);
    return this.push(script >= 0 ? script : domain.objectType(), NOT_NULL);
  }

  /**
   * As Verifier::emitGetProperty: a slot's or getter's type when the name
   * binds early, a Vector's element type for a numeric index, else *.
   */
  getProperty(mn: u32, n: u32): bool {
    const domain = this.domain;
    const obj = this.peek(n);
    const type = this.typeOf(obj);
    const b = this.binding(type, mn);
    if (b === BIND_Ambiguous) {
      return false;
    }

    let propType = this.readBinding(type, b);
    if (propType < TYPE_Any) {
      return false;
    }

    this.checkNull(obj);
    const kind = b & 7;
    if (kind === 2 || kind === 3) {
      // The builtin global's Math and Number are never null.
      const notNull =
        unchecked(domain.traits.abc[type]) === domain.builtinAbc &&
        domain.isMathOrNumber(this.index, mn);
      return this.popPush(n, propType, notNull ? NOT_NULL : 0);
    }

    if (kind === 5 || kind === 7) {
      return this.popPush(n, propType, domain.typeNotNull(propType) ? NOT_NULL : 0);
    }

    if (propType === TYPE_Any && this.numericIndex(mn)) {
      if (type === domain.vectorIntType) {
        propType = domain.intType;
      } else if (type === domain.vectorUintType) {
        propType = domain.uintType;
      } else if (type === domain.vectorDoubleType) {
        propType = domain.numberType;
      } else if (
        type >= 0 &&
        domain.vectorObjectType >= 0 &&
        domain.traits.subtypeOf(<u32>type, <u32>domain.vectorObjectType)
      ) {
        propType = unchecked(domain.traits.param[type]);
      }
    }

    return this.popPush(n, propType, domain.typeNotNull(propType) ? NOT_NULL : 0);
  }

  /**
   * Whether multiname `mn` is a runtime name in a public namespace, not an
   * attribute, and the top of the stack, its name, is a number.
   */
  numericIndex(mn: u32): bool {
    const domain = this.domain;
    const parts = nameParts(this.abc.pool, mn);
    if (parts & MN_Attr || !(parts & MN_Rtname) || !domain.hasPublicNamespace(this.index, mn)) {
      return false;
    }

    const t = this.typeOf(this.peek(1));
    return t === domain.intType || t === domain.uintType || t === domain.numberType;
  }

  /** As Verifier's OP_setproperty and OP_initproperty. */
  setProperty(opcode: u8, mn: u32): bool {
    const domain = this.domain;
    const n = this.propertyDepth(mn, 2);
    if (n === 0) {
      return false;
    }

    const obj = this.peek(n);
    const type = this.typeOf(obj);
    const b = this.binding(type, mn);
    if (b === BIND_Ambiguous) {
      return false;
    }

    const propType = this.readBinding(type, b);
    if (propType < TYPE_Any) {
      return false;
    }

    this.checkNull(obj);
    const kind = b & 7;
    const top = this.peek(1);

    // A var, or a const set by the initializer of the traits declaring it.
    if (
      kind === 2 ||
      (kind === 3 &&
        opcode === OP_initproperty &&
        domain.initOfDeclarer(type, this.index, mn) === <i32>this.global)
    ) {
      this.coerce(top, propType);
      return true;
    }

    if (kind === 6 || kind === 7) {
      const setter = unchecked(
        domain.traits.dispatch[domain.traits.dispatchStart[type] + (b >> 3) + 1],
      );
      if (setter >= 0 && !this.coerceArgs(<u32>setter, 1)) {
        return false;
      }

      return true;
    }

    if (this.numericIndex(mn)) {
      if (type === domain.vectorIntType) {
        this.coerce(top, domain.intType);
      } else if (type === domain.vectorUintType) {
        this.coerce(top, domain.uintType);
      } else if (type === domain.vectorDoubleType) {
        this.coerce(top, domain.numberType);
      }
    }

    return true;
  }

  /** As Verifier::emitCallproperty and emitCallpropertyMethod. */
  callProperty(opcode: u8, mn: u32, argc: u32): bool {
    const domain = this.domain;
    const traits = domain.traits;
    const n = this.propertyDepth(mn, argc + 1);
    if (n === 0) {
      return false;
    }

    const obj = this.peek(n);
    const type = this.typeOf(obj);
    if (type >= 0) {
      const error = traits.resolve(domain, <u32>type);
      if (error) {
        return this.fail(error);
      }
    }

    let b = this.binding(type, mn);
    if (b === BIND_Ambiguous) {
      return false;
    }

    this.checkNull(obj);
    const voidCall = opcode === OP_callpropvoid;
    if ((b & 7) === 1) {
      b = this.fasterCall(type, mn, b, argc);
      const m = unchecked(traits.dispatch[traits.dispatchStart[type] + (b >> 3)]);
      if (m >= 0) {
        const signError = traits.sign(domain, <u32>m);
        if (signError) {
          return this.fail(signError);
        }

        const count = unchecked(traits.paramCount[m]);
        const required = count - unchecked(traits.optionalCount[m]);
        if (argc >= required && (argc <= count || domain.allowsExtraArgs(<u32>m))) {
          if (!this.coerceArgs(<u32>m, argc)) {
            return false;
          }

          const result = unchecked(traits.returnType[m]);
          return this.popPush(n, result, domain.typeNotNull(result) ? NOT_NULL : 0);
        }
      }
    } else if (((b & 7) === 2 || (b & 7) === 3) && argc === 1) {
      // Calling a class slot with one argument converts or coerces to the class.
      const slotType = bindingType(domain, type, b);
      const converted = domain.conversionOf(slotType);
      const top = this.peek(1);
      if (converted !== -2) {
        if (converted >= 0 && domain.isConversion(slotType)) {
          this.setValue(top, converted, NOT_NULL);
        } else {
          this.coerce(top, converted);
        }

        const flags = unchecked(this.valueFlags[top]);
        const value = this.typeOf(top);
        return voidCall ? true : this.popPush(n, value, flags & NOT_NULL);
      }
    }

    return this.popPush(n, TYPE_Any, 0);
  }

  /**
   * As Verifier::findMathFunction and findStringFunction: Math's and
   * String's methods have variants named with a leading underscore for
   * arguments of the right types, which Math's numbers and String's exactly
   * its parameter types.
   */
  fasterCall(type: i32, mn: u32, b: u32, argc: u32): u32 {
    const domain = this.domain;
    if (type < 0 || (type !== domain.mathStatic && type !== domain.stringType)) {
      return b;
    }

    const name = domain.underscored(this.index, mn);
    const traits = domain.traits;
    const faster = name < 0 ? BIND_None : traits.findName(type, <u32>name);
    if ((faster & 7) !== 1) {
      return b;
    }

    const m = unchecked(traits.dispatch[traits.dispatchStart[type] + (faster >> 3)]);
    if (m < 0 || traits.sign(domain, <u32>m)) {
      return b;
    }

    const count = unchecked(traits.paramCount[m]);
    const start = unchecked(traits.paramStart[m]);
    if (type === domain.mathStatic) {
      if (argc !== count) {
        return b;
      }

      for (let k: u32 = 1; k <= argc; k++) {
        const t = this.typeOf(this.peek(argc - k + 1));
        if (t === TYPE_Any || !isNumeric(domain, t)) {
          return b;
        }
      }

      return faster;
    }

    if (argc < count - unchecked(traits.optionalCount[m]) || argc > count) {
      return b;
    }

    for (let k: u32 = 1; k <= argc; k++) {
      if (this.typeOf(this.peek(argc - k + 1)) !== unchecked(traits.paramType[start + k - 1])) {
        return b;
      }
    }

    return faster;
  }

  /** As Verifier's OP_callstatic: a bound method, called with its signature. */
  callStatic(m: u32, argc: u32): bool {
    const domain = this.domain;
    const traits = domain.traits;
    const global = unchecked(domain.methodStart[this.index]) + m;
    const error = traits.sign(domain, global);
    if (error) {
      return this.fail(error);
    }

    if (unchecked(traits.receiverType[global]) === TYPE_Any) {
      return this.fail(kDanglingFunctionError);
    }

    this.checkNull(this.peek(argc + 1));
    if (!this.coerceArgs(global, argc)) {
      return false;
    }

    const result = unchecked(traits.returnType[global]);
    return this.popPush(argc + 1, result, domain.typeNotNull(result) ? NOT_NULL : 0);
  }

  /** As Verifier's OP_callsuper and OP_callsupervoid. */
  callSuper(opcode: u8, mn: u32, argc: u32): bool {
    const domain = this.domain;
    const traits = domain.traits;
    const n = this.propertyDepth(mn, argc + 1);
    if (n === 0) {
      return false;
    }

    const obj = this.peek(n);
    const base = this.coerceSuper(obj);
    if (base < TYPE_Any) {
      return false;
    }

    const b = this.binding(base, mn);
    if (b === BIND_Ambiguous) {
      return false;
    }

    let result = TYPE_Any;
    if ((b & 7) === 1) {
      const error = traits.resolve(domain, <u32>base);
      if (error) {
        return this.fail(error);
      }

      const m = unchecked(traits.dispatch[traits.dispatchStart[base] + (b >> 3)]);
      if (m < 0) {
        return this.fail(kCorruptABCError);
      }

      const signError = traits.sign(domain, <u32>m);
      if (signError) {
        return this.fail(signError);
      }

      result = unchecked(traits.returnType[m]);
    }

    this.checkNull(obj);
    return opcode === OP_callsupervoid
      ? true
      : this.popPush(n, result, domain.typeNotNull(result) ? NOT_NULL : 0);
  }

  /** As Verifier's OP_getsuper. */
  getSuper(mn: u32): bool {
    const domain = this.domain;
    const n = this.propertyDepth(mn, 1);
    if (n === 0) {
      return false;
    }

    const obj = this.peek(n);
    const base = this.coerceSuper(obj);
    if (base < TYPE_Any) {
      return false;
    }

    const b = this.binding(base, mn);
    if (b === BIND_Ambiguous) {
      return false;
    }

    const propType = this.readBinding(base, b);
    if (propType < TYPE_Any) {
      return false;
    }

    this.checkNull(obj);
    return this.popPush(n, propType, domain.typeNotNull(propType) ? NOT_NULL : 0);
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

/** A multiname's MN_* parts, as avmplus' Multiname flags. */
function nameParts(pool: ConstantPool, index: u32): u8 {
  let kind = unchecked(pool.mnKind[index]);
  if (kind === CONSTANT_TypeName) {
    kind = unchecked(pool.mnKind[pool.mnA[index]]);
  }

  switch (kind) {
    case CONSTANT_Qname:
      return MN_QName;
    case CONSTANT_QnameA:
      return MN_QName | MN_Attr;
    case CONSTANT_RTQname:
      return MN_QName | MN_Rtns;
    case CONSTANT_RTQnameA:
      return MN_QName | MN_Rtns | MN_Attr;
    case CONSTANT_RTQnameL:
      return MN_QName | MN_Rtns | MN_Rtname;
    case CONSTANT_RTQnameLA:
      return MN_QName | MN_Rtns | MN_Rtname | MN_Attr;
    case CONSTANT_MultinameL:
      return MN_Rtname;
    case CONSTANT_MultinameLA:
      return MN_Rtname | MN_Attr;
    case CONSTANT_MultinameA:
      return MN_Attr;
    default:
      return 0;
  }
}
