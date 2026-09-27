// Decodes a method body's bytecode the way avmplus' Verifier walks it: from
// the entry along fall-through, branches and the exception handlers that a
// reachable instruction can trigger. Unreachable bytes are never read, as in
// Flash; obfuscated SWFs often hide junk there.
//
// Type and stack checks are the verifier's; this checks only what decoding
// needs, with the verifier's VerifyError numbers.
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
 * The reachable instructions of one body, ordered by offset. Operands:
 * a is the first u30, the signed branch offset, or pushbyte/pushshort's
 * value; b the second u30 (debug: string index; lookupswitch: case count - 1);
 * c debug's register, or where lookupswitch's case offsets start in `cases`.
 */
@final
export class Code {
  /** 0, or the VerifyError number avmplus would throw; then the lists are incomplete. */
  error: i32 = 0;
  offset: Array<u32> = [] as u32[];
  /** Offset of the next instruction in the code. */
  next: Array<u32> = [] as u32[];
  opcode: Array<u8> = [] as u8[];
  a: Array<i32> = [] as i32[];
  b: Array<u32> = [] as u32[];
  c: Array<u32> = [] as u32[];
  /** lookupswitch case offsets, relative to the instruction. */
  cases: Array<i32> = [] as i32[];

  @inline
  get count(): u32 {
    return this.offset.length;
  }

  fail(error: i32): Code {
    if (!this.error) {
      this.error = error;
    }

    return this;
  }
}

// Byte states in Decoder.cover, which starts zeroed: unseen.
const START: u8 = 1;
const INSIDE: u8 = 2;

@final
class Decoder {
  code: Code = new Code();
  start: usize;
  length: u32;
  r: Reader;

  /** Whether each byte starts an instruction, lies inside one, or is unseen (0). */
  cover: StaticArray<u8>;
  /** Decode order index of the instruction starting at each byte. */
  at: StaticArray<i32>;
  /** Offsets with a known frame state: branch and handler targets. */
  known: StaticArray<u8>;
  /** Targets of backward branches. */
  loopHeader: StaticArray<u8>;
  work: Array<u32> = [] as u32[];

  handlerFrom: StaticArray<u32>;
  handlerTo: StaticArray<u32>;
  handlerTarget: StaticArray<u32>;
  tryFrom: u32 = 0;
  tryTo: u32 = 0;
  /** A branch into the middle of an instruction, reported after other errors. */
  overlap: bool = false;

  constructor(abc: Abc, body: u32, base: usize) {
    const start = base + unchecked(abc.bodyCodeStart[body]);
    const length = unchecked(abc.bodyCodeLength[body]);
    const first = unchecked(abc.bodyExceptionStart[body]);
    const count = unchecked(abc.bodyExceptionStart[body + 1]) - first;

    this.start = start;
    this.length = length;
    // Operands may read past the code up to the end of the ABC, as avmplus'
    // do into its padding; the end of the code is checked per instruction.
    this.r = new Reader(start, base + abc.length);
    this.cover = new StaticArray<u8>(length);
    this.at = new StaticArray<i32>(length);
    this.known = new StaticArray<u8>(length);
    this.loopHeader = new StaticArray<u8>(length);
    this.handlerFrom = new StaticArray<u32>(count);
    this.handlerTo = new StaticArray<u32>(count);
    this.handlerTarget = new StaticArray<u32>(count);

    for (let i: u32 = 0; i < count; i++) {
      unchecked((this.handlerFrom[i] = abc.exceptionFrom[first + i]));
      unchecked((this.handlerTo[i] = abc.exceptionTo[first + i]));
      unchecked((this.handlerTarget[i] = abc.exceptionTarget[first + i]));
    }
  }

  /** As Verifier::parseExceptionHandlers: sane ranges and binding catch names. */
  checkHandlers(abc: Abc, body: u32): bool {
    const first = unchecked(abc.bodyExceptionStart[body]);
    for (let i = 0; i < this.handlerFrom.length; i++) {
      const from = unchecked(this.handlerFrom[i]);
      const to = unchecked(this.handlerTo[i]);
      const target = unchecked(this.handlerTarget[i]);
      const name = unchecked(abc.exceptionName[first + i]);
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

      if (to > this.tryTo) {
        this.tryTo = to;
      }
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
      this.work.push(t);
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

    for (let i = 0; i < this.handlerFrom.length; i++) {
      if (pc >= unchecked(this.handlerFrom[i]) && pc < unchecked(this.handlerTo[i])) {
        if (!this.target(<i64>pc, <i64>unchecked(this.handlerTarget[i]))) {
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

      const index = this.decode(pc, opcode, operands);
      if (index < 0) {
        return false;
      }

      const next = unchecked(code.next[index]);
      if (operands === OPERANDS_Branch) {
        if (!this.target(<i64>pc, <i64>next + unchecked(code.a[index]))) {
          return false;
        }
      } else if (opcode === OP_lookupswitch) {
        if (!this.target(<i64>pc, <i64>pc + unchecked(code.a[index]))) {
          return false;
        }

        const first = unchecked(code.c[index]);
        const last = first + unchecked(code.b[index]);
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

  /** Decode the instruction at `pc`; returns its index, or -1 after recording the error. */
  decode(pc: u32, opcode: u8, operands: u8): i32 {
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
      return -1;
    }

    const codeEnd = this.start + this.length;
    if (r.failed || r.pos > codeEnd) {
      code.fail(kLastInstExceedsCodeSizeError);
      return -1;
    }

    if (opcode === OP_lookupswitch) {
      c = code.cases.length;
      const caseCount = <u64>b + 1;
      if (<u64>r.pos + caseCount * 3 > codeEnd) {
        code.fail(kLastInstExceedsCodeSizeError);
        return -1;
      }

      for (let i: u64 = 0; i < caseCount; i++) {
        code.cases.push(r.s24());
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
    const index = code.offset.length;
    unchecked((this.at[pc] = index));
    code.offset.push(pc);
    code.next.push(next);
    code.opcode.push(opcode);
    code.a.push(a);
    code.b.push(b);
    code.c.push(c);
    return index;
  }

  /** The instructions again, ordered by offset. */
  ordered(): Code {
    const from = this.code;
    const to = new Code();
    to.cases = from.cases;
    for (let pc: u32 = 0; pc < this.length; pc++) {
      if (unchecked(this.cover[pc]) === START) {
        const i = unchecked(this.at[pc]);
        to.offset.push(unchecked(from.offset[i]));
        to.next.push(unchecked(from.next[i]));
        to.opcode.push(unchecked(from.opcode[i]));
        to.a.push(unchecked(from.a[i]));
        to.b.push(unchecked(from.b[i]));
        to.c.push(unchecked(from.c[i]));
      }
    }

    return to;
  }
}

/** Decode body `body` of `abc`, whose bytes start at `base`. */
export function decodeBody(abc: Abc, body: u32, base: usize): Code {
  const d = new Decoder(abc, body, base);
  if (!d.checkHandlers(abc, body)) {
    return d.code;
  }

  // Code starting with a label is a block target, so loops may branch to it.
  if (load<u8>(d.start) === OP_label) {
    d.target(-1, 0);
  } else if (!d.block(0)) {
    return d.code;
  }

  while (d.work.length) {
    if (!d.block(d.work.pop())) {
      return d.code;
    }
  }

  if (d.overlap) {
    return d.code.fail(kInvalidBranchTargetError);
  }

  return d.ordered();
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
