// The IR of one method: register-form instructions with the verifier's
// types, in blocks, as flat tables reused from method to method.
//
// A register is an index into the verifier's frame: locals first, then the
// scope stack's entries, then the operand stack's slots, so the stack slot
// at depth d is register localCount + maxScope + d. An instruction reads
// `count` consecutive registers from `src` and writes `dst`, or -1 for none.
//
// A register's type at each instruction follows from its block's entry
// state, which the IR keeps, and the types the instructions before it in
// the block give their destinations, as the verifier's did.
//
// Instructions are what avmplus' verifier tells its code generator
// (CodeWriter): mostly the ABC instruction, but with the verifier's
// decisions made explicit, such as a slot bound early (getslot), a method
// called by dispatch id (callmethod), where a name was found (getscopeobject,
// getouterscope, finddef), and every coercion and null check.
import { OP_lookupswitch } from "../abc/opcodes";

// Instructions beyond the ABC's opcodes.
/** dst = src coerced to type `c`. */
export const IR_Coerce: u16 = 0x100;
/** Throw a TypeError if src is null or undefined. */
export const IR_CheckNull: u16 = 0x101;
/** dst = the getter of dispatch id `a` of src's type, called on src. */
export const IR_CallGetter: u16 = 0x102;
/** The setter of dispatch id `a` of src's type, called on src with src + 1. */
export const IR_CallSetter: u16 = 0x103;
/** dst = method `c` (domain-wide id) of an interface, called on src with `b` arguments. */
export const IR_CallInterface: u16 = 0x104;
/** dst = the global object's property `a`, looked up at run time (findpropglobal). */
export const IR_FindPropGlobal: u16 = 0x105;
export const IR_FindPropGlobalStrict: u16 = 0x106;
/** dst = the method's global object, from its scope chain or its own first scope. */
export const IR_GetGlobalScope: u16 = 0x107;
/** dst = src + count - 1, dropping the `count - 1` values below it (a call's receiver and function). */
export const IR_Nip: u16 = 0x108;

@final
export class Ir {
  count: u32 = 0;
  op: StaticArray<u16> = new StaticArray<u16>(0);
  dst: StaticArray<i32> = new StaticArray<i32>(0);
  src: StaticArray<i32> = new StaticArray<i32>(0);
  /** How many consecutive registers from src the instruction reads. */
  srcCount: StaticArray<u32> = new StaticArray<u32>(0);
  a: StaticArray<u32> = new StaticArray<u32>(0);
  b: StaticArray<u32> = new StaticArray<u32>(0);
  c: StaticArray<i32> = new StaticArray<i32>(0);
  /** The type of dst after the instruction, and whether it is known not null. */
  type: StaticArray<i32> = new StaticArray<i32>(0);
  notNull: StaticArray<u8> = new StaticArray<u8>(0);
  /** The ABC offset of the instruction it comes from. */
  pc: StaticArray<u32> = new StaticArray<u32>(0);

  /** Blocks: the first instruction and the ABC offset of each; blockCount are valid. */
  blockCount: u32 = 0;
  blockFirst: StaticArray<u32> = new StaticArray<u32>(0);
  blockPc: StaticArray<u32> = new StaticArray<u32>(0);
  /** The operand and scope stack depths each block is entered with. */
  blockStack: StaticArray<u32> = new StaticArray<u32>(0);
  blockScope: StaticArray<u32> = new StaticArray<u32>(0);

  /**
   * Each block's entry state: frameSize types and flags from block *
   * frameSize, flag 1 for known not null and 2 for a with scope.
   */
  entryType: StaticArray<i32> = new StaticArray<i32>(0);
  entryFlags: StaticArray<u8> = new StaticArray<u8>(0);

  /** Exception handlers: the ABC range they cover, their block, exception type and catch scope type. */
  handlerCount: u32 = 0;
  handlerFrom: StaticArray<u32> = new StaticArray<u32>(0);
  handlerTo: StaticArray<u32> = new StaticArray<u32>(0);
  handlerBlock: StaticArray<u32> = new StaticArray<u32>(0);
  handlerType: StaticArray<i32> = new StaticArray<i32>(0);
  handlerScope: StaticArray<i32> = new StaticArray<i32>(0);

  /** lookupswitch targets as block numbers; an instruction's are cases[b .. b + a]. */
  cases: StaticArray<u32> = new StaticArray<u32>(0);
  caseCount: u32 = 0;

  // The method's frame, to name registers, and its outer scope chain's size.
  localCount: u32 = 0;
  maxScope: u32 = 0;
  frameSize: u32 = 0;
  outerSize: u32 = 0;

  reset(localCount: u32, maxScope: u32, frameSize: u32): void {
    this.count = 0;
    this.blockCount = 0;
    this.caseCount = 0;
    this.handlerCount = 0;
    this.localCount = localCount;
    this.maxScope = maxScope;
    this.frameSize = frameSize;
  }

  /** Append an instruction; its type is filled in once the verifier knows it. */
  add(op: u16, dst: i32, src: i32, count: u32, a: u32, b: u32, c: i32, pc: u32): u32 {
    if (this.count === <u32>this.op.length) {
      this.grow();
    }

    const i = this.count++;
    this.op[i] = op;
    this.dst[i] = dst;
    this.src[i] = src;
    this.srcCount[i] = count;
    this.a[i] = a;
    this.b[i] = b;
    this.c[i] = c;
    this.type[i] = -1;
    this.notNull[i] = 0;
    this.pc[i] = pc;
    return i;
  }

  grow(): void {
    const capacity = max(64, this.op.length * 2);
    this.op = grown<u16>(this.op, capacity, this.count);
    this.dst = grown<i32>(this.dst, capacity, this.count);
    this.src = grown<i32>(this.src, capacity, this.count);
    this.srcCount = grown<u32>(this.srcCount, capacity, this.count);
    this.a = grown<u32>(this.a, capacity, this.count);
    this.b = grown<u32>(this.b, capacity, this.count);
    this.c = grown<i32>(this.c, capacity, this.count);
    this.type = grown<i32>(this.type, capacity, this.count);
    this.notNull = grown<u8>(this.notNull, capacity, this.count);
    this.pc = grown<u32>(this.pc, capacity, this.count);
  }

  /**
   * Start a block at ABC offset `pc` with the next instruction, entered with
   * stack and scope depths `stack` and `scope` and the frame values `types`
   * and `flags` (1: not null, 2: with scope).
   */
  addBlock(pc: u32, stack: u32, scope: u32, types: StaticArray<i32>, flags: StaticArray<u8>): void {
    const k = this.blockCount;
    if (k === <u32>this.blockFirst.length) {
      const capacity = max(16, this.blockFirst.length * 2);
      this.blockFirst = grown<u32>(this.blockFirst, capacity, k);
      this.blockPc = grown<u32>(this.blockPc, capacity, k);
      this.blockStack = grown<u32>(this.blockStack, capacity, k);
      this.blockScope = grown<u32>(this.blockScope, capacity, k);
    }

    const size = this.frameSize;
    const used = k * size;
    if (used + size > <u32>this.entryType.length) {
      const capacity = max(used + size, <u32>this.entryType.length * 2);
      this.entryType = grown<i32>(this.entryType, capacity, used);
      this.entryFlags = grown<u8>(this.entryFlags, capacity, used);
    }

    for (let i: u32 = 0; i < size; i++) {
      this.entryType[used + i] = types[i];
      this.entryFlags[used + i] = flags[i] & 3;
    }

    this.blockFirst[k] = this.count;
    this.blockPc[k] = pc;
    this.blockStack[k] = stack;
    this.blockScope[k] = scope;
    this.blockCount++;
  }

  addHandler(from: u32, to: u32, block: u32, type: i32, scope: i32): void {
    const h = this.handlerCount;
    if (h === <u32>this.handlerFrom.length) {
      const capacity = max(4, this.handlerFrom.length * 2);
      this.handlerFrom = grown<u32>(this.handlerFrom, capacity, h);
      this.handlerTo = grown<u32>(this.handlerTo, capacity, h);
      this.handlerBlock = grown<u32>(this.handlerBlock, capacity, h);
      this.handlerType = grown<i32>(this.handlerType, capacity, h);
      this.handlerScope = grown<i32>(this.handlerScope, capacity, h);
    }

    this.handlerFrom[h] = from;
    this.handlerTo[h] = to;
    this.handlerBlock[h] = block;
    this.handlerType[h] = type;
    this.handlerScope[h] = scope;
    this.handlerCount++;
  }

  addCase(block: u32): void {
    if (this.caseCount === <u32>this.cases.length) {
      this.cases = grown<u32>(this.cases, max(16, this.cases.length * 2), this.caseCount);
    }

    this.cases[this.caseCount++] = block;
  }

  /** Whether instruction i is a lookupswitch, whose targets are in `cases`. */
  isSwitch(i: u32): bool {
    return this.op[i] === OP_lookupswitch;
  }
}

function grown<T>(from: StaticArray<T>, capacity: i32, used: u32): StaticArray<T> {
  const to = new StaticArray<T>(capacity);
  memory.copy(changetype<usize>(to), changetype<usize>(from), <usize>used * sizeof<T>());
  return to;
}
