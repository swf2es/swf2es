// Decodes a method body's bytecode the way avmplus' Verifier walks it: from
// the entry along fall-through, branches and the exception handlers that a
// reachable instruction can trigger. Unreachable bytes are never read, as in
// Flash; obfuscated SWFs often hide junk there.
//
// Type and stack checks are the verifier's; this checks only what decoding
// needs, with the verifier's VerifyError numbers.
//
// A BodyDecoder is made once per ABC and reused for every body: its scratch
// buffers and its output only grow, so decoding allocates nothing per body.
import { Abc } from "./abc";
import {
  CONSTANT_Multiname,
  CONSTANT_Qname,
  CONSTANT_TypeName,
  kCannotFallOffMethodError,
  kCorruptABCError,
  kIllegalExceptionHandlerError,
  kIllegalOpcodeError,
  kInvalidBranchTargetError,
  kLastInstExceedsCodeSizeError,
} from "./constants";
import {
  FLAG_Terminal,
  FLAG_Throws,
  OP_label,
  OP_lookupswitch,
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
    this.reset();

    if (!this.checkHandlers()) {
      return code;
    }

    // Code starting with a label is a block target, so loops may branch to it.
    if (load<u8>(this.start) === OP_label) {
      this.target(-1, 0);
    } else if (!this.block(0)) {
      return code;
    }

    while (this.workCount) {
      if (!this.block(unchecked(this.work[--this.workCount]))) {
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
    this.work = new StaticArray<u32>(capacity);
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

  /** As Verifier::checkTarget: stay in the code; back edges need a label or known target. */
  target(from: i64, to: i64): bool {
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
      unchecked((this.known[t] = 1));
      unchecked((this.work[this.workCount++] = t));
    }

    // A loop header's implicit interrupt check can throw, so it reaches the
    // handlers covering it, even when the back edge is found after its block.
    if (to <= from && !unchecked(this.loopHeader[t])) {
      unchecked((this.loopHeader[t] = 1));
      return this.throwsAt(t);
    }

    return true;
  }

  /** Edges from `pc` to every handler covering it. */
  throwsAt(pc: u32): bool {
    if (pc < this.tryFrom || pc >= this.tryTo) {
      return true;
    }

    const abc = this.abc;
    for (let i: u32 = 0; i < this.handlerCount; i++) {
      const h = this.handlerFirst + i;
      if (pc >= unchecked(abc.exceptionFrom[h]) && pc < unchecked(abc.exceptionTo[h])) {
        if (!this.target(<i64>pc, <i64>unchecked(abc.exceptionTarget[h]))) {
          return false;
        }
      }
    }

    return true;
  }

  /** Decode one block from `start` until it ends or runs into another block. */
  block(start: u32): bool {
    const code = this.code;
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
        return this.target(<i64>pc - 1, <i64>pc);
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

      if (!this.decodeAt(pc, opcode, operands)) {
        return false;
      }

      const next = unchecked(this.slotNext[pc]);
      if (operands === OPERANDS_Branch) {
        if (!this.target(<i64>pc, <i64>next + unchecked(this.slotA[pc]))) {
          return false;
        }
      } else if (opcode === OP_lookupswitch) {
        if (!this.target(<i64>pc, <i64>pc + unchecked(this.slotA[pc]))) {
          return false;
        }

        const first = unchecked(this.slotC[pc]);
        const last = first + unchecked(this.slotB[pc]);
        for (let i = first; i <= last; i++) {
          if (!this.target(<i64>pc, <i64>pc + unchecked(code.cases[i]))) {
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
