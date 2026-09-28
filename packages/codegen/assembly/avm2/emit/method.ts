// Writes one method's IR as a JavaScript function whose blocks run in a
// dispatcher: `for (;;) switch (b) { case 0: ... }`. Registers are `let`
// variables named as the IR names them (l0, sc0, s0), and the runtime is
// `rt` in the enclosing module.
//
// Typed lowering starts simple: what the IR's types make certain is plain
// JavaScript (int arithmetic ends in `| 0`), anything else calls the
// runtime, which does what avmplus does at run time.
import { Abc } from "../abc/abc";
import * as C from "../abc/constants";
import * as ops from "../abc/opcodes";
import { opcodeNames } from "../abc/opcodes";
import {
  IR_CallGetter,
  IR_CallInterface,
  IR_CallSetter,
  IR_CheckNull,
  IR_Coerce,
  IR_FindPropGlobal,
  IR_FindPropGlobalStrict,
  IR_GetGlobalScope,
  IR_Nip,
  Ir,
} from "../ir/ir";
import { Domain, NS_Private, URI_None } from "../link/domain";
import {
  BUILTIN_Any,
  BUILTIN_Boolean,
  BUILTIN_Int,
  BUILTIN_Namespace,
  BUILTIN_Number,
  BUILTIN_Object,
  BUILTIN_Other,
  BUILTIN_String,
  BUILTIN_Uint,
  TRAITS_Instance,
  TraitsTable,
  TYPE_Any,
} from "../link/traits";
import { Output } from "./output";
import { SourceMap } from "./sourcemap";

/** The deepest structured code a method is given; one deeper keeps the dispatcher. */
const MAX_NESTING: u32 = 500;
/** No type: a conversion, convert_s or convert_o, that always calls the runtime. */
const CONVERTS: i32 = -2;

@final
export class MethodEmitter {
  out: Output = new Output();
  /** Where the code for each AS3 line starts, by debugfile and debugline. */
  map: SourceMap = new SourceMap();
  /** The file (a string of the pool, -1 if none) and line (0 if none) of what is being written. */
  file: i32 = -1;
  line: u32 = 0;
  /** Each block's file and line where it starts, as the instructions before it in the ABC leave them. */
  blockFile: StaticArray<i32> = new StaticArray<i32>(0);
  blockLine: StaticArray<u32> = new StaticArray<u32>(0);
  /** Each register's type as the instruction being written reads it. */
  regType: StaticArray<i32> = new StaticArray<i32>(0);
  /** Which local scope registers hold with scopes, and how many are pushed. */
  scopeWith: StaticArray<u8> = new StaticArray<u8>(0);
  scopeDepth: u32 = 0;
  /** The classes and Vectors the method being written refers to, in the order its T holds them. */
  types: i32[] = [];
  typeIndex: Map<i32, u32> = new Map<i32, u32>();
  /** The name the method being written is given, a JavaScript identifier; "" for none. */
  functionName: string = "";
  /** The method being written: its ABC index and body. */
  current: u32 = 0;
  body: i32 = -1;
  /**
   * The ABC offsets where the set of handlers covering an instruction can
   * change, sorted; region r is from bounds[r - 1] up to bounds[r]. `t` in
   * the generated code is the region of the instruction running.
   */
  bounds: StaticArray<u32> = new StaticArray<u32>(0);
  /** Whether a handler covers region r + 1; a region none covers is region 0. */
  covered: StaticArray<u8> = new StaticArray<u8>(0);
  boundCount: u32 = 0;
  region: i32 = -1;

  domain: Domain;
  index: u32 = 0;
  abc: Abc;
  base: usize = 0;
  ir: Ir = new Ir();

  constructor(domain: Domain, index: u32) {
    this.domain = domain;
    this.index = index;
    this.abc = domain.abcs[index];
    this.base = domain.abcBase[index];
  }

  /**
   * Write method `method` (domain-wide id `global`) of the ABC, whose body's
   * IR is `ir`, as `function (p1, ..., pn) { ... }`.
   */
  method(method: u32, global: u32, ir: Ir): void {
    const out = this.out;
    const traits = this.domain.traits;
    this.ir = ir;
    this.current = method;
    this.body = this.abc.methodBody[method];
    if (<u32>this.regType.length < ir.frameSize) {
      this.regType = new StaticArray<i32>(ir.frameSize);
    }

    if (<u32>this.scopeWith.length < ir.maxScope) {
      this.scopeWith = new StaticArray<u8>(ir.maxScope);
    }

    if (<u32>this.copyOf.length < ir.frameSize) {
      this.copyOf = new StaticArray<i32>(ir.frameSize);
    }

    for (let r: u32 = 0; r < ir.frameSize; r++) {
      this.copyOf[r] = -1;
    }

    const count = traits.paramCount[global];
    // Named, for stacks and profiles: a name its code never binds.
    out.text(this.functionName.length ? `function ${this.functionName}(` : "function (");
    for (let p: u32 = 1; p <= count; p++) {
      out.text(p > 1 ? ", p" : "p");
      out.uint(p);
    }

    const flags = this.abc.methodFlags[method];
    if (flags & C.METHOD_NeedRest) {
      out.text(count ? ", ...rest" : "...rest");
    }

    out.text(") {\n");
    this.prologue(method, global, flags);
    const handled = ir.handlerCount > 0;
    if (handled) {
      this.regions();
    }

    this.debugLines();
    const marks = this.map.count;

    // Structured control flow where the graph is reducible and each
    // handler's try encloses the code it covers; else the dispatcher.
    if (this.analyze()) {
      const start = out.length;
      if (handled) {
        out.text("  let t = 0;\n");
      }

      this.structured = true;
      this.unenclosed = false;
      this.tryStack.length = 0;
      this.node(0);
      this.structured = false;
      if (!this.unenclosed) {
        out.text("}");
        return;
      }

      out.length = start;
      this.map.truncate(marks);
    }

    if (handled) {
      out.text("  let b = 0, t = 0;\n  for (;;) try { switch (b) {\n");
    } else {
      out.text("  let b = 0;\n  for (;;) switch (b) {\n");
    }

    for (let k: u32 = 0; k < ir.blockCount; k++) {
      this.block(k);
    }

    // The verifier proved every block ends; a dispatcher still needs an end.
    out.text("  default: throw rt.unreachable();\n  }");
    if (handled) {
      out.text(" } catch (e) {\n");
      this.handlers();
      out.text("  }");
    }

    out.text("\n}");
  }

  /** Each block's file and line where it starts, from the debugfile and debugline instructions before it. */
  debugLines(): void {
    const ir = this.ir;
    if (<u32>this.blockFile.length < ir.blockCount) {
      this.blockFile = new StaticArray<i32>(max(ir.blockCount, 64));
      this.blockLine = new StaticArray<u32>(max(ir.blockCount, 64));
    }

    let file: i32 = -1;
    let line: u32 = 0;
    for (let k: u32 = 0; k < ir.blockCount; k++) {
      this.blockFile[k] = file;
      this.blockLine[k] = line;
      const end = k + 1 < ir.blockCount ? ir.blockFirst[k + 1] : ir.count;
      for (let i = ir.blockFirst[k]; i < end; i++) {
        if (ir.op[i] === ops.OP_debugfile) {
          file = <i32>ir.a[i];
        } else if (ir.op[i] === ops.OP_debugline) {
          line = ir.a[i];
        }
      }
    }
  }

  /** The code written from here on is from the current file and line. */
  mark(): void {
    this.map.mark(this.out.length, this.file, this.line);
  }

  /** The bounds of the method's handler regions: every handler's from and to, sorted, once each. */
  regions(): void {
    const ir = this.ir;
    const count = ir.handlerCount * 2;
    if (<u32>this.bounds.length < count) {
      this.bounds = new StaticArray<u32>(count);
    }

    const bounds = this.bounds;
    let n: u32 = 0;
    for (let h: u32 = 0; h < count; h++) {
      const pc = h & 1 ? ir.handlerTo[h >> 1] : ir.handlerFrom[h >> 1];
      // Insert in order, skipping one already there.
      let at = n;
      while (at > 0 && bounds[at - 1] > pc) {
        at--;
      }

      if (at > 0 && bounds[at - 1] === pc) {
        continue;
      }

      for (let k = n; k > at; k--) {
        bounds[k] = bounds[k - 1];
      }

      bounds[at] = pc;
      n++;
    }

    this.boundCount = n;
    if (<u32>this.covered.length < n) {
      this.covered = new StaticArray<u8>(n);
    }

    for (let r: u32 = 1; r < n; r++) {
      const start = bounds[r - 1];
      let covered: u8 = 0;
      for (let h: u32 = 0; h < ir.handlerCount; h++) {
        if (start >= ir.handlerFrom[h] && start < ir.handlerTo[h]) {
          covered = 1;
          break;
        }
      }

      this.covered[r - 1] = covered;
    }
  }

  /** The handler region of ABC offset `pc`: how many bounds are at or before it, or 0 if none covers it. */
  regionOf(pc: u32): i32 {
    let lo: u32 = 0;
    let hi = this.boundCount;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.bounds[mid] <= pc) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }

    return lo > 0 && lo < this.boundCount && this.covered[lo - 1] ? <i32>lo : 0;
  }

  /**
   * The catch of the dispatcher: the handlers covering the region that
   * threw, in the order of the ABC's table, as avmplus finds them; the first
   * whose type the exception has gets it as its only stack value. With none,
   * the exception goes on to the caller.
   */
  handlers(): void {
    const out = this.out;
    const ir = this.ir;
    const bounds = this.bounds;
    const exception = <i32>(ir.localCount + ir.maxScope);
    out.text("    const x = rt.caught(e);\n    switch (t) {\n");
    for (let r: u32 = 1; r < this.boundCount; r++) {
      if (!this.covered[r - 1]) {
        continue;
      }

      const start = bounds[r - 1];
      let first = true;
      for (let h: u32 = 0; h < ir.handlerCount; h++) {
        if (start < ir.handlerFrom[h] || start >= ir.handlerTo[h]) {
          continue;
        }

        if (first) {
          out.text("    case ");
          out.uint(r);
          out.text(":\n");
          first = false;
        }

        const type = ir.handlerType[h];
        out.text("      ");
        if (type >= 0) {
          out.text("if (rt.catches(x, ");
          this.typeRef(type);
          out.text(")) ");
        }

        out.text("{ ");
        this.regName(exception);
        out.text(" = x; ");
        this.goto(ir.handlerBlock[h]);
        out.text(" }\n");
      }

      if (!first) {
        out.text("      break;\n");
      }
    }

    out.text("    }\n    throw e;\n");
  }

  /** Declare the registers: `this`, the parameters, coerced, with defaults, then the rest. */
  prologue(method: u32, global: u32, flags: u8): void {
    const out = this.out;
    const ir = this.ir;
    const traits = this.domain.traits;
    const abc = this.abc;
    const count = traits.paramCount[global];
    // The parameters with default values: an untyped function's others are
    // optional too, as avmplus' are, but a missing one is just undefined.
    const optional = abc.methodOptionalStart[method + 1] - abc.methodOptionalStart[method];

    // As MethodEnv's argcOk, before any coercion: fewer arguments than it
    // requires, or more than it declares unless it takes the rest.
    const required = count - traits.optionalCount[global];
    const extra = this.domain.allowsExtraArgs(global);
    if (required > 0 || !extra) {
      out.text("  if (");
      if (required > 0) {
        out.text("arguments.length < ");
        out.uint(required);
      }

      if (!extra) {
        out.text(required > 0 ? " || arguments.length > " : "arguments.length > ");
        out.uint(count);
      }

      out.text(") throw rt.argumentCountError(");
      out.uint(required);
      out.text(", arguments.length);\n");
    }

    out.text("  let l0 = this");
    for (let p: u32 = 1; p <= count; p++) {
      out.text(", l");
      out.uint(p);
      out.text(" = ");
      const type = traits.paramType[traits.paramStart[global] + p - 1];
      const first = count - optional;
      if (p > first) {
        // A missing optional argument takes its default.
        out.text("arguments.length < ");
        out.uint(p);
        out.text(" ? ");
        const o = abc.methodOptionalStart[method] + p - first - 1;
        this.constant(abc.optionalValue[o], abc.optionalKind[o], type);
        out.text(" : ");
      }

      this.convert("p", <i32>p, type, TYPE_Any);
    }

    let local = count + 1;
    if (flags & C.METHOD_NeedRest) {
      out.text(", l");
      out.uint(local++);
      out.text(" = rt.array(rest)");
    } else if (flags & C.METHOD_NeedArguments) {
      out.text(", l");
      out.uint(local++);
      out.text(" = rt.arguments(arguments)");
    }

    for (let r = local; r < ir.frameSize; r++) {
      out.text(", ");
      this.reg(<i32>r);
    }

    out.text(";\n");
  }

  /** Write block k: its case label, then its instructions, following register types. */
  block(k: u32): void {
    const out = this.out;
    out.text("  case ");
    out.uint(k);
    out.text(":\n");
    this.blockBody(k);
  }

  /** Block k's instructions, following register types from its entry state. */
  blockBody(k: u32): void {
    const out = this.out;
    const ir = this.ir;
    const entry = k * ir.frameSize;
    for (let r: u32 = 0; r < ir.frameSize; r++) {
      this.regType[r] = ir.entryType[entry + r];
    }

    this.scopeDepth = ir.blockScope[k];
    for (let d: u32 = 0; d < this.scopeDepth; d++) {
      this.scopeWith[d] = (ir.entryFlags[entry + ir.localCount + d] & 2) >> 1;
    }

    // A block may be entered from any region, so it sets its own first.
    const handled = ir.handlerCount > 0;
    this.region = -1;
    const last = k + 1 < ir.blockCount ? ir.blockFirst[k + 1] : ir.count;
    const stack = <i32>(ir.localCount + ir.maxScope);
    // Every way in wrote its copies.
    this.uncopy(stack);
    this.file = this.blockFile[k];
    this.line = this.blockLine[k];
    this.mark();
    for (let i = ir.blockFirst[k]; i < last; i++) {
      const op = ir.op[i];
      const dst = ir.dst[i];
      // What the instruction writes, other than stack registers, is copied
      // first by the stack registers copying it, but for those it takes:
      // it reads them before it writes. And what a branch leaves on the
      // stack is written, for the block it goes to.
      const frame = <i32>ir.frameSize;
      const pops = this.stackDiscipline(op) && ir.srcCount[i] > 0 && ir.src[i] >= stack;
      if (dst >= 0 && dst < stack) {
        this.copyAll(dst, pops ? ir.src[i] : frame);
      }

      if (op === ops.OP_hasnext2) {
        this.copyAll(<i32>ir.a[i], frame);
        this.copyAll(<i32>ir.b[i], frame);
      } else if (op === ops.OP_popscope) {
        this.copyAll(ir.src[i], frame);
      } else if (this.conditional(op) || op === ops.OP_lookupswitch) {
        this.copyBelow(ir.src[i]);
      } else if (op === ops.OP_jump) {
        this.copyBelow(<i32>ir.frameSize);
      }

      // A value the next instruction only moves to a local goes there
      // straight, if the instruction assigns it.
      this.target = -1;
      if (
        dst >= stack &&
        i + 1 < last &&
        this.setsLocal(ir.op[i + 1]) &&
        ir.src[i + 1] === dst &&
        op !== ops.OP_hasnext2
      ) {
        // After the two, the stack is as far as dst: what is there on, the
        // instruction takes.
        this.target = ir.dst[i + 1];
        this.copyAll(this.target, dst);
      }

      if (handled) {
        const region = this.regionOf(ir.pc[i]);
        if (region !== this.region) {
          out.text("    t = ");
          out.int(region);
          out.text(";\n");
          this.region = region;
          if (this.structured && !this.enclosed(region)) {
            this.unenclosed = true;
          }
        }
      }

      // A branch's own target, written in place, sinks its own values: only
      // an instruction given a local here can have assigned it.
      const sinking = this.target >= 0;
      this.kept = false;
      this.sunk = false;
      this.instruction(i);
      this.target = -1;
      if (op === ops.OP_swap) {
        // Its one destination is the new top, whose type the IR gives; the
        // register below it now holds what the top did, and its type.
        const x = ir.src[i];
        this.regType[x] = this.regType[x + 1];
      }

      if (dst >= 0) {
        this.regType[dst] = ir.type[i];
      }

      if (sinking && this.sunk) {
        // The setlocal is written: its stack register was never set, and
        // the stack is as far as it.
        i++;
        this.regType[ir.dst[i]] = ir.type[i];
        this.uncopy(dst);
        continue;
      }

      if (this.conditional(op) || op === ops.OP_lookupswitch) {
        // What the branch took is gone, and the rest is written.
        this.uncopy(stack);
      } else if (op === ops.OP_swap) {
        this.copyOf[ir.src[i]] = -1;
        this.copyOf[ir.src[i] + 1] = -1;
      } else {
        if (dst >= stack && !this.kept) {
          this.copyOf[dst] = -1;
        }

        // What is above the stack now is gone.
        if (this.stackDiscipline(op)) {
          if (dst >= stack) {
            this.uncopy(dst + 1);
          } else if (pops) {
            this.uncopy(ir.src[i]);
          }
        }
      }
    }

    if (!this.terminates(k)) {
      this.copyBelow(<i32>ir.frameSize);
    }
  }

  /**
   * Whether instruction i, a getlocal or dup to a stack register, only
   * makes it a copy: of the local, or of what the register duplicated copies.
   */
  private copies(i: u32): bool {
    const ir = this.ir;
    const stack = <i32>(ir.localCount + ir.maxScope);
    const dst = ir.dst[i];
    const src = ir.src[i];
    if (dst < stack) {
      return false;
    }

    const from = src < stack ? src : this.copyOf[src];
    if (from < 0) {
      return false;
    }

    this.copyOf[dst] = from;
    this.kept = true;
    return true;
  }

  /**
   * Whether op takes its stack operands from the top and pushes what it
   * gives there, as an instruction of a stack machine: all but a coercion
   * or null check in place, and swap.
   */
  private stackDiscipline(op: u16): bool {
    return op !== IR_Coerce && op !== IR_CheckNull && op !== ops.OP_swap;
  }

  /** Whether op is a setlocal, which takes its stack register. */
  private setsLocal(op: u16): bool {
    return op === ops.OP_setlocal || (op >= ops.OP_setlocal0 && op < ops.OP_setlocal0 + 4);
  }

  /** Write the stack registers below `limit` that are copies. */
  private copyBelow(limit: i32): void {
    const ir = this.ir;
    const end = min(limit, <i32>ir.frameSize);
    for (let r = <i32>(ir.localCount + ir.maxScope); r < end; r++) {
      if (this.copyOf[r] >= 0) {
        this.writeCopy(r);
      }
    }
  }

  /** Write the stack registers below `limit` that copy register w, before w changes. */
  private copyAll(w: i32, limit: i32): void {
    const ir = this.ir;
    const end = min(limit, <i32>ir.frameSize);
    for (let r = <i32>(ir.localCount + ir.maxScope); r < end; r++) {
      if (this.copyOf[r] === w) {
        this.writeCopy(r);
      }
    }
  }

  private writeCopy(r: i32): void {
    const out = this.out;
    const from = this.copyOf[r];
    this.copyOf[r] = -1;
    out.text("    ");
    this.reg(r);
    out.text(" = ");
    this.reg(from);
    out.text(";\n");
  }

  /** Forget every copy from register `from` up: none is needed. */
  private uncopy(from: i32): void {
    for (let r = from; r < <i32>this.ir.frameSize; r++) {
      this.copyOf[r] = -1;
    }
  }

  /** The builtin type of register r's value now. */
  builtinOf(r: i32): u8 {
    return this.domain.builtin(this.regType[r]);
  }

  /** Register r as read: what it copies, if it is a copy. */
  reg(r: i32): void {
    const copy = this.copyOf[r];
    this.regName(copy >= 0 ? copy : r);
  }

  /** Register r itself, as written. */
  regName(r: i32): void {
    const ir = this.ir;
    const out = this.out;
    const local = <i32>ir.localCount;
    if (r < local) {
      out.byte(0x6c); // l
      out.uint(<u64>r);
    } else if (r < local + <i32>ir.maxScope) {
      out.text("sc");
      out.uint(<u64>(r - local));
    } else {
      out.byte(0x73); // s
      out.uint(<u64>(r - local - <i32>ir.maxScope));
    }
  }

  /** `dst = ` for instruction i. */
  assign(i: u32): void {
    this.out.text("    ");
    if (this.target >= 0) {
      this.regName(this.target);
      this.sunk = true;
    } else {
      this.regName(this.ir.dst[i]);
    }

    this.out.text(" = ");
  }

  src(i: u32, k: u32): i32 {
    return this.ir.src[i] + <i32>k;
  }

  /** `b = n; continue;` to block n. */
  goto(block: u32): void {
    if (this.structured) {
      this.branchTo(block);
      return;
    }

    this.out.text("b = ");
    this.out.uint(block);
    this.out.text("; continue;");
  }

  // Structured control flow, as Ramsey's "Beyond Relooper" translates a
  // reducible control-flow graph: by the dominator tree, a loop header as
  // `L: for (;;) { ... }`, a merge node (more than one forward edge in) as
  // a labelled block `L: { ... }` followed by its code, and a branch as
  // continue to a loop header, break to a merge node, or else its target's
  // code in place, as its only way in.
  //
  // A handler's block has an edge in from each block its range covers, so
  // it is a child of what dominates them all, and is written as a merge
  // node is, with a try in its labelled block: `L: { try { ... } catch (e)
  // { ...; break L; } }`, then its code. Its catch takes the exception only
  // from its own regions, by t, so other code inside the try is no matter;
  // the code it covers must be inside, though, and the trys covering each
  // region open innermost first in the order of the ABC's table, as
  // avmplus looks for a handler. Where they are not, the dispatcher.

  /** Each block's successors, flat; succStart[k] .. succStart[k + 1]. */
  succStart: StaticArray<u32> = new StaticArray<u32>(0);
  succ: u32[] = [];
  /** Reverse postorder number by block, -1 if unreachable, and blocks by it. */
  rpo: StaticArray<i32> = new StaticArray<i32>(0);
  order: StaticArray<u32> = new StaticArray<u32>(0);
  idom: StaticArray<i32> = new StaticArray<i32>(0);
  forwardIn: StaticArray<u32> = new StaticArray<u32>(0);
  loopHeader: StaticArray<u8> = new StaticArray<u8>(0);
  predStart: StaticArray<u32> = new StaticArray<u32>(0);
  pred: u32[] = [];
  /** The dominator tree's children; childStart[k] .. childStart[k + 1]. */
  childStart: StaticArray<u32> = new StaticArray<u32>(0);
  child: u32[] = [];
  fill: StaticArray<u32> = new StaticArray<u32>(0);
  /** The handler whose block each block is, -1 if none; and where each block's normal successors start. */
  handlerOf: StaticArray<i32> = new StaticArray<i32>(0);
  normalStart: StaticArray<u32> = new StaticArray<u32>(0);
  /** The handlers whose trys are open, the innermost last; and whether some covered code was outside its try. */
  tryStack: u32[] = [];
  /** The state of the blocks around one being written in place, as save pushes it. */
  saved: i32[] = [];
  /**
   * The local or scope register each stack register copies, -1 if none:
   * a copy is not written until something needs the stack register itself,
   * so reading it reads what it copies.
   */
  copyOf: StaticArray<i32> = new StaticArray<i32>(0);
  /** Whether the instruction just written left its destination a copy, or as it was. */
  kept: bool = false;
  /** The local the instruction being written assigns in place of its stack register, -1 if none; and whether it did. */
  target: i32 = -1;
  sunk: bool = false;
  unenclosed: bool = false;
  dfsStack: u32[] = [];
  dfsEdge: u32[] = [];
  reachable: u32 = 0;
  structured: bool = false;
  currentBlock: u32 = 0;

  /** The index after block k's last instruction, and its first. */
  private blockEnd(k: u32): u32 {
    const ir = this.ir;
    return k + 1 < ir.blockCount ? ir.blockFirst[k + 1] : ir.count;
  }

  /** Whether block k ends in a branch, return or throw, not falling through. */
  private terminates(k: u32): bool {
    const ir = this.ir;
    const end = this.blockEnd(k);
    if (end === ir.blockFirst[k]) {
      return false;
    }

    const op = ir.op[end - 1];
    return (
      op === ops.OP_jump ||
      op === ops.OP_lookupswitch ||
      op === ops.OP_returnvoid ||
      op === ops.OP_returnvalue ||
      op === ops.OP_throw
    );
  }

  /** Whether op branches on a condition. */
  private conditional(op: u16): bool {
    return (
      (op >= ops.OP_ifnlt && op <= ops.OP_ifnge) || (op >= ops.OP_iftrue && op <= ops.OP_ifstrictne)
    );
  }

  /**
   * Block k's successors: the handlers covering any of it, the table's last
   * first; then every conditional branch in it (a block starts only where
   * something branches to, so one may be in the middle), then what its
   * last instruction does, or its fall-through.
   */
  private successors(k: u32): void {
    const ir = this.ir;
    const first = ir.blockFirst[k];
    const end = this.blockEnd(k);
    const next = k + 1 < ir.blockCount;
    if (end > first) {
      const from = ir.pc[first];
      const to = ir.pc[end - 1];
      for (let h = <i32>ir.handlerCount - 1; h >= 0; h--) {
        if (ir.handlerFrom[h] <= to && ir.handlerTo[h] > from) {
          this.succ.push(ir.handlerBlock[h]);
        }
      }
    }

    this.normalStart[k] = <u32>this.succ.length;
    for (let i = first; i < end; i++) {
      if (this.conditional(ir.op[i])) {
        this.succ.push(ir.a[i]);
      }
    }

    if (end === first) {
      if (next) {
        this.succ.push(k + 1);
      }
      return;
    }

    const i = end - 1;
    const op = ir.op[i];
    if (op === ops.OP_jump) {
      this.succ.push(ir.a[i]);
    } else if (op === ops.OP_lookupswitch) {
      this.succ.push(ir.a[i]);
      for (let c: u32 = 0; c <= <u32>ir.c[i]; c++) {
        this.succ.push(ir.cases[ir.b[i] + c]);
      }
    } else if (op === ops.OP_returnvoid || op === ops.OP_returnvalue || op === ops.OP_throw) {
      // No successor.
    } else if (next) {
      this.succ.push(k + 1);
    }
  }

  /**
   * The analysis the translation needs: successors and predecessors, a
   * reverse postorder, dominators (Cooper, Harvey and Kennedy's), each
   * block's children in the dominator tree, loop headers and forward edge
   * counts. False if the graph is irreducible: a retreating edge whose
   * target does not dominate its source.
   */
  analyze(): bool {
    const ir = this.ir;
    const n = ir.blockCount;
    if (<u32>this.rpo.length < n) {
      const size = max(n, 64);
      this.succStart = new StaticArray<u32>(size + 1);
      this.predStart = new StaticArray<u32>(size + 1);
      this.childStart = new StaticArray<u32>(size + 1);
      this.rpo = new StaticArray<i32>(size);
      this.order = new StaticArray<u32>(size);
      this.idom = new StaticArray<i32>(size);
      this.forwardIn = new StaticArray<u32>(size);
      this.loopHeader = new StaticArray<u8>(size);
      this.fill = new StaticArray<u32>(size);
      this.handlerOf = new StaticArray<i32>(size);
      this.normalStart = new StaticArray<u32>(size);
    }

    this.succ.length = 0;
    for (let k: u32 = 0; k < n; k++) {
      this.succStart[k] = <u32>this.succ.length;
      this.successors(k);
      this.rpo[k] = -1;
      this.idom[k] = -1;
      this.forwardIn[k] = 0;
      this.loopHeader[k] = 0;
      this.handlerOf[k] = -1;
    }

    // Each handler's own block, one block to a handler.
    for (let h: u32 = 0; h < ir.handlerCount; h++) {
      const block = ir.handlerBlock[h];
      if (this.handlerOf[block] >= 0) {
        return false;
      }

      this.handlerOf[block] = <i32>h;
    }

    this.succStart[n] = <u32>this.succ.length;

    // A depth-first walk from the entry: postorder, reversed. -2 marks a block on the way.
    const stack = this.dfsStack;
    const edge = this.dfsEdge;
    stack.length = 0;
    edge.length = 0;
    stack.push(0);
    edge.push(0);
    this.rpo[0] = -2;
    let post = n;
    while (stack.length) {
      const top = stack.length - 1;
      const k = stack[top];
      const e = edge[top];
      if (this.succStart[k] + e < this.succStart[k + 1]) {
        edge[top] = e + 1;
        const s = this.succ[this.succStart[k] + e];
        if (this.rpo[s] === -1) {
          this.rpo[s] = -2;
          stack.push(s);
          edge.push(0);
        }
      } else {
        stack.pop();
        edge.pop();
        this.rpo[k] = <i32>--post;
      }
    }

    // Reachable blocks, numbered from 0 in reverse postorder.
    const reachable = n - post;
    this.reachable = reachable;
    for (let k: u32 = 0; k < n; k++) {
      if (this.rpo[k] >= 0) {
        this.rpo[k] -= <i32>post;
        this.order[this.rpo[k]] = k;
      }
    }

    // Predecessors, by counting then filling.
    for (let k: u32 = 0; k <= n; k++) {
      this.predStart[k] = 0;
    }

    for (let e: u32 = 0; e < <u32>this.succ.length; e++) {
      this.predStart[this.succ[e] + 1]++;
    }

    for (let k: u32 = 0; k < n; k++) {
      this.predStart[k + 1] += this.predStart[k];
      this.fill[k] = this.predStart[k];
    }

    this.pred.length = this.succ.length;
    for (let p: u32 = 0; p < n; p++) {
      for (let e = this.succStart[p]; e < this.succStart[p + 1]; e++) {
        const s = this.succ[e];
        this.pred[this.fill[s]++] = p;
      }
    }

    // Dominators, iterated to a fixed point in reverse postorder.
    this.idom[0] = 0;
    let changed = true;
    while (changed) {
      changed = false;
      for (let r: u32 = 1; r < reachable; r++) {
        const b = this.order[r];
        let dom: i32 = -1;
        for (let e = this.predStart[b]; e < this.predStart[b + 1]; e++) {
          const p = this.pred[e];
          if (this.rpo[p] >= 0 && this.idom[p] >= 0) {
            dom = dom < 0 ? <i32>p : this.intersect(<u32>dom, p);
          }
        }

        if (dom !== this.idom[b]) {
          this.idom[b] = dom;
          changed = true;
        }
      }
    }

    // Edges: forward ones counted, retreating ones back edges to a
    // dominator, or irreducible. A handler's are forward, and its only ones.
    for (let r: u32 = 0; r < reachable; r++) {
      const p = this.order[r];
      for (let e = this.succStart[p]; e < this.succStart[p + 1]; e++) {
        const s = this.succ[e];
        if (e < this.normalStart[p]) {
          if (this.rpo[s] <= this.rpo[p]) {
            return false;
          }

          continue;
        }

        if (this.handlerOf[s] >= 0) {
          return false;
        }

        if (this.rpo[s] > this.rpo[p]) {
          this.forwardIn[s]++;
        } else if (this.dominates(s, p)) {
          this.loopHeader[s] = 1;
        } else {
          return false;
        }
      }
    }

    // The dominator tree's children, each block's in reverse postorder.
    for (let k: u32 = 0; k <= n; k++) {
      this.childStart[k] = 0;
    }

    for (let r: u32 = 1; r < reachable; r++) {
      this.childStart[this.idom[this.order[r]] + 1]++;
    }

    for (let k: u32 = 0; k < n; k++) {
      this.childStart[k + 1] += this.childStart[k];
      this.fill[k] = this.childStart[k];
    }

    this.child.length = reachable > 0 ? reachable - 1 : 0;
    for (let r: u32 = 1; r < reachable; r++) {
      const y = this.order[r];
      this.child[this.fill[this.idom[y]]++] = y;
    }

    // The translation recurses, and its code nests, along the dominator
    // tree: a block's code at most as deep as its dominator's, and a
    // labelled block for each of that one's merge children, a loop and an
    // if's braces around it. Deeper than engines parse keeps the dispatcher.
    this.fill[0] = this.loopHeader[0];
    for (let r: u32 = 1; r < reachable; r++) {
      const b = this.order[r];
      const d = <u32>this.idom[b];
      let merges: u32 = 0;
      for (let c = this.childStart[d]; c < this.childStart[d + 1]; c++) {
        const y = this.child[c];
        merges += this.handlerOf[y] >= 0 ? 2 : this.forwardIn[y] >= 2 ? 1 : 0;
      }

      const nesting = this.fill[d] + merges + this.loopHeader[b] + 1;
      if (nesting > MAX_NESTING) {
        return false;
      }

      this.fill[b] = nesting;
    }

    return true;
  }

  private intersect(a: u32, b: u32): u32 {
    let x = a;
    let y = b;
    while (x !== y) {
      while (this.rpo[x] > this.rpo[y]) {
        x = <u32>this.idom[x];
      }

      while (this.rpo[y] > this.rpo[x]) {
        y = <u32>this.idom[y];
      }
    }

    return x;
  }

  /** Whether block a dominates block b. */
  private dominates(a: u32, b: u32): bool {
    let x = b;
    while (x !== a) {
      if (x === 0) {
        return false;
      }

      x = <u32>this.idom[x];
    }

    return true;
  }

  /** Block x and what it dominates: in a loop if it heads one. */
  node(x: u32): void {
    const out = this.out;
    // Its children in the dominator tree that are merge nodes or handlers, the latest first.
    const merges: u32[] = [];
    for (let c = this.childStart[x + 1]; c > this.childStart[x]; c--) {
      const y = this.child[c - 1];
      if (this.forwardIn[y] >= 2 || this.handlerOf[y] >= 0) {
        merges.push(y);
      }
    }

    if (this.loopHeader[x]) {
      out.text("  L");
      out.uint(x);
      out.text(": for (;;) {\n");
      this.within(x, merges, 0);
      out.text("  }\n");
    } else {
      this.within(x, merges, 0);
    }
  }

  /** Block x's code inside a labelled block for each merge node from j, each followed by its code. */
  private within(x: u32, merges: u32[], j: i32): void {
    const out = this.out;
    if (j === merges.length) {
      this.structuredBlock(x);
      return;
    }

    const y = merges[j];
    out.text("  L");
    out.uint(y);
    out.text(": {\n");
    const h = this.handlerOf[y];
    if (h >= 0) {
      out.text("  try {\n");
      this.tryStack.push(<u32>h);
      this.within(x, merges, j + 1);
      this.tryStack.pop();
      out.text("  } catch (e) {\n");
      this.catchClause(<u32>h, y);
      out.text("  }\n");
    } else {
      this.within(x, merges, j + 1);
    }

    out.text("  }\n");
    this.node(y);
  }

  /**
   * Handler h's catch, around the code before its block y: the exception
   * if it came from one of h's regions and has its type, else on.
   */
  private catchClause(h: u32, y: u32): void {
    const out = this.out;
    const ir = this.ir;
    let low: u32 = 0;
    let high: u32 = 0;
    for (let r: u32 = 1; r < this.boundCount; r++) {
      const start = this.bounds[r - 1];
      if (this.covered[r - 1] && start >= ir.handlerFrom[h] && start < ir.handlerTo[h]) {
        low = low ? low : r;
        high = r;
      }
    }

    out.text("    const x = rt.caught(e);\n    if (");
    if (low === high) {
      out.text("t === ");
      out.uint(low);
    } else {
      out.text("t >= ");
      out.uint(low);
      out.text(" && t <= ");
      out.uint(high);
    }

    const type = ir.handlerType[h];
    if (type >= 0) {
      out.text(" && rt.catches(x, ");
      this.typeRef(type);
      out.text(")");
    }

    out.text(") { ");
    this.regName(<i32>(ir.localCount + ir.maxScope));
    out.text(" = x; break L");
    out.uint(y);
    out.text("; }\n    throw e;\n");
  }

  /** Whether the handlers covering region r have their trys open, innermost first in the table's order. */
  private enclosed(r: i32): bool {
    if (r === 0) {
      return true;
    }

    const ir = this.ir;
    const start = this.bounds[r - 1];
    let below = this.tryStack.length;
    for (let h: u32 = 0; h < ir.handlerCount; h++) {
      if (start < ir.handlerFrom[h] || start >= ir.handlerTo[h]) {
        continue;
      }

      let at = below - 1;
      while (at >= 0 && this.tryStack[at] !== h) {
        at--;
      }

      if (at < 0) {
        return false;
      }

      below = at;
    }

    return true;
  }

  /** Block k's instructions, and its fall-through as an explicit branch. */
  private structuredBlock(k: u32): void {
    this.currentBlock = k;
    this.blockBody(k);
    if (!this.terminates(k) && k + 1 < this.ir.blockCount) {
      this.currentBlock = k;
      this.out.text("    ");
      this.branchTo(k + 1);
      this.out.text("\n");
    }
  }

  /** A branch from the current block to block t. */
  private branchTo(t: u32): void {
    const out = this.out;
    const from = this.currentBlock;
    if (this.loopHeader[t] && this.rpo[t] <= this.rpo[from]) {
      out.text("continue L");
      out.uint(t);
      out.text(";");
    } else if (this.forwardIn[t] >= 2) {
      out.text("break L");
      out.uint(t);
      out.text(";");
    } else {
      // Its only way in: its code here, and then the block branching goes
      // on, a conditional branch's, with its own types, scopes and region.
      out.text("\n");
      this.save();
      this.node(t);
      this.restore();
      this.mark();
      this.currentBlock = from;
    }
  }

  /** Push what writing a block follows: its registers' types, scopes and region. */
  private save(): void {
    const ir = this.ir;
    const saved = this.saved;
    for (let r: u32 = 0; r < ir.frameSize; r++) {
      saved.push(this.regType[r]);
    }

    for (let d: u32 = 0; d < ir.maxScope; d++) {
      saved.push(this.scopeWith[d]);
    }

    saved.push(<i32>this.scopeDepth);
    saved.push(this.region);
    saved.push(this.file);
    saved.push(<i32>this.line);
  }

  /** Pop what save pushed. */
  private restore(): void {
    const ir = this.ir;
    const saved = this.saved;
    this.line = <u32>saved.pop();
    this.file = saved.pop();
    this.region = saved.pop();
    this.scopeDepth = <u32>saved.pop();
    for (let d = <i32>ir.maxScope - 1; d >= 0; d--) {
      this.scopeWith[d] = <u8>saved.pop();
    }

    for (let r = <i32>ir.frameSize - 1; r >= 0; r--) {
      this.regType[r] = saved.pop();
    }
  }

  instruction(i: u32): void {
    const out = this.out;
    const ir = this.ir;
    const op = ir.op[i];
    const a = ir.a[i];
    switch (op) {
      case ops.OP_pushbyte:
      case ops.OP_pushshort:
        this.assign(i);
        out.int(<i32>a);
        break;
      case ops.OP_pushint:
        this.assign(i);
        out.int(this.abc.pool.ints[a]);
        break;
      case ops.OP_pushuint:
        this.assign(i);
        out.uint(this.abc.pool.uints[a]);
        break;
      case ops.OP_pushdouble:
        this.assign(i);
        out.double(this.abc.pool.doubles[a]);
        break;
      case ops.OP_pushnan:
        this.assign(i);
        out.text("NaN");
        break;
      case ops.OP_pushstring:
        this.assign(i);
        this.string(a);
        break;
      case ops.OP_pushtrue:
        this.assign(i);
        out.text("true");
        break;
      case ops.OP_pushfalse:
        this.assign(i);
        out.text("false");
        break;
      case ops.OP_pushnull:
        this.assign(i);
        out.text("null");
        break;
      case ops.OP_pushnamespace:
        this.assign(i);
        out.text("rt.namespace(N[");
        out.uint(a);
        out.text("])");
        break;
      case ops.OP_pushundefined:
        this.assign(i);
        out.text("undefined");
        break;
      case ops.OP_getlocal:
      case ops.OP_setlocal:
      case ops.OP_dup:
        if (this.copies(i)) {
          return;
        }

        this.assign(i);
        this.reg(ir.src[i]);
        break;
      case ops.OP_kill:
        this.assign(i);
        out.text("undefined");
        break;
      case ops.OP_swap: {
        // Through a temporary, not [a, b] = [b, a]: destructuring is an
        // array and the iterator protocol, which V8 counts against inlining.
        const x = ir.src[i];
        out.text("    { const w = ");
        this.reg(x + 1);
        out.text("; ");
        this.regName(x + 1);
        out.text(" = ");
        this.reg(x);
        out.text("; ");
        this.regName(x);
        out.text(" = w; }");
        break;
      }
      case ops.OP_debugfile:
        this.file = <i32>a;
        return;
      case ops.OP_debugline:
        this.line = a;
        this.mark();
        return;
      case ops.OP_pop:
      case ops.OP_debug:
        return;
      case IR_Coerce:
        if (ir.dst[i] === ir.src[i] && this.keeps(ir.c[i], this.regType[ir.src[i]])) {
          this.kept = true;
          return;
        }

        this.assign(i);
        this.convert("", ir.src[i], ir.c[i], this.regType[ir.src[i]]);
        break;
      case IR_CheckNull:
        out.text("    if (");
        this.reg(ir.src[i]);
        out.text(" == null) throw rt.nullError(");
        this.reg(ir.src[i]);
        out.text(")");
        break;
      case ops.OP_add:
        this.assign(i);
        if (this.isNumber(this.src(i, 0)) && this.isNumber(this.src(i, 1))) {
          this.binary(i, " + ");
        } else {
          this.call2("rt.add(", i);
        }
        break;
      case ops.OP_subtract:
        this.assign(i);
        this.binary(i, " - ");
        break;
      case ops.OP_multiply:
        this.assign(i);
        this.binary(i, " * ");
        break;
      case ops.OP_divide:
        this.assign(i);
        this.binary(i, " / ");
        break;
      case ops.OP_modulo:
        this.assign(i);
        this.binary(i, " % ");
        break;
      case ops.OP_add_i:
        this.assign(i);
        this.binaryInt(i, " + ");
        break;
      case ops.OP_subtract_i:
        this.assign(i);
        this.binaryInt(i, " - ");
        break;
      case ops.OP_multiply_i:
        // int multiplication wraps as Math.imul does, not as a double product.
        this.assign(i);
        this.call2("Math.imul(", i);
        break;
      case ops.OP_bitand:
        this.assign(i);
        this.binary(i, " & ");
        break;
      case ops.OP_bitor:
        this.assign(i);
        this.binary(i, " | ");
        break;
      case ops.OP_bitxor:
        this.assign(i);
        this.binary(i, " ^ ");
        break;
      case ops.OP_lshift:
        this.assign(i);
        this.binary(i, " << ");
        break;
      case ops.OP_rshift:
        this.assign(i);
        this.binary(i, " >> ");
        break;
      case ops.OP_urshift:
        this.assign(i);
        this.binary(i, " >>> ");
        break;
      case ops.OP_bitnot:
        this.assign(i);
        out.text("~");
        this.reg(ir.src[i]);
        break;
      case ops.OP_negate:
        this.assign(i);
        out.text("-");
        this.reg(ir.src[i]);
        break;
      case ops.OP_negate_i:
        this.assign(i);
        out.text("-");
        this.reg(ir.src[i]);
        out.text(" | 0");
        break;
      case ops.OP_increment:
      case ops.OP_decrement:
        this.assign(i);
        this.reg(ir.src[i]);
        out.text(op === ops.OP_increment ? " + 1" : " - 1");
        break;
      case ops.OP_increment_i:
      case ops.OP_decrement_i:
        this.assign(i);
        this.reg(ir.src[i]);
        out.text(op === ops.OP_increment_i ? " + 1 | 0" : " - 1 | 0");
        break;
      case ops.OP_inclocal:
      case ops.OP_declocal:
        this.assign(i);
        this.reg(ir.src[i]);
        out.text(op === ops.OP_inclocal ? " + 1" : " - 1");
        break;
      case ops.OP_inclocal_i:
      case ops.OP_declocal_i:
        this.assign(i);
        this.reg(ir.src[i]);
        out.text(op === ops.OP_inclocal_i ? " + 1 | 0" : " - 1 | 0");
        break;
      case ops.OP_not:
        this.assign(i);
        out.text("!");
        this.reg(ir.src[i]);
        break;
      case ops.OP_typeof:
        this.assign(i);
        out.text("rt.typeOf(");
        this.reg(ir.src[i]);
        out.text(")");
        break;
      case ops.OP_equals:
      case ops.OP_strictequals:
      case ops.OP_lessthan:
      case ops.OP_lessequals:
      case ops.OP_greaterthan:
      case ops.OP_greaterequals:
        this.assign(i);
        this.compare(i, op, false);
        break;
      case ops.OP_convert_i:
      case ops.OP_coerce_i:
      case ops.OP_convert_u:
      case ops.OP_coerce_u:
      case ops.OP_convert_d:
      case ops.OP_coerce_d:
      case ops.OP_convert_b:
      case ops.OP_coerce_b:
      case ops.OP_convert_s:
      case ops.OP_coerce_s:
      case ops.OP_coerce_a:
      case ops.OP_coerce_o:
      case ops.OP_coerce:
      case ops.OP_convert_o:
        // A conversion that changes nothing, in place, is no code.
        if (
          ir.dst[i] === ir.src[i] &&
          this.keeps(this.conversionType(<u8>op, i), this.regType[ir.src[i]])
        ) {
          this.kept = true;
          return;
        }

        this.assign(i);
        this.conversion(i, <u8>op);
        break;
      case ops.OP_jump:
        out.text("    ");
        this.goto(a);
        break;
      case ops.OP_iftrue:
      case ops.OP_iffalse:
        out.text(op === ops.OP_iftrue ? "    if (" : "    if (!");
        this.reg(ir.src[i]);
        out.text(") { ");
        this.goto(a);
        out.text(" }");
        break;
      case ops.OP_ifeq:
      case ops.OP_ifne:
      case ops.OP_ifstricteq:
      case ops.OP_ifstrictne:
      case ops.OP_iflt:
      case ops.OP_ifle:
      case ops.OP_ifgt:
      case ops.OP_ifge:
      case ops.OP_ifnlt:
      case ops.OP_ifnle:
      case ops.OP_ifngt:
      case ops.OP_ifnge:
        this.branch(i, <u8>op);
        break;
      case ops.OP_lookupswitch: {
        // An index out of range, or not an int, takes the default.
        out.text("    switch (");
        this.reg(ir.src[i]);
        out.text(") {");
        const first = ir.b[i];
        for (let c: u32 = 0; c <= <u32>ir.c[i]; c++) {
          out.text(" case ");
          out.uint(c);
          out.text(": ");
          this.goto(ir.cases[first + c]);
        }

        out.text(" default: ");
        this.goto(a);
        out.text(" }");
        break;
      }
      case ops.OP_returnvoid:
        out.text("    return undefined");
        break;
      case ops.OP_returnvalue:
        out.text("    return ");
        this.reg(ir.src[i]);
        break;
      case ops.OP_throw:
        out.text("    throw ");
        this.reg(ir.src[i]);
        break;
      default:
        if (this.object(i, op)) {
          break;
        }

        if (op >= ops.OP_getlocal0 && op < ops.OP_getlocal0 + 4) {
          if (this.copies(i)) {
            return;
          }

          this.assign(i);
          this.reg(ir.src[i]);
          break;
        }

        if (op >= ops.OP_setlocal0 && op < ops.OP_setlocal0 + 4) {
          this.assign(i);
          this.reg(ir.src[i]);
          break;
        }

        // An instruction not lowered yet fails where it runs.
        out.text('    throw rt.unsupported("');
        out.text(op < 256 ? opcodeNames[op] : "ir");
        out.text('")');
        break;
    }

    out.text(";\n");
  }

  /**
   * The instructions of the object model: scopes, names, properties, calls,
   * and creating objects, functions and classes; false for one it does not
   * know, which then calls rt.unsupported.
   */
  object(i: u32, op: u16): bool {
    const out = this.out;
    const ir = this.ir;
    const a = ir.a[i];
    const src = ir.src[i];
    switch (op) {
      case ops.OP_pushscope:
      case ops.OP_pushwith:
        this.scopeWith[this.scopeDepth++] = op === ops.OP_pushwith ? 1 : 0;
        this.assign(i);
        this.reg(src);
        return true;
      case ops.OP_popscope:
        this.scopeDepth--;
        out.text("    ");
        this.regName(src);
        out.text(" = undefined");
        return true;
      case ops.OP_getscopeobject:
        this.assign(i);
        this.reg(src);
        return true;
      case ops.OP_getouterscope:
        this.assign(i);
        out.text("scope[");
        out.uint(a);
        out.text("]");
        return true;
      case ops.OP_getglobalscope:
      case IR_GetGlobalScope:
        this.assign(i);
        this.globalScope();
        return true;
      case ops.OP_finddef:
        this.assign(i);
        out.text("rt.findDef(M[");
        out.uint(a);
        out.text("])");
        return true;
      case IR_FindPropGlobal:
      case IR_FindPropGlobalStrict:
        this.assign(i);
        // Not found statically: a script's name, or else the global object's.
        out.text(op === IR_FindPropGlobalStrict ? "rt.findGlobalStrict(M[" : "rt.findGlobal(M[");
        out.uint(a);
        out.text("], ");
        this.globalScope();
        out.text(")");
        return true;
      case ops.OP_findproperty:
      case ops.OP_findpropstrict:
        this.assign(i);
        out.text(op === ops.OP_findpropstrict ? "rt.findPropertyStrict(" : "rt.findProperty(");
        this.name(a, src);
        out.text(", scope, ");
        this.localScopes();
        out.text(")");
        return true;
      case ops.OP_getslot:
        this.assign(i);
        this.reg(src);
        out.text(".$");
        out.uint(a);
        return true;
      case ops.OP_setslot:
        out.text("    ");
        this.reg(src);
        out.text(".$");
        out.uint(a);
        out.text(" = ");
        this.reg(src + 1);
        return true;
      case ops.OP_getglobalslot:
        this.assign(i);
        this.globalScope();
        out.text(".$");
        out.uint(a);
        return true;
      case ops.OP_setglobalslot:
        out.text("    ");
        this.globalScope();
        out.text(".$");
        out.uint(a);
        out.text(" = ");
        this.reg(src);
        return true;
      case IR_CallGetter:
        this.assign(i);
        this.virtual(a, src, 0);
        return true;
      case IR_CallSetter:
        out.text("    ");
        this.virtual(a, src, 1);
        return true;
      case ops.OP_callmethod:
        if (ir.dst[i] >= 0) {
          this.assign(i);
        } else {
          out.text("    ");
        }

        this.virtual(a, src, ir.b[i]);
        return true;
      case IR_CallInterface:
        if (ir.dst[i] >= 0) {
          this.assign(i);
        } else {
          out.text("    ");
        }

        // By the interface's dispatch id, which its layout maps to a name.
        out.text("rt.callInterface(");
        this.typeRef(this.regType[src]);
        out.text(", ");
        out.uint(a);
        out.text(", ");
        this.reg(src);
        this.args(src + 1, ir.b[i]);
        out.text(")");
        return true;
      case IR_Nip:
        this.assign(i);
        this.reg(src + <i32>ir.srcCount[i] - 1);
        return true;
      case ops.OP_getproperty:
        this.assign(i);
        if (this.indexed(a, src + 1)) {
          // As avmplus' getUintProperty: an element by its number, of a
          // Vector by the kind of its elements where the IR knows it.
          const kind = this.vectorKind(this.regType[src]);
          out.text(kind.length ? "rt.vectorGet" : "rt.getIndexed(");
          if (kind.length) {
            out.text(kind);
            out.text("(");
          }

          this.reg(src);
          out.text(", M[");
          out.uint(a);
          out.text("], ");
          this.reg(src + 1);
          out.text(")");
          return true;
        }

        out.text("rt.getProperty(");
        this.reg(src);
        out.text(", ");
        this.name(a, src + 1);
        out.text(")");
        return true;
      case ops.OP_setproperty:
        if (this.indexed(a, src + 1)) {
          const kind = this.vectorKind(this.regType[src]);
          out.text(kind.length ? "    rt.vectorSet" : "    rt.setIndexed(");
          if (kind.length) {
            out.text(kind);
            out.text("(");
          }

          this.reg(src);
          out.text(", M[");
          out.uint(a);
          out.text("], ");
          this.reg(src + 1);
          out.text(", ");
          this.reg(src + 2);
          out.text(")");
          return true;
        }

        out.text("    rt.setProperty(");
        this.reg(src);
        out.text(", ");
        this.name(a, src + 1);
        out.text(", ");
        this.reg(src + <i32>ir.srcCount[i] - 1);
        out.text(")");
        return true;
      case ops.OP_initproperty: {
        out.text(op === ops.OP_initproperty ? "    rt.initProperty(" : "    rt.setProperty(");
        this.reg(src);
        out.text(", ");
        this.name(a, src + 1);
        out.text(", ");
        this.reg(src + <i32>ir.srcCount[i] - 1);
        out.text(")");
        return true;
      }
      case ops.OP_deleteproperty:
        this.assign(i);
        out.text("rt.deleteProperty(");
        this.reg(src);
        out.text(", ");
        this.name(a, src + 1);
        out.text(")");
        return true;
      case ops.OP_in:
        this.assign(i);
        // `name in object`.
        this.call2("rt.in(", i);
        return true;
      case ops.OP_callproperty:
      case ops.OP_callproplex:
      case ops.OP_callpropvoid:
      case ops.OP_constructprop: {
        const argc = ir.b[i];
        const parts = ir.srcCount[i] - 1 - argc;
        if (ir.dst[i] >= 0) {
          this.assign(i);
        } else {
          out.text("    ");
        }

        out.text(
          op === ops.OP_constructprop
            ? "rt.constructProperty("
            : op === ops.OP_callproplex
              ? "rt.callPropLex("
              : "rt.callProperty(",
        );
        this.reg(src);
        out.text(", ");
        this.name(a, src + 1);
        this.args(src + 1 + <i32>parts, argc);
        out.text(")");
        return true;
      }
      case ops.OP_callsuper:
      case ops.OP_callsupervoid:
      case ops.OP_getsuper:
      case ops.OP_setsuper: {
        const argc = op === ops.OP_getsuper ? 0 : op === ops.OP_setsuper ? 1 : ir.b[i];
        const parts = ir.srcCount[i] - 1 - argc;
        if (ir.dst[i] >= 0) {
          this.assign(i);
        } else {
          out.text("    ");
        }

        out.text(
          op === ops.OP_getsuper
            ? "rt.getSuper(sup, "
            : op === ops.OP_setsuper
              ? "rt.setSuper(sup, "
              : "rt.callSuper(sup, ",
        );
        this.reg(src);
        out.text(", ");
        this.name(a, src + 1);
        this.args(src + 1 + <i32>parts, argc);
        out.text(")");
        return true;
      }
      case ops.OP_constructsuper:
        out.text("    rt.constructSuper(sup, ");
        this.reg(src);
        this.args(src + 1, a);
        out.text(")");
        return true;
      case ops.OP_construct:
        this.assign(i);
        out.text("rt.construct(");
        this.reg(src);
        this.args(src + 1, a);
        out.text(")");
        return true;
      case ops.OP_call:
        this.assign(i);
        out.text("rt.call(");
        this.reg(src);
        out.text(", ");
        this.reg(src + 1);
        this.args(src + 2, a);
        out.text(")");
        return true;
      case ops.OP_callstatic:
        if (ir.dst[i] >= 0) {
          this.assign(i);
        } else {
          out.text("    ");
        }

        out.text("rt.callStatic(A, ");
        out.uint(a);
        out.text(", ");
        this.reg(src);
        this.args(src + 1, ir.b[i]);
        out.text(")");
        return true;
      case ops.OP_newfunction:
        this.assign(i);
        out.text("rt.newFunction(F[");
        out.uint(a);
        out.text("], ");
        this.scopeHere();
        out.text(")");
        return true;
      case ops.OP_newclass:
        this.assign(i);
        out.text("rt.newClass(A.classes[");
        out.uint(a);
        out.text("], ");
        this.reg(src);
        out.text(", ");
        this.scopeHere();
        out.text(")");
        return true;
      case ops.OP_newactivation:
        this.assign(i);
        out.text("rt.newActivation(A.activations[");
        out.int(this.body);
        out.text("])");
        return true;
      case ops.OP_newcatch: {
        const abc = this.abc;
        const h = abc.bodyExceptionStart[this.body] + a;
        this.assign(i);
        out.text("rt.newCatch(M[");
        out.uint(abc.exceptionName[h]);
        out.text("])");
        return true;
      }
      case ops.OP_newobject:
        this.assign(i);
        out.text("rt.newObject([");
        this.list(src, ir.srcCount[i]);
        out.text("])");
        return true;
      case ops.OP_newarray:
        this.assign(i);
        out.text("rt.newArray([");
        this.list(src, ir.srcCount[i]);
        out.text("])");
        return true;
      case ops.OP_applytype:
        this.assign(i);
        out.text("rt.applyType(");
        this.reg(src);
        out.text(", [");
        this.list(src + 1, a);
        out.text("])");
        return true;
      case ops.OP_hasnext:
        this.assign(i);
        this.call2("rt.hasNext(", i);
        return true;
      case ops.OP_hasnext2: {
        // hasnext2 updates its two locals: the object and the index.
        const b = ir.b[i];
        out.text("    [");
        this.regName(ir.dst[i]);
        out.text(", ");
        this.regName(<i32>a);
        out.text(", ");
        this.regName(<i32>b);
        out.text("] = rt.hasNext2(");
        this.reg(<i32>a);
        out.text(", ");
        this.reg(<i32>b);
        out.text(")");
        return true;
      }
      case ops.OP_nextname:
        this.assign(i);
        this.call2("rt.nextName(", i);
        return true;
      case ops.OP_nextvalue:
        this.assign(i);
        this.call2("rt.nextValue(", i);
        return true;
      case ops.OP_instanceof:
        this.assign(i);
        this.call2("rt.instanceOf(", i);
        return true;
      case ops.OP_istypelate:
        this.assign(i);
        this.call2("rt.isTypeLate(", i);
        return true;
      case ops.OP_astypelate:
        this.assign(i);
        this.call2("rt.asTypeLate(", i);
        return true;
      case ops.OP_istype:
      case ops.OP_astype:
        this.assign(i);
        out.text(op === ops.OP_istype ? "rt.isType(" : "rt.asType(");
        this.reg(src);
        out.text(", M[");
        out.uint(a);
        out.text("])");
        return true;
      // Domain memory: loads and stores through the runtime, which checks
      // their range; sign extensions in plain JavaScript.
      case ops.OP_li8:
      case ops.OP_li16:
      case ops.OP_li32:
      case ops.OP_lf32:
      case ops.OP_lf64:
        this.assign(i);
        out.text("rt.");
        out.text(opcodeNames[op]);
        out.text("(");
        this.reg(src);
        out.text(")");
        return true;
      case ops.OP_si8:
      case ops.OP_si16:
      case ops.OP_si32:
      case ops.OP_sf32:
      case ops.OP_sf64:
        out.text("    rt.");
        out.text(opcodeNames[op]);
        out.text("(");
        this.reg(src);
        out.text(", ");
        this.reg(src + 1);
        out.text(")");
        return true;
      case ops.OP_sxi1:
      case ops.OP_sxi8:
      case ops.OP_sxi16:
        this.assign(i);
        out.text("(");
        this.reg(src);
        out.text(
          op === ops.OP_sxi1
            ? " << 31) >> 31"
            : op === ops.OP_sxi8
              ? " << 24) >> 24"
              : " << 16) >> 16",
        );
        return true;
      case ops.OP_getdescendants:
        this.assign(i);
        out.text("rt.getDescendants(");
        this.reg(src);
        out.text(", ");
        this.name(a, src + 1);
        out.text(")");
        return true;
      case ops.OP_dxns:
        out.text("    rt.setDefaultXmlNamespace(");
        this.string(a);
        out.text(")");
        return true;
      case ops.OP_dxnslate:
        out.text("    rt.setDefaultXmlNamespace(");
        this.reg(src);
        out.text(")");
        return true;
      case ops.OP_checkfilter:
        out.text("    rt.checkFilter(");
        this.reg(src);
        out.text(")");
        return true;
      case ops.OP_esc_xelem:
      case ops.OP_esc_xattr:
        this.assign(i);
        out.text(op === ops.OP_esc_xelem ? "rt.escapeElement(" : "rt.escapeAttribute(");
        this.reg(src);
        out.text(")");
        return true;
      default:
        return false;
    }
  }

  /** The method's global object: its scope chain's first, else its own first scope. */
  globalScope(): void {
    if (this.ir.outerSize > 0) {
      this.out.text("scope[0]");
    } else {
      this.reg(<i32>this.ir.localCount);
    }
  }

  /** The scopes pushed so far, innermost last: [sc0, ...], with their with flags. */
  localScopes(): void {
    const out = this.out;
    out.text("[");
    let withs: u32 = 0;
    for (let d: u32 = 0; d < this.scopeDepth; d++) {
      if (d) {
        out.text(", ");
      }

      this.reg(<i32>(this.ir.localCount + d));
      withs |= (<u32>this.scopeWith[d]) << d;
    }

    out.text("], ");
    out.uint(withs);
  }

  /** The scope chain a function or class created here runs in. */
  scopeHere(): void {
    this.out.text("rt.scope(scope, ");
    this.localScopes();
    this.out.text(")");
  }

  /**
   * Multiname `a`: M[a], or with its runtime namespace and
   * name taken from the registers from `from`.
   */
  name(a: u32, from: i32): void {
    const out = this.out;
    const kind = this.abc.pool.mnKind[a];
    const parts =
      kind === C.CONSTANT_RTQnameL || kind === C.CONSTANT_RTQnameLA
        ? 2
        : kind === C.CONSTANT_RTQname ||
            kind === C.CONSTANT_RTQnameA ||
            kind === C.CONSTANT_MultinameL ||
            kind === C.CONSTANT_MultinameLA
          ? 1
          : 0;
    if (parts === 0) {
      out.text("M[");
      out.uint(a);
      out.text("]");
      return;
    }

    out.text("rt.runtimeName(M[");
    out.uint(a);
    out.text("]");
    for (let k: i32 = 0; k < parts; k++) {
      out.text(", ");
      this.reg(from + k);
    }

    out.text(")");
  }

  /**
   * Whether multiname `a` is a runtime name alone, not an attribute, whose
   * name in register r is a number: an element's index, which the runtime
   * reads and writes without making the name.
   */
  /** The kind of a Vector's elements, as the runtime's vectorGet and vectorSet name it, for type t; "" if not a Vector's. */
  vectorKind(t: i32): string {
    const domain = this.domain;
    if (t < 0) {
      return "";
    }

    if (t === domain.vectorIntType) {
      return "Int";
    }

    if (t === domain.vectorUintType) {
      return "Uint";
    }

    if (t === domain.vectorDoubleType) {
      return "Double";
    }

    return domain.vectorObjectType >= 0 &&
      domain.traits.subtypeOf(<u32>t, <u32>domain.vectorObjectType)
      ? "Object"
      : "";
  }

  indexed(a: u32, r: i32): bool {
    return this.abc.pool.mnKind[a] === C.CONSTANT_MultinameL && this.isNumber(r);
  }

  /** `, r, r+1, ...` for `count` arguments from register `from`. */
  args(from: i32, count: u32): void {
    for (let k: u32 = 0; k < count; k++) {
      this.out.text(", ");
      this.reg(from + <i32>k);
    }
  }

  list(from: i32, count: u32): void {
    for (let k: u32 = 0; k < count; k++) {
      if (k) {
        this.out.text(", ");
      }

      this.reg(from + <i32>k);
    }
  }

  /**
   * A call by dispatch id `disp` on the receiver in `src`, with `argc`
   * arguments after it: a method of the receiver's prototype, or for a
   * primitive receiver, or a namespace, which the runtime represents
   * itself, of its class's.
   */
  virtual(disp: u32, src: i32, argc: u32): void {
    const out = this.out;
    const type = this.regType[src];
    const bt = this.builtinOf(src);
    const primitive =
      bt === BUILTIN_Int ||
      bt === BUILTIN_Uint ||
      bt === BUILTIN_Number ||
      bt === BUILTIN_Boolean ||
      bt === BUILTIN_String ||
      bt === BUILTIN_Namespace;
    if (primitive) {
      out.text("rt.prototypeOf(");
      this.typeRef(type);
      out.text(").$m");
      out.uint(disp);
      out.text(".call(");
      this.reg(src);
      this.args(src + 1, argc);
      out.text(")");
      return;
    }

    this.reg(src);
    out.text(".$m");
    out.uint(disp);
    out.text("(");
    this.list(src + 1, argc);
    out.text(")");
  }

  /**
   * The comparison `op` of instruction i's two operands, negated if `not`:
   * JavaScript's own operator where the types make it AS3's, else the
   * runtime's. For numbers and Booleans the relational operators and ==
   * are the same in both, NaN included; === is for any two primitives; and
   * == for two Strings, null included. A String compared otherwise would
   * convert as JavaScript does, which differs from AS3 for "0b1".
   */
  compare(i: u32, op: u16, not: bool): void {
    const out = this.out;
    const a = this.src(i, 0);
    const b = this.src(i, 1);
    const numeric = this.isNumeric(a) && this.isNumeric(b);
    const strings = this.builtinOf(a) === BUILTIN_String && this.builtinOf(b) === BUILTIN_String;
    let js = "";
    let runtime = "";
    switch (op) {
      case ops.OP_equals:
        js = numeric || strings ? " == " : "";
        runtime = "rt.equals(";
        break;
      case ops.OP_strictequals:
        js = this.isPrimitive(a) && this.isPrimitive(b) ? " === " : "";
        runtime = "rt.strictEquals(";
        break;
      case ops.OP_lessthan:
        js = numeric ? " < " : "";
        runtime = "rt.lessThan(";
        break;
      case ops.OP_lessequals:
        js = numeric ? " <= " : "";
        runtime = "rt.lessEquals(";
        break;
      case ops.OP_greaterthan:
        js = numeric ? " > " : "";
        runtime = "rt.greaterThan(";
        break;
      default:
        js = numeric ? " >= " : "";
        runtime = "rt.greaterEquals(";
        break;
    }

    if (js.length === 0) {
      if (not) {
        out.text("!");
      }

      this.call2(runtime, i);
      return;
    }

    out.text(not ? "!(" : "(");
    this.reg(a);
    out.text(js);
    this.reg(b);
    out.text(")");
  }

  /** Whether register r holds an int, uint, Number or Boolean now. */
  isNumeric(r: i32): bool {
    return this.isNumber(r) || this.builtinOf(r) === BUILTIN_Boolean;
  }

  /** Whether register r holds a value of one of the primitive types now. */
  isPrimitive(r: i32): bool {
    return this.isNumeric(r) || this.builtinOf(r) === BUILTIN_String;
  }

  isNumber(r: i32): bool {
    const bt = this.builtinOf(r);
    return bt === BUILTIN_Int || bt === BUILTIN_Uint || bt === BUILTIN_Number;
  }

  binary(i: u32, operator: string): void {
    this.reg(this.src(i, 0));
    this.out.text(operator);
    this.reg(this.src(i, 1));
  }

  binaryInt(i: u32, operator: string): void {
    this.binary(i, operator);
    this.out.text(" | 0");
  }

  call2(fn: string, i: u32): void {
    this.out.text(fn);
    this.reg(this.src(i, 0));
    this.out.text(", ");
    this.reg(this.src(i, 1));
    this.out.text(")");
  }

  /** A conditional branch comparing two values; the `n` forms are true when the comparison is not. */
  branch(i: u32, op: u8): void {
    const out = this.out;
    out.text("    if (");
    switch (op) {
      case ops.OP_ifeq:
        this.compare(i, ops.OP_equals, false);
        break;
      case ops.OP_ifne:
        this.compare(i, ops.OP_equals, true);
        break;
      case ops.OP_ifstricteq:
        this.compare(i, ops.OP_strictequals, false);
        break;
      case ops.OP_ifstrictne:
        this.compare(i, ops.OP_strictequals, true);
        break;
      case ops.OP_iflt:
        this.compare(i, ops.OP_lessthan, false);
        break;
      case ops.OP_ifle:
        this.compare(i, ops.OP_lessequals, false);
        break;
      case ops.OP_ifgt:
        this.compare(i, ops.OP_greaterthan, false);
        break;
      case ops.OP_ifge:
        this.compare(i, ops.OP_greaterequals, false);
        break;
      case ops.OP_ifnlt:
        this.compare(i, ops.OP_lessthan, true);
        break;
      case ops.OP_ifnle:
        this.compare(i, ops.OP_lessequals, true);
        break;
      case ops.OP_ifngt:
        this.compare(i, ops.OP_greaterthan, true);
        break;
      default:
        this.compare(i, ops.OP_greaterequals, true);
        break;
    }

    out.text(") { ");
    this.goto(this.ir.a[i]);
    out.text(" }");
  }

  /** The type a conversion instruction gives, or CONVERTS for one that always calls the runtime. */
  conversionType(op: u8, i: u32): i32 {
    const domain = this.domain;
    switch (op) {
      case ops.OP_convert_i:
      case ops.OP_coerce_i:
        return domain.intType;
      case ops.OP_convert_u:
      case ops.OP_coerce_u:
        return domain.uintType;
      case ops.OP_convert_d:
      case ops.OP_coerce_d:
        return domain.numberType;
      case ops.OP_convert_b:
      case ops.OP_coerce_b:
        return domain.booleanType;
      case ops.OP_coerce_s:
        return domain.stringType;
      case ops.OP_coerce_o:
        return domain.objectType();
      case ops.OP_coerce:
        return this.ir.c[i];
      case ops.OP_coerce_a:
        return TYPE_Any;
      default:
        return CONVERTS;
    }
  }

  /** Whether converting a value of type `from` to `type` gives the value itself, as convert writes no code for. */
  keeps(type: i32, from: i32): bool {
    if (type === CONVERTS) {
      return false;
    }

    const domain = this.domain;
    const bt = domain.builtin(type);
    const fromBt = domain.builtin(from);
    return (
      type === from ||
      bt === BUILTIN_Any ||
      (bt === BUILTIN_Number &&
        (fromBt === BUILTIN_Int || fromBt === BUILTIN_Uint || fromBt === BUILTIN_Number))
    );
  }

  /** The conversion instructions: the value of src as the type they give. */
  conversion(i: u32, op: u8): void {
    const domain = this.domain;
    const src = this.ir.src[i];
    const from = this.regType[src];
    switch (op) {
      case ops.OP_convert_i:
      case ops.OP_coerce_i:
        this.convert("", src, domain.intType, from);
        break;
      case ops.OP_convert_u:
      case ops.OP_coerce_u:
        this.convert("", src, domain.uintType, from);
        break;
      case ops.OP_convert_d:
      case ops.OP_coerce_d:
        this.convert("", src, domain.numberType, from);
        break;
      case ops.OP_convert_b:
      case ops.OP_coerce_b:
        this.convert("", src, domain.booleanType, from);
        break;
      case ops.OP_convert_s:
        // Unlike coerce_s, null and undefined become "null" and "undefined".
        this.out.text("rt.toString(");
        this.reg(src);
        this.out.text(")");
        break;
      case ops.OP_coerce_s:
        this.convert("", src, domain.stringType, from);
        break;
      case ops.OP_convert_o:
        this.out.text("rt.toObject(");
        this.reg(src);
        this.out.text(")");
        break;
      case ops.OP_coerce_o:
        this.convert("", src, domain.objectType(), from);
        break;
      case ops.OP_coerce:
        this.convert("", src, this.ir.c[i], from);
        break;
      default:
        this.reg(src);
        break;
    }
  }

  /**
   * Register r (or `prefix` + r, for a parameter) converted to `type` from
   * `from`, as avmplus' coercions: nothing when it is that type already,
   * plain JavaScript for numbers and booleans, the runtime otherwise.
   */
  convert(prefix: string, r: i32, type: i32, from: i32): void {
    const out = this.out;
    const domain = this.domain;
    const bt = domain.builtin(type);
    const fromBt = domain.builtin(from);
    if (type === from || bt === BUILTIN_Any) {
      this.operand(prefix, r);
      return;
    }

    const numeric = fromBt === BUILTIN_Int || fromBt === BUILTIN_Uint || fromBt === BUILTIN_Number;
    switch (bt) {
      case BUILTIN_Int:
        if (numeric || fromBt === BUILTIN_Boolean) {
          this.operand(prefix, r);
          out.text(" | 0");
        } else {
          out.text("rt.toInt(");
          this.operand(prefix, r);
          out.text(")");
        }
        return;
      case BUILTIN_Uint:
        if (numeric || fromBt === BUILTIN_Boolean) {
          this.operand(prefix, r);
          out.text(" >>> 0");
        } else {
          out.text("rt.toUint(");
          this.operand(prefix, r);
          out.text(")");
        }
        return;
      case BUILTIN_Number:
        if (numeric) {
          this.operand(prefix, r);
        } else {
          out.text("rt.toNumber(");
          this.operand(prefix, r);
          out.text(")");
        }
        return;
      case BUILTIN_Boolean:
        out.text("!!");
        this.operand(prefix, r);
        return;
      case BUILTIN_String:
        out.text("rt.coerceString(");
        this.operand(prefix, r);
        out.text(")");
        return;
      case BUILTIN_Object:
        out.text("rt.coerceObject(");
        this.operand(prefix, r);
        out.text(")");
        return;
      default:
        // A class's instances, by T: no builtin for the runtime to look for.
        out.text(this.isClassRef(type) ? "rt.coerceTo(" : "rt.coerce(");
        this.operand(prefix, r);
        out.text(", ");
        this.typeRef(type);
        out.text(")");
    }
  }

  operand(prefix: string, r: i32): void {
    if (prefix.length) {
      this.out.text(prefix);
      this.out.uint(<u64>r);
    } else {
      this.reg(r);
    }
  }

  /**
   * Type t in a method: an entry of the module's table T, made once when
   * the module loads, for a class or Vector; the builtin types, and * as
   * null, as they are.
   */
  /** Whether typeRef writes type t as T[k], a class's instances; else a literal. */
  isClassRef(t: i32): bool {
    // What typeExpr writes as a literal stays one: *, the builtins it names
    // by string, and a type that is not a class's instances.
    const bt = t < 0 ? BUILTIN_Any : this.domain.builtin(t);
    return (
      t >= 0 &&
      (bt === BUILTIN_Other || bt === BUILTIN_Namespace) &&
      t !== this.domain.voidType &&
      this.domain.traits.kind[t] === TRAITS_Instance
    );
  }

  typeRef(t: i32): void {
    const out = this.out;
    if (!this.isClassRef(t)) {
      this.typeExpr(t);
      return;
    }

    if (!this.typeIndex.has(t)) {
      this.typeIndex.set(t, <u32>this.types.length);
      this.types.push(t);
    }

    out.text("T[");
    out.uint(this.typeIndex.get(t));
    out.text("]");
  }

  /**
   * A reference to type t for the runtime, by name, as types are known
   * across modules: null for *, a string for the builtin primitive types,
   * rt.cls(namespace, "Name") for a class, rt.vector(type) for Vector.<T>.
   */
  typeExpr(t: i32): void {
    const out = this.out;
    const domain = this.domain;
    const traits = domain.traits;
    if (t < 0) {
      out.text("null");
      return;
    }

    switch (domain.builtin(t)) {
      case BUILTIN_Int:
        out.text('"int"');
        return;
      case BUILTIN_Uint:
        out.text('"uint"');
        return;
      case BUILTIN_Number:
        out.text('"Number"');
        return;
      case BUILTIN_Boolean:
        out.text('"Boolean"');
        return;
      case BUILTIN_String:
        out.text('"String"');
        return;
      case BUILTIN_Object:
        out.text('"Object"');
        return;
      default:
        break;
    }

    if (t === domain.voidType) {
      out.text('"void"');
    } else if (traits.kind[t] !== TRAITS_Instance) {
      out.text("null");
    } else if (traits.param[t] !== TYPE_Any) {
      out.text("rt.vector(");
      this.typeExpr(traits.param[t]);
      out.text(")");
    } else {
      const index = traits.abc[t];
      const abc = domain.abcs[index];
      const pool = abc.pool;
      let mn = abc.instanceName[traits.owner[t]];
      if (pool.mnKind[mn] === C.CONSTANT_TypeName) {
        mn = pool.mnA[mn];
      }

      let ns = pool.mnA[mn];
      if (pool.mnKind[mn] === C.CONSTANT_Multiname) {
        ns = pool.nsSetMembers[pool.nsSetStart[ns]];
      }

      const name = domain.abcString[index][pool.mnB[mn]];
      out.text("rt.cls(");
      const id = domain.abcNs[index][ns];
      if (domain.nsType[id] === NS_Private && index === this.index) {
        // A private namespace is its module's own object, N[k], which its
        // definitions are bound in, not one made again from its URI.
        out.text("N[");
        out.uint(ns);
        out.text("]");
      } else {
        this.namespace(id);
      }

      out.text(", ");
      out.string(domain.stringPtr[name], domain.stringLength[name]);
      out.text(")");
    }
  }

  /** A non-private namespace by its interned id, as rt.ns(type, uri). */
  namespace(id: u32): void {
    const out = this.out;
    out.text("rt.ns(");
    out.uint(this.domain.nsType[id]);
    out.text(", ");
    this.uri(this.domain.nsUri[id]);
    out.text(")");
  }

  uri(id: u32): void {
    if (id === URI_None) {
      this.out.text("null");
      return;
    }

    const domain = this.domain;
    this.out.string(domain.stringPtr[id], domain.stringLength[id]);
  }

  /** "uri::name", or just the name in a public namespace with an empty URI. */
  qualified(ns: u32, name: u32): string {
    const domain = this.domain;
    const nameText = String.UTF8.decodeUnsafe(domain.stringPtr[name], domain.stringLength[name]);
    const uri = domain.nsUri[ns];
    if (uri === URI_None) {
      return nameText;
    }

    const uriText = String.UTF8.decodeUnsafe(domain.stringPtr[uri], domain.stringLength[uri]);
    return uriText.length ? `${uriText}::${nameText}` : nameText;
  }

  /** The qualified name of the class traits t belong to. */
  className(traits: TraitsTable, t: u32): string {
    const domain = this.domain;
    const index = traits.abc[t];
    const abc = domain.abcs[index];
    const pool = abc.pool;
    let mn = abc.instanceName[traits.owner[t]];
    if (pool.mnKind[mn] === C.CONSTANT_TypeName) {
      mn = pool.mnA[mn];
    }

    let ns = pool.mnA[mn];
    if (pool.mnKind[mn] === C.CONSTANT_Multiname) {
      ns = pool.nsSetMembers[pool.nsSetStart[ns]];
    }

    return this.qualified(domain.abcNs[index][ns], domain.abcString[index][pool.mnB[mn]]);
  }

  /** Pool string `index` as a JavaScript string literal. */
  string(index: u32): void {
    const pool = this.abc.pool;
    this.out.string(this.base + pool.stringStart[index], pool.stringLength[index]);
  }

  /**
   * A constant of default-value kind `kind`, index `value`, for a slot or
   * parameter of `type`; value 0 is the type's own default.
   */
  constant(value: u32, kind: u8, type: i32): void {
    const out = this.out;
    const pool = this.abc.pool;
    if (value === 0) {
      this.defaultOf(type);
      return;
    }

    switch (kind) {
      case 0x03:
        out.int(pool.ints[value]);
        return;
      case 0x04:
        out.uint(pool.uints[value]);
        return;
      case 0x06:
        out.double(pool.doubles[value]);
        return;
      case 0x01:
        this.string(value);
        return;
      case 0x0a:
        out.text("false");
        return;
      case 0x0b:
        out.text("true");
        return;
      case 0x0c:
        out.text("null");
        return;
      default:
        // A namespace, as the Namespace object it is to AS3.
        out.text("rt.namespace(N[");
        out.uint(value);
        out.text("])");
        return;
    }
  }

  /** The value a slot or parameter of `type` has before anything is stored. */
  defaultOf(type: i32): void {
    const out = this.out;
    switch (this.domain.builtin(type)) {
      case BUILTIN_Any:
        out.text("undefined");
        return;
      case BUILTIN_Int:
      case BUILTIN_Uint:
        out.text("0");
        return;
      case BUILTIN_Number:
        out.text("NaN");
        return;
      case BUILTIN_Boolean:
        out.text("false");
        return;
      default:
        out.text("null");
        return;
    }
  }
}
