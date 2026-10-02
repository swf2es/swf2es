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
import { Domain } from "../link/domain";
import {
  BUILTIN_Any,
  BUILTIN_Boolean,
  BUILTIN_Int,
  BUILTIN_Namespace,
  BUILTIN_Number,
  BUILTIN_Object,
  BUILTIN_String,
  BUILTIN_Uint,
  TYPE_Any,
} from "../link/traits";
import { Output } from "./output";
import { constant, isClassRef, poolString, typeRef } from "./refs";
import { SourceMap } from "./sourcemap";
import { analyze, branchTo, conditional, enclosed, node, terminates } from "./structure";

/** The deepest structured code a method is given; one deeper keeps the dispatcher. */
export const MAX_NESTING: u32 = 500;
/** No type: a conversion, convert_s or convert_o, that always calls the runtime. */
const CONVERTS: i32 = -2;
/** copyOf of a stack register that holds a constant: CONSTANT - the instruction that pushed it. */
const CONSTANT: i32 = -2;

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
  /**
   * Whether the method being written can see the default XML namespace: a
   * lookup, call or construction that may reach XML, a closure or class it
   * makes, a with scope, or dxns. Only such a method checks, on entry, that
   * it runs with its scope's (see checkEntry).
   */
  seesDxns: bool = false;
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
    this.staticInit = this.isStaticInit(method);
    if (<u32>this.regType.length < ir.frameSize) {
      this.regType = new StaticArray<i32>(ir.frameSize);
    }

    if (<u32>this.scopeWith.length < ir.maxScope) {
      this.scopeWith = new StaticArray<u8>(ir.maxScope);
    }

    if (<u32>this.copyOf.length < ir.frameSize) {
      this.copyOf = new StaticArray<i32>(ir.frameSize);
      this.promoted = new StaticArray<u8>(ir.frameSize);
    }

    for (let r: u32 = 0; r < ir.frameSize; r++) {
      this.copyOf[r] = -1;
    }

    if (<u32>this.checked.length < ir.frameSize) {
      this.checked = new StaticArray<u8>(ir.frameSize);
    }

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
    this.prologue(method, global, flags);
    // A method that sets the default XML namespace gives its caller's
    // back when it returns or throws.
    const dxns = (flags & C.METHOD_SetsDxns) !== 0;
    if (dxns) {
      out.text("  const $dxns = rt.enterDxns();\n  try {\n");
    }

    const handled = ir.handlerCount > 0;
    if (handled) {
      this.regions();
    }

    this.debugLines();
    const marks = this.map.count;

    // Structured control flow where the graph is reducible and each
    // handler's try encloses the code it covers; else the dispatcher.
    if (analyze(this)) {
      const start = out.length;
      if (handled) {
        out.text("  let t = 0;\n");
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

    out.text("\n");
    this.leaveDxns(dxns);
    out.text("}");
    this.checkEntry();
  }

  /**
   * The checks on entry, written first in the method once its code shows
   * which it needs. Its arguments' count, as MethodEnv's argcOk. And a
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
      check = `  if (${args} || ${dxns}) return rt.enter($dx, ${this.entryName}, this, arguments, ${this.argsRequired}, ${this.argsMax});\n`;
    } else if (this.seesDxns) {
      check = `  if (${dxns}) return rt.callInDxns($dx, ${this.entryName}, this, arguments);\n`;
    } else if (args.length) {
      check = `  if (${args}) throw rt.argumentCountError(${this.argsRequired}, arguments.length);\n`;
    } else {
      return;
    }

    this.out.insert(this.dxnsAt, check);
    this.map.shift(this.dxnsMarks, <u32>check.length);
  }

  /** Whether register r may hold XML or an XMLList: untyped, Object, or either. */
  mayBeXml(r: i32): bool {
    const type = this.regType[r];
    const bt = this.domain.builtin(type);
    return (
      bt === BUILTIN_Any ||
      bt === BUILTIN_Object ||
      type === this.domain.xmlType ||
      type === this.domain.xmlListType
    );
  }

  /**
   * Note whether instruction i, `op` on register `src`, can see the default
   * XML namespace. A call or construction the linker did not bind may reach
   * XML's, XMLList's or QName's class through any name, as a class held in
   * a variable, so each counts; a call of a value, when the value may be a
   * class.
   */
  notesDxns(op: u16, src: i32): void {
    switch (op) {
      case ops.OP_getproperty:
      case ops.OP_setproperty:
      case ops.OP_initproperty:
      case ops.OP_deleteproperty:
      case ops.OP_getdescendants:
        if (this.mayBeXml(src)) {
          this.seesDxns = true;
        }

        break;
      case ops.OP_in:
        if (this.mayBeXml(src + 1)) {
          this.seesDxns = true;
        }

        break;
      case ops.OP_call:
        if (this.mayBeXml(src) || this.regType[src] === this.domain.classType) {
          this.seesDxns = true;
        }

        break;
      case ops.OP_callproperty:
      case ops.OP_callproplex:
      case ops.OP_callpropvoid:
      case ops.OP_constructprop:
      case ops.OP_construct:
      case ops.OP_newfunction:
      case ops.OP_newclass:
      case ops.OP_pushwith:
      case ops.OP_dxns:
      case ops.OP_dxnslate:
        this.seesDxns = true;
        break;
    }
  }

  /** The end of a method that sets the default XML namespace: its caller's back. */
  leaveDxns(dxns: bool): void {
    if (dxns) {
      this.out.text("  } finally {\n    rt.defaultXmlNamespace = $dxns;\n  }\n");
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
    this.argsRequired = required;
    this.argsMax = extra ? -1 : <i32>count;
    if (required > 0 && !extra) {
      this.argsTest =
        required === count
          ? `arguments.length !== ${count}`
          : `arguments.length < ${required} || arguments.length > ${count}`;
    } else if (required > 0) {
      this.argsTest = `arguments.length < ${required}`;
    } else if (!extra) {
      this.argsTest = `arguments.length > ${count}`;
    } else {
      this.argsTest = "";
    }

    // var, not let: V8 starts a frame's registers undefined, where each
    // let is initialized with bytecode of its own, which counts against inlining.
    out.text("  var l0 = this");
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
        constant(this, abc.optionalValue[o], abc.optionalKind[o], type);
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
      // With the function itself, for arguments.callee.
      out.text(", l");
      out.uint(local++);
      out.text(" = rt.arguments(arguments, ");
      out.text(this.functionName.length ? this.functionName : "$method");
      out.text(")");
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
    // Every way in wrote its copies. A block written in place has one way
    // in, the code before it, and keeps what that checked; avmplus' JIT
    // knows no value as it was made from there, a block in place or not.
    this.uncopy(stack);
    for (let r: u32 = 0; r < ir.frameSize; r++) {
      this.promoted[r] = 0;
    }

    if (!this.inPlace) {
      for (let r: u32 = 0; r < ir.frameSize; r++) {
        this.checked[r] = 0;
      }
    }

    this.inPlace = false;
    this.file = this.blockFile[k];
    this.line = this.blockLine[k];
    this.mark();
    for (let i = ir.blockFirst[k]; i < last; i++) {
      const op = ir.op[i];
      const dst = ir.dst[i];
      // A branch's code written in place is another block's: this one's end, for each instruction.
      this.blockLast = last;
      // An int or uint the verifier makes a Number, as LIR's i2d and ui2d (see wraps).
      const promotes =
        op === IR_Coerce &&
        dst === ir.src[i] &&
        this.domain.builtin(ir.c[i]) === BUILTIN_Number &&
        (this.builtinOf(dst) === BUILTIN_Int || this.builtinOf(dst) === BUILTIN_Uint);
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
      } else if (conditional(this, op) || op === ops.OP_lookupswitch) {
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
          if (this.structured && !enclosed(this, region)) {
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
      this.unchecks(i);
      this.target = -1;
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

      if (sinking && this.sunk) {
        // The setlocal is written: its stack register was never set, and
        // the stack is as far as it.
        i++;
        this.regType[ir.dst[i]] = ir.type[i];
        this.uncopy(dst);
        continue;
      }

      if (conditional(this, op) || op === ops.OP_lookupswitch) {
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

    if (!terminates(this, k)) {
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
    if (from === -1) {
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
      if (this.copyOf[r] !== -1) {
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
    this.checked[r] = 0;
    out.text("    ");
    this.reg(r);
    out.text(" = ");
    this.copied(from);
    out.text(";\n");
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

  /** Whether op pushes a constant, which a stack register can be a copy of. */
  private pushesConstant(op: u16): bool {
    switch (op) {
      case ops.OP_pushbyte:
      case ops.OP_pushshort:
      case ops.OP_pushint:
      case ops.OP_pushuint:
      case ops.OP_pushdouble:
      case ops.OP_pushnan:
      case ops.OP_pushstring:
      case ops.OP_pushtrue:
      case ops.OP_pushfalse:
      case ops.OP_pushnull:
      case ops.OP_pushundefined:
        return true;
      default:
        return false;
    }
  }

  /** What a copy reads: a register, or the constant instruction `CONSTANT - copy` pushed. */
  private copied(copy: i32): void {
    if (copy >= 0) {
      this.regName(copy);
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
        out.text("undefined");
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
    if (copy === -1) {
      this.regName(r);
    } else {
      this.copied(copy);
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
   * The local or scope register each stack register copies, -1 if none:
   * a copy is not written until something needs the stack register itself,
   * so reading it reads what it copies.
   */
  copyOf: StaticArray<i32> = new StaticArray<i32>(0);
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

  instruction(i: u32): void {
    const out = this.out;
    const ir = this.ir;
    const op = ir.op[i];
    const a = ir.a[i];
    if (this.pushesConstant(op) && ir.dst[i] >= <i32>(ir.localCount + ir.maxScope)) {
      // Read as the literal until the register changes or a branch needs
      // it: V8 then gives the operation the constant in its own bytecode.
      this.copyOf[ir.dst[i]] = CONSTANT - <i32>i;
      this.kept = true;
      return;
    }

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
        poolString(this, a);
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
      case IR_CheckNull: {
        // A register checked since it was last written is not null.
        const copy = this.copyOf[ir.src[i]];
        const r = copy === -1 ? ir.src[i] : copy;
        if (r >= 0) {
          if (this.checked[r]) {
            return;
          }

          this.checked[r] = 1;
        }

        out.text("    if (");
        this.reg(ir.src[i]);
        out.text(" == null) throw rt.nullError(");
        this.reg(ir.src[i]);
        out.text(")");
        break;
      }
      case ops.OP_add:
        this.assign(i);
        if (
          (this.isNumeric(this.src(i, 0)) && this.isNumeric(this.src(i, 1))) ||
          this.concatenates(i)
        ) {
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
        if (this.wraps(i)) {
          this.call2("Math.imul(", i);
        } else {
          this.binary(i, " * ");
        }

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
    if (!this.seesDxns) {
      this.notesDxns(op, src);
    }
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
        typeRef(this, this.regType[src]);
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
        // Its method's id, as avmplus writes a function as [object Function-id].
        out.text(", ");
        out.uint(a);
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
      // Domain memory: in place at an int address, else through the
      // runtime, which checks the range and converts the address; also
      // what the code in place calls for an address out of range, so that
      // the runtime rejects it as avmplus does. Sign extensions in plain
      // JavaScript.
      case ops.OP_li8:
      case ops.OP_li16:
      case ops.OP_li32:
      case ops.OP_lf32:
      case ops.OP_lf64:
        this.assign(i);
        if (this.isAddress(src)) {
          out.text("(");
          this.inRange(src, op);
          out.text(" ? rt.view.");
          out.text(this.viewMethod(op));
          out.text("(");
          this.reg(src);
          out.text(op === ops.OP_li8 ? ")" : ", true)");
          out.text(" : ");
        }

        out.text("rt.");
        out.text(opcodeNames[op]);
        out.text("(");
        this.reg(src);
        out.text(")");
        if (this.isAddress(src)) {
          out.text(")");
        }

        return true;
      case ops.OP_si8:
      case ops.OP_si16:
      case ops.OP_si32:
      case ops.OP_sf32:
      case ops.OP_sf64:
        // The value's conversion is DataView's own for a number or Boolean.
        out.text("    ");
        if (this.isAddress(src + 1) && this.isNumeric(src)) {
          out.text("if (");
          this.inRange(src + 1, op);
          out.text(") rt.view.");
          out.text(this.viewMethod(op));
          out.text("(");
          this.reg(src + 1);
          out.text(", ");
          this.reg(src);
          out.text(op === ops.OP_si8 ? "); else " : ", true); else ");
        }

        out.text("rt.");
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
        poolString(this, a);
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
    // XML's methods look names up in the default XML namespace.
    if (type === this.domain.xmlType || type === this.domain.xmlListType) {
      this.seesDxns = true;
    }

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
      typeRef(this, type);
      out.text(").$m");
      out.uint(disp);
      out.text(".call(");
      this.reg(src);
      this.args(src + 1, argc);
      out.text(")");
      return;
    }

    // An Object may be a primitive, or a Namespace, whose methods are its
    // class prototype's; any other object has its own.
    if (bt === BUILTIN_Object) {
      out.text("(");
      this.reg(src);
      out.text(".$m");
      out.uint(disp);
      out.text(" ?? rt.prototypeOf(");
      typeRef(this, type);
      out.text(").$m");
      out.uint(disp);
      out.text(").call(");
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

  /**
   * Whether add i is JavaScript's own `+`: a String and a String, int, uint
   * or Boolean, whose strings are JavaScript's. null, the one String that
   * is not a string, adds as a number in both, and Numbers' strings differ.
   */
  concatenates(i: u32): bool {
    const a = this.builtinOf(this.src(i, 0));
    const b = this.builtinOf(this.src(i, 1));
    return (a === BUILTIN_String || b === BUILTIN_String) && this.primitive(a) && this.primitive(b);
  }

  private primitive(bt: u8): bool {
    return (
      bt === BUILTIN_String || bt === BUILTIN_Int || bt === BUILTIN_Uint || bt === BUILTIN_Boolean
    );
  }

  /**
   * Whether multiply i is an int multiplication that wraps, as avmplus' JIT
   * makes one (CodegenLIR::coerceNumberToInt): two ints or uints, which
   * the verifier makes Numbers just before, whose product is converted to
   * an int or uint next, in the same block. Its interpreter, which runs
   * the initializers, multiplies doubles. A product converted after a
   * merge, or later in the block, stays a double product here, where
   * avmshell's JIT may still wrap it.
   */
  private wraps(i: u32): bool {
    const ir = this.ir;
    const next = i + 1;
    if (
      this.staticInit ||
      !this.promoted[this.src(i, 0)] ||
      !this.promoted[this.src(i, 1)] ||
      next >= this.blockLast ||
      ir.src[next] !== ir.dst[i]
    ) {
      return false;
    }

    switch (ir.op[next]) {
      case ops.OP_convert_i:
      case ops.OP_coerce_i:
      case ops.OP_convert_u:
      case ops.OP_coerce_u:
        return true;
      case IR_Coerce: {
        const bt = this.domain.builtin(ir.c[next]);
        return bt === BUILTIN_Int || bt === BUILTIN_Uint;
      }
      default:
        return false;
    }
  }

  /** Whether method m initializes a script or a class, as avmplus' setStaticInit marks it. */
  private isStaticInit(m: u32): bool {
    const abc = this.abc;
    for (let s = 0; s < abc.scriptInit.length; s++) {
      if (abc.scriptInit[s] === m) {
        return true;
      }
    }

    for (let c = 0; c < abc.classInit.length; c++) {
      if (abc.classInit[c] === m) {
        return true;
      }
    }

    return false;
  }

  /** Whether register r is a domain memory address the emitter can use as it is: an int or uint. */
  private isAddress(r: i32): bool {
    const bt = this.builtinOf(r);
    return bt === BUILTIN_Int || bt === BUILTIN_Uint;
  }

  /** `(a >>> 0) <= rt.memoryLength - size`: whether op's bytes at address register a are all in the domain memory. */
  private inRange(a: i32, op: u16): void {
    this.out.text("(");
    this.reg(a);
    this.out.text(" >>> 0) <= rt.memoryLength - ");
    this.out.uint(this.memorySize(op));
  }

  private memorySize(op: u16): u32 {
    switch (op) {
      case ops.OP_li8:
      case ops.OP_si8:
        return 1;
      case ops.OP_li16:
      case ops.OP_si16:
        return 2;
      case ops.OP_lf64:
      case ops.OP_sf64:
        return 8;
      default:
        return 4;
    }
  }

  /** The DataView method that loads or stores as op does, little-endian. */
  private viewMethod(op: u16): string {
    switch (op) {
      case ops.OP_li8:
        return "getUint8";
      case ops.OP_li16:
        return "getUint16";
      case ops.OP_li32:
        return "getInt32";
      case ops.OP_lf32:
        return "getFloat32";
      case ops.OP_lf64:
        return "getFloat64";
      case ops.OP_si8:
        return "setUint8";
      case ops.OP_si16:
        return "setUint16";
      case ops.OP_si32:
        return "setInt32";
      case ops.OP_sf32:
        return "setFloat32";
      default:
        return "setFloat64";
    }
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
        (fromBt === BUILTIN_Int || fromBt === BUILTIN_Uint || fromBt === BUILTIN_Number)) ||
      this.upcast(type, from)
    );
  }

  /**
   * Whether a value of class type `from` is one of class `type` already, as
   * CodegenLIR::coerceToType writes no code for: instances of a subtype
   * are, and null stays null.
   */
  upcast(type: i32, from: i32): bool {
    return (
      isClassRef(this, type) &&
      isClassRef(this, from) &&
      this.domain.traits.subtypeOf(<u32>from, <u32>type)
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
        if (this.upcast(type, from)) {
          this.operand(prefix, r);
          return;
        }

        // A class's instances, by T: no builtin for the runtime to look for.
        out.text(isClassRef(this, type) ? "rt.coerceTo(" : "rt.coerce(");
        this.operand(prefix, r);
        out.text(", ");
        typeRef(this, type);
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
}
