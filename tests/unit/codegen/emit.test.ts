import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { s24, script } from "./ir-cases.ts";
import { testing } from "./testing-module.ts";

const generated = new URL("../../../oracle/avmplus/generated/", import.meta.url);
const skip = !existsSync(generated) && "oracle/avmplus missing";

/** Just what these methods call. */
const rt = {
  greaterThan: (a: number, b: number) => a > b,
  caught: (e: unknown) => e,
  unreachable: () => new Error("unreachable"),
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
  return new Function("rt", `return ${emit(abc)}`)(rt).call({});
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
const JUMP = 0x10;
const IFTRUE = 0x11;
const IFFALSE = 0x12;
const PUSHTRUE = 0x26;
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
  assert.equal(run(script(code, { exceptions: [[0, 3, 3, 0, 0]] })), 7);
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
  const entry = script[2].match(new RegExp(`\\[${disp}, F\\[(\\d+)\\]\\]`));
  assert.ok(entry, "its method by dispatch id");
  const factories = js.slice(js.indexOf("const F = ["), js.indexOf("const A = "));
  const natives = [...factories.matchAll(/rt\.native\("([^"]*)"\)/g)].map((m) => m[1]);
  assert.ok(natives.includes("flash.net::registerClassAlias"));
  assert.match(
    factoryAt(factories, Number(entry[1])),
    /rt\.native\("flash\.net::registerClassAlias"\)/,
  );
});

/** F[index]'s source in a module's `const F = [...]`: entries start on a line after one ending in [ or ,. */
function factoryAt(factories: string, index: number): string {
  const lines = factories.split("\n");
  let at = -1;
  for (let i = 1; i < lines.length; i++) {
    if (
      /^ {4}(\(scope, sup\) =>|rt\.)/.test(lines[i]) &&
      /[[,]$/.test(lines[i - 1]) &&
      ++at === index
    ) {
      return lines[i];
    }
  }

  return "";
}
