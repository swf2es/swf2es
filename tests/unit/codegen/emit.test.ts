import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { abc, tables, u30 } from "./abc-builder.ts";
import { s24, script } from "./ir-cases.ts";
import { loadTesting, testing } from "./testing-module.ts";

const generated = new URL("../../../oracle/avmplus/generated/", import.meta.url);
const skip = !existsSync(generated) && "oracle/avmplus missing";

/** Just what these methods call. */
const rt = {
  greaterThan: (a: number, b: number) => a > b,
  caught: (e: unknown) => e,
  unreachable: () => new Error("unreachable"),
  defaultXmlNamespace: null,
};

/** The script initializer of `abc` as JavaScript. */
function emit(abc: Uint8Array): string {
  testing.domainReset(50);
  testing.domainAdd(new Uint8Array(readFileSync(new URL("builtin.abc", generated))), true);
  assert.equal(testing.domainAdd(abc, false), 0);
  return testing.domainEmit(0) as string;
}

/** The script initializer of `abc`, compiled and run with `this` as its global; its result. */
function run(abc: Uint8Array): unknown {
  // $dx: the default XML namespace a method's factory gives it.
  return new Function("rt", "$dx", `return ${emit(abc)}`)(rt, rt.defaultXmlNamespace).call({});
}

const PUSHBYTE = 0x24;
const LABEL = 0x09;
const IFGT = 0x17;
const LSHIFT = 0xa5;
const SUBTRACT_I = 0xc6;
const ADD = 0xa0;
const ADD_I = 0xc5;
const DECLOCAL_I = 0xc3;
const RETURNVALUE = 0x48;
const THROW = 0x03;
const POP = 0x29;
const PUSHNAN = 0x28;
const CONVERT_I = 0x73;
const JUMP = 0x10;
const IFTRUE = 0x11;
const IFFALSE = 0x12;
const PUSHTRUE = 0x26;
const PUSHFALSE = 0x27;
const GETLOCAL1 = 0xd1;
const GETLOCAL2 = 0xd2;
const GETLOCAL3 = 0xd3;
const SETLOCAL1 = 0xd5;
const SETLOCAL2 = 0xd6;
const SETLOCAL3 = 0xd7;

test("locals and arithmetic run as plain JavaScript", { skip }, () => {
  const code = [PUSHBYTE, 7, SETLOCAL1, PUSHBYTE, 5, SETLOCAL2, GETLOCAL1, GETLOCAL2, ADD];
  assert.equal(run(script([...code, SETLOCAL3, GETLOCAL3, RETURNVALUE])), 12);
});

test("int arithmetic wraps as avmplus' does", { skip }, () => {
  // (1 << 31) - 1, in int: -2147483648 - 1 wraps to 2147483647.
  const code = [PUSHBYTE, 1, PUSHBYTE, 31, LSHIFT, PUSHBYTE, 1, SUBTRACT_I, RETURNVALUE];
  assert.equal(run(script(code)), 2147483647);
});

test("a loop runs through its blocks until its branch falls through", { skip }, () => {
  // sum = 0; i = 10; do { sum += i; i-- } while (i > 0); return sum
  // 6: label; 16: ifgt back to 6 (next 20, offset -14).
  const code = [
    PUSHBYTE,
    0,
    SETLOCAL1,
    PUSHBYTE,
    10,
    SETLOCAL2,
    LABEL,
    GETLOCAL1,
    GETLOCAL2,
    ADD_I,
    SETLOCAL1,
    DECLOCAL_I,
    2,
    GETLOCAL2,
    PUSHBYTE,
    0,
    IFGT,
    ...s24(-14),
    GETLOCAL1,
    RETURNVALUE,
  ];
  assert.equal(run(script(code)), 55);
});

test("a loop is a labelled for (;;), its back edge a continue, and no dispatcher", { skip }, () => {
  // As the loop above: sum = 0; i = 10; do { sum += i; i-- } while (i > 0); return sum
  const code = [
    PUSHBYTE,
    0,
    SETLOCAL1,
    PUSHBYTE,
    10,
    SETLOCAL2,
    LABEL,
    GETLOCAL1,
    GETLOCAL2,
    ADD_I,
  ];
  const js = emit(
    script([
      ...code,
      SETLOCAL1,
      DECLOCAL_I,
      2,
      GETLOCAL2,
      PUSHBYTE,
      0,
      IFGT,
      ...s24(-14),
      GETLOCAL1,
      RETURNVALUE,
    ]),
  );
  assert.match(js, /L1: for \(;;\) \{/);
  assert.match(js, /continue L1;/);
  assert.doesNotMatch(js, /switch \(b\)/);
  // The locals are read and written straight, with no stack registers between.
  assert.match(js, /l1 = l1 \+ l2 \| 0;\nl2 = l2 - 1 \| 0;/);
});

test("if and else meet again after a labelled block", { skip }, () => {
  // 0 pushtrue; 1 iffalse +6 to 11; 5 pushbyte 1; 7 jump +2 to 13; 11 pushbyte 2; 13 returnvalue.
  const code = [
    PUSHTRUE,
    IFFALSE,
    ...s24(6),
    PUSHBYTE,
    1,
    JUMP,
    ...s24(2),
    PUSHBYTE,
    2,
    RETURNVALUE,
  ];
  // The stack value merges, so each side sets it and both go on to its merge block.
  const js = emit(script(code));
  assert.match(js, /L\d+: \{/);
  assert.doesNotMatch(js, /switch \(b\)/);
  assert.equal(run(script(code)), 1);
});

test("code after an if goes on with its own register types, not the if body's", { skip }, () => {
  // NaN stays on the stack past if (!true) { pop; return 1 }, then int(it): the
  // if body, written in place, pushes an int where the NaN was, but after it the
  // NaN is still there, a Number.
  // 0 pushnan; 1 pushtrue; 2 iffalse +2 to 8; 6 convert_i; 7 returnvalue;
  // 8 pop; 9 pushbyte 1; 11 returnvalue.
  const code = [
    PUSHNAN,
    PUSHTRUE,
    IFFALSE,
    ...s24(2),
    CONVERT_I,
    RETURNVALUE,
    POP,
    PUSHBYTE,
    1,
    RETURNVALUE,
  ];
  assert.equal(run(script(code)), 0);
});

test("a value an if body moves to a local leaves the code after the if as it is", { skip }, () => {
  // l1 = 1; if (false) l1 = 7; else { l1 = 3 } return l1: the if body, written in
  // place, ends putting 7 straight in l1, and the else still pushes its 3.
  // 0 pushbyte 1; 2 setlocal1; 3 pushfalse; 4 iftrue +7 to 15; 8 pushbyte 3;
  // 10 setlocal1; 11 jump +3 to 18; 15 pushbyte 7; 17 setlocal1; 18 getlocal1; 19 returnvalue.
  const code = [
    PUSHBYTE,
    1,
    SETLOCAL1,
    PUSHFALSE,
    IFTRUE,
    ...s24(7),
    PUSHBYTE,
    3,
    SETLOCAL1,
    JUMP,
    ...s24(3),
    PUSHBYTE,
    7,
    SETLOCAL1,
    GETLOCAL1,
    RETURNVALUE,
  ];
  const js = emit(script(code));
  assert.match(js, /l1 = 3;/);
  assert.equal(run(script(code)), 3);
});

test("an irreducible loop keeps the dispatcher, and runs the same", { skip }, () => {
  // n = 3; if (true) goto B; A: n--; B: if (n > 0) goto A; return n. A and B are
  // a loop with two ways in, from the entry to each, so neither dominates the other.
  // 0 pushbyte 3; 2 setlocal1; 3 pushtrue; 4 iftrue +10 to 18;
  // 8 label; 9 getlocal1; 10 pushbyte 1; 12 subtract_i; 13 setlocal1; 14 jump +0 to 18;
  // 18 getlocal1; 19 pushbyte 0; 21 ifgt -17 to 8; 25 getlocal1; 26 returnvalue.
  const code = [
    PUSHBYTE,
    3,
    SETLOCAL1,
    PUSHTRUE,
    IFTRUE,
    ...s24(10),
    LABEL,
    GETLOCAL1,
    PUSHBYTE,
    1,
    SUBTRACT_I,
    SETLOCAL1,
    JUMP,
    ...s24(0),
    GETLOCAL1,
    PUSHBYTE,
    0,
    IFGT,
    ...s24(-17),
    GETLOCAL1,
    RETURNVALUE,
  ];
  assert.match(emit(script(code)), /switch \(b\)/);
  assert.equal(run(script(code)), 0);
});

test("a throw in a handler's range runs the handler, with the exception on the stack", {
  skip,
}, () => {
  // 0: pushbyte 7; 2: throw; 3: returnvalue, the handler of 0 up to 3, for any type.
  const code = [PUSHBYTE, 7, THROW, RETURNVALUE];
  const abc = script(code, { exceptions: [[0, 3, 3, 0, 0]] });
  assert.equal(run(abc), 7);
  // A structured try, the handler's code after its labelled block.
  const js = emit(abc);
  assert.match(js, /L\d+: \{\ntry \{/);
  assert.doesNotMatch(js, /switch \(b\)/);
});

test("of two handlers covering a throw, the table's first takes it, as the inner try", {
  skip,
}, () => {
  // 0 pushbyte 7; 2 throw; 3 pop; 4 pushbyte 1; 6 returnvalue; 7 pop; 8 pushbyte 2; 10 returnvalue.
  const code = [PUSHBYTE, 7, THROW, POP, PUSHBYTE, 1, RETURNVALUE, POP, PUSHBYTE, 2, RETURNVALUE];
  const first = script(code, {
    exceptions: [
      [0, 3, 3, 0, 0],
      [0, 3, 7, 0, 0],
    ],
  });
  const second = script(code, {
    exceptions: [
      [0, 3, 7, 0, 0],
      [0, 3, 3, 0, 0],
    ],
  });
  assert.equal(run(first), 1);
  assert.equal(run(second), 2);
  assert.doesNotMatch(emit(first), /switch \(b\)/);
  assert.doesNotMatch(emit(second), /switch \(b\)/);
});

test("an exception in a handler's code goes to the handler covering that", { skip }, () => {
  // 0 pushbyte 7; 2 throw; 3 pop; 4 pushbyte 8; 6 throw; 7 returnvalue. The
  // handler at 3 covers 0 up to 3; the one at 7 covers 0 up to 7, the first's code too.
  const code = [PUSHBYTE, 7, THROW, POP, PUSHBYTE, 8, THROW, RETURNVALUE];
  const abc = script(code, {
    exceptions: [
      [0, 3, 3, 0, 0],
      [0, 7, 7, 0, 0],
    ],
  });
  assert.equal(run(abc), 8);
  assert.doesNotMatch(emit(abc), /switch \(b\)/);
});

test("a handler that goes back into its range first keeps the dispatcher, and runs the same", {
  skip,
}, () => {
  // n = 1; M: if (n > 0) { n = 0; throw 9 } return n; the handler at 19, of 0
  // up to 19, pops and jumps back to M: M is reached through the handler first.
  // 0 pushbyte 1; 2 setlocal1; 3 label; 4 getlocal1; 5 pushbyte 0; 7 ifgt +2 to 13;
  // 11 getlocal1; 12 returnvalue; 13 pushbyte 0; 15 setlocal1; 16 pushbyte 9; 18 throw;
  // 19 pop; 20 jump -21 to 3.
  const code = [
    PUSHBYTE,
    1,
    SETLOCAL1,
    LABEL,
    GETLOCAL1,
    PUSHBYTE,
    0,
    IFGT,
    ...s24(2),
    GETLOCAL1,
    RETURNVALUE,
    PUSHBYTE,
    0,
    SETLOCAL1,
    PUSHBYTE,
    9,
    THROW,
    POP,
    JUMP,
    ...s24(-21),
  ];
  const abc = script(code, { exceptions: [[0, 19, 19, 0, 0]] });
  assert.match(emit(abc), /switch \(b\)/);
  assert.equal(run(abc), 0);
});

test("a throw past a handler's range goes on to the caller", { skip }, () => {
  // The handler covers 0 up to 2, so not the throw at 2.
  const code = [PUSHBYTE, 7, THROW, RETURNVALUE];
  assert.throws(
    () => run(script(code, { exceptions: [[0, 2, 3, 0, 0]] })),
    (e) => e === 7,
  );
});

/** The module of `name`, added to the domain, as a function of `rt` whose body parses. */
function module(name: string, builtin: boolean): string {
  assert.equal(
    testing.domainAdd(new Uint8Array(readFileSync(new URL(name, generated))), builtin),
    0,
  );
  const js = testing.domainModule("") as string;
  const body = js.replace(/^export default function \(rt\) \{/, "").replace(/\}\s*$/, "");
  assert.doesNotThrow(() => new Function("rt", body), `${name} parses`);
  return js;
}

test("the builtins compile to modules with every instruction lowered", { skip }, () => {
  testing.domainReset(50);
  for (const name of ["builtin.abc", "shell_toplevel.abc"]) {
    const js = module(name, true);
    assert.deepEqual(js.match(/rt\.unsupported\("[^"]*"\)/g) ?? [], [], name);
    assert.equal(js.match(/rt\.unverified/g), null, `${name} has every method verified`);
  }
});

test("a module's functions are named after their methods, for stacks and profiles", {
  skip,
}, () => {
  testing.domainReset(50);
  const js = module("builtin.abc", true);
  // A script's function, by its qualified name, as a JavaScript identifier after $.
  assert.match(js, /function \$avmplus__describeType\(/);
  // A class's method, Class#uri::name, and a setter, Class#set:name.
  assert.match(js, /function \$Array_http___adobe_com_AS3_2006_builtin__join\(/);
  assert.match(js, /function \$Array_Array__set_length\(/);
  // No name the generated code binds: every factory's function starts with $.
  assert.doesNotMatch(js, /=> function [A-Za-z_][A-Za-z0-9_]*\(/);
});

test("the tables name namespaces, classes and multinames by the module's shorthands", {
  skip,
}, () => {
  testing.domainReset(50);
  const js = module("builtin.abc", true);
  assert.match(js, /\n {2}const mn = \(kind, set, name\) => rt\.name\(N, V, kind, set, name\);\n/);
  assert.match(js, /\n {4}mn\(7, \[\d+\], "Object"\),\n/);
  assert.match(js, /\bcls\(ns\(\d, "[\w.]*"\), "\w+"\)/);
  assert.equal(js.match(/rt\.(ns|cls|name)\(/g)?.length, 3, "only in the shorthands");
});

test("a metadata item's key or value past the string pool is empty, as avmplus reads it", {
  skip,
}, () => {
  // [x(99="98")] on a slot, where the pool has one string: avmplus' poolstr
  // gives "" for an index past the end, and the module must not read on.
  const pool = {
    strings: ["x"],
    namespaces: [[0x16, ...u30(0)]],
    multinames: [[0x07, ...u30(1), ...u30(1)]],
  };
  const bytes = abc(
    pool,
    tables({
      methods: [{}],
      metadata: [{ name: 1, items: [[99, 98]] }],
      scripts: [{ init: 0, traits: [{ name: 1, kind: 0, index: 0, metadata: [0] }] }],
      bodies: [{ method: 0, code: [0x47], maxStack: 1, localCount: 1, maxScopeDepth: 1 }],
    }),
  );
  testing.domainReset(50);
  testing.domainAdd(new Uint8Array(readFileSync(new URL("builtin.abc", generated))), true);
  testing.domainModule("");
  assert.equal(testing.domainAdd(bytes, false), 0);
  const js = testing.domainModule("") as string;
  assert.match(js, /meta: \[\[0, \d+, \[\["x", \["", ""\]\]\]\]\]/);
});

test("a method with a long name is named without the memory growing with it", {
  skip,
}, async () => {
  // A script's method named by 8000 characters: its function's name is built
  // in one buffer, where a string grown a character at a time took 63 MiB.
  const long = "n".repeat(8000);
  const pool = {
    strings: ["x", "", long],
    namespaces: [[0x16, ...u30(2)]],
    multinames: [
      [0x07, ...u30(1), ...u30(1)],
      [0x07, ...u30(1), ...u30(3)],
    ],
  };
  const returnVoid = [0x47];
  const bytes = abc(
    pool,
    tables({
      methods: [{}, {}],
      scripts: [{ init: 0, traits: [{ name: 2, kind: 1, index: 1 }] }],
      bodies: [
        { method: 0, code: returnVoid, maxStack: 1, localCount: 1, maxScopeDepth: 1 },
        { method: 1, code: returnVoid, maxStack: 1, localCount: 1, maxScopeDepth: 1 },
      ],
    }),
  );
  const fresh = await loadTesting("dist-test");
  fresh.domainReset(50);
  fresh.domainAdd(new Uint8Array(readFileSync(new URL("builtin.abc", generated))), true);
  fresh.domainModule("");
  assert.equal(fresh.domainAdd(bytes, false), 0);
  const before = fresh.memory.buffer.byteLength;
  const js = fresh.domainModule("") as string;
  assert.ok(js.includes(`function $${long}(`), "the method named in full");
  const grown = fresh.memory.buffer.byteLength - before;
  assert.ok(grown < 4 << 20, `memory grew ${grown} bytes`);
});

test("an ABC compiled again gives the same module", { skip }, () => {
  testing.domainReset(50);
  const first = module("builtin.abc", true);
  assert.equal(testing.domainModule(""), first);
});

test("a module lays out traits that verifying its methods did not resolve", { skip }, () => {
  // Nothing in builtin.abc calls flash.net's registerClassAlias, so only
  // emitting the module resolves its script's traits.
  testing.domainReset(50);
  const js = module("builtin.abc", true);
  const script = js.match(
    /\{ traits: \{[^\n]*"registerClassAlias", (\d+)\][^\n]*methods: \[([^\n]*?)\] \}, init/,
  );
  assert.ok(script, "the script binding registerClassAlias");
  const disp = Number(script[1]) >> 3;
  // Its dispatch id, factory, method id, then its signature for describeType.
  const entry = script[2].match(new RegExp(`\\[${disp}, F\\[(\\d+)\\], \\d+, `));
  assert.ok(entry, "its method by dispatch id");
  const factories = js.slice(js.indexOf("const F = ["), js.indexOf("const A = "));
  // A native's name, and its argument counts when it has any.
  const natives = [...factories.matchAll(/rt\.native\("([^"]*)"(?:, \d+, -?\d+)?\)/g)].map(
    (m) => m[1],
  );
  assert.ok(natives.includes("flash.net::registerClassAlias"));
  assert.match(
    factoryAt(factories, Number(entry[1])),
    /rt\.native\("flash\.net::registerClassAlias", 2, 2\)/,
  );
});

/**
 * F[index]'s source in a module's `const F = [...]`: entries start on a
 * line after one ending in [ or ,, with the method's type table or not.
 */
function factoryAt(factories: string, index: number): string {
  const lines = factories.split("\n");
  let at = -1;
  for (let i = 1; i < lines.length; i++) {
    if (
      /^ {4}(\(\(\.\.\.T\) => |\((scope(, sup(, \$dx[^)]*)?)?)?\) =>|rt\.)/.test(lines[i]) &&
      /[[,]$/.test(lines[i - 1]) &&
      ++at === index
    ) {
      return lines[i];
    }
  }

  return "";
}

const DEBUGLINE = 0xf0;
const DEBUGFILE = 0xf1;

/** A source map's mappings, decoded: per generated line, its segments' source indices and lines, absolute. */
function mappings(map: string): [number, number][][] {
  const digits = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let source = 0;
  let line = 0;
  return map.split(";").map((segments) =>
    segments
      ? segments.split(",").map((segment) => {
          const fields: number[] = [];
          let value = 0;
          let shift = 0;
          for (const c of segment) {
            const d = digits.indexOf(c);
            value |= (d & 31) << shift;
            shift += 5;
            if (!(d & 32)) {
              fields.push(value & 1 ? -(value >> 1) : value >> 1);
              value = 0;
              shift = 0;
            }
          }

          source += fields[1];
          line += fields[2];
          return [source, line] as [number, number];
        })
      : [],
  );
}

test("a module's source map has each statement's line, from debugfile and debugline", {
  skip,
}, () => {
  // debugfile "x"; debugline 7; l1 = 5; debugline 9; return l1.
  const code = [
    DEBUGFILE,
    1,
    DEBUGLINE,
    7,
    PUSHBYTE,
    5,
    SETLOCAL1,
    DEBUGLINE,
    9,
    GETLOCAL1,
    RETURNVALUE,
  ];
  testing.domainReset(50);
  testing.domainAdd(new Uint8Array(readFileSync(new URL("builtin.abc", generated))), true);
  assert.equal(testing.domainAdd(script(code), false), 0);
  const js = (testing.domainModule("") as string).split("\n");
  const map = JSON.parse(testing.domainSourceMap() as string);
  assert.deepEqual(map.sources, ["x"]);
  const lines = mappings(map.mappings);
  // The source line (zero-based) the generated line starts in: its last segment's, or the line before's.
  const lineOf = (g: number): number => {
    for (let at = g; at >= 0; at--) {
      const segments = lines[at] ?? [];
      if (segments.length) {
        return segments[segments.length - 1][1];
      }
    }

    return -1;
  };

  assert.equal(lineOf(js.findIndex((l) => l.trim() === "l1 = 5;")), 6);
  assert.equal(lineOf(js.findIndex((l) => l.trim() === "return l1;")), 8);
});

test("a null check is made where the instruction it checks for reads the value first", {
  skip,
}, () => {
  const GETPROPERTY = 0x66;
  const CONVERT_O = 0x77;
  assert.match(
    emit(script([GETLOCAL1, GETPROPERTY, 1, RETURNVALUE])),
    /= rt\.getProperty\(l1 \?\? nn\(l1\), M\[1\]\);/,
  );
  // A conversion to Object reads it after a check of its own.
  assert.match(emit(script([GETLOCAL1, CONVERT_O, RETURNVALUE])), /\nl1 \?\? nn\(l1\);\n/);
});

test("undefined is written void 0, and a return of it a bare return", { skip }, () => {
  const PUSHUNDEFINED = 0x21;
  const KILL = 0x08;
  const RETURNVOID = 0x47;
  const js = emit(script([PUSHUNDEFINED, SETLOCAL1, GETLOCAL1, POP, KILL, 1, RETURNVOID]));
  assert.match(js, /\nl1 = void 0;\n/);
  assert.match(js, /\nreturn;\n/);
  assert.doesNotMatch(js, /\bundefined\b/);
});

test("registers reset one after another are reset in one statement", { skip }, () => {
  const KILL = 0x08;
  const code = [PUSHBYTE, 1, SETLOCAL1, PUSHBYTE, 2, SETLOCAL2, GETLOCAL1, GETLOCAL2, ADD, POP];
  const js = emit(script([...code, KILL, 1, KILL, 2, KILL, 3, PUSHBYTE, 3, RETURNVALUE]));
  assert.match(js, /\nl1 = l2 = l3 = void 0;\n/);
  assert.equal(run(script([...code, KILL, 1, GETLOCAL1, KILL, 2, RETURNVALUE])), undefined);
});

test("a factory names only the parameters its method uses", { skip }, () => {
  testing.domainReset(50);
  const js = module("builtin.abc", true);
  const factories = js.match(/\(([^()]*)\) => function \$\w*\([^)]*\) \{\n(.*\n){2}/g) ?? [];
  const named = (params: string) => factories.filter((f) => f.startsWith(`(${params}) =>`));
  assert.ok(named("").length > 0, "() =>");
  assert.ok(named("scope, sup").length > 0, "(scope, sup) =>");
  // $dx where the method checks it on entry, and only there.
  const dx = named("scope, sup, $dx = rt.defaultXmlNamespace");
  assert.ok(dx.length > 0);
  assert.ok(dx.every((f) => f.includes("rt.defaultXmlNamespace !== $dx")));
  assert.equal(js.match(/!== \$dx\)/g)?.length, dx.length);
});
