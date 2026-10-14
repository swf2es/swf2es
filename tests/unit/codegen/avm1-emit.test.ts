import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createCodegen } from "@swf2es/codegen";
import {
  Avm1Assembler,
  constant,
  constant16,
  double,
  float,
  register,
} from "../../avm1-assembler.ts";
import { testing } from "./testing-module.ts";

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

type Region = (cx: Activation, st?: unknown[]) => void;

interface Activation {
  pool: unknown[];
  st: unknown[];
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
  const versions: number[] = [];
  const rt = {
    version(v: number) {
      versions.push(v);
      return V;
    },
  };
  return { calls, rt, versions };
}

async function load(module: string, rt: unknown): Promise<Region[][]> {
  const url = `data:text/javascript;base64,${Buffer.from(module).toString("base64")}`;
  const { default: factory } = await import(url);
  return factory(rt);
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
  assert.ok(module.includes('st.push("a");\nV.trace(cx, st.pop());\nV.stop(cx);\nreturn;\n'));
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
  // The block starts with the movie's pool, which the runtime gives.
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

test("every other action throws that it is not yet supported", async () => {
  const getVariable = await run([asm().push("a").trace().push("x").action(0x1c).trace().bytes()]);
  assert.deepEqual(getVariable.calls, [["trace", "a"]]);
  assert.equal(getVariable.error, "not yet supported: GetVariable");

  const pushRegister = await run([asm().push("a", register(1)).trace().bytes()]);
  assert.equal(pushRegister.error, "not yet supported: Push of a register");

  // An action with operands, and one that ends the block.
  const goto = await run([asm().action(0x81, [1, 0]).bytes()]);
  assert.equal(goto.error, "not yet supported: GotoFrame");
  const ret = await run([asm().action(0x3e).push("after").trace().bytes()]);
  assert.equal(ret.error, "not yet supported: Return");
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
  assert.equal(error, "not yet supported: DefineFunction");
  assert.equal(entries[0].length, 2);
  assert.equal(module.match(/"in the body"/g)?.length, 2);

  const { calls, rt } = stub();
  const regions = (await load(moduleOf([block], 10), rt))[0];
  regions[1]({ pool: [], st: [] });
  assert.deepEqual(calls, [["trace", "in the body"]]);
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

/** Entries 2, 0, 1 of `entries`, in that order, as actionsEmitEach writes them. */
function alone(entries: string): string {
  const parts = entries.split("\u0002").filter(Boolean);
  return `${[2, 0, 1].map((k) => parts[k]).join("\u0002")}\u0002`;
}
