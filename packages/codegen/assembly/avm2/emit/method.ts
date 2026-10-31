// Writes one method's IR as a JavaScript function whose blocks run in a
// dispatcher: `for (;;) switch (b) { case 0: ... }`. Registers are `let`
// variables named as the IR names them (l0, sc0, s0), and the runtime is
// `rt` in the enclosing module.
//
// Typed lowering starts simple: what the IR's types make certain is plain
// JavaScript (int arithmetic ends in `| 0`), anything else calls the
// runtime, which does what avmplus does at run time.

import { Output } from "../../output";
import { Abc } from "../abc/abc";
import * as C from "../abc/constants";
import * as ops from "../abc/opcodes";
import { IR_CheckNull, IR_Coerce, Ir } from "../ir/ir";
import { Domain } from "../link/domain";
import { BUILTIN_Float, BUILTIN_Int, BUILTIN_Number, BUILTIN_Uint, TYPE_Any } from "../link/traits";
import { CONSTANT, flowCopies, NONE, setsLocal } from "./copies";
import { floatLocals } from "./floats";
import { instruction } from "./instructions";
import { constant, poolString, typeRef } from "./refs";
import { SourceMap } from "./sourcemap";
import { analyze, branchTo, conditional, enclosed, node, terminates } from "./structure";
import { conversionType, convert, isStaticInit, keeps } from "./values";

/** The deepest structured code a method is given; one deeper keeps the dispatcher. */
export const MAX_NESTING: u32 = 500;
/** The length of the end of a reset, ` = void 0;\n`. */
const RESET_END: u32 = 11;

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
  /** Locals whose float identity is known at every use; their storage is a JS number. */
  unboxed: StaticArray<u8> = new StaticArray<u8>(0);
  /** Float stack values stay unboxed within a block, boxed only for a successor that needs them. */
  rawFloat: StaticArray<u8> = new StaticArray<u8>(0);
  rawTop: i32 = 0;
  rawResult: bool = false;
  unboxResult: bool = false;
  /** Which local scope registers hold with scopes, and how many are pushed. */
  scopeWith: StaticArray<u8> = new StaticArray<u8>(0);
  scopeDepth: u32 = 0;
  /** The classes and Vectors the method being written refers to, in the order its T holds them. */
  types: i32[] = [];
  /**
   * By type: its index in types, where its stamp is typeGen, the method's.
   * A new generation per method forgets them all: a Map's clear allocates
   * new tables, garbage the minimal runtime keeps until the call returns,
   * thousands of times in a module.
   */
  typeIndex: StaticArray<u32> = new StaticArray<u32>(0);
  typeStamp: StaticArray<u32> = new StaticArray<u32>(0);
  // From 1, as a fresh stamp is 0: an emitter that never called newTypes has seen no type.
  typeGen: u32 = 1;
  /** The name the method being written is given, a JavaScript identifier; "" for none. */
  functionName: string = "";
  /**
   * Whether the method being written can see the default XML namespace: a
   * lookup, call or construction that may reach XML, a closure or class it
   * makes, a with scope, or dxns. Only such a method checks, on entry, that
   * it runs with its scope's (see checkEntry).
   */
  seesDxns: bool = false;
  /** Whether the method reads its factory's scope chain, and its base class. */
  usesScope: bool = false;
  usesSup: bool = false;
  dxnsAt: u32 = 0;
  dxnsMarks: i32 = 0;
  /** The method's name in its own code, for running it again (see checkEntry). */
  entryName: string = "";
  /** The test its arguments' count fails, "" if none; how many it requires and takes, -1 for any. */
  argsTest: string = "";
  argsRequired: u32 = 0;
  argsMax: i32 = -1;
  /** The method being written: its ABC index and body. */
  current: u32 = 0;
  body: i32 = -1;
  /** Whether the method is a script's or class's initializer, which avmplus runs in its interpreter, not its JIT. */
  staticInit: bool = false;
  /** Where the block being written ends: the instruction after its last. */
  blockLast: u32 = 0;
  /**
   * The register whose null check the next instruction makes where it
   * first reads it, -1 if none; and where the check's statement goes
   * should it not read it.
   */
  pendingNull: i32 = -1;
  pendingRead: i32 = -1;
  pendingUntil: u32 = 0;
  pendingAt: u32 = 0;
  pendingMarks: i32 = 0;
  /** By register: whether it holds an int or uint made a Number by the coercion before it, in this block. */
  promoted: StaticArray<u8> = new StaticArray<u8>(0);
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
    this.staticInit = isStaticInit(this, method);
    if (<u32>this.regType.length < ir.frameSize) {
      this.regType = new StaticArray<i32>(ir.frameSize);
    }

    if (<u32>this.scopeWith.length < ir.maxScope) {
      this.scopeWith = new StaticArray<u8>(ir.maxScope);
    }

    if (<u32>this.copyOf.length < ir.frameSize) {
      this.copyOf = new StaticArray<i32>(ir.frameSize);
      this.copiedBy = new StaticArray<u32>(ir.frameSize);
      this.promoted = new StaticArray<u8>(ir.frameSize);
      this.rawFloat = new StaticArray<u8>(ir.frameSize);
    }

    for (let r: u32 = 0; r < ir.frameSize; r++) {
      this.copyOf[r] = NONE;
    }

    this.recount();
    if (<u32>this.checked.length < ir.frameSize) {
      this.checked = new StaticArray<u8>(ir.frameSize);
    }

    floatLocals(this);

    const count = traits.paramCount[global];
    // Named, for stacks and profiles: a name its code never binds.
    const name = this.functionName.length ? this.functionName : "$method";
    out.text(`function ${name}(`);
    for (let p: u32 = 1; p <= count; p++) {
      out.text(p > 1 ? ", p" : "p");
      out.uint(p);
    }

    const flags = this.abc.methodFlags[method];
    if (flags & C.METHOD_NeedRest) {
      out.text(count ? ", ...rest" : "...rest");
    }

    out.text(") {\n");
    this.dxnsAt = out.length;
    this.dxnsMarks = this.map.count;
    this.entryName = name;
    this.seesDxns = false;
    this.usesScope = false;
    this.usesSup = false;
    this.prologue(method, global, flags);
    // A method that sets the default XML namespace gives its caller's
    // back when it returns or throws.
    const dxns = (flags & C.METHOD_SetsDxns) !== 0;
    if (dxns) {
      out.text("const $dxns = rt.enterDxns();\ntry {\n");
    }

    const handled = ir.handlerCount > 0;
    if (handled) {
      this.regions();
    }

    this.debugLines();
    flowCopies(this);
    const marks = this.map.count;

    // Structured control flow where the graph is reducible and each
    // handler's try encloses the code it covers; else the dispatcher.
    if (analyze(this)) {
      const start = out.length;
      if (handled) {
        out.text("let t = 0;\n");
      }

      this.structured = true;
      this.unenclosed = false;
      this.tryStack.length = 0;
      node(this, 0);
      this.structured = false;
      if (!this.unenclosed) {
        this.leaveDxns(dxns);
        out.text("}");
        this.checkEntry();
        return;
      }

      out.length = start;
      this.map.truncate(marks);
    }

    if (handled) {
      out.text("let b = 0, t = 0;\nfor (;;) try { switch (b) {\n");
    } else {
      out.text("let b = 0;\nfor (;;) switch (b) {\n");
    }

    for (let k: u32 = 0; k < ir.blockCount; k++) {
      this.block(k);
    }

    // The verifier proved every block ends; a dispatcher still needs an end.
    out.text("default: throw rt.unreachable();\n}");
    if (handled) {
      out.text(" } catch (e) {\n");
      this.handlers();
      out.text("}");
    }

    out.text("\n");
    this.leaveDxns(dxns);
    out.text("}");
    this.checkEntry();
  }

  /**
   * The checks on entry, written first in the method once its code shows
   * which it needs. Its arguments' count, as MethodEnv's argcOk, whose
   * error the module's ac throws (see ModuleEmitter.module). And a
   * method that can see the default XML namespace runs with the one of the
   * scope it was made in ($dx, see ModuleEmitter.factory), not its
   * caller's: else it runs again with it, and the caller's is back after.
   * With both, one test, as V8 counts each against inlining: rt.enter
   * throws the count's error or runs the method again, which counts again.
   */
  checkEntry(): void {
    const args = this.argsTest;
    const dxns = "rt.defaultXmlNamespace !== $dx";
    let check = "";
    if (this.seesDxns && args.length) {
      check = `if (${args} || ${dxns}) return rt.enter($dx, ${this.entryName}, this, arguments, ${this.argsRequired}, ${this.argsMax});\n`;
    } else if (this.seesDxns) {
      check = `if (${dxns}) return rt.callInDxns($dx, ${this.entryName}, this, arguments);\n`;
    } else if (args.length) {
      check = `if (${args}) ac(${this.argsRequired}, arguments.length);\n`;
    } else {
      return;
    }

    this.out.insert(this.dxnsAt, check);
    this.map.shift(this.dxnsMarks, <u32>check.length);
  }

  /** The end of a method that sets the default XML namespace: its caller's back. */
  leaveDxns(dxns: bool): void {
    if (dxns) {
      this.out.text("} finally {\nrt.defaultXmlNamespace = $dxns;\n}\n");
    }
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
    out.text("const x = rt.caught(e);\nswitch (t) {\n");
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
          out.text("case ");
          out.uint(r);
          out.text(":\n");
          first = false;
        }

        const type = ir.handlerType[h];
        if (type >= 0) {
          out.text("if (rt.catches(x, ");
          typeRef(this, type);
          out.text(")) ");
        }

        out.text("{ ");
        this.regName(exception);
        out.text(" = x; ");
        this.goto(ir.handlerBlock[h]);
        out.text(" }\n");
      }

      if (!first) {
        out.text("break;\n");
      }
    }

    out.text("}\nthrow e;\n");
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
    // requires, or more than it declares unless it takes the rest; both, as
    // one unsigned comparison.
    const required = count - traits.optionalCount[global];
    const extra = this.domain.allowsExtraArgs(global);
    this.argsRequired = required;
    this.argsMax = extra ? -1 : <i32>count;
    if (required > 0 && !extra) {
      this.argsTest =
        required === count
          ? `arguments.length !== ${count}`
          : `arguments.length - ${required} >>> 0 > ${count - required}`;
    } else if (required > 0) {
      this.argsTest = `arguments.length < ${required}`;
    } else if (!extra) {
      this.argsTest = `arguments.length > ${count}`;
    } else {
      this.argsTest = "";
    }

    // var, not let: V8 starts a frame's registers undefined, where each
    // let is initialized with bytecode of its own, which counts against inlining.
    out.text("var l0 = this");
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
        if (this.unboxed[p]) {
          out.text("rt.toNumber(");
        }

        constant(this, abc.optionalValue[o], abc.optionalKind[o], type);
        if (this.unboxed[p]) {
          out.text(")");
        }

        out.text(" : ");
      }

      convert(this, "p", <i32>p, type, TYPE_Any, this.unboxed[p] !== 0);
    }

    let local = count + 1;
    if (flags & C.METHOD_NeedRest) {
      out.text(", l");
      out.uint(local++);
      out.text(" = rt.array(rest)");
    } else if (flags & C.METHOD_NeedArguments) {
      // With the function itself, for arguments.callee.
      out.text(", l");
      out.uint(local++);
      out.text(" = rt.arguments(arguments, ");
      out.text(this.functionName.length ? this.functionName : "$method");
      out.text(")");
    }

    for (let r = local; r < ir.frameSize; r++) {
      out.text(", ");
      this.regName(<i32>r);
    }

    out.text(";\n");
  }

  /** Write block k: its case label, then its instructions, following register types. */
  block(k: u32): void {
    const out = this.out;
    out.text("case ");
    out.uint(k);
    out.text(":\n");
    this.blockBody(k);
  }

  /** Block k's instructions, following register types from its entry state. */
  blockBody(k: u32): void {
    const out = this.out;
    const ir = this.ir;
    const entry = k * ir.frameSize;
    this.clearRaw(0);
    this.resetEnd = -1;
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
    // Every way in wrote the copies the block does not know. A block written
    // in place has one way in, the code before it, and keeps what that
    // checked; avmplus' JIT knows no value as it was made from there, a
    // block in place or not.
    const base = <i32>ir.localCount;
    const slots = <i32>ir.frameSize - base;
    const row = <i32>k * slots;
    for (let s = 0; s < slots; s++) {
      this.copyOf[base + s] = this.copyIn[row + s];
    }

    this.recount();

    for (let r: u32 = 0; r < ir.frameSize; r++) {
      this.promoted[r] = 0;
    }

    if (!this.inPlace) {
      for (let r: u32 = 0; r < ir.frameSize; r++) {
        this.checked[r] = 0;
      }
    }

    this.inPlace = false;
    this.pendingNull = -1;
    this.file = this.blockFile[k];
    this.line = this.blockLine[k];
    this.mark();
    for (let i = ir.blockFirst[k]; i < last; i++) {
      const op = ir.op[i];
      const dst = ir.dst[i];
      // A branch's code written in place is another block's: this one's end, for each instruction.
      this.blockLast = last;
      const promotes = this.promotes(i);
      // What the instruction writes, other than stack registers, is copied
      // first by the stack registers copying it, but for those it takes:
      // it reads them before it writes. And what a branch leaves on the
      // stack is written, for the block it goes to.
      const frame = <i32>ir.frameSize;
      const pops = this.stackDiscipline(op) && ir.srcCount[i] > 0 && ir.src[i] >= stack;
      if (dst >= 0 && !this.keptAt(i, this.regType[dst])) {
        // Above a push nothing is live to copy it.
        const push = dst >= stack && this.stackDiscipline(op);
        this.copyAll(dst, pops ? ir.src[i] : push ? dst : frame);
      }

      if (op === ops.OP_hasnext2) {
        this.copyAll(<i32>ir.a[i], frame);
        this.copyAll(<i32>ir.b[i], frame);
      } else if (op === ops.OP_popscope || op === ops.OP_swap) {
        this.copyAll(ir.src[i], frame);
      } else if (conditional(op)) {
        this.boxRaw(ir.src[i]);
        this.copyFor(ir.a[i], ir.src[i]);
      } else if (op === ops.OP_lookupswitch) {
        this.boxRaw(ir.src[i]);
        this.copyFor(ir.a[i], ir.src[i]);
        for (let c: u32 = 0; c <= <u32>ir.c[i]; c++) {
          this.copyFor(ir.cases[ir.b[i] + c], ir.src[i]);
        }
      } else if (op === ops.OP_jump) {
        this.boxRaw(frame);
        this.copyFor(ir.a[i], frame);
      }

      // A value the next instruction only moves to a local or scope goes
      // there straight, if the instruction assigns it; one it duplicates to
      // set a local goes to the local, and stays on the stack as its copy.
      // Conversions between that change nothing write nothing either.
      this.target = -1;
      let moves: u32 = 0;
      let duplicated = false;
      if (dst >= stack && op !== ops.OP_hasnext2) {
        let n = i + 1;
        let type = ir.type[i];
        while (n < last) {
          if (
            this.domain.floatType >= 0 &&
            type === this.domain.floatType &&
            this.debugRecord(ir.op[n])
          ) {
            n++;
          } else if (ir.dst[n] === dst && this.keptAt(n, type)) {
            type = ir.type[n++];
          } else {
            break;
          }
        }

        if (n < last && ir.src[n] === dst) {
          const next = ir.op[n];
          if (setsLocal(next) || next === ops.OP_pushscope) {
            moves = n - i;
          } else if (next === ops.OP_dup) {
            let set = n + 1;
            while (set < last && this.domain.floatType >= 0 && type === this.domain.floatType) {
              if (this.debugRecord(ir.op[set])) {
                set++;
              } else if (ir.dst[set] === dst + 1 && this.keptAt(set, type)) {
                type = ir.type[set++];
              } else {
                break;
              }
            }

            if (
              set < last &&
              setsLocal(ir.op[set]) &&
              ir.src[set] === dst + 1 &&
              (set === n + 1 || this.unboxedLocal(ir.dst[set]))
            ) {
              moves = set - i;
              duplicated = true;
            }
          }
        }
      }

      if (moves) {
        // After them, the stack is as far as dst: what is there on, the
        // instruction takes.
        this.target = ir.dst[i + moves];
        this.copyAll(this.target, dst);
      }

      if (handled) {
        const region = this.regionOf(ir.pc[i]);
        if (region !== this.region) {
          out.text("t = ");
          out.int(region);
          out.text(";\n");
          this.region = region;
          if (this.structured && !enclosed(this, region)) {
            this.unenclosed = true;
          }
        }
      }

      // A branch's own target, written in place, sinks its own values: only
      // an instruction given a local here can have assigned it.
      const sinking = this.target;
      this.kept = false;
      this.sunk = false;
      instruction(this, i);
      if (this.pendingNull >= 0 && i >= this.pendingUntil) {
        this.unpend();
      }

      this.unchecks(i);
      this.target = -1;
      if (conditional(op) || op === ops.OP_jump || op === ops.OP_lookupswitch) {
        this.clearRaw(0);
      } else if (op === ops.OP_swap) {
        this.rawFloat[ir.src[i]] = 0;
        this.rawFloat[ir.src[i] + 1] = 0;
      } else if (dst >= stack && !this.kept) {
        this.rawFloat[dst] = this.rawResult ? 1 : 0;
        if (this.rawResult) {
          this.rawTop = max(this.rawTop, dst + 1);
        }
      }

      if (op === ops.OP_swap) {
        // Its one destination is the new top, whose type the IR gives; the
        // register below it now holds what the top did, and its type.
        const x = ir.src[i];
        this.regType[x] = this.regType[x + 1];
      }

      if (dst >= 0) {
        this.regType[dst] = ir.type[i];
        this.promoted[dst] = promotes ? 1 : 0;
      }

      if (op === ops.OP_swap) {
        this.promoted[ir.src[i]] = 0;
        this.promoted[ir.src[i] + 1] = 0;
      } else if (op === ops.OP_hasnext2) {
        this.promoted[ir.a[i]] = 0;
        this.promoted[ir.b[i]] = 0;
      }

      if (this.target >= 0) {
        this.promoted[this.target] = 0;
      }

      if (sinking >= 0 && this.sunk) {
        // The setlocal or pushscope is written: its stack register was
        // never set, and the stack is as far as it, or as far as the copy.
        for (let j = i + 1; j <= i + moves; j++) {
          const to = ir.dst[j];
          if (to >= 0) {
            this.promoted[to] = this.promotes(j) ? 1 : 0;
            this.regType[to] = ir.type[j];
          } else if (ir.op[j] === ops.OP_debugfile) {
            this.file = <i32>ir.a[j];
          } else if (ir.op[j] === ops.OP_debugline) {
            this.line = ir.a[j];
            this.mark();
          }
        }

        i += moves;
        this.setCopy(sinking, NONE);
        if (ir.op[i] === ops.OP_pushscope) {
          this.scopeWith[this.scopeDepth++] = 0;
        }

        if (duplicated) {
          this.setCopy(dst, sinking);
          this.uncopy(dst + 1);
        } else {
          this.uncopy(dst);
        }

        continue;
      }

      if (conditional(op) || op === ops.OP_lookupswitch) {
        // What the branch took is gone.
        this.uncopy(ir.src[i]);
      } else if (op === ops.OP_swap) {
        this.setCopy(ir.src[i], NONE);
        this.setCopy(ir.src[i] + 1, NONE);
      } else if (op === ops.OP_popscope) {
        this.setCopy(ir.src[i], NONE);
      } else {
        if (dst >= 0 && !this.kept) {
          this.setCopy(dst, NONE);
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

    if (!terminates(this, k) && k + 1 < ir.blockCount) {
      this.boxRaw(<i32>ir.frameSize);
      this.copyFor(k + 1, <i32>ir.frameSize);
    }
  }

  /**
   * Whether instruction i, reading register `read`, only makes its
   * destination a copy, as flowCopies knows it: a getlocal, dup,
   * getscopeobject or nip to a stack register, of what it reads or what
   * that copies; a pushscope of a local or scope.
   */
  copies(i: u32, read: i32): bool {
    const ir = this.ir;
    const stack = <i32>(ir.localCount + ir.maxScope);
    const dst = ir.dst[i];
    if (dst < <i32>ir.localCount) {
      return false;
    }

    const copy = read < <i32>ir.localCount ? NONE : this.copyOf[read];
    const from = copy === NONE ? read : copy;
    if (dst < stack && (from < 0 || from >= stack)) {
      return false;
    }

    // Its own value again, as a nip of a dup: as it was.
    this.setCopy(dst, from === dst ? NONE : from);
    this.kept = true;
    return true;
  }

  private debugRecord(op: u16): bool {
    return op === ops.OP_debugfile || op === ops.OP_debugline || op === ops.OP_debug;
  }

  /** Whether instruction i makes an int or uint a Number, as LIR's i2d and ui2d (see wraps). */
  private promotes(i: u32): bool {
    const ir = this.ir;
    const dst = ir.dst[i];
    if (ir.op[i] !== IR_Coerce || dst !== ir.src[i]) {
      return false;
    }

    const bt = this.builtinOf(dst);
    return (
      this.domain.builtin(ir.c[i]) === BUILTIN_Number && (bt === BUILTIN_Int || bt === BUILTIN_Uint)
    );
  }

  /** Whether instruction i is a conversion in place that writes nothing, its value of type `from` being one already. */
  private keptAt(i: u32, from: i32): bool {
    const ir = this.ir;
    const op = ir.op[i];
    if (ir.dst[i] !== ir.src[i] || ir.srcCount[i] !== 1) {
      return false;
    }

    if (op === IR_Coerce) {
      return keeps(this, ir.c[i], from);
    }

    return op < 256 && keeps(this, conversionType(this, <u8>op, i), from);
  }

  /**
   * Before a branch to block t: write the copies below `limit` that t
   * needs and does not know, as flowCopies found its entry.
   */
  private copyFor(t: u32, limit: i32): void {
    const ir = this.ir;
    const base = <i32>ir.localCount;
    const stack = base + <i32>ir.maxScope;
    const end = min(min(limit, <i32>ir.frameSize), this.copyTop);
    const row = <i32>t * (<i32>ir.frameSize - base) - base;
    const scopes = base + <i32>ir.blockScope[t];
    const depth = stack + <i32>ir.blockStack[t];
    for (let r = base; r < end; r++) {
      const copy = this.copyOf[r];
      if (copy === NONE || this.copyIn[row + r] === copy) {
        continue;
      }

      if (r < stack ? r < scopes : r < depth) {
        this.writeCopy(r);
      }
    }
  }

  /**
   * Whether op takes its stack operands from the top and pushes what it
   * gives there, as an instruction of a stack machine: all but a coercion
   * or null check in place, and swap.
   */
  private stackDiscipline(op: u16): bool {
    return op !== IR_Coerce && op !== IR_CheckNull && op !== ops.OP_swap;
  }

  /** Write the scope and stack registers below `limit` that copy register w, before w changes. */
  private copyAll(w: i32, limit: i32): void {
    if (this.copiedBy[w] === 0) {
      return;
    }

    const ir = this.ir;
    const end = min(min(limit, <i32>ir.frameSize), this.copyTop);
    for (let r = <i32>ir.localCount; r < end; r++) {
      if (this.copyOf[r] === w) {
        this.writeCopy(r);
      }
    }
  }

  /**
   * A copy written may be the register of a pending null check: the
   * instruction then reads the copy, as unpend would read what pendingRead
   * names, both the value when it was checked.
   */
  private writeCopy(r: i32): void {
    const out = this.out;
    const from = this.copyOf[r];
    this.setCopy(r, NONE);
    this.checked[r] = 0;
    this.regName(r);
    out.text(" = ");
    this.copied(from);
    out.text(";\n");
    this.rawFloat[r] = 0;
  }

  /** Forget the null checks of what instruction i wrote. */
  private unchecks(i: u32): void {
    const ir = this.ir;
    const op = ir.op[i];
    if (ir.dst[i] >= 0) {
      this.checked[ir.dst[i]] = 0;
    }

    if (this.target >= 0) {
      this.checked[this.target] = 0;
    }

    if (op === ops.OP_hasnext2) {
      this.checked[ir.a[i]] = 0;
      this.checked[ir.b[i]] = 0;
    } else if (op === ops.OP_swap) {
      this.checked[ir.src[i]] = 0;
      this.checked[ir.src[i] + 1] = 0;
    }
  }

  /** What a copy reads: a register, or the constant instruction `CONSTANT - copy` pushed. */
  private copied(copy: i32, boxed: bool = true): void {
    if (copy >= 0) {
      const wrap = boxed && (this.unboxedLocal(copy) || this.rawFloat[copy] !== 0);
      if (wrap) {
        this.out.text("rt.float(");
      }

      this.regName(copy);
      if (wrap) {
        this.out.text(")");
      }

      return;
    }

    const out = this.out;
    const pool = this.abc.pool;
    const i = <u32>(CONSTANT - copy);
    const a = this.ir.a[i];
    switch (this.ir.op[i]) {
      case ops.OP_pushbyte:
      case ops.OP_pushshort:
        this.literal(<f64>(<i32>a), false);
        break;
      case ops.OP_pushint:
        this.literal(<f64>pool.ints[a], false);
        break;
      case ops.OP_pushuint:
        out.uint(pool.uints[a]);
        break;
      case ops.OP_pushdouble:
        this.literal(pool.doubles[a], true);
        break;
      case ops.OP_pushfloat:
        out.text("rt.float(");
        this.literal(pool.floats[a], true);
        out.text(")");
        break;
      case ops.OP_pushnan:
        out.text("NaN");
        break;
      case ops.OP_pushstring:
        poolString(this, a);
        break;
      case ops.OP_pushtrue:
        out.text("true");
        break;
      case ops.OP_pushfalse:
        out.text("false");
        break;
      case ops.OP_pushnull:
        out.text("null");
        break;
      default:
        out.text("void 0");
    }
  }

  /** A number read as an operand, a negative one in parentheses, so that `-` before it is no decrement. */
  private literal(d: f64, double: bool): void {
    const out = this.out;
    const negative = d < 0 || (d === 0 && 1 / d < 0);
    if (negative) {
      out.byte(0x28); // (
    }

    if (double) {
      out.double(d);
    } else {
      out.int(<i64>d);
    }

    if (negative) {
      out.byte(0x29); // )
    }
  }

  /** Forget every copy from register `from` up: none is needed. */
  private uncopy(from: i32): void {
    this.clearRaw(from);
    const top = min(this.copyTop, <i32>this.ir.frameSize);
    for (let r = from; r < top; r++) {
      this.setCopy(r, NONE);
    }

    if (from < this.copyTop) {
      this.copyTop = max(from, 0);
    }
  }

  /** Register r now a copy of `copy`, or of nothing for NONE: copyTop and copiedBy kept. */
  setCopy(r: i32, copy: i32): void {
    const old = this.copyOf[r];
    if (old >= 0) {
      this.copiedBy[old]--;
    }

    this.copyOf[r] = copy;
    if (copy >= 0) {
      this.copiedBy[copy]++;
    }

    if (copy !== NONE && r >= this.copyTop) {
      this.copyTop = r + 1;
    }
  }

  /** copyTop and copiedBy made again from copyOf, as a block's entry or a restore sets it whole. */
  recount(): void {
    const frame = <i32>this.ir.frameSize;
    let top = 0;
    for (let r = 0; r < frame; r++) {
      this.copiedBy[r] = 0;
    }

    for (let r = 0; r < frame; r++) {
      const copy = this.copyOf[r];
      if (copy >= 0) {
        this.copiedBy[copy]++;
      }

      if (copy !== NONE) {
        top = r + 1;
      }
    }

    this.copyTop = top;
  }

  /** The builtin type of register r's value now. */
  builtinOf(r: i32): u8 {
    return this.domain.builtin(this.regType[r]);
  }

  /** A new method's types: none yet. */
  newTypes(): void {
    this.types.length = 0;
    if (++this.typeGen === 0) {
      // Every 2^32 methods, the stamps of the first generation would match again.
      const stamp = this.typeStamp;
      for (let k = 0; k < stamp.length; k++) {
        stamp[k] = 0;
      }

      this.typeGen = 1;
    }
  }

  /** Class or Vector type t's index in the method's T, given it the next if new. */
  typeSlot(t: i32): u32 {
    // t is a type of the domain's (isClassRef read its kind), which may
    // have more since the tables were sized.
    const count = this.domain.traits.kind.length;
    if (this.typeStamp.length < count) {
      const size = max(count, this.typeStamp.length * 2);
      const index = new StaticArray<u32>(size);
      const stamp = new StaticArray<u32>(size);
      memory.copy(
        changetype<usize>(index),
        changetype<usize>(this.typeIndex),
        this.typeIndex.length << 2,
      );
      memory.copy(
        changetype<usize>(stamp),
        changetype<usize>(this.typeStamp),
        this.typeStamp.length << 2,
      );
      this.typeIndex = index;
      this.typeStamp = stamp;
    }

    if (this.typeStamp[t] !== this.typeGen) {
      this.typeStamp[t] = this.typeGen;
      this.typeIndex[t] = <u32>this.types.length;
      this.types.push(t);
    }

    return this.typeIndex[t];
  }

  /** A space, but at the start of a line, as after a block written in place. */
  space(): void {
    if (this.out.bytes[this.out.length - 1] !== 0x0a) {
      this.out.byte(0x20);
    }
  }

  /** Register r as read: what it copies, if it is a copy; null checked, if the check is pending. */
  reg(r: i32): void {
    if (r === this.pendingNull) {
      this.pendingNull = -1;
      this.checkedRead(r);
      return;
    }

    this.read(r);
  }

  /** Register r as read before a `.`; a constant in parentheses, as `void 0.x` does not parse. */
  member(r: i32): void {
    if (r === this.pendingNull || this.copyOf[r] <= CONSTANT) {
      this.out.byte(0x28); // (
      this.reg(r);
      this.out.byte(0x29); // )
      return;
    }

    this.read(r);
  }

  /**
   * Register r read, null checked: `r ?? nn(r)`, nn throwing the error for
   * null or undefined (see ModuleEmitter.module); only a null or undefined
   * r reads it twice.
   */
  checkedRead(r: i32): void {
    this.read(r);
    this.out.text(" ?? nn(");
    this.read(r);
    this.out.text(")");
  }

  /**
   * The null check pending for an instruction that did not read the
   * register, as a statement before it.
   */
  unpend(): void {
    const name = this.nameOf(this.pendingRead);
    this.pendingNull = -1;
    const check = `${name} ?? nn(${name});\n`;
    this.out.insert(this.pendingAt, check);
    this.map.shift(this.pendingMarks, <u32>check.length);
  }

  /** Register `at`'s name, as text. */
  nameOf(at: i32): string {
    const ir = this.ir;
    const local = <i32>ir.localCount;
    if (at < local) {
      return `l${at}`;
    }

    if (at < local + <i32>ir.maxScope) {
      return `sc${at - local}`;
    }

    return `s${at - local - <i32>ir.maxScope}`;
  }

  /** Register r as read: what it copies, if it is a copy. */
  read(r: i32): void {
    const copy = this.copyOf[r];
    if (copy === NONE) {
      this.copied(r);
    } else {
      this.copied(copy);
    }
  }

  unboxedLocal(r: i32): bool {
    return r >= 0 && r < <i32>this.ir.localCount && this.unboxed[r] !== 0;
  }

  unboxedTarget(i: u32): bool {
    const r = this.target >= 0 ? this.target : this.ir.dst[i];
    return (
      this.unboxedLocal(r) ||
      (r >= <i32>(this.ir.localCount + this.ir.maxScope) &&
        this.domain.floatType >= 0 &&
        this.ir.type[i] === this.domain.floatType)
    );
  }

  private clearRaw(from: i32): void {
    for (let r = max(from, 0); r < this.rawTop; r++) {
      this.rawFloat[r] = 0;
    }

    this.rawTop = min(this.rawTop, max(from, 0));
  }

  private boxRaw(limit: i32): void {
    for (let r = <i32>(this.ir.localCount + this.ir.maxScope); r < min(limit, this.rawTop); r++) {
      if (this.rawFloat[r]) {
        if (this.copyOf[r] === NONE) {
          this.regName(r);
          this.out.text(" = rt.float(");
          this.regName(r);
          this.out.text(");\n");
        }

        this.rawFloat[r] = 0;
      }
    }
  }

  /** A known float's payload, avoiding a wrapper when it is a local or its copy. */
  numberReg(r: i32): void {
    const copy = this.copyOf[r];
    if (copy <= CONSTANT && this.ir.op[CONSTANT - copy] === ops.OP_pushfloat) {
      this.literal(this.abc.pool.floats[this.ir.a[CONSTANT - copy]], true);
    } else if (
      this.unboxedLocal(copy === NONE ? r : copy) ||
      (copy >= NONE && this.rawFloat[copy === NONE ? r : copy] !== 0)
    ) {
      this.copied(copy === NONE ? r : copy, false);
    } else if (this.builtinOf(r) === BUILTIN_Float) {
      this.out.text("rt.toNumber(");
      this.reg(r);
      this.out.text(")");
    } else {
      this.reg(r);
    }
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
  assign(i: u32, number: bool = false): void {
    if (this.target >= 0) {
      this.regName(this.target);
      this.sunk = true;
    } else {
      this.regName(this.ir.dst[i]);
    }

    this.out.text(" = ");
    this.unboxResult = !number && this.unboxedTarget(i);
    this.rawResult =
      this.target < 0 &&
      this.ir.dst[i] >= <i32>(this.ir.localCount + this.ir.maxScope) &&
      this.domain.floatType >= 0 &&
      this.ir.type[i] === this.domain.floatType;
    if (this.unboxResult) {
      this.out.text("rt.toNumber(");
    }
  }

  src(i: u32, k: u32): i32 {
    return this.ir.src[i] + <i32>k;
  }

  /** `b = n; continue;` to block n. */
  goto(block: u32): void {
    if (this.structured) {
      branchTo(this, block);
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
   * The register or constant each scope and stack register copies, NONE if
   * none: a copy is not written until something needs the register itself,
   * so reading it reads what it copies.
   */
  copyOf: StaticArray<i32> = new StaticArray<i32>(0);
  /**
   * A register from which up none is a copy, so that what forgets or writes
   * the copies looks at those below it: a static initializer that pushes
   * thousands of values looked at the whole frame for each, and spent most
   * of its compile there.
   */
  copyTop: i32 = 0;
  /** How many scope and stack registers copy each register: a write to one none copies has none to write first. */
  copiedBy: StaticArray<u32> = new StaticArray<u32>(0);
  /** Each block's copies on entry, and flowCopies' scratch (see copies.ts). */
  copyIn: StaticArray<i32> = new StaticArray<i32>(0);
  flow: StaticArray<i32> = new StaticArray<i32>(0);
  dirty: StaticArray<u8> = new StaticArray<u8>(0);
  /** By register: whether it was checked not null since it was last written, in the block being written. */
  checked: StaticArray<u8> = new StaticArray<u8>(0);
  /** Whether the block about to be written is written in place, after the one way into it. */
  inPlace: bool = false;
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
  /** Where the last reset written ends, -1 if none can be joined, and the source map's marks then; whether one is being written. */
  resetEnd: i32 = -1;
  resetMarks: i32 = 0;
  resets: bool = false;

  /**
   * `r = void 0`, as a kill or popscope leaves a register; one right after
   * another such, with nothing written or marked between, joins it as
   * `a = r = void 0`, one statement.
   */
  reset(r: i32): void {
    const out = this.out;
    if (<i32>out.length === this.resetEnd && this.map.count === this.resetMarks) {
      out.length -= RESET_END;
      out.text(" = ");
    }

    this.regName(r);
    out.text(" = void 0");
    this.resets = true;
  }
}
