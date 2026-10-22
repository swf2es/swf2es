import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createCodegen } from "@swf2es/codegen";
import { readActions, readSwf } from "../../../packages/format/dist/index.js";
import { lazyBlocks } from "../../../packages/player/dist/avm1/compile.js";
import { type Region as Avm1Region, Runtime } from "../../../packages/runtime/dist/avm1/index.js";
import {
  Avm1Assembler,
  constant,
  constant16,
  double,
  FunctionFlag,
  float,
  register,
  TryFlag,
} from "../../avm1-assembler.ts";
import { backwardActions, branch, sharedBackwardSwf, unitActions } from "../../avm1-backward.ts";
import { loadTesting, testing } from "./testing-module.ts";

// AVM1 blocks assembled in the tests, compiled by codegen's emitter
// (assembly/avm1/emit/) and run with a stub runtime that records what the
// code calls: its traces, play and stop, and the "not yet" errors of the
// actions the emitter leaves to later steps.

const utf8 = new TextDecoder();

/** The blocks as one SWF's bytes, with each one's range. */
function laid(blocks: Uint8Array[]) {
  const bytes = new Uint8Array(blocks.reduce((n, b) => n + b.length, 0));
  const offsets: number[] = [];
  let at = 0;
  for (const block of blocks) {
    bytes.set(block, at);
    offsets.push(at);
    at += block.length;
  }

  return {
    bytes,
    offsets: Int32Array.from(offsets),
    lengths: Int32Array.from(blocks, (b) => b.length),
  };
}

function moduleOf(blocks: Uint8Array[], version: number): string {
  const { bytes, offsets, lengths } = laid(blocks);
  return utf8.decode(testing.actionsModuleBytes(bytes, offsets, lengths, version, false));
}

type Region = (cx: Activation, self?: unknown, args?: unknown[]) => unknown;

interface Activation {
  pool: unknown[];
  st: unknown[];
  g?: unknown[];
  global?: unknown;
}

/** A stub runtime: what the code calls, in order. */
function stub(conditions: boolean[] = []) {
  const calls: unknown[][] = [];
  const V = {
    trace: (_cx: Activation, value: unknown) => calls.push(["trace", value]),
    play: () => calls.push(["play"]),
    stop: () => calls.push(["stop"]),
    constantPool: (cx: Activation, pool: string[]) => {
      cx.pool = pool;
      calls.push(["constantPool", ...pool]);
    },
    // The conditions given, in turn, then the value's own truth.
    toBoolean: (value: unknown) => {
      calls.push(["toBoolean", value]);
      return conditions.length ? conditions.shift() : Boolean(value);
    },
    notYet: (name: string) => {
      throw new Error(`not yet supported: ${name}`);
    },
    halt: () => calls.push(["halt"]),
    tooLarge: () => {
      throw new Error("too large");
    },
  };
  // Any other operation records its operands and gives its name.
  const operations = new Proxy(V, {
    get: (target, name: string) =>
      Object.hasOwn(target, name)
        ? target[name as keyof typeof V]
        : (...operands: unknown[]) => {
            calls.push([name, ...operands]);
            return name;
          },
  });
  const versions: number[] = [];
  const rt = {
    version(v: number) {
      versions.push(v);
      return operations;
    },
  };
  return { calls, rt, versions };
}

async function load(module: string, rt: unknown): Promise<Region[][]> {
  const url = `data:text/javascript;base64,${Buffer.from(module).toString("base64")}`;
  const { default: factory, units } = await import(url);
  const blocks = factory(rt);
  if (units !== undefined && rt instanceof Runtime) {
    rt.adoptUnits(blocks, units(rt));
  }

  return blocks;
}

/**
 * Block 0 of `blocks` run with a stub runtime: its calls, and the error it
 * threw, if any.
 */
async function run(
  blocks: Uint8Array[],
  { version = 10, pool = [] as unknown[], conditions = [] as boolean[] } = {},
) {
  const module = moduleOf(blocks, version);
  const { calls, rt, versions } = stub(conditions);
  const entries = await load(module, rt);
  let error: string | null = null;
  try {
    entries[0][0]({ pool, st: [] });
  } catch (e) {
    error = (e as Error).message;
  }

  return { calls, error, module, entries, versions };
}

const asm = () => new Avm1Assembler();

/**
 * Block 0 of `blocks` run by the runtime, the objects and functions it
 * defines on the root as it runs: what it traces.
 */
async function traced(blocks: Uint8Array[], version = 7): Promise<string[]> {
  const lines: string[] = [];
  const rt = new Runtime();
  const entries = (await load(moduleOf(blocks, version), rt)) as unknown as Avm1Region[][];
  const host = { trace: (text: string) => lines.push(text), play() {}, stop() {}, halt() {} };
  const root = rt.newObject();
  rt.run(entries[0], rt.activation([], [], {}, root, host));
  return lines;
}

/** `{a: "oa"}` on the stack. */
const object = (a: Avm1Assembler) => a.push("a", "oa", 1).op("InitObject");

test("a module asks for its SWF's version's operations once, and has an entry per block", async () => {
  const blocks = [asm().push("one").trace().bytes(), asm().push("two").trace().bytes()];
  const { calls, entries, versions, module } = await run(blocks, { version: 6 });
  assert.deepEqual(versions, [6]);
  assert.equal(entries.length, 2);
  assert.deepEqual(calls, [["trace", "one"]]);
  assert.ok(module.startsWith("export default function (rt) {\nconst V = rt.version(6);\n"));
  assert.ok(!/version|\b6\b/.test(module.slice(module.indexOf("return ["))), module);
});

test("Push writes every constant type as its value", async () => {
  const values = ["hi", 7, -2147483648, double(2.5), double(-0), float(0.1), true, false, null];
  const block = asm().push(...values, undefined);
  for (let i = 0; i <= values.length; i++) {
    block.trace();
  }

  const { calls } = await run([block.bytes()]);
  const traced = calls.map((c) => c[1]);
  assert.deepEqual(traced, [
    undefined,
    null,
    false,
    true,
    Math.fround(0.1),
    -0,
    2.5,
    -2147483648,
    7,
    "hi",
  ]);
  assert.ok(Object.is(traced[5], -0));
});

test("doubles at the edges are written exactly", async () => {
  const edges = [Number.NaN, Infinity, -Infinity, 5e-324, Number.MAX_VALUE, 0.1 + 0.2, 2 ** 53 + 2];
  const block = asm().push(...edges.map(double));
  for (const _ of edges) {
    block.trace();
  }

  const { calls } = await run([block.bytes()]);
  assert.deepEqual(
    calls.map((c) => c[1]),
    [...edges].reverse(),
  );
});

test("a pop of the empty stack gives undefined", async () => {
  const { calls, error } = await run([asm().trace().pop().push("a").pop().trace().bytes()]);
  assert.equal(error, null);
  assert.deepEqual(calls, [
    ["trace", undefined],
    ["trace", undefined],
  ]);
});

test("the operand stack is the activation's, which blocks share", async () => {
  // In adl, the next block run in a frame pops what one left on the stack.
  const blocks = [asm().push("left", "over").bytes(), asm().trace().trace().trace().bytes()];
  const { calls, rt } = stub();
  const entries = await load(moduleOf(blocks, 8), rt);
  const st: unknown[] = [];
  entries[0][0]({ pool: [], st });
  entries[1][0]({ pool: [], st });
  assert.deepEqual(calls, [
    ["trace", "over"],
    ["trace", "left"],
    ["trace", undefined],
  ]);
});

test("If branches on the version's truth of the value it pops", async () => {
  const block = asm()
    .push("yes")
    .if("taken")
    .push("not taken")
    .trace()
    .label("taken")
    .push(0)
    .if("skipped")
    .push("fell through")
    .trace()
    .label("skipped")
    .bytes();
  const { calls } = await run([block]);
  assert.deepEqual(calls, [
    ["toBoolean", "yes"],
    ["toBoolean", 0],
    ["trace", "fell through"],
  ]);
});

test("Jump and If loop back, and leave the block past its end or before its start", async () => {
  const loop = asm()
    .label("top")
    .push("again")
    .trace()
    .push(true)
    .if("top")
    .push("out")
    .jump("end")
    .trace()
    .label("end")
    .bytes();
  const looped = await run([loop], { conditions: [true, true, false] });
  assert.deepEqual(
    looped.calls.filter((c) => c[0] === "trace"),
    [
      ["trace", "again"],
      ["trace", "again"],
      ["trace", "again"],
    ],
  );
  assert.match(looped.module, /for \(;;\) switch \(b\)/);
  // Only the jump back counts down to the script timeout's check: once here, not the If's fall-through.
  assert.equal(looped.calls.filter((c) => c[0] === "timeout").length, 0);
  assert.equal(looped.module.match(/if \(--V\.budget < 0\) V\.timeout\(cx\);/g)?.length, 1);

  // A jump past the end, and one before the block's first byte, end it.
  const past = asm().push("a").trace().raw([0x99, 2, 0, 0x10, 0]).push("b").trace().bytes();
  assert.deepEqual((await run([past])).calls, [["trace", "a"]]);
  const before = asm().push("a").trace().raw([0x99, 2, 0, 0x00, 0x80]).push("b").trace().bytes();
  assert.deepEqual((await run([before])).calls, [["trace", "a"]]);
  // An If out of the block returns when taken.
  const exit = asm().push(true).raw([0x9d, 2, 0, 0x10, 0]).push("b").trace().bytes();
  assert.deepEqual((await run([exit])).calls, [["toBoolean", true]]);
});

test("a block of straight code is written without the dispatcher", async () => {
  const { module } = await run([asm().push("a").trace().stop().bytes()]);
  assert.ok(!module.includes("switch"), module);
  assert.ok(module.includes('V.trace(cx, "a");\nV.stop(cx);\nreturn;\n'));
});

test("Play, Stop and End", async () => {
  const block = asm().play().stop().end().push("after").trace().bytes();
  const { calls } = await run([block]);
  assert.deepEqual(calls, [["play"], ["stop"]]);
});

test("a ConstantPool that reaches a push on every path makes its constants literals", async () => {
  const block = asm()
    .constantPool("a", "b")
    .push(true)
    .if("join")
    .push(constant(1))
    .trace()
    .label("join")
    .push(constant(0), constant16(1), constant(2))
    .trace()
    .trace()
    .trace()
    .bytes();
  const { calls, module } = await run([block]);
  assert.ok(!module.includes("cx.pool"), module);
  assert.deepEqual(
    calls.filter((c) => c[0] === "trace"),
    [
      ["trace", undefined],
      ["trace", "b"],
      ["trace", "a"],
    ],
  );
});

test("a push reads the activation's pool where none or several reach it", async () => {
  // The block starts with the pool the runtime gives it.
  const unknown = asm().push(constant(1), constant(5)).trace().trace().bytes();
  const before = await run([unknown], { pool: ["x", "y"] });
  assert.match(before.module, /cx\.pool\[1\]/);
  assert.deepEqual(before.calls, [
    ["trace", undefined],
    ["trace", "y"],
  ]);

  // Two pools meet.
  const two = asm()
    .push(true)
    .if("second")
    .constantPool("first")
    .jump("join")
    .label("second")
    .constantPool("second")
    .label("join")
    .push(constant(0))
    .trace()
    .bytes();
  const met = await run([two], { conditions: [true] });
  assert.match(met.module, /cx\.pool\[0\]/);
  assert.deepEqual(met.calls.at(-1), ["trace", "second"]);

  // A pool set in a loop meets the activation's at the loop's head.
  const loop = asm()
    .label("top")
    .push(constant(0))
    .trace()
    .constantPool("set")
    .push(true)
    .if("top")
    .bytes();
  const looped = await run([loop], { pool: ["given"], conditions: [true, false] });
  assert.deepEqual(
    looped.calls.filter((c) => c[0] === "trace"),
    [
      ["trace", "given"],
      ["trace", "set"],
    ],
  );
});

test("an operator calls its version's operation with its operands, the top first", async () => {
  const block = asm()
    .push("b", "a")
    .op("Subtract")
    .trace()
    .push(1)
    .op("Not")
    .trace()
    .push("s", 2, 3)
    .op("StringExtract")
    .trace()
    .push("x", "y")
    .op("Less2")
    .op("TypeOf")
    .trace()
    .bytes();
  const { calls, error } = await run([block]);
  assert.equal(error, null);
  assert.deepEqual(calls, [
    ["subtract", "a", "b"],
    ["trace", "subtract"],
    ["not", 1],
    ["trace", "not"],
    ["stringExtract", 3, 2, "s"],
    ["trace", "stringExtract"],
    ["less2", "y", "x"],
    ["typeOf", "less2"],
    ["trace", "typeOf"],
  ]);
});

test("each operator is a call of its version's operation", async () => {
  const names: [string, number, number][] = [
    ["add", 0x0a, 2],
    ["add2", 0x47, 2],
    ["subtract", 0x0b, 2],
    ["multiply", 0x0c, 2],
    ["divide", 0x0d, 2],
    ["modulo", 0x3f, 2],
    ["equals", 0x0e, 2],
    ["equals2", 0x49, 2],
    ["strictEquals", 0x66, 2],
    ["less", 0x0f, 2],
    ["less2", 0x48, 2],
    ["greater", 0x67, 2],
    ["and", 0x10, 2],
    ["or", 0x11, 2],
    ["not", 0x12, 1],
    ["bitAnd", 0x60, 2],
    ["bitOr", 0x61, 2],
    ["bitXor", 0x62, 2],
    ["bitLShift", 0x63, 2],
    ["bitRShift", 0x64, 2],
    ["bitURShift", 0x65, 2],
    ["increment", 0x50, 1],
    ["decrement", 0x51, 1],
    ["stringAdd", 0x21, 2],
    ["stringEquals", 0x13, 2],
    ["stringLess", 0x29, 2],
    ["stringGreater", 0x68, 2],
    ["stringLength", 0x14, 1],
    ["mbStringLength", 0x31, 1],
    ["stringExtract", 0x15, 3],
    ["mbStringExtract", 0x35, 3],
    ["charToAscii", 0x32, 1],
    ["asciiToChar", 0x33, 1],
    ["mbCharToAscii", 0x36, 1],
    ["mbAsciiToChar", 0x37, 1],
    ["toNumber", 0x4a, 1],
    ["toString", 0x4b, 1],
    ["toInteger", 0x18, 1],
    ["typeOf", 0x44, 1],
  ];
  for (const [name, op, operands] of names) {
    const values = [1, 2, 3].slice(0, operands);
    const { calls, error } = await run([
      asm()
        .push(...values)
        .action(op)
        .trace()
        .bytes(),
    ]);
    assert.equal(error, null, name);
    assert.deepEqual(
      calls,
      [
        [name, ...values.reverse()],
        ["trace", name],
      ],
      name,
    );
  }
});

test("PushDuplicate and StackSwap work on the stack, its empty end undefined", async () => {
  const block = asm()
    .push("a", "b")
    .op("StackSwap")
    .trace()
    .trace()
    .push("c")
    .op("PushDuplicate")
    .trace()
    .trace()
    .op("PushDuplicate")
    .op("StackSwap")
    .trace()
    .trace()
    .trace()
    .bytes();
  const { calls } = await run([block]);
  assert.deepEqual(calls, [
    ["trace", "a"],
    ["trace", "b"],
    ["trace", "c"],
    ["trace", "c"],
    ["trace", undefined],
    ["trace", undefined],
    ["trace", undefined],
  ]);
});

test("the variable and member actions take their operands as popped, the top first", async () => {
  const block = asm()
    .push("x")
    .op("GetVariable")
    .trace()
    .push("y", 1)
    .op("SetVariable")
    .push("l", 2)
    .op("DefineLocal")
    .push("m")
    .op("DefineLocal2")
    .push("o", "n")
    .op("GetMember")
    .trace()
    .push("o", "n", 3)
    .op("SetMember")
    .push("o", "n")
    .op("Delete")
    .push("v")
    .op("Delete2")
    .push("e")
    .op("Enumerate")
    .push("o")
    .op("Enumerate2")
    .op("InitObject")
    .op("InitArray")
    .op("CallFunction")
    .op("CallMethod")
    .op("NewObject")
    .op("NewMethod")
    .bytes();
  const { calls, error } = await run([block]);
  assert.equal(error, null);
  const cx = calls[0][1];
  assert.deepEqual(calls, [
    ["getVariable", cx, "x"],
    ["trace", "getVariable"],
    ["setVariable", cx, 1, "y"],
    ["defineLocal", cx, 2, "l"],
    ["defineLocal2", cx, "m"],
    ["getMember", cx, "n", "o"],
    ["trace", "getMember"],
    ["setMember", cx, 3, "n", "o"],
    ["deleteMember", cx, "n", "o"],
    ["deleteVariable", cx, "v"],
    ["enumerate", cx, "e"],
    ["enumerate2", cx, "o"],
    ["initObject", cx],
    ["initArray", cx],
    ["callFunction", cx],
    ["callMethod", cx],
    ["newObject", cx],
    ["newMethod", cx],
  ]);
});

test("GetTime, CloneSprite and RemoveSprite are calls of their operations", async () => {
  const block = asm()
    .op("GetTime")
    .trace()
    .push("a", "b", 3)
    .op("CloneSprite")
    .push("b")
    .op("RemoveSprite")
    .bytes();
  const { calls, error } = await run([block]);

  assert.equal(error, null);
  assert.deepEqual(
    calls.filter((c) => c[0] !== "constantPool"),
    [
      ["getTime", { pool: [], st: [] }],
      ["trace", "getTime"],
      ["cloneSprite", { pool: [], st: [] }, 3, "b", "a"],
      ["removeSprite", { pool: [], st: [] }, "b"],
    ],
  );
});

test("StartDrag and EndDrag are calls that take their operands off the stack themselves", async () => {
  // StartDrag's bounds are on the stack only where its constrain flag is true.
  const block = asm().push(1, 2, 3, 4, true, false, "a").op("StartDrag").op("EndDrag").bytes();
  const { calls, error } = await run([block]);

  assert.equal(error, null);
  assert.deepEqual(
    calls.filter((c) => c[0] !== "constantPool"),
    [
      ["startDrag", { pool: [], st: [1, 2, 3, 4, true, false, "a"] }],
      ["stopDrag", { pool: [], st: [1, 2, 3, 4, true, false, "a"] }],
    ],
  );
});

test("GetUrl passes its strings, GetUrl2 its target and URL off the stack and its flags", async () => {
  // A method of 3 is none.
  const block = asm()
    .getUrl("FSCommand:quit", "")
    .push("u", "t")
    .raw([0x9a, 1, 0, 0x42])
    .push("u", "t")
    .raw([0x9a, 1, 0, 0x83])
    .bytes();
  const { calls, error } = await run([block]);

  assert.equal(error, null);
  assert.deepEqual(
    calls.filter((c) => c[0] !== "constantPool"),
    [
      ["getUrl", { pool: [], st: [] }, "FSCommand:quit", ""],
      ["getUrl2", { pool: [], st: [] }, "t", "u", 0x42],
      ["getUrl2", { pool: [], st: [] }, "t", "u", 0x80],
    ],
  );
});

test("a block's registers are the movie's four, and StoreRegister leaves its value", async () => {
  const block = asm()
    .push("a")
    .storeRegister(1)
    .storeRegister(7)
    .trace()
    .push(register(1), register(3), register(4))
    .trace()
    .trace()
    .trace()
    .storeRegister(2)
    .trace()
    .bytes();
  const { calls, rt } = stub();
  const g = ["g0", "g1", "g2", "g3"];
  const st: unknown[] = [];
  (await load(moduleOf([block], 6), rt))[0][0]({ pool: [], st, g });

  // Register 4 is none, a store to it the value kept; a store on an empty stack stores undefined.
  assert.deepEqual(calls, [
    ["trace", "a"],
    ["trace", undefined],
    ["trace", "g3"],
    ["trace", "a"],
    ["trace", undefined],
  ]);
  assert.deepEqual(g, ["g0", "a", undefined, "g3"]);
  assert.deepEqual(st, []);
});

test("Return gives the value it pops, and ends a block", async () => {
  const body = asm().push("kept", "returned").action(0x3e).push("after").trace().bytes();
  const block = asm()
    .defineFunction("", [], new Avm1Assembler().raw([...body]))
    .bytes();
  const { rt } = stub();
  const regions = await load(moduleOf([block, body], 6), rt);
  const st: unknown[] = [];
  assert.equal(regions[0][1]({ pool: [], st }, undefined, []), "returned");
  assert.deepEqual(st, ["kept"]);
  assert.equal(regions[1][0]({ pool: [], st }), "returned");
  assert.deepEqual(st, ["kept", "kept"]);
});

test("DefineFunction makes a function of its region, its parameters' names given", async () => {
  const block = asm()
    .defineFunction("f", ["a", "b"], asm().push("f").trace())
    .defineFunction("", [], asm())
    .bytes();
  const { calls, entries } = await run([block], { version: 6 });
  assert.equal(entries[0].length, 3);
  assert.deepEqual(
    calls.map((c) => c.slice(2)),
    [
      [1, "f", ["a", "b"]],
      [2, "", []],
    ],
  );
});

test("DefineFunction2's registers are its own, its preloads in order from r1, then its parameters", async () => {
  const all =
    FunctionFlag.preloadThis |
    FunctionFlag.preloadArguments |
    FunctionFlag.preloadSuper |
    FunctionFlag.preloadRoot |
    FunctionFlag.preloadParent |
    FunctionFlag.preloadGlobal;
  const reads = (n: number) => {
    const body = asm();
    for (let r = 0; r < n; r++) {
      body.push(register(r)).trace();
    }

    return body;
  };
  const defined = async (registers: number, flags: number, params: [string, number][]) => {
    const block = asm().defineFunction2("f", registers, flags, params, reads(9)).bytes();
    const { calls, rt } = stub();
    const regions = (await load(moduleOf([block], 7), rt))[0];
    regions[0]({ pool: [], st: [] });
    const definition = calls.splice(0);
    regions[1]({ pool: [], st: [], g: ["g0", "g1", "g2", "g3"], global: "G" }, "this", ["x", "y"]);
    return { definition: definition[0].slice(2), calls };
  };

  // r1 this, r2 arguments, r3 super, r4 _root, r5 _parent, r6 _global, and y in r7.
  const full = await defined(9, all, [
    ["x", 0],
    ["y", 7],
  ]);
  assert.deepEqual(full.definition, [1, "f", ["x", null], all]);
  assert.deepEqual(
    full.calls.filter((c) => c[0] === "trace").map((c) => c[1]),
    [undefined, "this", "argumentsOf", "superOf", "root", "parentOf", "G", "y", undefined],
  );

  // Suppressed, `this` and `super` are undefined and `arguments` still loaded; past the count,
  // registers are the global ones up to 3; a parameter's register past it is none.
  const suppressed = await defined(
    3,
    FunctionFlag.preloadThis |
      FunctionFlag.suppressThis |
      FunctionFlag.preloadArguments |
      FunctionFlag.suppressArguments,
    [["z", 5]],
  );
  assert.deepEqual(suppressed.definition, [1, "f", [null], 0x0f]);
  assert.deepEqual(
    suppressed.calls.filter((c) => c[0] === "trace").map((c) => c[1]),
    [
      undefined,
      undefined,
      "argumentsOf",
      "g3",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    ],
  );

  // Without a parent, _global takes the parent's register.
  const block = asm()
    .defineFunction2("", 3, FunctionFlag.preloadParent | FunctionFlag.preloadGlobal, [], reads(3))
    .bytes();
  const { calls, rt } = stub();
  const parentless = new Proxy(rt.version(7), {
    get: (target, name: string) =>
      name === "parentOf" ? () => undefined : target[name as keyof typeof target],
  });
  const regions = (await load(moduleOf([block], 7), { version: () => parentless }))[0];
  regions[1]({ pool: [], st: [], g: [], global: "G" }, undefined, []);
  assert.deepEqual(
    calls.filter((c) => c[0] === "trace").map((c) => c[1]),
    [undefined, "G", undefined],
  );
});

test("an action Flash does not know is skipped, and one cut short stops the SWF", async () => {
  const unknown = asm().push("a").action(0x01).action(0xa0, [1, 2]).trace().bytes();
  assert.deepEqual((await run([unknown])).calls, [["trace", "a"]]);

  // A Push whose integer runs past the block's end.
  const cut = asm().push("a").trace().raw([0x96, 5, 0, 7, 1]).bytes();
  const { calls, error } = await run([cut]);
  assert.equal(error, null);
  assert.deepEqual(calls, [["trace", "a"], ["halt"]]);
});

test("a Push of a value type Flash does not know stops the SWF, pushing nothing", async () => {
  const block = asm().push("a").raw([0x96, 3, 0, 2, 10, 3]).trace().bytes();
  const { calls, error, module } = await run([block]);
  assert.equal(error, null);
  assert.deepEqual(calls, [["halt"]]);
  assert.ok(!module.includes("null"), module);
});

/**
 * What adl reads from a string's bytes from SWF 6 (strings.ts), as char
 * codes: the reference the emitter's strings are held to.
 */
function adlString(bytes: number[]): string {
  const offsets = [0, 0x3080, 0xe2080, 0x3c82080, 0xfa082080, 0x82082080];
  const units: number[] = [];
  let i = 0;
  while (i < bytes.length) {
    const b = bytes[i];
    const more = b < 0xc0 ? 0 : b < 0xe0 ? 1 : b < 0xf0 ? 2 : b < 0xf8 ? 3 : b < 0xfc ? 4 : 5;
    if (i + more >= bytes.length) {
      break;
    }

    let c = 0;
    for (let k = 0; k <= more; k++) {
      c = ((c << 6) + bytes[i + k]) >>> 0;
    }

    c = (c - offsets[more]) >>> 0;
    i += more + 1;
    if (c === 0) {
      break;
    }

    if (c > 0x10ffff || (c >= 0xd800 && c <= 0xdfff)) {
      units.push(0xfffd);
    } else if (c > 0xffff) {
      units.push(0xd800 + ((c - 0x10000) >> 10), 0xdc00 + ((c - 0x10000) & 0x3ff));
    } else {
      units.push(c);
    }
  }

  return String.fromCharCode(...units);
}

/** A Push of each string, as its bytes, and a Trace of each. */
function tracing(strings: number[][]): Uint8Array {
  const code: number[] = [];
  for (const bytes of strings) {
    code.push(0x96, (bytes.length + 2) & 0xff, (bytes.length + 2) >> 8, 0, ...bytes, 0, 0x26);
  }

  return new Uint8Array(code);
}

test("strings read as adl reads them: UTF-8 from SWF 6, a character a byte before", async () => {
  // adl's char codes for these bytes, at SWF 6, 8 and 10 alike.
  const cases: [number[], number[]][] = [
    [[0xc3, 0xa9], [0xe9]],
    [[0xe2, 0x82, 0xac], [0x20ac]],
    [[0xc2, 0x80], [0x80]],
    [
      [0xe2, 0x80, 0xa8, 0x22, 0x5c],
      [0x2028, 0x22, 0x5c],
    ],
    [[0xef, 0xbf, 0xbf], [0xffff]],
    [
      [0xf4, 0x8f, 0xbf, 0xbf],
      [0xdbff, 0xdfff],
    ],
    // A byte that leads nothing is its own character.
    [
      [0x41, 0xbf, 0x41],
      [0x41, 0xbf, 0x41],
    ],
    [
      [0x80, 0x81, 0x9f, 0xe9, 0x41],
      [0x80, 0x81, 0x9f],
    ],
    // A lead takes the bytes after it, whatever they are, and overlong forms read.
    [
      [0xc3, 0xc3, 0x41],
      [0x103, 0x41],
    ],
    [[0xc2, 0x41], [0x41]],
    [
      [0xe2, 0x41, 0x41, 0x42],
      [0x1001, 0x42],
    ],
    [
      [0xe2, 0x82, 0x41, 0x42],
      [0x2041, 0x42],
    ],
    [
      [0xf0, 0x9f, 0x98, 0x41],
      [0xd83d, 0xddc1],
    ],
    [[0xc1, 0x81], [0x41]],
    [[0xe0, 0x81, 0x81], [0x41]],
    [[0xc1, 0xbf], [0x7f]],
    [[0xe0, 0x9f, 0xbf], [0x7ff]],
    [[0xf0, 0x8f, 0xbf, 0xbf], [0xffff]],
    // A surrogate, a code point past U+10FFFF or below 0 is U+FFFD.
    [[0xed, 0xbf, 0xbf], [0xfffd]],
    [
      [0xed, 0xa0, 0xbd, 0xed, 0xb8, 0x80],
      [0xfffd, 0xfffd],
    ],
    [[0xf5, 0x80, 0x80, 0x80], [0xfffd]],
    [[0xf7, 0xbf, 0xbf, 0xbf], [0xfffd]],
    [
      [0xf8, 0x88, 0x80, 0x80, 0x80, 0x41],
      [0xfffd, 0x41],
    ],
    [
      [0xfc, 0x84, 0x80, 0x80, 0x80, 0x80, 0x41],
      [0xfffd, 0x41],
    ],
    [[0xc0, 0x41], [0xfffd]],
    // A sequence cut short by the end, or a code point of 0, ends the string.
    [[0x61, 0xe2, 0x82], [0x61]],
    [[0x41, 0xc3], [0x41]],
    [[0xfe, 0x41], []],
    [[0xff, 0x41], []],
    [[0xc0, 0x80, 0x41], []],
    [[0xe0, 0x80, 0x80, 0x41], []],
    [[0xf0, 0x80, 0x80, 0x80, 0x41], []],
  ];
  const block = tracing(cases.map(([bytes]) => bytes));
  for (const version of [6, 10]) {
    const { calls } = await run([block], { version });
    assert.deepEqual(
      calls.map((c) => c[1]),
      cases.map(([, codes]) => String.fromCharCode(...codes)),
    );
  }

  for (const [bytes, codes] of cases) {
    assert.equal(adlString(bytes), String.fromCharCode(...codes), String(bytes));
  }

  // Up to SWF 5, each byte is its own character, as adl's charCodeAt and length count them.
  const five = await run([block], { version: 5 });
  assert.deepEqual(
    five.calls.map((c) => c[1]),
    cases.map(([bytes]) => String.fromCharCode(...bytes)),
  );
});

test("a string's literal is what it reads as, whatever its bytes", async () => {
  // Bytes that read as quotes, backslashes and line ends, overlong or not, among others.
  const random = (() => {
    let s = 1;
    return () => {
      s = (Math.imul(s, 1103515245) + 12345) >>> 0;
      return (s >>> 8) / 0x1000000;
    };
  })();
  const special = [0x22, 0x5c, 0x0a, 0x0d, 0x24, 0x60, 0xc0, 0xc1, 0xe0, 0x80, 0x88, 0x9c, 0xa2];
  const byte = () => {
    const r = random();
    if (r < 0.4) {
      return special[Math.floor(random() * special.length)];
    }

    return r < 0.7 ? 0x80 + Math.floor(random() * 0x80) : 1 + Math.floor(random() * 0xff);
  };
  const strings = Array.from({ length: 1000 }, () =>
    Array.from({ length: 1 + Math.floor(random() * 6) }, byte),
  );
  const block = tracing(strings);
  const six = await run([block], { version: 6 });
  assert.deepEqual(
    six.calls.map((c) => c[1]),
    strings.map(adlString),
  );
  const five = await run([block], { version: 5 });
  assert.deepEqual(
    five.calls.map((c) => c[1]),
    strings.map((bytes) => String.fromCharCode(...bytes)),
  );

  // The module is UTF-8 that decodes as it was written, with no line separator in a literal.
  assert.ok(!six.module.includes(" ") && !six.module.includes(" "));
});

test("a function's body is an entry of its own, not inlined; a With's body is the block's", async () => {
  const body = asm().push("in the body").trace().bytes();
  // DefineFunction "f"(), its body; then a With of the same body.
  const block = asm()
    .action(0x9b, [0x66, 0, 0, 0, body.length, 0])
    .raw([...body])
    .push("x")
    .action(0x94, [body.length, 0])
    .raw([...body])
    .bytes();
  const { entries, error, module } = await run([block]);
  assert.equal(error, null);
  assert.equal(entries[0].length, 2);
  assert.equal(module.match(/"in the body"/g)?.length, 2);

  const { calls, rt } = stub();
  const regions = (await load(moduleOf([block], 10), rt))[0];
  regions[1]({ pool: [], st: [] });
  assert.deepEqual(calls, [["trace", "in the body"]]);
});

test("a With's object is on the scope chain over its body, and for one action past it", async () => {
  const lines = await traced([
    object(asm())
      .with("end")
      .push("a")
      .op("GetVariable")
      .trace()
      .push("a")
      .label("end")
      // The first action past the body runs in its scope, the next does not.
      .op("GetVariable")
      .trace()
      .push("a")
      .op("GetVariable")
      .trace()
      .push(undefined)
      .with("skipped")
      .push("not run")
      .trace()
      .label("skipped")
      .bytes(),
  ]);
  assert.deepEqual(lines, ["oa", "oa", "undefined"]);
});

test("a jump out of a With's body leaves it; one back before it finds no scope there", async () => {
  const lines = await traced([
    asm()
      .push("i", 0)
      .op("SetVariable")
      .label("top")
      .push(0)
      .pop()
      .push("a")
      .op("GetVariable")
      .trace()
      .push("i", "i")
      .op("GetVariable")
      .op("Increment")
      .op("SetVariable")
      .raw([...object(asm()).bytes()])
      .with("end")
      .push("a")
      .op("GetVariable")
      .trace()
      .push("i")
      .op("GetVariable")
      .push(2)
      .op("Less2")
      .if("top")
      .label("end")
      .bytes(),
  ]);
  assert.deepEqual(lines, ["undefined", "oa", "undefined", "oa"]);
});

test("a Try's catch takes the value into its body's own variable, its finally after", async () => {
  const lines = await traced([
    asm()
      .push("e", "outer")
      .op("SetVariable")
      .push(1, 2)
      .try("e", "catch", "finally", "end")
      .push("t1", "x")
      .op("Throw")
      .label("catch")
      // The stack is cut back to its height at the Try.
      .push("e")
      .op("GetVariable")
      .trace()
      .op("PushDuplicate")
      .trace()
      .label("finally")
      .push("finally")
      .trace()
      .label("end")
      .push("e")
      .op("GetVariable")
      .trace()
      .bytes(),
  ]);
  assert.deepEqual(lines, ["x", "2", "finally", "outer"]);
});

test("a throw in a try body without a catch, or in a catch, runs the finally and throws again", async () => {
  const inner = (a: Avm1Assembler) =>
    a
      .try("i", "ic", "if", "ie")
      .push("thrown")
      .op("Throw")
      .label("ic")
      .push("again")
      .op("Throw")
      .label("if")
      .push("inner finally")
      .trace()
      .jump("out")
      .label("ie");
  const lines = await traced([
    inner(asm().try("o", "oc", "of", "oe"))
      .label("out")
      .push("not run")
      .trace()
      .label("oc")
      .push("o")
      .op("GetVariable")
      .trace()
      .label("of")
      .label("oe")
      .bytes(),
  ]);
  assert.deepEqual(lines, ["inner finally", "again"]);
});

test("a Return in a try body runs the finally, and returns the stack's top as it ends", async () => {
  const body = asm()
    .try("e", "c", "f", "end")
    .push("from try")
    .op("Return")
    .label("c")
    .label("f")
    .push("from finally")
    .label("end")
    .bytes();
  const lines = await traced([
    asm()
      .action(0x9b, [0x66, 0, 0, 0, body.length & 0xff, body.length >> 8])
      .raw([...body])
      .push(0, "f")
      .op("CallFunction")
      .trace()
      .trace()
      .bytes(),
  ]);
  assert.deepEqual(lines, ["from finally", "from try"]);
});

test("a catch into a register sets a DefineFunction2's own or the movie's", async () => {
  const body = asm()
    .try(register(1), "c", "f", "end")
    .push("local")
    .op("Throw")
    .label("c")
    .push(register(1))
    .trace()
    .label("f")
    .label("end");
  const lines = await traced([
    asm()
      .defineFunction2("f", 2, 0, [], body)
      .push(0, "f")
      .op("CallFunction")
      .pop()
      .try(register(1), "c", "f", "end", TryFlag.catch)
      .push("global")
      .op("Throw")
      .label("c")
      .label("f")
      .label("end")
      .push(register(1))
      .trace()
      .bytes(),
  ]);
  assert.deepEqual(lines, ["local", "global"]);
});

test("a thrown value nothing catches ends the block, writing nothing", async () => {
  const lines = await traced([asm().push("x").op("Throw").push("not run").trace().bytes()]);
  assert.deepEqual(lines, []);
});

test("a region without a With or a Try neither catches nor leaves", async () => {
  const plain = moduleOf([asm().label("top").push(true).if("top").bytes()], 7);
  assert.ok(!/try|V\.leave|V\.scopes|case -1/.test(plain));

  const held = moduleOf(
    [object(asm()).with("end").push(1).pop().label("end").push(2).pop().bytes()],
    7,
  );
  assert.ok(held.includes("V.with(cx, st.pop(), "));
  assert.ok(held.includes("V.scopes(cx, "));
  assert.ok(!held.includes("try {"));
});

test("an empty block is a region that does nothing", async () => {
  const { entries, error, calls } = await run([new Uint8Array(0)]);
  assert.equal(error, null);
  assert.equal(entries[0].length, 1);
  assert.deepEqual(calls, []);
});

test("a block's range outside the SWF's bytes is an empty block", () => {
  const bytes = new Uint8Array([0x07]);
  const module = utf8.decode(
    testing.actionsModuleBytes(bytes, Int32Array.from([0, -1, 0]), Int32Array.from([1, 1, 2]), 6),
  );
  assert.equal(module.match(/V\.stop/g)?.length, 1);
  assert.equal(module.match(/function \(cx\)/g)?.length, 3);
});

test("backward branches read SWF prefixes, including functions and chained distant jumps", async () => {
  const codegen = await createCodegen(
    await WebAssembly.compile(
      await readFile(new URL("../../../packages/codegen/dist/codegen.wasm", import.meta.url)),
    ),
  );
  for (const distant of [false, true]) {
    const { bytes, offset } = backwardActions(distant);
    const offsets = Int32Array.of(offset);
    const lengths = Int32Array.of(bytes.length - offset);
    const actions = { version: 8, blocks: [{ offset, length: lengths[0] }] };
    const compiled = codegen.compileActions(bytes, actions);
    assert.equal(
      utf8.decode(testing.actionsModuleBytes(bytes, offsets, lengths, 8, true)),
      compiled.module,
    );
    const entries = testing.actionsModuleEntries();
    for (const reuse of [false, true]) {
      assert.equal(
        testing.actionsEmitEach(bytes, offsets, lengths, 8, "0,0", reuse),
        entries.repeat(2),
      );
    }

    assert.equal(codegen.compileActionBlocks(bytes, actions, [0]).get(0), compiled.entries[0]);
    const lines: string[] = [];
    const rt = new Runtime();
    const blocks = (await load(compiled.module, rt)) as unknown as Avm1Region[][];
    const host = { trace: (text: string) => lines.push(text), play() {}, stop() {}, halt() {} };
    rt.run(blocks[0], rt.activation([], [], {}, rt.newObject(), host));
    assert.deepEqual(
      lines,
      distant
        ? ["distant prefix", "returned"]
        : ["outside é", "callback", "42", "conditional prefix", "done"],
    );
  }
});

test("code outside a block's bytes runs in units, as it would in the block, alone as in the module", async () => {
  const codegen = await createCodegen(
    await WebAssembly.compile(
      await readFile(new URL("../../../packages/codegen/dist/codegen.wasm", import.meta.url)),
    ),
  );
  const { bytes, offset } = unitActions();
  for (const version of [4, 6]) {
    const actions = { version, blocks: [{ offset, length: bytes.length - offset }] };
    const compiled = codegen.compileActions(bytes, actions);
    assert.match(compiled.module, /return V\.far\(cx, 0, /);
    assert.ok(compiled.units.size >= 2);
    assert.equal(
      [...compiled.units.values()].some(({ unit }) => unit.five),
      version < 5,
      "a function's body runs as a SWF 5's",
    );
    for (const { unit, code, high, reach } of compiled.units.values()) {
      assert.deepEqual(codegen.compileActionUnit(bytes, actions, unit), { code, high, reach });
    }

    // The same as the JIT runs it and as the module does.
    for (const jit of [false, true]) {
      const lines: string[] = [];
      const rt = new Runtime();
      const blocks = jit
        ? lazyBlocks(codegen, bytes, actions, rt)
        : ((await load(compiled.module, rt)) as unknown as Avm1Region[][]);
      const host = { trace: (text: string) => lines.push(text), play() {}, stop() {}, halt() {} };
      rt.run(blocks[0], rt.activation([], [], {}, rt.newObject(), host));
      assert.deepEqual(lines, ["1", "2", "3", "done", "in f", "7"], `SWF ${version}, JIT ${jit}`);
    }
  }
});

test("the SWFs whose units compile are held, the few used last, until let go", async () => {
  const codegen = await createCodegen(
    await WebAssembly.compile(
      await readFile(new URL("../../../packages/codegen/dist/codegen.wasm", import.meta.url)),
    ),
  );
  const { bytes, offset } = unitActions();
  const swfs = [bytes, bytes.slice()].map((b) => ({
    bytes: b,
    actions: { version: 6, blocks: [{ offset, length: b.length - offset }] },
  }));
  const units = [...codegen.compileActions(bytes, swfs[0].actions).units.values()];
  // Units of two SWFs in turn copy each in once.
  for (let round = 0; round < 3; round++) {
    for (const { bytes: b, actions } of swfs) {
      for (const { unit } of units) {
        codegen.compileActionUnit(b, actions, unit);
      }
    }
  }
  assert.deepEqual(codegen.heldActions(), { held: 2, copies: 2 });

  // One let go is copied in again if its units are asked for since.
  codegen.releaseActions(swfs[0].bytes);
  assert.deepEqual(codegen.heldActions(), { held: 1, copies: 2 });
  codegen.compileActionUnit(swfs[0].bytes, swfs[0].actions, units[0].unit);
  assert.deepEqual(codegen.heldActions(), { held: 2, copies: 3 });

  // Past a few, the one used least lately goes.
  for (let k = 0; k < 6; k++) {
    const b = bytes.slice();
    codegen.compileActionUnit(b, { ...swfs[0].actions }, units[0].unit);
  }
  assert.equal(codegen.heldActions().held, 4);
});

test("a region that holds a With or a Try as control leaves its bytes keeps all it reaches", () => {
  // A With whose body jumps back before the block: its scope holds there.
  const prefix = new Avm1Assembler().push("x").op("GetVariable").trace().end().bytes();
  const block = new Avm1Assembler()
    .push("o")
    .op("GetVariable")
    .with("w")
    .raw([0x99, 2, 0, 0, 0])
    .label("w")
    .end()
    .bytes();
  const bytes = new Uint8Array([...prefix, ...block]);
  branch(bytes, prefix.length + block.indexOf(0x99), 0);
  const module = utf8.decode(
    testing.actionsModuleBytes(bytes, Int32Array.of(prefix.length), Int32Array.of(block.length), 6),
  );
  assert.doesNotMatch(module, /V\.far/);
  assert.match(module, /V\.getVariable/g);
});

test("SWF context does not extend an action block's upper decoding bound", () => {
  const bytes = Uint8Array.of(0x07, 0x96, 5, 0, 7, 1, 0, 0, 0);
  const module = utf8.decode(
    testing.actionsModuleBytes(bytes, Int32Array.of(1), Int32Array.of(4), 8),
  );
  assert.match(module, /V\.halt\(cx\)/);
});

test("shared SWF prefixes reuse analysis storage across blocks without changing entries", async () => {
  const fresh = await loadTesting(process.env.SWF2ES_CHECKED ? "dist-test-checked" : "dist-test");
  const swf = readSwf(sharedBackwardSwf(500));
  const blocks = readActions(swf).blocks;
  const offsets = Int32Array.from(blocks, (b) => b.offset);
  const lengths = Int32Array.from(blocks, (b) => b.length);
  fresh.actionsModuleBytes(swf.bytes, offsets, lengths, 8, true);
  const memory = fresh.memory.buffer.byteLength;
  assert.ok(memory < 32 * 1024 * 1024, `500 shared-prefix blocks grew memory to ${memory} bytes`);
  const entries = (fresh.actionsModuleEntries() as string).split("\u0002").filter(Boolean);
  assert.equal(entries.length, 500);
  for (const reuse of [false, true]) {
    assert.equal(
      fresh.actionsEmitEach(swf.bytes, offsets, lengths, 8, "499,0,250,0", reuse),
      [499, 0, 250, 0]
        .map((i) => entries[i])
        .join("\u0002")
        .concat("\u0002"),
    );
  }
});

test("each block compiled alone is its entry in the module, in the test and release builds", async () => {
  const blocks = [
    asm().constantPool("a").push(constant(0)).trace().bytes(),
    asm().label("top").push(constant(0)).trace().push(true).if("top").bytes(),
    asm().push("é").trace().stop().bytes(),
  ];
  const { bytes, offsets, lengths } = laid(blocks);
  testing.actionsModuleBytes(bytes, offsets, lengths, 7, true);
  const entries: string = testing.actionsModuleEntries();
  const order = "2,0,1,9,-1,";
  assert.equal(testing.actionsEmitEach(bytes, offsets, lengths, 7, order, false), alone(entries));
  assert.equal(testing.actionsEmitEach(bytes, offsets, lengths, 7, order, true), alone(entries));
  for (const reuse of [false, true]) {
    assert.equal(
      utf8.decode(testing.actionsEmitEachBytes(bytes, offsets, lengths, 7, order, reuse)),
      alone(entries),
    );
  }

  const wasm = new URL("../../../packages/codegen/dist/codegen.wasm", import.meta.url);
  const codegen = await createCodegen(
    await WebAssembly.compile(await readFile(fileURLToPath(wasm))),
  );
  const actions = {
    version: 7,
    blocks: blocks.map((_, k) => ({ offset: offsets[k], length: lengths[k] })),
  };
  const compiled = codegen.compileActions(bytes, actions);
  assert.equal(compiled.module, moduleOf(blocks, 7));
  assert.equal(codegen.compileActionsModule(bytes, actions), compiled.module);
  const each = codegen.compileActionBlocks(bytes, actions, [1, 0, 2, 3]);
  assert.deepEqual([...each.keys()], [1, 0, 2]);
  compiled.entries.forEach((entry, k) => {
    assert.equal(each.get(k), entry);
    assert.ok(compiled.module.includes(`\n${entry},\n`));
  });
});

test("lazy blocks reclaim their full SWF copy before the next compilation", async () => {
  const codegen = await createCodegen(
    await WebAssembly.compile(
      await readFile(new URL("../../../packages/codegen/dist/codegen.wasm", import.meta.url)),
    ),
  );
  const bytes = new Uint8Array(5 * 1024 * 1024);
  const actions = { version: 8, blocks: [{ offset: bytes.length - 1, length: 1 }] };
  for (let i = 0; i < 96; i++) {
    codegen.compileActionBlocks(bytes, actions, [0]);
  }

  const memory = codegen.usage().memory;
  assert.ok(memory < 32 * 1024 * 1024, `per-block compilation grew memory to ${memory} bytes`);
});

/** Entries 2, 0, 1 of `entries`, in that order, as actionsEmitEach writes them. */
function alone(entries: string): string {
  const parts = entries.split("\u0002").filter(Boolean);
  return `${[2, 0, 1].map((k) => parts[k]).join("\u0002")}\u0002`;
}

test("the clip actions are calls of their operations, their operands as written or popped", async () => {
  const block = asm()
    .setTarget("a/b")
    .push("/c")
    .op("SetTarget2")
    .push("x", 0)
    .op("GetProperty")
    .push("x", 2, 50)
    .op("SetProperty")
    .gotoFrame(4)
    .gotoLabel("label")
    .push("f")
    .gotoFrame2(true, 3)
    .push(2)
    .gotoFrame2(false)
    .op("NextFrame")
    .op("PreviousFrame")
    .push("p")
    .op("TargetPath")
    .push(1)
    .op("Call")
    .op("StopSounds")
    .op("ToggleQuality")
    .bytes();
  const { calls, error } = await run([block], { version: 6 });

  assert.equal(error, null);
  assert.deepEqual(
    calls.map(([name, , ...operands]) => [name, ...operands]),
    [
      ["setTarget", "a/b"],
      ["setTarget2", "/c"],
      ["getProperty", 0, "x"],
      ["setProperty", 50, 2, "x"],
      ["gotoFrame", 4],
      ["gotoLabel", "label"],
      ["gotoFrame2", "f", true, 3],
      ["gotoFrame2", 2, false, 0],
      ["nextFrame"],
      ["prevFrame"],
      ["targetPath", "p"],
      ["callFrame", 1],
      ["stopSounds"],
      ["toggleQuality"],
    ],
  );
});

test("WaitForFrame skips its actions where the frame is not loaded", async () => {
  const block = (loaded: boolean) =>
    asm()
      .waitForFrame(loaded ? 1 : 20000, "skip")
      .push("in")
      .trace()
      .label("skip")
      .push("after")
      .trace()
      .bytes();
  const traces = async (loaded: boolean) => {
    const { calls } = await run([block(loaded)]);
    return calls.filter(([name]) => name === "trace").map(([, value]) => value);
  };

  // The stub's frameLoaded gives its name, which is true.
  assert.deepEqual(await traces(true), ["in", "after"]);

  const wait2 = asm().push(3).waitForFrame2("end").push("in").trace().label("end").bytes();
  const { calls } = await run([wait2]);
  assert.deepEqual(calls[0], ["frameLoaded2", calls[0][1], 3]);
});

test("a SWF 4's functions run with SWF 5's operations", async () => {
  const body = asm().push("in").trace();
  const block = asm().defineFunction("f", [], body).push("out").trace().bytes();
  const module = moduleOf([block], 4);

  assert.ok(
    module.startsWith(
      "export default function (rt) {\nconst V = rt.version(4);\nconst V5 = rt.version(5);\n",
    ),
  );
  assert.ok(module.includes("function (cx, self, args) {\nconst st = cx.st;\nconst V = V5;\n"));
});
